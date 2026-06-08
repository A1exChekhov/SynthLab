import Foundation

/// Real-time DSP for the DSP-900 "Effects Processor" faders & pads:
///   Position (pan + distance), Tone (warm↔bright tilt + drive), Mono-Bass crossover,
///   Compressor, and a Freeverb-style algorithmic Reverb.
///
/// One `OutputFXChain` instance lives per output (in `RenderState`) so each speaker
/// keeps its own filter / reverb / envelope state. `process()` runs on the audio
/// render thread and reads the flat `EffectState.fx*` mirrors (never the dictionaries).
///
/// (Spatial / 3D / Surround and the graphic EQ + Bass low-shelf are handled elsewhere:
///  `applySpatial(...)` and the per-output `AVAudioUnitEQ`.)
final class OutputFXChain {
    private let sr: Float

    // one-pole low-pass states
    private var distLpL: Float = 0, distLpR: Float = 0
    private var mbLpL: Float = 0,   mbLpR: Float = 0
    private var toneLpL: Float = 0, toneLpR: Float = 0
    // compressor detector envelope
    private var env: Float = 0
    // reverb (mono send, fed to both channels)
    private let reverb: ReverbMono

    init(sr: Float) {
        self.sr = sr
        reverb = ReverbMono(sr: sr)
    }

    /// Process the stereo bus in place. Called after `applySpatial`, before mono collapse.
    func process(_ L: UnsafeMutablePointer<Float>, _ R: UnsafeMutablePointer<Float>,
                 frames: Int, fx: EffectState) {

        // ── POSITION: pan + distance ──────────────────────────────────────────
        if fx.fxPosOn {
            let p = max(-1, min(1, fx.fxPan))
            let gl: Float = p <= 0 ? 1 : 1 - p
            let gr: Float = p >= 0 ? 1 : 1 + p
            let d = max(0, min(1, fx.fxDistance))
            let att = 1 - 0.55 * d
            let cutoff = 18000 * (1 - 0.85 * d)
            let a = 1 - expf(-2 * Float.pi * cutoff / sr)
            let far = d > 0.001
            for i in 0..<frames {
                var l = L[i] * gl * att
                var r = R[i] * gr * att
                distLpL += a * (l - distLpL)
                distLpR += a * (r - distLpR)
                if far { l = distLpL; r = distLpR }
                L[i] = l; R[i] = r
            }
        }

        // ── MONO-BASS: sum sub-crossover lows to mono (tighter bass) ──────────
        if fx.fxMonobassOn {
            let hz = max(40, min(300, fx.fxMonobassHz))
            let a = 1 - expf(-2 * Float.pi * hz / sr)
            for i in 0..<frames {
                mbLpL += a * (L[i] - mbLpL)
                mbLpR += a * (R[i] - mbLpR)
                let mono = (mbLpL + mbLpR) * 0.5
                L[i] = (L[i] - mbLpL) + mono
                R[i] = (R[i] - mbLpR) + mono
            }
        }

        // ── TONE: warm↔bright tilt + drive (soft saturation) ─────────────────
        if fx.fxToneOn {
            let tilt = max(-1, min(1, fx.fxTilt))
            let drive = max(0, min(1, fx.fxDrive))
            let aTone = 1 - expf(-2 * Float.pi * 800 / sr)
            let dgain = 1 + drive * 4
            let norm: Float = drive > 0.001 ? 1 / tanhf(dgain) : 1
            let tg = tilt * 0.6
            for i in 0..<frames {
                var l = L[i], r = R[i]
                if tilt != 0 {
                    toneLpL += aTone * (l - toneLpL)
                    toneLpR += aTone * (r - toneLpR)
                    l = toneLpL * (1 - tg) + (l - toneLpL) * (1 + tg)
                    r = toneLpR * (1 - tg) + (r - toneLpR) * (1 + tg)
                }
                if drive > 0.001 {
                    l = tanhf(l * dgain) * norm
                    r = tanhf(r * dgain) * norm
                }
                L[i] = l; R[i] = r
            }
        }

        // ── COMPRESSOR: 4:1, peak detector, makeup gain ──────────────────────
        if fx.fxCompOn {
            let threshLin = powf(10, max(-60, min(0, fx.fxCompThresh)) / 20)
            let ratio: Float = 4
            let atk = expf(-1 / (sr * 0.005))
            let rel = expf(-1 / (sr * 0.150))
            let makeup = powf(10, (-fx.fxCompThresh) * (1 - 1 / ratio) * 0.4 / 20)
            for i in 0..<frames {
                let lvl = max(abs(L[i]), abs(R[i]))
                if lvl > env { env = atk * env + (1 - atk) * lvl }
                else         { env = rel * env + (1 - rel) * lvl }
                var g: Float = 1
                if env > threshLin && env > 0 {
                    let overDB = 20 * log10f(env / threshLin)
                    let grDB = overDB * (1 - 1 / ratio)
                    g = powf(10, -grDB / 20)
                }
                L[i] *= g * makeup
                R[i] *= g * makeup
            }
        }

        // ── REVERB: Freeverb-style mono reverb mixed back into both channels ──
        if fx.fxReverbOn && fx.fxReverbMix > 0.001 {
            let mix = max(0, min(0.8, fx.fxReverbMix))
            let size = max(0, min(1, fx.fxReverbSize))
            let damp: Float = 0.25
            let dry = 1 - mix
            let wetGain = mix * 1.4
            for i in 0..<frames {
                let inp = (L[i] + R[i]) * 0.25
                let wet = reverb.process(inp, size: size, damp: damp)
                L[i] = L[i] * dry + wet * wetGain
                R[i] = R[i] * dry + wet * wetGain
            }
        }
    }
}

// MARK: - Freeverb building blocks

private final class CombFilter {
    private var buf: [Float]
    private var idx = 0
    private var lp: Float = 0
    init(size: Int) { buf = [Float](repeating: 0, count: max(1, size)) }
    @inline(__always) func process(_ x: Float, feedback: Float, damp: Float) -> Float {
        let y = buf[idx]
        lp = y * (1 - damp) + lp * damp
        buf[idx] = x + lp * feedback
        idx += 1; if idx >= buf.count { idx = 0 }
        return y
    }
}

private final class AllPass {
    private var buf: [Float]
    private var idx = 0
    private let fb: Float = 0.5
    init(size: Int) { buf = [Float](repeating: 0, count: max(1, size)) }
    @inline(__always) func process(_ x: Float) -> Float {
        let bufout = buf[idx]
        let y = -x + bufout
        buf[idx] = x + bufout * fb
        idx += 1; if idx >= buf.count { idx = 0 }
        return y
    }
}

/// Compact Freeverb (8 combs + 4 all-pass), mono. Delay lengths scaled from the
/// classic 44.1 kHz tunings to the running sample rate.
private final class ReverbMono {
    private let combs: [CombFilter]
    private let aps: [AllPass]
    init(sr: Float) {
        let scale = sr / 44100
        let combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
        let apT   = [556, 441, 341, 225]
        combs = combT.map { CombFilter(size: Int((Float($0) * scale).rounded())) }
        aps   = apT.map   { AllPass(size: Int((Float($0) * scale).rounded())) }
    }
    @inline(__always) func process(_ x: Float, size: Float, damp: Float) -> Float {
        let fb = 0.70 + 0.28 * size
        var out: Float = 0
        for c in combs { out += c.process(x, feedback: fb, damp: damp) }
        out /= Float(combs.count)
        for a in aps { out = a.process(out) }
        return out
    }
}
