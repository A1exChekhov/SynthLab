import Foundation
import Accelerate

// MARK: - Stereo ring buffer (one per source × output), lock-guarded

final class StereoRing {
    private var left: [Float]
    private var right: [Float]
    private let capacity: Int
    private var writeIdx = 0
    private var available = 0
    private var lock = os_unfair_lock_s()

    init(capacity: Int) {
        self.capacity = capacity
        left = [Float](repeating: 0, count: capacity)
        right = [Float](repeating: 0, count: capacity)
    }

    func clear() {
        os_unfair_lock_lock(&lock)
        writeIdx = 0; available = 0
        os_unfair_lock_unlock(&lock)
    }

    /// Push interleaved-by-channel blocks. Drops oldest on overflow.
    func push(l: UnsafePointer<Float>, r: UnsafePointer<Float>, count: Int) {
        os_unfair_lock_lock(&lock)
        for i in 0..<count {
            left[writeIdx] = l[i]
            right[writeIdx] = r[i]
            writeIdx = (writeIdx + 1) % capacity
            if available < capacity { available += 1 }
        }
        os_unfair_lock_unlock(&lock)
    }

    /// Pull `count` frames into dst arrays; zero-fill underflow.
    func pull(into dstL: UnsafeMutablePointer<Float>, _ dstR: UnsafeMutablePointer<Float>, count: Int) {
        os_unfair_lock_lock(&lock)
        let have = min(available, count)
        let start = (writeIdx - available + capacity) % capacity
        for i in 0..<have {
            let idx = (start + i) % capacity
            dstL[i] = left[idx]
            dstR[i] = right[idx]
        }
        for i in have..<count {
            dstL[i] = 0; dstR[i] = 0
        }
        available -= have
        os_unfair_lock_unlock(&lock)
    }
}

// MARK: - Spectrum analyser (12 bands matching EQ_FREQS)

final class SpectrumAnalyzer {
    private let n = 2048
    private let log2n: vDSP_Length
    private var fftSetup: FFTSetup
    private var window: [Float]
    private var realp: [Float]
    private var imagp: [Float]

    init() {
        log2n = vDSP_Length(log2(Float(n)))
        fftSetup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
        window = [Float](repeating: 0, count: n)
        vDSP_hann_window(&window, vDSP_Length(n), Int32(vDSP_HANN_NORM))
        realp = [Float](repeating: 0, count: n / 2)
        imagp = [Float](repeating: 0, count: n / 2)
    }

    deinit { vDSP_destroy_fftsetup(fftSetup) }

    /// Returns per-band magnitudes (0..~1), tilt-balanced like the reference.
    func bands(from samples: [Float]) -> [Float] {
        var bandsOut = [Float](repeating: 0, count: Audio.eqFreqs.count)
        guard samples.count >= n else { return bandsOut }

        var windowed = [Float](repeating: 0, count: n)
        let slice = Array(samples.suffix(n))
        vDSP_vmul(slice, 1, window, 1, &windowed, 1, vDSP_Length(n))

        realp.withUnsafeMutableBufferPointer { rp in
            imagp.withUnsafeMutableBufferPointer { ip in
                var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                windowed.withUnsafeBufferPointer { wp in
                    wp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) { cp in
                        vDSP_ctoz(cp, 2, &split, 1, vDSP_Length(n / 2))
                    }
                }
                vDSP_fft_zrip(fftSetup, &split, 1, log2n, FFTDirection(FFT_FORWARD))

                var mags = [Float](repeating: 0, count: n / 2)
                vDSP_zvabs(&split, 1, &mags, 1, vDSP_Length(n / 2))
                var scale = Float(1.0) / Float(n)
                vDSP_vsmul(mags, 1, &scale, &mags, 1, vDSP_Length(n / 2))

                let binHz = Float(Audio.sampleRate) / Float(n)
                for (i, edge) in Audio.eqEdges.enumerated() {
                    let lo = max(1, Int(edge.lo / binHz))
                    let hi = min(n / 2 - 1, Int(edge.hi / binHz))
                    if hi >= lo {
                        var sum: Float = 0
                        vDSP_meanv(Array(mags[lo...hi]), 1, &sum, vDSP_Length(hi - lo + 1))
                        bandsOut[i] = sum * Audio.eqTilt[i]
                    }
                }
            }
        }
        return bandsOut
    }
}

// MARK: - Visualizer analyser (64 log-bands + waveform + level/bass/treble/centroid/beat)
//
// Ports the Windows GPU visualizer feed (`_update_viz` in splitter_gui.py):
//   VIZ_N = 64 bands over geomspace(30, 16000), magnitudes `sqrt(b)*6`, with an
//   attack-fast / release-slow smoother. Plus RMS level, bass/treble energy, a
//   normalized spectral centroid, a 256-pt waveform, and a bass-vs-running-avg
//   beat flag. All values are consumed by viz.html's WebGL feedback shader.

final class VizAnalyzer {
    static let bandCount = 64
    static let waveCount = 256
    private let n = 4096
    private let log2n: vDSP_Length
    private var fftSetup: FFTSetup
    private var window: [Float]
    private var realp: [Float]
    private var imagp: [Float]

