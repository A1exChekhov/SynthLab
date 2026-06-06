import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox
import Accelerate
import Combine

// MARK: - Per-output render state (captured by the source-node callback)

final class RenderState {
    let toneHz: Double
    var tonePhase: Double = 0
    var testOn: Bool = true

    // spatial history
    let maxDelay: Int
    var histL: [Float]
    var histR: [Float]

    // calibration chirp
    var chirp: [Float]? = nil
    var chirpIndex: Int = 0
    var chirpPlaying: Bool = false

    init(toneHz: Double) {
        self.toneHz = toneHz
        maxDelay = Int(Audio.sampleRate * 0.08) + 1
        histL = [Float](repeating: 0, count: maxDelay)
        histR = [Float](repeating: 0, count: maxDelay)
    }
}

// MARK: - Output runtime

final class OutputRuntime {
    let speaker: OutputSpeaker
    let engine = AVAudioEngine()
    let eq: AVAudioUnitEQ
    let delay = AVAudioUnitDelay()
    var sourceNode: AVAudioSourceNode!
    let state: RenderState

    init(speaker: OutputSpeaker, toneHz: Double) {
        self.speaker = speaker
        self.state = RenderState(toneHz: toneHz)
        self.eq = AVAudioUnitEQ(numberOfBands: Audio.eqFreqs.count + 2) // 12 EQ + bass + lowpass
    }
}

// MARK: - Source runtime (capture)

final class SourceRuntime {
    let config: SourceConfig
    let engine = AVAudioEngine()
    var converter: AVAudioConverter?
    var rings: [UUID: StereoRing] = [:]
    let canonical: AVAudioFormat

    init(config: SourceConfig) {
        self.config = config
        canonical = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                  sampleRate: Audio.sampleRate,
                                  channels: 2, interleaved: false)!
    }
}

// MARK: - Engine

final class PartyEngine: ObservableObject {
    @Published var isRunning = false
    @Published var statusText = "остановлено"

    // injected references (set by AppModel)
    var effects = EffectState()
    var masterGain: Float = 1.0

    private(set) var outRuntimes: [OutputRuntime] = []
    private var srcRuntimes: [SourceRuntime] = []
    private var testMode = false
    private var calibrationBypass = false

    /// Native system-audio loopback (Core Audio process tap, macOS 14.2+).
    let systemTap = SystemAudioTap()

    /// Speakers that failed to open on the last start() — others keep playing.
    private(set) var failedOutputs: [(name: String, error: String)] = []

    let spectrumAnalyzer = SpectrumAnalyzer()
    private var specBuffer = [Float](repeating: 0, count: 2048)
    private var specWrite = 0
    private var specLock = os_unfair_lock_s()
    private var specOutputID: UUID?

    // MARK: Start / stop

