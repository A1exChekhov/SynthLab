import Foundation
import CoreAudio
import AudioToolbox

/// Native system-audio loopback via Core Audio process taps (macOS 14.2+).
/// Creates a global stereo tap (excluding our own process to avoid a feedback loop)
/// and wraps it in a *private* aggregate device whose input streams carry everything
/// the system is playing. That aggregate's AudioDeviceID can then be used by the
/// normal capture path (AVAudioEngine input), so "System Audio" works with no
/// third-party driver (no BlackHole / VB-Cable required).
final class SystemAudioTap {

    private var tapID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)

    /// True on macOS 14.2+ where the process-tap API exists.
    static var isSupported: Bool {
        if #available(macOS 14.2, *) { return true }
        return false
    }

    /// Returns a ready aggregate device id backed by a live system-audio tap,
    /// creating it on first use. Returns nil if unsupported or creation failed.
    func ensureDevice() -> AudioDeviceID? {
        if aggregateID != AudioObjectID(kAudioObjectUnknown) { return aggregateID }
        guard #available(macOS 14.2, *) else { return nil }
        return create()
    }

    @available(macOS 14.2, *)
    private func create() -> AudioDeviceID? {
        // Exclude our own process so the tap never picks up what we render to the speakers.
        let exclude: [AudioObjectID] = {
            let obj = SystemAudioTap.processObject(for: getpid())
            return obj != AudioObjectID(kAudioObjectUnknown) ? [obj] : []
        }()

        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: exclude)
        desc.name = "Channel Splitter System Audio"
        desc.isPrivate = true
        desc.muteBehavior = .unmuted   // keep playing normally through the speakers

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
    }

    deinit { teardown() }

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