    // band bin ranges (precomputed) + smoothing state
    private let binLo: [Int]
    private let binHi: [Int]
    private var smooth = [Float](repeating: 0, count: VizAnalyzer.bandCount)
    private var bassAvg: Float = 0

    init() {
        log2n = vDSP_Length(log2(Float(n)))
        fftSetup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
        window = [Float](repeating: 0, count: n)
        vDSP_hann_window(&window, vDSP_Length(n), Int32(vDSP_HANN_NORM))
        realp = [Float](repeating: 0, count: n / 2)
        imagp = [Float](repeating: 0, count: n / 2)

        // geomspace(30, 16000, bandCount+1) → per-band [lo, hi) bin indices
        let binHz = Float(Audio.sampleRate) / Float(n)
        let f0: Float = 30, f1: Float = 16000
        let steps = VizAnalyzer.bandCount
        var lo = [Int](repeating: 0, count: steps)
        var hi = [Int](repeating: 0, count: steps)
        let ratio = log(f1 / f0)
        for i in 0..<steps {
            let eLo = f0 * exp(ratio * Float(i) / Float(steps))
            let eHi = f0 * exp(ratio * Float(i + 1) / Float(steps))
            lo[i] = max(1, Int(eLo / binHz))
            hi[i] = min(n / 2 - 1, max(lo[i], Int(eHi / binHz)))
        }
        binLo = lo; binHi = hi
    }

    deinit { vDSP_destroy_fftsetup(fftSetup) }

    struct Frame {
        var bands: [Double]
        var wave: [Double]
        var level: Double
        var bass: Double
        var treble: Double
        var cen: Double
        var beat: Double
    }

    func analyze(_ samples: [Float]) -> Frame {
        var bandsOut = [Double](repeating: 0, count: VizAnalyzer.bandCount)
        var waveOut = [Double](repeating: 0.5, count: VizAnalyzer.waveCount)
        guard samples.count >= n else {
            return Frame(bands: bandsOut, wave: waveOut, level: 0, bass: 0, treble: 0, cen: 0, beat: 0)
        }
        let slice = Array(samples.suffix(n))

        // RMS level
        var rms: Float = 0
        vDSP_rmsqv(slice, 1, &rms, vDSP_Length(n))

        // waveform downsample to 256 → clip(x*4,-1,1)*0.5+0.5
        let stride = n / VizAnalyzer.waveCount
        for i in 0..<VizAnalyzer.waveCount {
            let v = max(-1, min(1, slice[i * stride] * 4))
            waveOut[i] = Double(v * 0.5 + 0.5)
        }

        // windowed FFT magnitudes
        var windowed = [Float](repeating: 0, count: n)
        vDSP_vmul(slice, 1, window, 1, &windowed, 1, vDSP_Length(n))
        var mags = [Float](repeating: 0, count: n / 2)
        realp.withUnsafeMutableBufferPointer { rp in
            imagp.withUnsafeMutableBufferPointer { ip in
                var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                windowed.withUnsafeBufferPointer { wp in
                    wp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) { cp in
                        vDSP_ctoz(cp, 2, &split, 1, vDSP_Length(n / 2))
                    }
                }
                vDSP_fft_zrip(fftSetup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                vDSP_zvabs(&split, 1, &mags, 1, vDSP_Length(n / 2))
                var scale = Float(1.0) / Float(n)
                vDSP_vsmul(mags, 1, &scale, &mags, 1, vDSP_Length(n / 2))
            }
        }

        // bands: mean(mag[lo..hi]) → sqrt*6 → attack/release smoothing
        for i in 0..<VizAnalyzer.bandCount {
            let lo = binLo[i], hi = binHi[i]
            var m: Float = 0
            vDSP_meanv(Array(mags[lo...hi]), 1, &m, vDSP_Length(hi - lo + 1))
            let val = sqrtf(max(0, m)) * 6
            smooth[i] = val > smooth[i] ? val : smooth[i] * 0.86 + val * 0.14
            bandsOut[i] = Double(min(1, smooth[i]))
        }

        // centroid (40..16000 → normalized log), bass/treble energy
        let binHz = Float(Audio.sampleRate) / Float(n)
        var num: Float = 0, den: Float = 0, bassSum: Float = 0, trebSum: Float = 0
        var bassCnt = 0, trebCnt = 0
        for k in 1..<(n / 2) {
            let f = Float(k) * binHz
            let mg = mags[k]
            num += f * mg; den += mg
            if f < 160 { bassSum += mg; bassCnt += 1 }
            if f >= 2000 { trebSum += mg; trebCnt += 1 }
        }
        let cenHz = den > 0 ? max(40, min(16000, num / den)) : 40
        let cenNorm = log2f(cenHz / 40) / log2f(16000 / 40)
        let bass = bassCnt > 0 ? bassSum / Float(bassCnt) : 0
        let treble = trebCnt > 0 ? trebSum / Float(trebCnt) : 0

        // beat detection (bass vs slow running average)
        var beat: Float = 0
        if bass > bassAvg * 1.28 && bass > 0.0025 { beat = 1 }
        bassAvg = 0.95 * bassAvg + 0.05 * bass

        return Frame(bands: bandsOut, wave: waveOut,
                     level: Double(min(1, rms)), bass: Double(bass),
                     treble: Double(treble), cen: Double(cenNorm), beat: Double(beat))
    }
}

