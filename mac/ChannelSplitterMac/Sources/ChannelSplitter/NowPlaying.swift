import Foundation
import AppKit

/// Reads the system "now playing" track info (title / artist / position) the same way
/// Control Center and the lock screen do — via the private MediaRemote framework.
/// Works for any app that publishes now-playing info (Music, Spotify, Safari/Chrome,
/// podcast apps, etc.). Loaded dynamically with dlopen so no Xcode / linking is needed.
///
/// Note: MediaRemote is a private API. It works on macOS through Sonoma (14.x); on
/// 15.4+ Apple gated it behind a special entitlement, so there it may return nothing —
/// in that case the player simply shows "—" and the rest of the app is unaffected.
final class NowPlaying {
    static let shared = NowPlaying()

    // void MRMediaRemoteGetNowPlayingInfo(dispatch_queue_t, void(^)(CFDictionaryRef))
    private typealias GetInfoFn = @convention(c) (DispatchQueue, @escaping ([String: Any]) -> Void) -> Void
    // void MRMediaRemoteGetNowPlayingApplicationIsPlaying(dispatch_queue_t, void(^)(Bool))
    private typealias IsPlayingFn = @convention(c) (DispatchQueue, @escaping (Bool) -> Void) -> Void
    // Bool MRMediaRemoteSendCommand(MRMediaRemoteCommand, NSDictionary*)
    private typealias SendCmdFn = @convention(c) (UInt32, NSDictionary?) -> Bool
    // void MRMediaRemoteSetElapsedTime(double)
    private typealias SetElapsedFn = @convention(c) (Double) -> Void
    // void MRMediaRemoteGetNowPlayingApplicationPID(dispatch_queue_t, void(^)(int))
    private typealias GetPIDFn = @convention(c) (DispatchQueue, @escaping (Int32) -> Void) -> Void

    private var getInfo: GetInfoFn?
    private var isPlayingFn: IsPlayingFn?
    private var sendCmdFn: SendCmdFn?
    private var setElapsedFn: SetElapsedFn?
    private var getPIDFn: GetPIDFn?
    /// Имя приложения, которое СЕЙЧАС является системным now-playing (для фильтрации:
    /// показывать данные только от выбранного источника, а не от чужого плеера).
    private(set) var appName = ""

    /// MRMediaRemoteCommand values used by the transport buttons.
    enum Command: UInt32 {
        case play = 0, pause = 1, togglePlayPause = 2, stop = 3, next = 4, previous = 5
    }

    // Latest snapshot (updated asynchronously by refresh()).
    private(set) var title = ""
    private(set) var artist = ""
    private(set) var album = ""
    private(set) var elapsed: Double = 0
    private(set) var duration: Double = 0
    private(set) var playing = false
    private(set) var artworkData: Data?     // album cover bytes (PNG/JPEG)
    private(set) var artID = ""             // cheap change-token (track + size) for the UI
    // The instant (per MediaRemote) at which `elapsed` was measured — NOT the query time.
    // MediaRemote reports elapsed as of the last playback state change, so live position
    // must be extrapolated from this timestamp, otherwise the clock appears frozen.
    private var timestamp = Date()

    var available: Bool { getInfo != nil }

    private init() {
        let path = "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote"
        guard let handle = dlopen(path, RTLD_NOW) else { return }
        if let s = dlsym(handle, "MRMediaRemoteGetNowPlayingInfo") {
            getInfo = unsafeBitCast(s, to: GetInfoFn.self)
        }
        if let s = dlsym(handle, "MRMediaRemoteGetNowPlayingApplicationIsPlaying") {
            isPlayingFn = unsafeBitCast(s, to: IsPlayingFn.self)
        }
        if let s = dlsym(handle, "MRMediaRemoteSendCommand") {
            sendCmdFn = unsafeBitCast(s, to: SendCmdFn.self)
        }
        if let s = dlsym(handle, "MRMediaRemoteSetElapsedTime") {
            setElapsedFn = unsafeBitCast(s, to: SetElapsedFn.self)
        }
        if let s = dlsym(handle, "MRMediaRemoteGetNowPlayingApplicationPID") {
            getPIDFn = unsafeBitCast(s, to: GetPIDFn.self)
        }
    }

