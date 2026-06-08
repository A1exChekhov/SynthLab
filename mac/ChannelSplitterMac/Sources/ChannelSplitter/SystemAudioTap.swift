import Foundation
import CoreAudio
import AudioToolbox
import AppKit

/// Native system-audio loopback via Core Audio process taps (macOS 14.2+).
/// Creates a global stereo tap (excluding our own process to avoid a feedback loop)
/// and wraps it in a *private* aggregate device whose input streams carry everything
/// the system is playing. That aggregate's AudioDeviceID can then be used by the
/// normal capture path (AVAudioEngine input), so "System Audio" works with no
/// third-party driver (no BlackHole / VB-Cable required).
final class SystemAudioTap {

    private var tapID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
    /// Процесс, под который собран текущий tap (kAudioObjectUnknown = весь системный звук).
    private var requestedProcess: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
    /// Доп. процессы, исключаемые из глобального muted-tap (помимо нашего) — для режима
    /// «глушить всё, КРОМЕ выбранного приложения».
    private var extraExclude: [AudioObjectID] = []
    /// Процессы для mixdown-мьюта (глушим именно их, тем же механизмом, что и захват одного
    /// приложения) — для режима «заглушить ВСЕ остальные приложения».
    private var mixdownProcs: [AudioObjectID] = []

    /// True on macOS 14.2+ where the process-tap API exists.
    static var isSupported: Bool {
        if #available(macOS 14.2, *) { return true }
        return false
    }

    /// Returns a ready aggregate device id backed by a live system-audio tap, creating it
    /// on first use. `processObj` (nil = весь системный звук) выбирает конкретное приложение
    /// для loopback. Если цель изменилась — tap пересобирается. nil при неподдержке/ошибке.
    func ensureDevice(forProcess processObj: AudioObjectID? = nil) -> AudioDeviceID? {
        let want = processObj ?? AudioObjectID(kAudioObjectUnknown)
        if aggregateID != AudioObjectID(kAudioObjectUnknown) {
            if want == requestedProcess && extraExclude.isEmpty { return aggregateID }
            teardown()   // целевое приложение сменилось — пересобираем tap
        }
        guard #available(macOS 14.2, *) else { return nil }
        requestedProcess = want
        extraExclude = []
        mixdownProcs = []
        return create(forProcess: processObj)
    }

    /// Глобальный muted-tap, который глушит ВЕСЬ системный звук, КРОМЕ нашего процесса и
    /// переданных приложений (их слышно через сплиттер). Аггрегат не читается — нужен лишь
    /// для активации заглушки (как в режиме радио). nil при неподдержке/ошибке.
    func ensureMuteAllExcept(processes extra: [AudioObjectID]) -> AudioDeviceID? {
        if aggregateID != AudioObjectID(kAudioObjectUnknown) {
            if requestedProcess == AudioObjectID(kAudioObjectUnknown) && extraExclude == extra { return aggregateID }
            teardown()
        }
        guard #available(macOS 14.2, *) else { return nil }
        requestedProcess = AudioObjectID(kAudioObjectUnknown)
        extraExclude = extra
        mixdownProcs = []
        return create(forProcess: nil)
    }

    /// Заглушить КОНКРЕТНЫЕ приложения (mixdown-мьют) — тем же механизмом, что и захват
    /// одного приложения. Агрегат не читается, нужен лишь для активации заглушки. Используется
    /// для «приоритета последнего источника»: глушим все ОСТАЛЬНЫЕ играющие приложения.
    func ensureMuteProcesses(_ procs: [AudioObjectID]) -> AudioDeviceID? {
        let key = procs.filter { $0 != AudioObjectID(kAudioObjectUnknown) }.sorted()
        guard !key.isEmpty else { teardown(); return nil }
        if aggregateID != AudioObjectID(kAudioObjectUnknown) {
            if mixdownProcs == key { return aggregateID }
            teardown()
        }
        guard #available(macOS 14.2, *) else { return nil }
        mixdownProcs = key
        requestedProcess = AudioObjectID(kAudioObjectUnknown)
        extraExclude = []
        return create(forProcess: nil)
    }