    func start(outputs: [OutputSpeaker], sources: [SourceConfig], test: Bool) throws {
        stop()
        testMode = test
        specOutputID = outputs.first(where: { !$0.isSub })?.id ?? outputs.first?.id
        failedOutputs = []

        // build source capture runtimes (skip in test mode) — a bad source must not kill the rest
        if !test {
            for src in sources {
                // Resolve the capture device: a loopback ("System Audio") source uses the
                // native Core Audio tap; a physical source uses its selected input device.
                let deviceID: AudioDeviceID
                if src.loopback {
                    guard let tapDev = systemTap.ensureDevice() else { continue }
                    deviceID = tapDev
                } else {
                    guard let dev = src.device else { continue }
                    deviceID = dev.deviceID
                }
                let rt = SourceRuntime(config: src)
                for o in outputs { rt.rings[o.id] = StereoRing(capacity: Audio.maxBufFrames) }
                do {
                    try setupCapture(rt, deviceID: deviceID)
                    srcRuntimes.append(rt)
                } catch {
                    // skip this source; others continue
                }
            }
        }

        // start capture first (so rings are filling before outputs pull)
        for rt in srcRuntimes {
            rt.engine.prepare()
            try? rt.engine.start()
        }

        // open each output tolerantly — one unavailable speaker must not kill the others
        for (i, spk) in outputs.enumerated() {
            guard let dev = spk.device else { continue }
            let rt = OutputRuntime(speaker: spk, toneHz: Audio.testTones[i % Audio.testTones.count])
            rt.state.testOn = true   // overwritten by setSoloTest for single-speaker test
            do {
                try setupOutput(rt, deviceID: dev.deviceID)
                configureEQ(rt)
                rt.delay.delayTime = max(0, spk.delayMs) / 1000.0
                rt.engine.prepare()
                try rt.engine.start()
                outRuntimes.append(rt)
            } catch {
                failedOutputs.append((spk.device?.name ?? "колонка", error.localizedDescription))
            }
        }

        if outRuntimes.isEmpty {
            let detail = failedOutputs.map { "\($0.name): \($0.error)" }.joined(separator: "; ")
            stop()
            throw NSError(domain: "PartyEngine", code: 10,
                          userInfo: [NSLocalizedDescriptionKey:
                            "Не удалось открыть ни одной колонки: \(detail)"])
        }

        // make sure the spectrum source points at a started, non-sub output
        if !outRuntimes.contains(where: { $0.speaker.id == specOutputID }) {
            specOutputID = outRuntimes.first(where: { !$0.speaker.isSub })?.speaker.id
                ?? outRuntimes.first?.speaker.id
        }

        isRunning = true
        if test {
            statusText = "тест"
        } else if failedOutputs.isEmpty {
            statusText = "играет"
        } else {
            statusText = "играет (не открылись: \(failedOutputs.count))"
        }
    }

    func stop() {
        for rt in outRuntimes { rt.engine.stop() }
        for rt in srcRuntimes {
            rt.engine.inputNode.removeTap(onBus: 0)
            rt.engine.stop()
        }
        outRuntimes.removeAll()
        srcRuntimes.removeAll()
        systemTap.teardown()   // release the system-audio tap + its private aggregate device
        isRunning = false
        statusText = "остановлено"
    }

    /// For the single-speaker test button: only `target` should sound.
    func setSoloTest(target: OutputSpeaker) {
        for rt in outRuntimes { rt.state.testOn = (rt.speaker === target) }
    }

    // MARK: Live parameter application

    func applyDelays() {
        for rt in outRuntimes {
            rt.delay.delayTime = max(0, rt.speaker.delayMs) / 1000.0
        }
    }

    func applyEQToAll() {
        for rt in outRuntimes { configureEQ(rt) }
    }

    func setCalibrationBypass(_ on: Bool) {
        calibrationBypass = on
        for rt in outRuntimes { configureEQ(rt) }
    }

    private func configureEQ(_ rt: OutputRuntime) {
        let bands = rt.eq.bands
        let n = Audio.eqFreqs.count
        let sub = rt.speaker.isSub

        // 12 parametric EQ bands
        for i in 0..<n {
            let b = bands[i]
            b.filterType = .parametric
            b.frequency = Audio.eqFreqs[i]
            b.bandwidth = qToOctaves(Audio.eqQ)
            b.gain = Float(effects.eqGains[i])
            b.bypass = calibrationBypass || sub || !effects.eqOn
        }
        // bass low-shelf
        let bassBand = bands[n]
        bassBand.filterType = .lowShelf
        bassBand.frequency = Audio.bassFreq
        bassBand.gain = Float(effects.bass)
        bassBand.bypass = calibrationBypass || sub || !(effects.bassOn && effects.bass > 0)
        // subwoofer crossover low-pass
        let lp = bands[n + 1]
        lp.filterType = .lowPass
        lp.frequency = Float(max(40, min(rt.speaker.xover, Audio.sampleRate / 2 - 1)))
        lp.bypass = calibrationBypass || !sub
    }

