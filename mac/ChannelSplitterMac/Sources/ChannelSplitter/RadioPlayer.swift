import Foundation
import AudioToolbox
import AVFoundation

/// Интернет-радио как ИСТОЧНИК сплиттера. macOS `MTAudioProcessingTap` не работает с
/// потоковым/HLS-вещанием (у AVPlayerItem нет аудио-дорожки → tap не запускается), поэтому
/// радио раньше шло мимо усилителя. Здесь поток декодируется ВРУЧНУЮ:
///   URLSession (HTTP) → разбор ICY-метаданных → AudioFileStream (разбор пакетов) →
///   AudioConverter (декод MP3/AAC → PCM Float 48 кГц) → запись в кольцевые буферы выходов.
/// Так радио идёт через сплиттер: EQ, эффекты, спектр, реальный формат/битрейт.
final class RadioPlayer: NSObject {
    let config: SourceConfig
    private(set) var rings: [UUID: StereoRing] = [:]
    private(set) var currentTitle = ""
    private(set) var streamCodec = ""
    private(set) var bitrateKbps = 0
    private(set) var paused = false
    private(set) var stopped = false

    private var session: URLSession?
    private var task: URLSessionDataTask?

    // ICY (Shoutcast/Icecast) метаданные, вкраплённые в аудио-поток.
    private var icyMetaInt = 0          // период метаданных (байт аудио между блоками)
    private var icyBytesLeft = 0        // сколько байт аудио до следующего блока метаданных
    private var icyMetaLen = -1         // -1 = ждём байт длины; иначе размер блока метаданных
    private var icyMetaBuf = [UInt8]()

    // AudioFileStream → AudioConverter
    private var afs: AudioFileStreamID?
    private var converter: AudioConverterRef?
    private var srcASBD = AudioStreamBasicDescription()
    private var dstChannels = 2
    private var ready = false

    // контекст для input-колбэка конвертера (одна порция пакетов за вызов decode)
    fileprivate var inBase: UnsafeRawPointer?
    fileprivate var inByteSize: UInt32 = 0
    fileprivate var inDescs: UnsafeMutablePointer<AudioStreamPacketDescription>?
    fileprivate var inPackets: UInt32 = 0
    fileprivate var inConsumed = false

    init(config: SourceConfig, outputs: [OutputSpeaker]) {
        self.config = config
        super.init()
        for o in outputs { rings[o.id] = StereoRing(capacity: Audio.maxBufFrames) }
    }

