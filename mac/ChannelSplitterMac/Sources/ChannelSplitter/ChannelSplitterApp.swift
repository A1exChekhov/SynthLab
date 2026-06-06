import SwiftUI
import Combine

let kBrand = "Errarium™"
let kVersion = "2.1"
let kDeveloper = "Errarium"

struct AppAlert: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}

@main
struct ChannelSplitterApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup("CHANNEL SPLITTER") {
            WebRootView()
                .environmentObject(model)
                .frame(minWidth: 400, minHeight: 300)
        }
        // contentMinSize (not .contentSize): SwiftUI only enforces a minimum, so the
        // web UI's fitWindow()/resize_window can freely shrink the window to content
        // height when switching 1→2 columns (no leftover black strip at the bottom).
        .windowResizability(.contentMinSize)
    }
}

final class AppModel: ObservableObject {
    @Published var outputs: [OutputSpeaker] = []
    @Published var sources: [SourceConfig] = []
    @Published var outDevices: [AudioDeviceInfo] = []
    @Published var inDevices: [AudioDeviceInfo] = []
    @Published var masterPercent: Double = 100
    @Published var meterTick: Int = 0          // bumped by timer to refresh meters/spectrum
    @Published var spectrum: [Float] = Array(repeating: 0, count: Audio.eqFreqs.count)
    @Published var calibrating = false
    @Published var alert: AppAlert?

    let effects = EffectState()
    let engine = PartyEngine()
    private(set) lazy var calibrator = Calibrator(engine: engine)
    weak var bridge: Bridge?

    private var meterTimer: Timer?
    private var deviceTimer: Timer?
    private var deviceSig = ""
    private var warnedManySpeakers = false
    private var specDisplay = [Float](repeating: 0, count: Audio.eqFreqs.count)

    // Web-bridge persisted UI / presets / misc state (see AppCore.swift)
    var idSeq = 1
    var uiState: [String: Any] = ["theme": "dark", "cols": 2, "lang": "ru", "hold_mic": ""]
    var vizState: [String: Any] = ["color_mode": 0]
    var holdOn = false
    var eqPresets: [String: [Double]] = [:]
    func nextId() -> Int { defer { idSeq += 1 }; return idSeq }

    init() {
        engine.effects = effects
        refreshDevices()
        loadSettings()
        // defaults: one system-audio source + two speakers (Left / Right)
        let src = SourceConfig(); src.intId = nextId()
        src.loopback = true
        src.name = "System Audio"
        if SystemAudioTap.isSupported {
            src.device = nil   // captured natively via Core Audio tap
        } else {
            src.device = AudioDevices.defaultMatching("BlackHole", wantOutput: false) ?? inDevices.first
        }
        sources = [src]

        let left = OutputSpeaker(); left.intId = nextId(); left.role = .left
        left.device = AudioDevices.defaultMatching("Bob", wantOutput: true) ?? outDevices.first
        let right = OutputSpeaker(); right.intId = nextId(); right.role = .right
        right.device = AudioDevices.defaultMatching("JBL", wantOutput: true) ?? outDevices.first
        outputs = [left, right]

        startMeterTimer()
        startDevicePoll()
    }

    // MARK: Devices

    private func deviceSignature() -> String {
        outDevices.map { $0.name }.joined(separator: "|") + "##" +
        inDevices.map { $0.name }.joined(separator: "|")
    }

    func refreshDevices() {
        if engine.isRunning { engine.stop() }
        outDevices = AudioDevices.outputDevices()
        inDevices = AudioDevices.inputDevices()
        deviceSig = deviceSignature()
    }

    /// Detect hot-plugged (Bluetooth) devices without restarting — only while stopped
    /// and not calibrating, so we never disturb live or calibration streams.
    private func startDevicePoll() {
        deviceSig = deviceSignature()
        deviceTimer = Timer.scheduledTimer(withTimeInterval: 4.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.engine.isRunning || self.calibrating { return }
            let outs = AudioDevices.outputDevices()
            let ins = AudioDevices.inputDevices()
            let sig = outs.map { $0.name }.joined(separator: "|") + "##" +
                      ins.map { $0.name }.joined(separator: "|")
            if sig != self.deviceSig {
                self.deviceSig = sig
                self.outDevices = outs
                self.inDevices = ins
                self.engine.statusText = "🔄 список устройств обновлён"
            }
        }
    }

    // MARK: Rows