    private func qToOctaves(_ q: Float) -> Float {
        // BW(octaves) from Q for a peaking filter
        let x = 1.0 + 1.0 / (2.0 * q * q)
        return Float((1.0 / log(2.0)) * asinh(Double(sqrt(x * x - 1.0)))) * 2.0
    }

    // MARK: Spectrum feed (UI reads via latestSpectrumSamples)

    private func feedSpectrum(_ samples: UnsafePointer<Float>, _ count: Int) {
        os_unfair_lock_lock(&specLock)
        for i in 0..<count {
            specBuffer[specWrite] = samples[i]
            specWrite = (specWrite + 1) % specBuffer.count
        }
        os_unfair_lock_unlock(&specLock)
    }

    func latestSpectrumSamples() -> [Float] {
        os_unfair_lock_lock(&specLock)
        let n = specBuffer.count
        var out = [Float](repeating: 0, count: n)
        for i in 0..<n { out[i] = specBuffer[(specWrite + i) % n] }
        os_unfair_lock_unlock(&specLock)
        return out
    }

    // MARK: Calibration support (driven by Calibrator)

    /// Plays the chirp through one output; returns when finished (blocking small wait done by caller).
    func playChirp(on output: OutputRuntime, samples: [Float]) {
        output.state.chirp = samples
        output.state.chirpIndex = 0
        output.state.chirpPlaying = true
    }

    func isChirpFinished(_ output: OutputRuntime) -> Bool { !output.state.chirpPlaying }

    // MARK: Device assignment