    /// Перемотать текущий now-playing трек на заданную позицию (сек). Используется для
    /// «мягкого STOP» — пауза + перемотка в начало (трек/очередь не сбрасываются).
    func seek(_ seconds: Double) { setElapsedFn?(seconds) }

    /// Send a transport command to the system "now playing" app (Music, Spotify,
    /// Safari/Chrome, etc.). Returns false if MediaRemote is gated (macOS 15.4+).
    @discardableResult
    func send(_ cmd: Command) -> Bool {
        sendCmdFn?(cmd.rawValue, nil) ?? false
    }

    /// Kick off an async fetch; results land in the properties above on the main queue.
    func refresh() {
        getInfo?(DispatchQueue.main) { [weak self] info in
            guard let self else { return }
            self.title    = info["kMRMediaRemoteNowPlayingInfoTitle"] as? String ?? ""
            self.artist   = info["kMRMediaRemoteNowPlayingInfoArtist"] as? String ?? ""
            self.album    = info["kMRMediaRemoteNowPlayingInfoAlbum"] as? String ?? ""
            self.elapsed  = (info["kMRMediaRemoteNowPlayingInfoElapsedTime"] as? NSNumber)?.doubleValue ?? 0
            self.duration = (info["kMRMediaRemoteNowPlayingInfoDuration"] as? NSNumber)?.doubleValue ?? 0
            self.timestamp = (info["kMRMediaRemoteNowPlayingInfoTimestamp"] as? Date) ?? Date()
            self.artworkData = info["kMRMediaRemoteNowPlayingInfoArtworkData"] as? Data
            // art_id = идентификатор ТРЕКА (без размера обложки), чтобы пауза не дёргала
            // перезагрузку обложки (на паузе artworkData на миг пропадает → мигание).
            self.artID = (self.title.isEmpty && self.artist.isEmpty) ? "" : "\(self.title)|\(self.artist)"
        }
        isPlayingFn?(DispatchQueue.main) { [weak self] playing in
            self?.playing = playing
        }
        getPIDFn?(DispatchQueue.main) { [weak self] pid in
            guard let self else { return }
            self.appName = pid > 0 ? (NSRunningApplication(processIdentifier: pid)?.localizedName ?? "") : ""
        }
    }

    /// Elapsed time advanced to "now" while playing, so the progress bar moves smoothly
    /// between the (relatively infrequent) MediaRemote snapshots.
    private var liveElapsed: Double {
        let e = playing ? elapsed + Date().timeIntervalSince(timestamp) : elapsed
        let clamped = max(0, e)
        return duration > 0 ? min(clamped, duration) : clamped
    }

    private func clock(_ s: Double) -> String {
        let v = Int(s.rounded(.down))
        return String(format: "%d:%02d", v / 60, v % 60)
    }

    /// Dictionary shaped for the web player UI (updateNP in app.js).
    func npDict() -> [String: Any] {
        let sub: String
        if !artist.isEmpty && !album.isEmpty { sub = "\(artist) — \(album)" }
        else { sub = artist.isEmpty ? album : artist }
        let e = liveElapsed
        return [
            "title": title,
            "sub": sub,
            "cur": clock(e),
            "total": duration > 0 ? clock(duration) : "0:00",
            "posfrac": duration > 0 ? e / duration : 0,
            "art_id": artID,
        ]
    }

    /// Album artwork as a `data:` URL (base64) for the web player. Returned on demand by
    /// the `now_playing_art` bridge method — NOT streamed in every `meters()` poll.
    func artworkDataURL() -> String? {
        guard let d = artworkData, !d.isEmpty else { return nil }
        let mime = (d.first == 0x89) ? "image/png" : "image/jpeg"
        return "data:\(mime);base64," + d.base64EncodedString()
    }
}
