import Foundation
import CoreAudio
import AudioToolbox

enum AudioDevices {

    static func outputDevices() -> [AudioDeviceInfo] { devices(wantOutput: true) }
    static func inputDevices() -> [AudioDeviceInfo] { devices(wantOutput: false) }

    static func devices(wantOutput: Bool) -> [AudioDeviceInfo] {
        var result: [AudioDeviceInfo] = []
        for id in allDeviceIDs() {
            let channels = channelCount(deviceID: id, wantOutput: wantOutput)
            guard channels > 0 else { continue }
            let name = stringProperty(deviceID: id, selector: kAudioObjectPropertyName) ?? "Device \(id)"
            let uid = stringProperty(deviceID: id, selector: kAudioDevicePropertyDeviceUID) ?? ""
            result.append(AudioDeviceInfo(deviceID: id, name: name, uid: uid))
        }
        return result
    }

    static func defaultMatching(_ substring: String, wantOutput: Bool) -> AudioDeviceInfo? {
        let lower = substring.lowercased()
        return devices(wantOutput: wantOutput).first { $0.name.lowercased().contains(lower) }
    }

    static func builtInInput() -> AudioDeviceInfo? {
        let ins = inputDevices()
        return ins.first { $0.name.lowercased().contains("micro") || $0.name.lowercased().contains("микро") || $0.name.lowercased().contains("built") }
            ?? ins.first
    }

    // MARK: - HAL helpers

    private static func allDeviceIDs() -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize) == noErr else {
            return []
        }
        let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var ids = [AudioDeviceID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &ids) == noErr else {
            return []
        }
        return ids
    }

    private static func channelCount(deviceID: AudioDeviceID, wantOutput: Bool) -> Int {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: wantOutput ? kAudioObjectPropertyScopeOutput : kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &dataSize) == noErr, dataSize > 0 else {
            return 0
        }
        let bufPtr = UnsafeMutableRawPointer.allocate(byteCount: Int(dataSize), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { bufPtr.deallocate() }
        guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &dataSize, bufPtr) == noErr else {
            return 0
        }
        let listPtr = UnsafeMutableAudioBufferListPointer(bufPtr.assumingMemoryBound(to: AudioBufferList.self))
        var total = 0
        for buffer in listPtr {
            total += Int(buffer.mNumberChannels)
        }
        return total
    }

    private static func stringProperty(deviceID: AudioDeviceID, selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var cfStr: CFString? = nil
        var dataSize = UInt32(MemoryLayout<CFString?>.size)
        let status = withUnsafeMutablePointer(to: &cfStr) { ptr -> OSStatus in
            AudioObjectGetPropertyData(deviceID, &address, 0, nil, &dataSize, ptr)
        }
        guard status == noErr, let s = cfStr else { return nil }
        return s as String
    }
}