    private func setDevice(_ deviceID: AudioDeviceID, on node: AVAudioIONode) throws {
        guard let unit = node.audioUnit else {
            throw NSError(domain: "PartyEngine", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "No audio unit for node"])
        }
        var dev = deviceID
        let status = AudioUnitSetProperty(unit,
                                          kAudioOutputUnitProperty_CurrentDevice,
                                          kAudioUnitScope_Global, 0,
                                          &dev, UInt32(MemoryLayout<AudioDeviceID>.size))
        if status != noErr {
            throw NSError(domain: "PartyEngine", code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey: "Cannot set device \(deviceID) (err \(status))"])
        }
    }

    // MARK: Capture setup

    private func setupCapture(_ rt: SourceRuntime, deviceID: AudioDeviceID) throws {
        let input = rt.engine.inputNode
        try setDevice(deviceID, on: input)
        let inFmt = input.inputFormat(forBus: 0)
        guard inFmt.sampleRate > 0 else {
            throw NSError(domain: "PartyEngine", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Источник не отдаёт звук (sampleRate=0)"])
        }
        rt.converter = AVAudioConverter(from: inFmt, to: rt.canonical)

        let rings = rt.rings
        let config = rt.config
        let canonical = rt.canonical
        guard let converter = rt.converter else { return }

        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(Audio.block), format: inFmt) { [weak self] buf, _ in
            guard self != nil else { return }
            let outCap = AVAudioFrameCount(Double(buf.frameLength) * canonical.sampleRate / inFmt.sampleRate) + 16
            guard let outBuf = AVAudioPCMBuffer(pcmFormat: canonical, frameCapacity: outCap) else { return }
            var fed = false
            var err: NSError?
            converter.convert(to: outBuf, error: &err) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true
                status.pointee = .haveData
                return buf
            }
            let frames = Int(outBuf.frameLength)
            guard frames > 0, let ch = outBuf.floatChannelData else { return }
            let l = ch[0]
            let r = outBuf.format.channelCount > 1 ? ch[1] : ch[0]
            // peaks
            var pl: Float = 0, pr: Float = 0
            vDSP_maxmgv(l, 1, &pl, vDSP_Length(frames))
            vDSP_maxmgv(r, 1, &pr, vDSP_Length(frames))
            config.peakL = pl; config.peakR = pr
            for (_, ring) in rings { ring.push(l: l, r: r, count: frames) }
        }
    }

    // MARK: Output setup

    private func setupOutput(_ rt: OutputRuntime, deviceID: AudioDeviceID) throws {
        let engine = rt.engine
        try setDevice(deviceID, on: engine.outputNode)

        let mono = AVAudioFormat(standardFormatWithSampleRate: Audio.sampleRate, channels: 1)!

        rt.delay.wetDryMix = 100
        rt.delay.feedback = 0
        rt.delay.lowPassCutoff = 20000

        // capture for render closure
        let speaker = rt.speaker
        let state = rt.state
        let effects = self.effects
        let srcPairs: [(StereoRing, SourceConfig)] = srcRuntimes.compactMap { sr in
            guard let ring = sr.rings[speaker.id] else { return nil }
            return (ring, sr.config)
        }
        let sr = Audio.sampleRate

        var scratchL = [Float](repeating: 0, count: 8192)
        var scratchR = [Float](repeating: 0, count: 8192)

        let node = AVAudioSourceNode(format: mono) { [weak self] _, _, frameCount, ablPtr in
            let frames = Int(frameCount)
            let abl = UnsafeMutableAudioBufferListPointer(ablPtr)
            guard let outPtr = abl[0].mData?.assumingMemoryBound(to: Float.self) else { return noErr }

            if scratchL.count < frames {
                scratchL = [Float](repeating: 0, count: frames)
                scratchR = [Float](repeating: 0, count: frames)
            }

            // 1) calibration chirp takes over
            if state.chirpPlaying, let chirp = state.chirp {
                for i in 0..<frames {
                    let idx = state.chirpIndex + i
                    outPtr[i] = idx < chirp.count ? chirp[idx] : 0
                }
                state.chirpIndex += frames
                if state.chirpIndex >= chirp.count { state.chirpPlaying = false }
                return noErr
            }

            // 2) test tone
            if self?.testMode == true {
                if state.testOn {
                    for i in 0..<frames {
                        let t = (state.tonePhase + Double(i)) / sr
                        outPtr[i] = Float(0.2 * sin(2 * Double.pi * state.toneHz * t))
                    }
                    state.tonePhase += Double(frames)
                } else {
                    for i in 0..<frames { outPtr[i] = 0 }
                }
                self?.applyGainAndMeter(outPtr, frames, speaker)
                return noErr
            }

            // 3) normal mix: sum sources → sumL/sumR
            scratchL.withUnsafeMutableBufferPointer { sumLBuf in
                scratchR.withUnsafeMutableBufferPointer { sumRBuf in
                    let sumL = sumLBuf.baseAddress!
                    let sumR = sumRBuf.baseAddress!
                    for i in 0..<frames { sumL[i] = 0; sumR[i] = 0 }

                    var tmpL = [Float](repeating: 0, count: frames)
                    var tmpR = [Float](repeating: 0, count: frames)
                    tmpL.withUnsafeMutableBufferPointer { tlb in
                        tmpR.withUnsafeMutableBufferPointer { trb in
                            let tl = tlb.baseAddress!, tr = trb.baseAddress!
                            for (ring, src) in srcPairs {
                                ring.pull(into: tl, tr, count: frames)
                                if src.mute { continue }
                                let v = src.volume
                                let bal = src.balance
                                let lg = (bal <= 0 ? 1.0 : 1.0 - bal) * v
                                let rg = (bal >= 0 ? 1.0 : 1.0 + bal) * v
                                let rsign: Float = src.invertPhase ? -1 : 1
                                for i in 0..<frames {
                                    sumL[i] += tl[i] * lg
                                    sumR[i] += tr[i] * rsign * rg
                                }
                            }
                        }
                    }

                    applySpatial(state: state, effects: effects, sumL: sumL, sumR: sumR, frames: frames, sr: sr)

                    // collapse to mono by speaker balance
                    let b = speaker.balance
                    let gl = 0.5 - b * 0.5
                    let gr = 0.5 + b * 0.5
                    for i in 0..<frames { outPtr[i] = sumL[i] * gl + sumR[i] * gr }
                }
            }

            self?.applyGainAndMeter(outPtr, frames, speaker)
            if speaker.id == self?.specOutputID { self?.feedSpectrum(outPtr, frames) }
            return noErr
        }

        rt.sourceNode = node
        engine.attach(node)
        engine.attach(rt.eq)
        engine.attach(rt.delay)
        engine.connect(node, to: rt.eq, format: mono)
        engine.connect(rt.eq, to: rt.delay, format: mono)
        engine.connect(rt.delay, to: engine.mainMixerNode, format: mono)
    }

    private func applyGainAndMeter(_ ptr: UnsafeMutablePointer<Float>, _ frames: Int, _ speaker: OutputSpeaker) {
        var g = speaker.volume * masterGain
        vDSP_vsmul(ptr, 1, &g, ptr, 1, vDSP_Length(frames))
        var peak: Float = 0
        vDSP_maxmgv(ptr, 1, &peak, vDSP_Length(frames))
        speaker.peak = peak
    }
}