    func start(urlString: String) {
        guard let url = URL(string: urlString) else { return }
        stopped = false; paused = false
        var req = URLRequest(url: url)
        req.setValue("1", forHTTPHeaderField: "Icy-MetaData")          // просим ICY-метаданные
        req.setValue("AppleCoreMedia", forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 20
        let cfg = URLSessionConfiguration.default
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        session = s
        let t = s.dataTask(with: req)
        task = t
        t.resume()
    }

    func stop() {
        task?.cancel(); task = nil
        session?.invalidateAndCancel(); session = nil
        if let c = converter { AudioConverterDispose(c); converter = nil }
        if let a = afs { AudioFileStreamClose(a); afs = nil }
        currentTitle = ""; streamCodec = ""; bitrateKbps = 0
        paused = false; ready = false
        icyMetaInt = 0; icyBytesLeft = 0; icyMetaLen = -1; icyMetaBuf.removeAll()
    }

    @discardableResult func togglePlayPause() -> Bool {
        if stopped {                       // после STOP — перезапуск станции с нуля
            start(urlString: config.radioURL)
            return true
        }
        paused.toggle(); return !paused
    }
    func pause() { paused = true }

    /// STOP = сброс: останавливаем поток и декодер (тишина). Play перезапустит станцию.
    func stopReset() {
        task?.cancel(); task = nil
        session?.invalidateAndCancel(); session = nil
        if let c = converter { AudioConverterDispose(c); converter = nil }
        if let a = afs { AudioFileStreamClose(a); afs = nil }
        currentTitle = ""; bitrateKbps = 0
        ready = false; paused = false; stopped = true
        icyMetaInt = 0; icyBytesLeft = 0; icyMetaLen = -1; icyMetaBuf.removeAll()
    }

    // MARK: ICY → аудио

    /// Разделяет поток на аудио-байты и блоки ICY-метаданных, аудио отдаёт в AudioFileStream.
    fileprivate func feed(_ bytes: UnsafeRawBufferPointer) {
        let p = bytes.bindMemory(to: UInt8.self)
        var i = 0
        let n = p.count
        while i < n {
            if icyMetaInt > 0 && icyBytesLeft == 0 {
                if icyMetaLen < 0 {                 // байт длины блока метаданных
                    icyMetaLen = Int(p[i]) * 16; i += 1
                    icyMetaBuf.removeAll(keepingCapacity: true)
                    if icyMetaLen == 0 { icyBytesLeft = icyMetaInt; icyMetaLen = -1 }
                    continue
                } else {                            // тело блока метаданных
                    let need = icyMetaLen - icyMetaBuf.count
                    let take = min(need, n - i)
                    icyMetaBuf.append(contentsOf: UnsafeBufferPointer(start: p.baseAddress! + i, count: take))
                    i += take
                    if icyMetaBuf.count >= icyMetaLen {
                        parseICY(icyMetaBuf)
                        icyBytesLeft = icyMetaInt; icyMetaLen = -1
                    }
                    continue
                }
            }
            // аудио-байты
            let take = icyMetaInt > 0 ? min(icyBytesLeft, n - i) : (n - i)
            parseAudio(p.baseAddress! + i, count: take)
            if icyMetaInt > 0 { icyBytesLeft -= take }
            i += take
        }
    }

    private func parseICY(_ buf: [UInt8]) {
        guard let s = String(bytes: buf, encoding: .utf8) ?? String(bytes: buf, encoding: .isoLatin1) else { return }
        if let t = Self.parseTitle(s), !t.isEmpty { currentTitle = t }
    }

    private func parseAudio(_ ptr: UnsafeRawPointer, count: Int) {
        guard count > 0 else { return }
        if afs == nil {
            let selfPtr = Unmanaged.passUnretained(self).toOpaque()
            AudioFileStreamOpen(selfPtr, afsPropertyProc, afsPacketsProc, afsHint, &afs)
        }
        if let a = afs { AudioFileStreamParseBytes(a, UInt32(count), ptr, []) }
    }

    fileprivate var afsHint: AudioFileTypeID = 0   // подсказка типа из Content-Type

    // MARK: AudioFileStream колбэки

    fileprivate func onProperty(_ id: AudioFileStreamPropertyID) {
        guard id == kAudioFileStreamProperty_ReadyToProducePackets, let a = afs, converter == nil else { return }
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        AudioFileStreamGetProperty(a, kAudioFileStreamProperty_DataFormat, &size, &srcASBD)
        guard srcASBD.mSampleRate > 0 else { return }

        dstChannels = max(1, min(2, Int(srcASBD.mChannelsPerFrame)))
        var dst = AudioStreamBasicDescription(
            mSampleRate: Audio.sampleRate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(4 * dstChannels),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(4 * dstChannels),
            mChannelsPerFrame: UInt32(dstChannels),
            mBitsPerChannel: 32,
            mReserved: 0)
        var conv: AudioConverterRef?
        let st = AudioConverterNew(&srcASBD, &dst, &conv)
        guard st == noErr, let conv else { NSLog("[radio] AudioConverterNew err=\(st)"); return }
        converter = conv
        ready = true

        // реальный формат потока в UI
        streamCodec = Self.codecName(srcASBD.mFormatID)
        config.fmtRate = srcASBD.mSampleRate
        config.fmtChannels = Int(srcASBD.mChannelsPerFrame)
        config.fmtCodec = streamCodec
    }

    fileprivate func onPackets(_ numberBytes: UInt32, _ numberPackets: UInt32,
                               _ inputData: UnsafeRawPointer,
                               _ descs: UnsafeMutablePointer<AudioStreamPacketDescription>?) {
        guard ready, let conv = converter, numberPackets > 0 else { return }

        // одна порция пакетов → конвертер. Выходной буфер с запасом по кадрам.
        let srcFPP = srcASBD.mFramesPerPacket > 0 ? Double(srcASBD.mFramesPerPacket) : 1152
        let ratio = Audio.sampleRate / max(1, srcASBD.mSampleRate)
        let cap = Int(Double(numberPackets) * srcFPP * ratio) + 4096
        let outBytes = cap * 4 * dstChannels
        let outPtr = malloc(outBytes)!
        defer { free(outPtr) }

        inBase = inputData; inByteSize = numberBytes; inDescs = descs
        inPackets = numberPackets; inConsumed = false

        var abl = AudioBufferList()
        abl.mNumberBuffers = 1
        abl.mBuffers.mNumberChannels = UInt32(dstChannels)
        abl.mBuffers.mDataByteSize = UInt32(outBytes)
        abl.mBuffers.mData = outPtr
        var ioFrames = UInt32(cap)
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        _ = AudioConverterFillComplexBuffer(conv, convInputProc, selfPtr, &ioFrames, &abl, nil)
        if ioFrames > 0 { pushPCM(outPtr.assumingMemoryBound(to: Float.self), frames: Int(ioFrames)) }
    }

    /// Деинтерливинг PCM и запись в кольца выходов (с учётом паузы).
    private func pushPCM(_ interleaved: UnsafePointer<Float>, frames: Int) {
        guard frames > 0, !paused else { return }
        var l = [Float](repeating: 0, count: frames)
        var r = [Float](repeating: 0, count: frames)
        if dstChannels >= 2 {
            for f in 0..<frames { l[f] = interleaved[f*2]; r[f] = interleaved[f*2+1] }
        } else {
            for f in 0..<frames { l[f] = interleaved[f]; r[f] = interleaved[f] }
        }
        l.withUnsafeBufferPointer { lb in
            r.withUnsafeBufferPointer { rb in
                for (_, ring) in rings { ring.push(l: lb.baseAddress!, r: rb.baseAddress!, count: frames) }
            }
        }
    }

    // MARK: helpers (codec name + ICY title)

    /// Человекочитаемое имя аудио-кодека по FourCC.
    static func codecName(_ fourCC: FourCharCode) -> String {
        switch fourCC {
        case kAudioFormatMPEG4AAC, kAudioFormatMPEG4AAC_HE, kAudioFormatMPEG4AAC_HE_V2,
             kAudioFormatMPEG4AAC_LD, kAudioFormatMPEG4AAC_ELD: return "AAC"
        case kAudioFormatMPEGLayer3: return "MP3"
        case kAudioFormatMPEGLayer2: return "MP2"
        case kAudioFormatMPEGLayer1: return "MP1"
        case kAudioFormatOpus:       return "Opus"
        case kAudioFormatFLAC:       return "FLAC"
        case kAudioFormatAppleLossless: return "ALAC"
        case kAudioFormatLinearPCM:  return "PCM"
        default:
            let b = [UInt8((fourCC >> 24) & 0xFF), UInt8((fourCC >> 16) & 0xFF),
                     UInt8((fourCC >> 8) & 0xFF), UInt8(fourCC & 0xFF)]
            let s = String(bytes: b, encoding: .ascii)?.trimmingCharacters(in: .whitespaces) ?? ""
            return s.isEmpty ? "Stream" : s
        }
    }

    /// Достаёт «исполнитель — название» из строки ICY (`StreamTitle='...'`) или JSON-блоба.
    static func parseTitle(_ raw: String) -> String? {
        var t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = t.range(of: "StreamTitle=") {
            t = String(t[r.upperBound...])
            if let end = t.range(of: "';") { t = String(t[..<end.lowerBound]) }
        }
        t = t.trimmingCharacters(in: CharacterSet(charactersIn: "';\" "))
        // на случай нультерминированного хвоста блока метаданных
        if let z = t.firstIndex(of: "\0") { t = String(t[..<z]) }
        if t.hasPrefix("{"), let data = t.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            func find(_ d: [String: Any], _ keys: [String]) -> String? {
                for k in keys { for (kk, vv) in d where kk.lowercased() == k {
                    if let s = vv as? String, !s.isEmpty { return s } } }
                return nil
            }
            var dict = obj
            for nest in ["now", "track", "song", "data", "nowplaying"] {
                if let inner = dict[nest] as? [String: Any] { dict = inner; break }
            }
            let artist = find(dict, ["artist", "performer", "singer"])
            let title  = find(dict, ["title", "song", "track", "name"])
            if let a = artist, let s = title { return "\(a) — \(s)" }
            return title ?? artist
        }
        if t.hasPrefix("{") || t.contains("\"result\"") { return nil }
        return t.isEmpty ? nil : t
    }
}

