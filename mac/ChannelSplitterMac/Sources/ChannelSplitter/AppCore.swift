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

        // ---- window / tray / mini player ----
        case "show_main":   AppChrome.shared?.showMain();   resolve(nil)
        case "toggle_main": AppChrome.shared?.toggleMain(); resolve(nil)
        case "hide_main":   AppChrome.shared?.hideMain();   resolve(nil)
        case "show_mini":   AppChrome.shared?.showMini();   resolve(nil)
        case "hide_mini":   AppChrome.shared?.hideMini();   resolve(nil)
        case "toggle_mini": AppChrome.shared?.toggleMini(); resolve(nil)
        case "mini_move":
            if let dx = aDouble(args, 0), let dy = aDouble(args, 1) {
                AppChrome.shared?.moveMini(CGFloat(dx), CGFloat(dy))
            }
            resolve(nil)

        // ---- visualizer (цветомузыка) ----
        case "open_viz":    AppChrome.shared?.openViz();    resolve(true)
        case "set_viz":
            if let k = aStr(args, 0) { vizState[k] = args.count > 1 ? args[1] : NSNull(); saveSettings() }
            resolve(nil)

        // ---- media transport: при активном радио управляем им (AVPlayer), иначе системным плеером ----
        case "media_playpause": resolve(engine.hasRadio ? engine.radioTogglePlayPause() : NowPlaying.shared.send(.togglePlayPause))
        case "media_next":      resolve(engine.hasRadio ? false : NowPlaying.shared.send(.next))
        case "media_prev":      resolve(engine.hasRadio ? false : NowPlaying.shared.send(.previous))
        // STOP = мягкий сброс: радио — стоп потока; приложение — пауза + перемотка текущей
        // песни в начало (трек/очередь НЕ сбрасываются, Play играет её с начала).
        case "media_stop":
            if engine.hasRadio { engine.radioStopReset() }
            else {
                // Сначала перемотка в начало (часть плееров не принимает seek на паузе), потом пауза.
                NowPlaying.shared.seek(0)
                NowPlaying.shared.send(.pause)
                NowPlaying.shared.seek(0)
            }
            resolve(false)
        case "now_playing_art":
            // Радио — обложка песни (из главного окна) или лого станции; иначе обложка
            // системного now-playing (data URL).
            if engine.hasRadio {
                let u = radioCoverURL.isEmpty ? radioFavicon : radioCoverURL
                resolve(u.isEmpty ? nil : u)
            } else { resolve(NowPlaying.shared.artworkDataURL()) }

        case "set_ui":
            if let k = aStr(args, 0) { uiState[k] = args.count > 1 ? args[1] : NSNull() ; saveSettings() }
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
        case "set_input":
            setInput(kind: aStr(args, 0), value: aStr(args, 1))
            resolve(nil)
        case "tuner_play":
            if let u = aStr(args, 0), !u.isEmpty {
                tunerPlay(url: u, name: aStr(args, 1) ?? "", favicon: aStr(args, 2) ?? "")
            }
            resolve(nil)
        case "set_radio_cover":
            radioCoverURL = aStr(args, 0) ?? ""
            resolve(nil)
        case "tuner_stop":
            tunerStop()
            resolve(nil)

        // ---- transport ----
        case "toggle": toggleRun(); resolve(nil)
        case "set_master":
            if let v = aDouble(args, 0) { masterPercent = v * 100; applyMaster(); scheduleSave() }
            resolve(nil)

        // ---- EQ ----
        case "set_eq":
            if let i = aInt(args, 0), let g = aDouble(args, 1), i >= 0, i < effects.eqGains.count {
                effects.eqGains[i] = g; applyEQ(); scheduleSave()
            }
            resolve(nil)
        case "set_eq_on":
            if let on = aBool(args, 0) { effects.eqOn = on; applyEQ(); scheduleSave() }
            resolve(nil)
        case "eq_reset":
            effects.eqGains = Array(repeating: 0, count: effects.eqGains.count); applyEQ(); scheduleSave()
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
            if let k = aStr(args, 0) { setFX(key: k, value: args.count > 1 ? args[1] : nil); scheduleSave() }
            resolve(nil)

        // ---- calibration / hold ----
        case "hold_toggle":
            resolve(toggleHold(micLabel: aStr(args, 0)))
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

    /// Кнопка Input: меняет ПЕРВЫЙ источник на выбранный — системный звук / приложение
    /// (per-app loopback) / входное устройство. Создаёт источник, если их нет.
    func setInput(kind: String?, value: String?) {
        let s: SourceConfig
        if let first = sources.first { s = first }
        else { let n = SourceConfig(); n.intId = nextId(); sources = [n]; s = n }
        s.radio = false; s.radioURL = ""   // выбор обычного источника всегда выключает радио
        switch kind {
        case "app":
            s.loopback = true; s.lbName = value ?? ""; s.device = nil; s.name = "System Audio"
            // Новый источник перехватывает: остальные скриптуемые плееры — на паузу.
            MediaControl.pauseOthers(exceptName: value ?? "")
        case "device":
            s.loopback = false; s.lbName = ""; s.device = inDevices.first { $0.name == value }; s.name = value ?? "Input"
            MediaControl.pauseOthers(exceptName: "")   // слушаем вход — медиаплееры на паузу
        default: // "system"
            s.loopback = true; s.lbName = ""; s.device = nil; s.name = "System Audio"
            // «Весь системный звук» — намеренно микшируем всё, не ставим на паузу.
        }
        sources = sources   // SourceConfig — класс: форсируем перерисовку строки
        // Выбор источника всегда начинает маршрутизацию: если сплиттер выключен — включаем его,
        // чтобы выбранный источник сразу «перехватил» звук (а не ждал ручного Power).
        if engine.isRunning { reapply() } else { toggleRun() }
        saveSettings()
    }

    /// Tuner: ставит первый источник в режим интернет-радио и перезапускает движок.
    func tunerPlay(url: String, name: String = "", favicon: String = "") {
        let s: SourceConfig
        if let first = sources.first { s = first }
        else { let n = SourceConfig(); n.intId = nextId(); sources = [n]; s = n }
        s.radio = true; s.radioURL = url; s.loopback = false; s.device = nil; s.lbName = ""; s.name = "Radio"
        radioStationName = name; radioFavicon = favicon; radioStartTime = Date()
        sources = sources
        // Если системный звук НЕ добавлен отдельным (вторым) источником для микса —
        // ставим системный плеер на паузу, чтобы радио не накладывалось на него.
        let mixSystem = sources.contains { $0 !== s && $0.loopback && !$0.radio }
        if !mixSystem {
            NowPlaying.shared.send(.pause)          // текущий now-playing
            MediaControl.pauseOthers(exceptName: "") // адресно: Apple Music / Spotify
        }
        if engine.isRunning { reapply() } else { toggleRun() }   // включаем воспроизведение, если ещё не идёт
    }

    /// Tuner: выключить радио — вернуть источник к системному звуку.
    func tunerStop() {
        guard let s = sources.first, s.radio else { return }
        s.radio = false; s.radioURL = ""; s.loopback = true; s.name = "System Audio"
        radioStationName = ""; radioFavicon = ""; radioCoverURL = ""
        sources = sources
        reapply()
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
        // Refresh the audio-thread-safe mirrors so the render closure picks up the change.
        effects.syncFXMirrors()
    }

    // MARK: - Calibration

    /// HOLD: онлайн-удержание синхронизации колонок по микрофону (порт из Windows).
    /// Требует ≥2 не-саб колонки, активного воспроизведения и микрофона.
    func toggleHold(micLabel: String?) -> Bool {
        if holdOn { hold.stop(); holdOn = false; return false }
        let nonSub = outputs.filter { !$0.isSub }
        guard engine.isRunning, nonSub.count >= 2 else { return false }
        let label = (micLabel?.isEmpty == false) ? micLabel! : (uiState["hold_mic"] as? String ?? "")
        let mic = inDevices.first(where: { $0.name == label })
            ?? AudioDevices.builtInInput()
            ?? inDevices.first
        guard let mic else { return false }
        if let l = micLabel, !l.isEmpty { uiState["hold_mic"] = l; saveSettings() }
        hold.start(micDeviceID: mic.deviceID)
        holdOn = true
        return true
    }

    private func runCalibrate(mic: String?, resolve: @escaping (Any?) -> Void) {
        guard engine.isRunning, !calibrating else {
            resolve(["msg": "Запустите воспроизведение перед калибровкой", "items": []])
            return
        }
        calibrating = true
        let micID = (inDevices.first(where: { $0.name == mic }) ?? AudioDevices.builtInInput())?.deviceID
        calibrator.calibrate(micDeviceID: micID, progress: { [weak self] msg in
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
             "radio": s.radio,
             "vol": s.volumePercent / 100.0,
             "bal": s.balancePercent / 100.0,
             "mute": s.mute,
             "inv": s.invertPhase]
        }

        return [
            "out_devices": outDevs,
            "in_devices": inDevs,
            "lb_speakers": SystemAudioTap.audioProcesses().map { $0.name },
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

    /// Now-playing для активного радио (общий для главного окна и мини-плеера). nil = радио нет.
    private func radioNowPlaying() -> [String: Any]? {
        guard engine.hasRadio else { return nil }
        let song = engine.radioTitle.trimmingCharacters(in: .whitespaces)
        let station = radioStationName.isEmpty ? "Radio" : radioStationName
        let e = max(0, Date().timeIntervalSince(radioStartTime))
        let cur = String(format: "%d:%02d", Int(e) / 60, Int(e) % 60)
        return [
            "title": song.isEmpty ? station : song,
            "sub":   song.isEmpty ? "RADIO" : station,
            "cur": cur, "total": "LIVE", "posfrac": 0,
            // art_id меняется при смене обложки → мини-плеер перетягивает её.
            "art_id": "radio:" + (radioCoverURL.isEmpty ? radioFavicon : radioCoverURL),
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
            "level": vizData["level"] ?? 0.0,
            "beat": vizData["beat"] ?? 0.0,
            "viz": vizData,
            "np": radioNowPlaying() ?? NowPlaying.shared.npDict(),
            "np_app": NowPlaying.shared.appName,   // какое приложение сейчас системный now-playing
            "radio_title": engine.radioTitle,
            "radio_paused": engine.radioPaused,
            "radio_stopped": engine.radioStopped,
            "radio_active": engine.hasRadio,   // правда движка: играет ли сейчас радио
            "fmt": [
                "rate": sources.first?.fmtRate ?? 0,
                "ch": sources.first?.fmtChannels ?? 0,
                "codec": sources.first?.fmtCodec ?? "",
                // битрейт реален только для радио (из потока); для захвата системы/приложений 0
                "kbps": engine.hasRadio ? engine.radioBitrateKbps : 0,
            ],
            // Сигнатура активного источника — чтобы web перерисовал строку после авто-переключения.
            "src_sig": sources.map { "\($0.lbName)|\($0.radio)|\($0.device?.name ?? "")" }.joined(separator: ","),
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

        // Restore the last graphic-EQ position.
        if let eq = obj["eq"] as? [String: Any] {
            if let on = eq["on"] as? NSNumber { effects.eqOn = on.boolValue }
            if let g = eq["gains"] as? [Double], g.count == effects.eqGains.count { effects.eqGains = g }
            else if let ga = eq["gains"] as? [NSNumber], ga.count == effects.eqGains.count {
                effects.eqGains = ga.map { $0.doubleValue }
            }
        }

        // Restore the last effect (FX) state.
        if let fx = obj["fx"] as? [String: Any] {
            func b(_ k: String) -> Bool? { (fx[k] as? NSNumber)?.boolValue }
            func n(_ k: String) -> Double? { (fx[k] as? NSNumber)?.doubleValue }
            if let v = b("spatial_on")  { effects.spatialOn = v }
            if let v = n("spatial")     { effects.spatialPercent = v * 50 }
            if let v = b("threeD_on")   { effects.threeDOn = v }
            if let v = n("threeD")      { effects.threeDPercent = v * 100 }
            if let v = b("surround_on") { effects.surroundOn = v }
            if let v = n("surround")    { effects.surroundPercent = v * 100 }
            if let v = b("bass_on")     { effects.bassOn = v }
            if let v = n("bass")        { effects.bass = v }
            for k in effects.extraBool.keys { if let v = b(k) { effects.extraBool[k] = v } }
            for k in effects.extraNum.keys  { if let v = n(k) { effects.extraNum[k] = v } }
        }
        effects.syncFXMirrors()

        // Restore saved outputs / sources (device assignments, roles, levels). Devices that
        // are no longer present resolve to nil — the row stays, the user can re-pick.
        if let outs = obj["outputs"] as? [[String: Any]], !outs.isEmpty {
            outputs = outs.map { d in
                let o = OutputSpeaker(); o.intId = nextId()
                if let r = d["role"] as? String { o.roleKey = r }
                if let dev = d["device"] as? String, !dev.isEmpty { o.device = outDevices.first { $0.name == dev } }
                if let v = (d["vol"] as? NSNumber)?.doubleValue { o.volumePercent = v * 100 }
                if let m = (d["mute"] as? NSNumber)?.boolValue { o.mute = m }
                if let s = (d["sub"] as? NSNumber)?.boolValue { o.isSub = s }
                if let x = (d["xover"] as? NSNumber)?.doubleValue { o.xover = x }
                if let dl = (d["delay"] as? NSNumber)?.doubleValue { o.delayMs = dl }
                if let iv = (d["inv"] as? NSNumber)?.boolValue { o.inv = iv }
                return o
            }
        }
        if let srcs = obj["sources"] as? [[String: Any]], !srcs.isEmpty {
            sources = srcs.map { d in
                let s = SourceConfig(); s.intId = nextId()
                if let n = d["name"] as? String { s.name = n }
                if let lb = (d["loopback"] as? NSNumber)?.boolValue { s.loopback = lb }
                if let ln = d["lb_name"] as? String { s.lbName = ln }
                if let dev = d["device"] as? String, !dev.isEmpty { s.device = inDevices.first { $0.name == dev } }
                if let v = (d["vol"] as? NSNumber)?.doubleValue { s.volumePercent = v * 100 }
                if let b = (d["bal"] as? NSNumber)?.doubleValue { s.balancePercent = b * 100 }
                if let m = (d["mute"] as? NSNumber)?.boolValue { s.mute = m }
                if let iv = (d["inv"] as? NSNumber)?.boolValue { s.invertPhase = iv }
                return s
            }
        }
    }

    func saveSettings() {
        let outs: [[String: Any]] = outputs.map { o in
            ["device": o.device?.name ?? "", "role": o.roleKey,
             "vol": o.volumePercent / 100.0, "mute": o.mute, "sub": o.isSub,
             "xover": o.xover, "delay": o.delayMs, "inv": o.inv]
        }
        let srcs: [[String: Any]] = sources.map { s in
            // радио не сохраняем как радио (не возобновляем автоматически) — пишем как системный звук
            ["name": s.radio ? "System Audio" : s.name, "loopback": s.radio ? true : s.loopback, "lb_name": s.lbName,
             "device": s.device?.name ?? "", "vol": s.volumePercent / 100.0,
             "bal": s.balancePercent / 100.0, "mute": s.mute, "inv": s.invertPhase]
        }
        let obj: [String: Any] = [
            "ui": uiState,
            "viz": vizState,
            "master": masterPercent / 100.0,
            "eq_presets": eqPresets,
            "eq": ["on": effects.eqOn, "gains": effects.eqGains],
            "fx": fxDict(),
            "outputs": outs,
            "sources": srcs,
        ]
        guard JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]) else { return }
        try? data.write(to: settingsURL)
    }
}