// MARK: - Spatial DSP (free function so it can be called from the render closure)

private func applySpatial(state: RenderState, effects: EffectState,
                          sumL: UnsafeMutablePointer<Float>, sumR: UnsafeMutablePointer<Float>,
                          frames: Int, sr: Double) {
    guard effects.spatialOn || effects.threeDOn || effects.surroundOn else { return }
    let maxD = state.maxDelay

    var extL = state.histL
    var extR = state.histR
    extL.append(contentsOf: UnsafeBufferPointer(start: sumL, count: frames))
    extR.append(contentsOf: UnsafeBufferPointer(start: sumR, count: frames))

    func tap(_ ext: [Float], _ ms: Double) -> ([Float]) {
        let dly = Int(sr * ms / 1000.0)
        let start = maxD - dly
        var out = [Float](repeating: 0, count: frames)
        for i in 0..<frames {
            let idx = start + i
            if idx >= 0 && idx < ext.count { out[i] = ext[idx] }
        }
        return out
    }

    if effects.spatialOn && effects.spatialWidth != 1.0 {
        let w = effects.spatialWidth
        for i in 0..<frames {
            let mid = (sumL[i] + sumR[i]) * 0.5
            let side = (sumL[i] - sumR[i]) * 0.5 * w
            sumL[i] = mid + side
            sumR[i] = mid - side
        }
    }
    if effects.threeDOn && effects.threeD > 0 {
        let a = effects.threeD
        let dR = tap(extR, 12.0)
        let dL = tap(extL, 12.0)
        for i in 0..<frames {
            sumL[i] += a * 0.6 * dR[i]
            sumR[i] += a * 0.6 * dL[i]
        }
    }
    if effects.surroundOn && effects.surround > 0 {
        let a = effects.surround
        var mext = [Float](repeating: 0, count: extL.count)
        for i in 0..<extL.count { mext[i] = (extL[i] + extR[i]) * 0.5 }
        let l1 = tap(mext, 19), l2 = tap(mext, 29), l3 = tap(mext, 41), l4 = tap(mext, 57)
        let r1 = tap(mext, 23), r2 = tap(mext, 33), r3 = tap(mext, 47), r4 = tap(mext, 61)
        for i in 0..<frames {
            sumL[i] += a * (0.45 * l1[i] + 0.35 * l2[i] + 0.28 * l3[i] + 0.22 * l4[i])
            sumR[i] += a * (0.45 * r1[i] + 0.33 * r2[i] + 0.26 * r3[i] + 0.20 * r4[i])
        }
    }

    // save tail history
    let tail = extL.count - maxD
    if tail >= 0 {
        state.histL = Array(extL[tail...])
        state.histR = Array(extR[tail...])
    }
}
