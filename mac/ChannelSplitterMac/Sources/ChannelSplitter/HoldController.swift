import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox
import Accelerate

/// HOLD — онлайн-удержание баланса (синхронизации) колонок по микрофону.
/// Порт из Windows-версии (`splitter_app._hold_worker`): пока играет музыка, функция
/// кросс-коррелирует ЖИВОЙ программный звук (его движок пишет в `OutputRuntime.calCap`)
/// с выбранным микрофоном и держит относительное время прихода двух первых не-саб
/// колонок равным базовому значению, зафиксированному в момент нажатия HOLD —
/// компенсируя дрейф задержки Bluetooth без прерывания воспроизведения.
final class HoldController {
    private let engine: PartyEngine
    private let micEngine = AVAudioEngine()
    private var converter: AVAudioConverter?

    // Микрофон, ресэмплированный в Audio.sampleRate (моно), кольцевой буфер ~3 с.
    private let micCap = Int(Audio.sampleRate * 3)
    private var micRing: [Float]
    private var micW = 0
    private var micLock = os_unfair_lock_s()

    private var stopFlag = false
    private(set) var active = false

    init(engine: PartyEngine) {
        self.engine = engine
        micRing = [Float](repeating: 0, count: micCap)
    }

    /// Запускает удержание по микрофону `micDeviceID`. Идемпотентно.
    func start(micDeviceID: AudioDeviceID) {
        stop()
        stopFlag = false
        guard startMic(deviceID: micDeviceID) else { return }
        engine.calCapture = true
        active = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in self?.worker() }
    }

    func stop() {
        stopFlag = true
        if active {
            micEngine.inputNode.removeTap(onBus: 0)
            micEngine.stop()
        }
        engine.calCapture = false
        active = false
    }

    // MARK: - Микрофон (ресэмпл в SR, моно) → кольцевой буфер

    private func startMic(deviceID: AudioDeviceID) -> Bool {
        let input = micEngine.inputNode
        var dev = deviceID
        if let unit = input.audioUnit {
            AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                 kAudioUnitScope_Global, 0, &dev,
                                 UInt32(MemoryLayout<AudioDeviceID>.size))
        }
        let inFmt = input.inputFormat(forBus: 0)
        guard inFmt.sampleRate > 0 else { return false }
        let canonical = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                      sampleRate: Audio.sampleRate, channels: 1, interleaved: false)!
        converter = AVAudioConverter(from: inFmt, to: canonical)
        guard let converter else { return false }

        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(Audio.block), format: inFmt) { [weak self] buf, _ in
            guard let self else { return }
            let cap = AVAudioFrameCount(Double(buf.frameLength) * canonical.sampleRate / inFmt.sampleRate) + 16
            guard let outBuf = AVAudioPCMBuffer(pcmFormat: canonical, frameCapacity: cap) else { return }
            var fed = false
            var err: NSError?
            converter.convert(to: outBuf, error: &err) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true; status.pointee = .haveData; return buf
            }
            if let ch = outBuf.floatChannelData, outBuf.frameLength > 0 {
                self.writeMic(ch[0], Int(outBuf.frameLength))
            }
        }
        micEngine.prepare()
        do { try micEngine.start() } catch { return false }
        return true
    }

    private func writeMic(_ p: UnsafePointer<Float>, _ n: Int) {
        os_unfair_lock_lock(&micLock); defer { os_unfair_lock_unlock(&micLock) }
        micRing.withUnsafeMutableBufferPointer { rb in
            let r = rb.baseAddress!
            if n >= micCap {
                for i in 0..<micCap { r[i] = p[n - micCap + i] }
                micW = 0
            } else {
                var idx = micW
                for i in 0..<n { r[idx] = p[i]; idx += 1; if idx == micCap { idx = 0 } }
                micW = idx
            }
        }
    }

    private func micSnapshot() -> [Float] {
        os_unfair_lock_lock(&micLock); let w = micW; let r = micRing; os_unfair_lock_unlock(&micLock)
        return Array(r[w...]) + Array(r[..<w])
    }

    // MARK: - Цикл удержания

    private func worker() {
        let outs = engine.outRuntimes.filter { !$0.speaker.isSub }
        guard outs.count >= 2 else { DispatchQueue.main.async { self.stop() }; return }
        let a = outs[0], b = outs[1]
        let baseDA = a.speaker.delayMs, baseDB = b.speaker.delayMs   // базовые задержки на момент HOLD
        let SR = Audio.sampleRate
        let WINs = Int(0.9 * SR)
        let maxLag = Int(SR)               // искать сдвиг до 1 с
        var base: Double? = nil            // зафиксированное относительное время прихода

        while !stopFlag && engine.isRunning {
            Thread.sleep(forTimeInterval: 2.0)
            if stopFlag || !engine.isRunning { break }

            let micAll = micSnapshot()
            let sa = engine.calSnapshot(a)
            let sb = engine.calSnapshot(b)
            guard micAll.count >= WINs, sa.count >= WINs, sb.count >= WINs else { continue }
            let mic = Array(micAll.suffix(WINs))
            let saW = Array(sa.suffix(WINs))
            let sbW = Array(sb.suffix(WINs))

            let (t0, r0) = CalibrationDSP.bestLagRatio(reference: mic, signal: saW, maxLagSamples: maxLag)
            let (t1, r1) = CalibrationDSP.bestLagRatio(reference: mic, signal: sbW, maxLagSamples: maxLag)
            if r0 < 3.0 || r1 < 3.0 { continue }   // ненадёжно (моно-контент / тишина) — пропускаем

            let rel = Double(t1 - t0) / SR * 1000.0
            if base == nil { base = rel; continue }
            let drift = rel - base!
            let net = (baseDB - baseDA) - drift
            DispatchQueue.main.async {
                if net >= 0 {
                    a.speaker.delayMs = 0
                    b.speaker.delayMs = min(300.0, net)
                } else {
                    a.speaker.delayMs = min(300.0, -net)
                    b.speaker.delayMs = 0
                }
                self.engine.applyDelays()
            }
        }
        DispatchQueue.main.async { [weak self] in self?.engine.calCapture = false }
    }
}
