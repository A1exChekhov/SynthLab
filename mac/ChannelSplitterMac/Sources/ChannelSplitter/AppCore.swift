import Foundation
import AppKit

/// Web-bridge backend: mirrors the Python `AppCore` js_api over the existing engine.
/// Each method name matches `splitter_app.py` and the calls made by `app_web/app.js`.
extension AppModel {

    // MARK: - Arg coercion

    private func aInt(_ a: [Any], _ i: Int) -> Int? {
        guard i < a.count else { return nil }
        if let n = a[i] as? NSNumber { return n.intValue }
        if let s = a[i] as? String { return Int(s) }
        return nil
    }
    private func aDouble(_ a: [Any], _ i: Int) -> Double? {
        guard i < a.count else { return nil }
        if let n = a[i] as? NSNumber { return n.doubleValue }
        if let s = a[i] as? String { return Double(s) }
        return nil
    }
    private func aBool(_ a: [Any], _ i: Int) -> Bool? {
        guard i < a.count else { return nil }
        if let n = a[i] as? NSNumber { return n.boolValue }
        if let b = a[i] as? Bool { return b }
        return nil
    }
    private func aStr(_ a: [Any], _ i: Int) -> String? {
        guard i < a.count else { return nil }
        return a[i] as? String
    }

    private func output(byId id: Int?) -> OutputSpeaker? { outputs.first { $0.intId == id } }
    private func source(byId id: Int?) -> SourceConfig? { sources.first { $0.intId == id } }
    private func outDevice(label: String?) -> AudioDeviceInfo? {
        guard let label else { return nil }
        return outDevices.first { $0.name == label }
    }
    private func inDevice(label: String?) -> AudioDeviceInfo? {
        guard let label else { return nil }
        return inDevices.first { $0.name == label }
    }

    // MARK: - Dispatch

    func handleBridge(method: String, args: [Any], resolve: @escaping (Any?) -> Void) {
        switch method {

        // ---- state / meters ----
        case "get_state": resolve(getState())
        case "meters":    resolve(metersState())

        // ---- window / app / misc ----
        case "resize_window":
            if let w = aDouble(args, 0), let h = aDouble(args, 1) {
                bridge?.resizeWindow(width: CGFloat(w), height: CGFloat(h))
            }
            resolve(nil)
        case "open_url":
            if let s = aStr(args, 0), let url = URL(string: s) { NSWorkspace.shared.open(url) }
            resolve(nil)
        case "quit_app": NSApp.terminate(nil); resolve(nil)
        case "save_settings": saveSettings(); resolve(nil)
        case "show_main", "hide_main", "show_mini", "hide_mini", "toggle_mini",
             "open_viz", "media_playpause", "media_next", "media_prev", "media_stop":
            resolve(nil) // stubs (mini-player / GPU viz / media keys — future phases)

        case "set_ui":
            if let k = aStr(args, 0) { uiState[k] = args.count > 1 ? args[1] : NSNull() ; saveSettings() }
            resolve(nil)
        case "set_viz":
            if let k = aStr(args, 0) { vizState[k] = args.count > 1 ? args[1] : NSNull(); saveSettings() }
            resolve(nil)

        // ---- devices ----
        case "refresh_devices": refreshDevices(); resolve(nil)

        // ---- outputs ----
        case "add_output": addOutput(); resolve(nil)
        case "remove_output":
            if let o = output(byId: aInt(args, 0)) { removeOutput(o) }
            resolve(nil)
        case "set_output":
            setOutput(id: aInt(args, 0), field: aStr(args, 1), value: args.count > 2 ? args[2] : nil)
            resolve(nil)
        case "test_output":
            if let o = output(byId: aInt(args, 0)) { testOutput(o) }
            resolve(nil)

        // ---- sources ----
        case "add_source": addSource(systemAudio: false); resolve(nil)
        case "add_loopback": addSource(systemAudio: true); resolve(nil)
        case "remove_source":
            if let s = source(byId: aInt(args, 0)) { removeSource(s) }
            resolve(nil)
        case "set_source":
            setSource(id: aInt(args, 0), field: aStr(args, 1), value: args.count > 2 ? args[2] : nil)
            resolve(nil)

        // ---- transport ----
        case "toggle": toggleRun(); resolve(nil)
        case "set_master":
            if let v = aDouble(args, 0) { masterPercent = v * 100; applyMaster() }
            resolve(nil)

        // ---- EQ ----
        case "set_eq":
            if let i = aInt(args, 0), let g = aDouble(args, 1), i >= 0, i < effects.eqGains.count {
                effects.eqGains[i] = g; applyEQ()
            }
            resolve(nil)
        case "set_eq_on":
            if let on = aBool(args, 0) { effects.eqOn = on; applyEQ() }
            resolve(nil)
        case "eq_reset":
            effects.eqGains = Array(repeating: 0, count: effects.eqGains.count); applyEQ()
            resolve(nil)
        case "eq_presets":
            resolve(eqPresets.keys.sorted())
        case "eq_save":
            if let n = aStr(args, 0) { eqPresets[n] = effects.eqGains; saveSettings() }
            resolve(nil)
        case "eq_apply":
            if let n = aStr(args, 0), let g = eqPresets[n] {
                for i in 0..<min(g.count, effects.eqGains.count) { effects.eqGains[i] = g[i] }
                applyEQ()
            }
            resolve(nil)
        case "eq_delete":
            if let n = aStr(args, 0) { eqPresets.removeValue(forKey: n); saveSettings() }
            resolve(nil)

        // ---- effects ----
        case "set_fx":
            if let k = aStr(args, 0) { setFX(key: k, value: args.count > 1 ? args[1] : nil) }
            resolve(nil)

        // ---- calibration / hold ----
        case "hold_toggle":
            holdOn.toggle()
            if let mic = aStr(args, 0), !mic.isEmpty { uiState["hold_mic"] = mic; saveSettings() }
            resolve(holdOn)
        case "calibrate":
            runCalibrate(mic: aStr(args, 0), resolve: resolve)

        default:
            resolve(nil)
        }
    }