    func addOutput(role: SpeakerRole = .left) {
        let o = OutputSpeaker(); o.intId = nextId(); o.role = role; o.device = outDevices.first
        outputs.append(o)
        if outputs.count >= 3 && !warnedManySpeakers {
            warnedManySpeakers = true
            alert = AppAlert(
                title: "Несколько колонок — важно",
                message:
                    "⚠️ Bluetooth: BT-чип Mac стабильно тянет МАКСИМУМ 2 BT-колонки одновременно. " +
                    "При 3+ звук начинает заикаться/хрипеть (перегруз радиоканала 2.4 ГГц) — буфер это не лечит.\n\n" +
                    "⚠️ Умные/сетевые колонки (Яндекс «Алиса», Sonos, HomePod и т.п.) могут отображаться в списке, " +
                    "но НЕ воспроизводить через macOS — они играют только через свой кастинг (AirPlay/cast).\n\n" +
                    "Совет: держи ≤2 Bluetooth; остальные подключай проводом/USB.")
        }
        reapply()
    }
    func removeOutput(_ o: OutputSpeaker) { outputs.removeAll { $0 === o }; reapply() }

    func addSource(systemAudio: Bool) {
        let s = SourceConfig(); s.intId = nextId()
        s.loopback = systemAudio
        s.name = systemAudio ? "System Audio" : ""
        if systemAudio {
            // Native Core Audio tap (14.2+) captures the whole system mix — no device needed.
            // Pre-14.2 fall back to a BlackHole-style input if present.
            s.device = SystemAudioTap.isSupported
                ? nil
                : AudioDevices.defaultMatching("BlackHole", wantOutput: false)
        } else {
            s.device = inDevices.first
        }
        sources.append(s)
        reapply()
    }
    func removeSource(_ s: SourceConfig) { sources.removeAll { $0 === s }; reapply() }

    /// Called when a row's device selection changes — re-route live.
    func deviceChanged() { reapply() }

    /// Restart the graph so output/source changes take effect while playing.
    func reapply() {
        guard engine.isRunning else { return }
        engine.stop()
        engine.masterGain = Float(masterPercent) / 100.0
        do {
            try engine.start(outputs: outputs, sources: sources, test: false)
            engine.applyEQToAll()
            engine.applyDelays()
            reportFailures()
        } catch {
            engine.statusText = "ошибка: \(error.localizedDescription)"
        }
    }

    private func reportFailures() {
        let failed = engine.failedOutputs
        guard !failed.isEmpty else { return }
        let names = failed.map { "• \($0.name): \($0.error)" }.joined(separator: "\n")
        alert = AppAlert(
            title: "Часть колонок не открылась",
            message: "Эти колонки не удалось открыть (остальные играют):\n\n" + names +
                     "\n\nЧасто помогает: переподключить устройство, или оно занято / не на 48 кГц.")
    }

    // MARK: Transport

    func toggleRun() {
        if engine.isRunning { engine.stop(); return }
        engine.masterGain = Float(masterPercent) / 100.0
        do {
            try engine.start(outputs: outputs, sources: sources, test: false)
            engine.applyEQToAll()
            engine.applyDelays()
            reportFailures()
        } catch {
            engine.statusText = "ошибка: \(error.localizedDescription)"
            alert = AppAlert(title: "Не удалось запустить", message: error.localizedDescription)
        }
    }

    private var testStopWork: DispatchWorkItem?
    func testOutput(_ target: OutputSpeaker) {
        engine.stop()
        engine.masterGain = Float(masterPercent) / 100.0
        do {
            try engine.start(outputs: outputs, sources: [], test: true)
            engine.setSoloTest(target: target)
        } catch {
            engine.statusText = "ошибка теста: \(error.localizedDescription)"
            return
        }
        testStopWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            if self?.engine.isRunning == true { self?.engine.stop() }
        }
        testStopWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8, execute: w)
    }

    // MARK: Live param changes

    func applyEQ() { engine.applyEQToAll() }
    func applyDelays() { engine.applyDelays() }
    func applyMaster() { engine.masterGain = Float(masterPercent) / 100.0 }

    // MARK: Calibration

    func calibrate() {
        guard engine.isRunning, !calibrating else { return }
        calibrating = true
        engine.statusText = "калибровка…"
        calibrator.calibrate(progress: { [weak self] msg in
            self?.engine.statusText = msg
        }, done: { [weak self] result in
            self?.calibrating = false
            switch result {
            case .success: self?.engine.statusText = "калибровка завершена"
            case .failure(let e): self?.engine.statusText = "калибровка: \(e.localizedDescription)"
            }
        })
    }

    // MARK: Meters / spectrum

    private func startMeterTimer() {
        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.engine.isRunning {
                let raw = self.engine.spectrumAnalyzer.bands(from: self.engine.latestSpectrumSamples())
                for i in 0..<self.specDisplay.count {
                    self.specDisplay[i] = max(raw[i], self.specDisplay[i] * 0.8)
                }
                self.spectrum = self.specDisplay
            }
            self.meterTick &+= 1
        }
    }
}
