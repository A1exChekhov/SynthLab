import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox
import Accelerate

private final class MicRecorder {
    private var samples: [Float] = []
    private var lock = os_unfair_lock_s()

    func reset() {
        os_unfair_lock_lock(&lock); samples.removeAll(keepingCapacity: true); os_unfair_lock_unlock(&lock)
    }
    func append(_ ptr: UnsafePointer<Float>, _ count: Int) {
        os_unfair_lock_lock(&lock)
        samples.append(contentsOf: UnsafeBufferPointer(start: ptr, count: count))
        os_unfair_lock_unlock(&lock)
    }
    func snapshot() -> [Float] {
        os_unfair_lock_lock(&lock); let s = samples; os_unfair_lock_unlock(&lock); return s
    }
}

final class Calibrator {
    private let engine: PartyEngine
    private let micEngine = AVAudioEngine()
    private let recorder = MicRecorder()
    private var converter: AVAudioConverter?

    init(engine: PartyEngine) { self.engine = engine }

    enum CalibError: LocalizedError {
        case notRunning, noMic, noOutputs
        var errorDescription: String? {
            switch self {
            case .notRunning: return "Сначала включи воспроизведение (ON)."
            case .noMic: return "Не найден микрофон для калибровки."
            case .noOutputs: return "Нет активных колонок."
            }
        }
    }

    /// Runs the full sweep on a background queue. `progress` and `done` are called on main.
    /// `micDeviceID` — выбранный пользователем микрофон (nil → встроенный).
    func calibrate(durationSec: Double = 1.5,
                   micDeviceID: AudioDeviceID? = nil,
                   progress: @escaping (String) -> Void,
                   done: @escaping (Result<Void, Error>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try self.run(durationSec: durationSec, micDeviceID: micDeviceID, progress: progress)
                DispatchQueue.main.async { done(.success(())) }
            } catch {
                DispatchQueue.main.async { done(.failure(error)) }
            }
        }
    }

    private func run(durationSec: Double, micDeviceID: AudioDeviceID?, progress: @escaping (String) -> Void) throws {
        guard engine.isRunning else { throw CalibError.notRunning }
        let outputs = engine.outRuntimes
        guard !outputs.isEmpty else { throw CalibError.noOutputs }
        guard let micID = micDeviceID ?? AudioDevices.builtInInput()?.deviceID else { throw CalibError.noMic }

        engine.setCalibrationBypass(true)
        defer { engine.setCalibrationBypass(false) }

        try startMic(deviceID: micID)
        defer { micEngine.inputNode.removeTap(onBus: 0); micEngine.stop() }

        // Each speaker gets its OWN log-frequency band so the cross-correlation
        // for one speaker is not confused by another speaker's sweep (ported from v1.1).
        let m = outputs.count
        let loF = 150.0, hiF = 7000.0
        func edge(_ j: Int) -> Double { loF * pow(hiF / loF, Double(j) / Double(max(1, m))) }

        var taus: [Int] = []

        for (i, out) in outputs.enumerated() {
            let f0 = edge(i)
            let f1 = max(edge(i + 1), f0 * 2.0)
            let chirp = CalibrationDSP.logChirp(durationSec: durationSec, f0: f0, f1: f1)
            DispatchQueue.main.async {
                progress("Калибровка \(i + 1)/\(outputs.count): \(out.speaker.device?.name ?? "") (\(Int(f0))–\(Int(f1)) Гц)")
            }
            recorder.reset()
            Thread.sleep(forTimeInterval: 0.15)
            engine.playChirp(on: out, samples: chirp)

            let deadline = Date().addingTimeInterval(durationSec + 0.6)
            while Date() < deadline && !engine.isChirpFinished(out) {
                Thread.sleep(forTimeInterval: 0.02)
            }
            Thread.sleep(forTimeInterval: 0.3) // capture the tail (room + speaker latency)

            let recorded = recorder.snapshot()
            let lag = CalibrationDSP.bestLag(reference: chirp, signal: recorded)
            taus.append(lag)
        }

        guard let tauMax = taus.max() else { return }
        for (i, out) in outputs.enumerated() {
            let deltaSamples = tauMax - taus[i]
            let ms = Double(deltaSamples) / Audio.sampleRate * 1000.0
            DispatchQueue.main.async {
                out.speaker.measuredDelayMs = Double(taus[i]) / Audio.sampleRate * 1000.0
                out.speaker.delayMs = max(0, ms)
            }
        }
        DispatchQueue.main.async { self.engine.applyDelays() }
    }

    private func startMic(deviceID: AudioDeviceID) throws {
        let input = micEngine.inputNode
        var dev = deviceID
        if let unit = input.audioUnit {
            AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                 kAudioUnitScope_Global, 0, &dev,
                                 UInt32(MemoryLayout<AudioDeviceID>.size))
        }
        let inFmt = input.inputFormat(forBus: 0)
        guard inFmt.sampleRate > 0 else { throw CalibError.noMic }
        let canonical = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                      sampleRate: Audio.sampleRate, channels: 1, interleaved: false)!
        converter = AVAudioConverter(from: inFmt, to: canonical)
        guard let converter = converter else { throw CalibError.noMic }
        let recorder = self.recorder

        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(Audio.block), format: inFmt) { buf, _ in
            let cap = AVAudioFrameCount(Double(buf.frameLength) * canonical.sampleRate / inFmt.sampleRate) + 16
            guard let outBuf = AVAudioPCMBuffer(pcmFormat: canonical, frameCapacity: cap) else { return }
            var fed = false
            var err: NSError?
            converter.convert(to: outBuf, error: &err) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true; status.pointee = .haveData; return buf
            }
            if let ch = outBuf.floatChannelData, outBuf.frameLength > 0 {
                recorder.append(ch[0], Int(outBuf.frameLength))
            }
        }
        micEngine.prepare()
        try micEngine.start()
    }
}