    // MARK: - Field setters

    private func setOutput(id: Int?, field: String?, value: Any?) {
        guard let o = output(byId: id), let field, let value else { return }
        switch field {
        case "device": o.device = outDevice(label: value as? String); deviceChanged()
        case "role":   if let r = value as? String { o.roleKey = r }; reapply()
        case "vol":    if let v = (value as? NSNumber)?.doubleValue { o.volumePercent = v * 100; applyMaster() }
        case "mute":   if let b = (value as? NSNumber)?.boolValue { o.mute = b }
        case "sub":    if let b = (value as? NSNumber)?.boolValue { o.isSub = b; reapply() }
        case "inv":    if let b = (value as? NSNumber)?.boolValue { o.inv = b }
        case "delay":  if let v = (value as? NSNumber)?.doubleValue { o.delayMs = v; applyDelays() }
        case "xover":  if let v = (value as? NSNumber)?.doubleValue { o.xover = v; reapply() }
        default: break
        }
    }

    private func setSource(id: Int?, field: String?, value: Any?) {
        guard let s = source(byId: id), let field, let value else { return }
        switch field {
        case "device":  s.device = inDevice(label: value as? String); deviceChanged()
        case "lb_name": if let v = value as? String { s.lbName = v; reapply() }
        case "vol":     if let v = (value as? NSNumber)?.doubleValue { s.volumePercent = v * 100 }
        case "bal":     if let v = (value as? NSNumber)?.doubleValue { s.balancePercent = v * 100 }
        case "mute":    if let b = (value as? NSNumber)?.boolValue { s.mute = b }
        case "inv":     if let b = (value as? NSNumber)?.boolValue { s.invertPhase = b }
        default: break
        }
    }

    private func setFX(key: String, value: Any?) {
        let num = (value as? NSNumber)?.doubleValue
        let boo = (value as? NSNumber)?.boolValue
        switch key {
        case "spatial_on":  if let b = boo { effects.spatialOn = b }
        case "spatial":     if let v = num { effects.spatialPercent = v * 50 }
        case "threeD_on":   if let b = boo { effects.threeDOn = b }
        case "threeD":      if let v = num { effects.threeDPercent = v * 100 }
        case "surround_on": if let b = boo { effects.surroundOn = b }
        case "surround":    if let v = num { effects.surroundPercent = v * 100 }
        case "bass_on":     if let b = boo { effects.bassOn = b; applyEQ() }
        case "bass":        if let v = num { effects.bass = v; applyEQ() }
        default:
            if effects.extraBool[key] != nil, let b = boo { effects.extraBool[key] = b }
            else if let v = num { effects.extraNum[key] = v }
        }
    }

    // MARK: - Calibration

    private func runCalibrate(mic: String?, resolve: @escaping (Any?) -> Void) {
        guard engine.isRunning, !calibrating else {
            resolve(["msg": "Запустите воспроизведение перед калибровкой", "items": []])
            return
        }
        calibrating = true
        calibrator.calibrate(progress: { [weak self] msg in
            self?.engine.statusText = msg
        }, done: { [weak self] result in
            guard let self else { return }
            self.calibrating = false
            var msg = "Готово"
            if case .failure(let e) = result { msg = "Ошибка: \(e.localizedDescription)" }
            let items: [[String: Any]] = self.outputs.map { o in
                ["id": o.intId,
                 "name": o.device?.name ?? "Out \(o.intId)",
                 "delay": Int(o.delayMs.rounded())]
            }
            resolve(["msg": msg, "items": items])
        })
    }