// MARK: - Calibration DSP

enum CalibrationDSP {
    /// Gentle logarithmic sine sweep (chirp) with short fades. Quiet & non-piercing
    /// (amp 0.16, 40 ms fades by default) yet unique enough for robust cross-correlation.
    static func logChirp(durationSec: Double, sampleRate: Double = Audio.sampleRate,
                         f0: Double = 120, f1: Double = 8000, amp: Double = 0.16) -> [Float] {
        let total = Int(durationSec * sampleRate)
        var out = [Float](repeating: 0, count: total)
        let k = pow(f1 / f0, 1.0 / durationSec)
        let twoPiF0 = 2.0 * Double.pi * f0
        let lnk = log(k)
        let fade = max(1, Int(0.04 * sampleRate))
        for i in 0..<total {
            let t = Double(i) / sampleRate
            let phase = twoPiF0 * (pow(k, t) - 1.0) / lnk
            var s = sin(phase) * amp
            if i < fade { s *= Double(i) / Double(fade) }
            if i > total - fade { s *= Double(total - i) / Double(fade) }
            out[i] = Float(s)
        }
        return out
    }

    /// FFT cross-correlation: returns lag (in samples) of `signal` relative to `reference`,
    /// searching non-negative lags up to 1 s (signal arrives after reference).
    static func bestLag(reference: [Float], signal: [Float]) -> Int {
        let outReal = correlate(reference, signal)
        guard !outReal.isEmpty else { return 0 }
        let maxLag = min(outReal.count, Int(Audio.sampleRate))
        var peakIdx = 0
        var peakVal = -Float.greatestFiniteMagnitude
        for lag in 0..<maxLag {
            let v = abs(outReal[lag])
            if v > peakVal { peakVal = v; peakIdx = lag }
        }
        return peakIdx
    }

    /// Like `bestLag`, but also returns a peak/median confidence ratio so HOLD can skip
    /// unreliable frames (mono content / silence). Lag searched over `0..<maxLagSamples`.
    static func bestLagRatio(reference: [Float], signal: [Float], maxLagSamples: Int) -> (lag: Int, ratio: Float) {
        let outReal = correlate(reference, signal)
        guard !outReal.isEmpty else { return (0, 0) }
        let maxLag = max(1, min(outReal.count, maxLagSamples))
        var peakIdx = 0
        var peakVal: Float = 0
        var mags = [Float](repeating: 0, count: maxLag)
        for lag in 0..<maxLag {
            let v = abs(outReal[lag]); mags[lag] = v
            if v > peakVal { peakVal = v; peakIdx = lag }
        }
        mags.sort()
        let med = mags[maxLag / 2] + 1e-9
        return (peakIdx, peakVal / med)
    }

    /// Raw cross-correlation via inverse FFT of conj(X)·Y. Result index = lag in samples.
    private static func correlate(_ reference: [Float], _ signal: [Float]) -> [Float] {
        let need = reference.count + signal.count
        var size = 1
        while size < need { size <<= 1 }
        let log2n = vDSP_Length(log2(Float(size)))
        guard let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else { return [] }
        defer { vDSP_destroy_fftsetup(setup) }

        func fwd(_ x: [Float]) -> (re: [Float], im: [Float]) {
            var padded = x
            padded.append(contentsOf: [Float](repeating: 0, count: size - x.count))
            var re = [Float](repeating: 0, count: size / 2)
            var im = [Float](repeating: 0, count: size / 2)
            re.withUnsafeMutableBufferPointer { rp in
                im.withUnsafeMutableBufferPointer { ip in
                    var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                    padded.withUnsafeBufferPointer { pp in
                        pp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: size / 2) { cp in
                            vDSP_ctoz(cp, 2, &split, 1, vDSP_Length(size / 2))
                        }
                    }
                    vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                }
            }
            return (re, im)
        }

        let X = fwd(reference)
        let Y = fwd(signal)

        // conj(X) * Y
        var pr = [Float](repeating: 0, count: size / 2)
        var pi = [Float](repeating: 0, count: size / 2)
        for i in 0..<(size / 2) {
            pr[i] = X.re[i] * Y.re[i] + X.im[i] * Y.im[i]
            pi[i] = X.re[i] * Y.im[i] - X.im[i] * Y.re[i]
        }

        var outReal = [Float](repeating: 0, count: size)
        pr.withUnsafeMutableBufferPointer { rp in
            pi.withUnsafeMutableBufferPointer { ip in
                var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_INVERSE))
                outReal.withUnsafeMutableBufferPointer { op in
                    op.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: size / 2) { cp in
                        vDSP_ztoc(&split, 1, cp, 2, vDSP_Length(size / 2))
                    }
                }
            }
        }

        return outReal
    }
}