    @available(macOS 14.2, *)
    private func create(forProcess processObj: AudioObjectID?) -> AudioDeviceID? {
        let desc: CATapDescription
        if !mixdownProcs.isEmpty {
            // Глушим перечисленные приложения (mixdown-мьют, как при захвате одного приложения).
            desc = CATapDescription(stereoMixdownOfProcesses: mixdownProcs)
        } else if let p = processObj, p != AudioObjectID(kAudioObjectUnknown) {
            // Захват ОДНОГО приложения (его сведённый стерео-выход).
            desc = CATapDescription(stereoMixdownOfProcesses: [p])
        } else {
            // Весь системный звук, исключая наш процесс (чтобы tap не ловил нашу же выдачу)
            // и — в режиме «глушить всё, кроме выбранного» — переданные приложения.
            var exclude: [AudioObjectID] = {
                let obj = SystemAudioTap.processObject(for: getpid())
                return obj != AudioObjectID(kAudioObjectUnknown) ? [obj] : []
            }()
            for p in extraExclude where p != AudioObjectID(kAudioObjectUnknown) && !exclude.contains(p) {
                exclude.append(p)
            }
            desc = CATapDescription(stereoGlobalTapButExcludeProcesses: exclude)
        }
        desc.name = "Channel Splitter System Audio"
        desc.isPrivate = true
        // VB-Cable behaviour: silence the captured audio on its normal output device so
        // ONLY our processed mix is heard (no doubling of the original, unmodified sound).
        // Our own PID is excluded above, so our speaker output is never muted/looped.
        // Restored automatically when the tap is destroyed in teardown()/stop().
        desc.muteBehavior = .muted

        var newTap = AudioObjectID(kAudioObjectUnknown)
        let tStatus = AudioHardwareCreateProcessTap(desc, &newTap)
        guard tStatus == noErr, newTap != AudioObjectID(kAudioObjectUnknown) else {
            return nil
        }
        tapID = newTap

        let aggDesc: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Channel Splitter System Audio",
            kAudioAggregateDeviceUIDKey: "com.errarium.channelsplitter.tap." + UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapUIDKey: desc.uuid.uuidString,
                    kAudioSubTapDriftCompensationKey: true,
                ]
            ],
        ]

        var newAgg = AudioObjectID(kAudioObjectUnknown)
        let aStatus = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &newAgg)
        guard aStatus == noErr, newAgg != AudioObjectID(kAudioObjectUnknown) else {
            // roll back the tap on failure
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
            return nil
        }
        aggregateID = newAgg
        return aggregateID
    }

    /// Destroy the aggregate + tap. Idempotent; safe to call when nothing was created.
    func teardown() {
        guard #available(macOS 14.2, *) else { return }
        if aggregateID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        requestedProcess = AudioObjectID(kAudioObjectUnknown)
        extraExclude = []
        mixdownProcs = []
    }

    deinit { teardown() }

    // MARK: - Перечисление аудио-процессов (для выбора приложения в loopback)

    /// Приложения, ВОСПРОИЗВОДЯЩИЕ звук прямо сейчас (id Core Audio + имя), без дублей.
    static func audioProcesses() -> [(id: AudioObjectID, name: String)] {
        guard #available(macOS 14.2, *) else { return [] }
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(
                AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr, size > 0
        else { return [] }
        let count = Int(size) / MemoryLayout<AudioObjectID>.size
        var objs = [AudioObjectID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &objs) == noErr
        else { return [] }

        var seen = Set<String>()
        var result: [(AudioObjectID, String)] = []
        for obj in objs {
            guard processBool(obj, kAudioProcessPropertyIsRunningOutput) else { continue }
            var name: String? = nil
            let pid = processPID(obj)
            if pid > 0 { name = NSRunningApplication(processIdentifier: pid)?.localizedName }
            // Electron/Chromium-приложения (Яндекс Музыка, YouTube Music и т.п.) отдают звук
            // из helper-процесса без имени → определяем главное приложение по bundle ID.
            if (name?.isEmpty ?? true), let bid = processString(obj, kAudioProcessPropertyBundleID) {
                name = appName(forBundleID: bid)
            }
            guard let nm = name, !nm.isEmpty, !seen.contains(nm) else { continue }
            seen.insert(nm)
            result.append((obj, nm))
        }
        return result
    }

    /// Прочитать строковое свойство (CFString) процесса, напр. bundle ID.
    @available(macOS 14.2, *)
    private static func processString(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var addr = AudioObjectPropertyAddress(
            mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<CFString?>.size)
        var cf: Unmanaged<CFString>? = nil
        let st = AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &cf)
        guard st == noErr, let s = cf?.takeRetainedValue() else { return nil }
        return s as String
    }

    /// Человекочитаемое имя приложения по bundle ID (с учётом helper-суффиксов).
    private static func appName(forBundleID bid: String) -> String? {
        guard !bid.isEmpty else { return nil }
        if let n = NSRunningApplication.runningApplications(withBundleIdentifier: bid).first?.localizedName, !n.isEmpty { return n }
        var base = bid
        for marker in [".helper", ".Helper"] {
            if let r = base.range(of: marker) { base = String(base[..<r.lowerBound]); break }
        }
        if base != bid,
           let n = NSRunningApplication.runningApplications(withBundleIdentifier: base).first?.localizedName, !n.isEmpty { return n }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: base) {
            return FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
        }
        return nil
    }

    /// Найти Core Audio process object по имени приложения (для применения выбора loopback).
    static func processObject(forName name: String) -> AudioObjectID? {
        guard !name.isEmpty else { return nil }
        return audioProcesses().first(where: { $0.name == name })?.id
    }

    @available(macOS 14.2, *)
    private static func processPID(_ obj: AudioObjectID) -> pid_t {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyPID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var pid: pid_t = -1
        var size = UInt32(MemoryLayout<pid_t>.size)
        return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &pid) == noErr ? pid : -1
    }

    @available(macOS 14.2, *)
    private static func processBool(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Bool {
        var addr = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var val: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &val) == noErr && val != 0
    }

    // MARK: - Helpers

    /// Translate a Unix pid into the Core Audio process AudioObjectID.
    private static func processObject(for pid: pid_t) -> AudioObjectID {
        var pidVar = pid
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var obj = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &addr,
            UInt32(MemoryLayout<pid_t>.size), &pidVar, &size, &obj)
        return status == noErr ? obj : AudioObjectID(kAudioObjectUnknown)
    }
}