// MARK: - URLSession delegate (HTTP-стрим + заголовки ICY)

extension RadioPlayer: URLSessionDataDelegate {
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let http = response as? HTTPURLResponse {
            let h = http.allHeaderFields
            func hv(_ key: String) -> String? {
                for (k, v) in h where (k as? String)?.lowercased() == key { return "\(v)" }
                return nil
            }
            if let mi = hv("icy-metaint"), let v = Int(mi) { icyMetaInt = v; icyBytesLeft = v }
            if let br = hv("icy-br"), let v = Int(br.components(separatedBy: ",").first ?? br) { bitrateKbps = v }
            let ct = (hv("content-type") ?? response.mimeType ?? "").lowercased()
            if ct.contains("mpeg") || ct.contains("mp3") { afsHint = kAudioFileMP3Type }
            else if ct.contains("aac") { afsHint = kAudioFileAAC_ADTSType }
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        data.withUnsafeBytes { feed($0) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error, (error as NSError).code != NSURLErrorCancelled { NSLog("[radio] stream end err=\(error.localizedDescription)") }
    }
}

// MARK: - C-колбэки AudioFileStream / AudioConverter

private func afsPropertyProc(_ client: UnsafeMutableRawPointer,
                             _ stream: AudioFileStreamID,
                             _ propID: AudioFileStreamPropertyID,
                             _ flags: UnsafeMutablePointer<AudioFileStreamPropertyFlags>) {
    Unmanaged<RadioPlayer>.fromOpaque(client).takeUnretainedValue().onProperty(propID)
}

private func afsPacketsProc(_ client: UnsafeMutableRawPointer,
                            _ numberBytes: UInt32,
                            _ numberPackets: UInt32,
                            _ inputData: UnsafeRawPointer,
                            _ packetDescs: UnsafeMutablePointer<AudioStreamPacketDescription>?) {
    Unmanaged<RadioPlayer>.fromOpaque(client).takeUnretainedValue()
        .onPackets(numberBytes, numberPackets, inputData, packetDescs)
}

private func convInputProc(_ converter: AudioConverterRef,
                           _ ioNumberDataPackets: UnsafeMutablePointer<UInt32>,
                           _ ioData: UnsafeMutablePointer<AudioBufferList>,
                           _ outDescs: UnsafeMutablePointer<UnsafeMutablePointer<AudioStreamPacketDescription>?>?,
                           _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    let me = Unmanaged<RadioPlayer>.fromOpaque(userData!).takeUnretainedValue()
    if me.inConsumed || me.inPackets == 0 {
        // Ненулевой статус = «данных пока нет». Возврат noErr+0 пакетов означал бы КОНЕЦ
        // потока — после него AudioConverter «завершается» и больше не декодирует.
        ioNumberDataPackets.pointee = 0
        return 1
    }
    ioData.pointee.mNumberBuffers = 1
    ioData.pointee.mBuffers.mData = me.inBase.map { UnsafeMutableRawPointer(mutating: $0) }
    ioData.pointee.mBuffers.mDataByteSize = me.inByteSize
    ioData.pointee.mBuffers.mNumberChannels = me.srcASBDChannels
    if let outDescs { outDescs.pointee = me.inDescs }
    ioNumberDataPackets.pointee = me.inPackets
    me.inConsumed = true
    return noErr
}

private extension RadioPlayer {
    var srcASBDChannels: UInt32 { srcASBD.mChannelsPerFrame }
}