    // MARK: - State JSON

    func getState() -> [String: Any] {
        let outDevs = outDevices.enumerated().map { ["idx": $0.offset, "label": $0.element.name] }
        let inDevs  = inDevices.enumerated().map { ["idx": $0.offset, "label": $0.element.name] }

        let outs: [[String: Any]] = outputs.map { o in
            ["id": o.intId,
             "device": o.device?.name ?? "",
             "role": o.roleKey,
             "vol": o.volumePercent / 100.0,
             "mute": o.mute,
             "sub": o.isSub,
             "xover": o.xover,
             "delay": Int(o.delayMs.rounded()),
             "inv": o.inv]
        }
        let srcs: [[String: Any]] = sources.map { s in
            ["id": s.intId,
             "name": s.name,
             "loopback": s.loopback,
             "lb_name": s.lbName,
             "device": s.device?.name ?? "",
             "vol": s.volumePercent / 100.0,
             "bal": s.balancePercent / 100.0,
             "mute": s.mute,
             "inv": s.invertPhase]
        }

        return [
            "out_devices": outDevs,
            "in_devices": inDevs,
            "lb_speakers": [String](),
            "mic_devices": inDevs,
            "gpu": false,
            "loopback": SystemAudioTap.isSupported
                || AudioDevices.defaultMatching("BlackHole", wantOutput: false) != nil,
            "running": engine.isRunning,
            "master": masterPercent / 100.0,
            "outputs": outs,
            "sources": srcs,
            "eq": ["on": effects.eqOn, "gains": effects.eqGains],
            "fx": fxDict(),
            "viz": vizState,
            "ui": uiState,
            "hold": holdOn,
            "np": ["codec": "PCM", "rate": "48000", "bits": "32f", "ch": "2", "kbps": "—"],
        ]
    }

    private func fxDict() -> [String: Any] {
        func n(_ k: String) -> Double { effects.extraNum[k] ?? 0 }
        func b(_ k: String) -> Bool { effects.extraBool[k] ?? false }
        return [
            "spatial_on": effects.spatialOn,
            "spatial": effects.spatialPercent / 50.0,
            "threeD_on": effects.threeDOn,
            "threeD": effects.threeDPercent / 100.0,
            "surround_on": effects.surroundOn,
            "surround": effects.surroundPercent / 100.0,
            "bass_on": effects.bassOn,
            "bass": effects.bass,
            "monobass_on": b("monobass_on"),
            "monobass_hz": n("monobass_hz"),
            "pos_on": b("pos_on"),
            "pan": n("pan"),
            "distance": n("distance"),
            "tone_on": b("tone_on"),
            "tilt": n("tilt"),
            "drive": n("drive"),
            "reverb_on": b("reverb_on"),
            "reverb_size": n("reverb_size"),
            "reverb_mix": n("reverb_mix"),
            "comp_on": b("comp_on"),
            "comp_thresh": n("comp_thresh"),
        ]
    }

    func metersState() -> [String: Any] {
        var outs: [String: Double] = [:]
        for o in outputs { outs[String(o.intId)] = Double(o.peak) }
        var srcs: [String: [Double]] = [:]
        for s in sources { srcs[String(s.intId)] = [Double(s.peakL), Double(s.peakR)] }
        let spec = spectrum.map { Double(min(1.0, $0)) }
        return [
            "running": engine.isRunning,
            "outs": outs,
            "srcs": srcs,
            "spectrum": spec,
            "bands": spec,
            "level": 0.0,
            "beat": 0.0,
        ]
    }

    // MARK: - Persistence (settings.json in Application Support)

    private var settingsURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("ChannelSplitter", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("settings.json")
    }

    func loadSettings() {
        guard let data = try? Data(contentsOf: settingsURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let ui = obj["ui"] as? [String: Any] { uiState.merge(ui) { _, new in new } }
        if let viz = obj["viz"] as? [String: Any] { vizState.merge(viz) { _, new in new } }
        if let m = obj["master"] as? NSNumber { masterPercent = m.doubleValue * 100 }
        if let p = obj["eq_presets"] as? [String: [Double]] { eqPresets = p }
    }

    func saveSettings() {
        let obj: [String: Any] = [
            "ui": uiState,
            "viz": vizState,
            "master": masterPercent / 100.0,
            "eq_presets": eqPresets,
        ]
        guard JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]) else { return }
        try? data.write(to: settingsURL)
    }
}
