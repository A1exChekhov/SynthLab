import Foundation
import AppKit

/// Ставит на паузу системные медиаплееры через AppleScript (Apple Events).
/// macOS не даёт послать «паузу» произвольному фоновому приложению через MediaRemote —
/// команда уходит только текущему «now playing». Поэтому для «новый источник перехватывает,
/// старый убирается» используем AppleScript: он умеет адресно ставить на паузу КОНКРЕТНЫЙ
/// скриптуемый плеер (Apple Music, Spotify). Приложения без AppleScript-поддержки
/// (Яндекс Музыка / YouTube Music — Electron) этим способом остановить нельзя.
enum MediaControl {
    /// Скриптуемые медиаплееры: bundle ID → имя приложения в AppleScript.
    private static let players: [String] = [
        "com.apple.Music",      // Apple Music («Музыка»)
        "com.spotify.client",   // Spotify
    ]

    /// Поставить на паузу все скриптуемые плееры, КРОМЕ активного (по локализованному имени).
    /// Запускается асинхронно — Apple Events не должны блокировать аудио/UI поток.
    static func pauseOthers(exceptName active: String) {
        for bid in players {
            guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bid).first
            else { continue }                       // не запущено — пропускаем (и не запускаем)
            if !active.isEmpty, app.localizedName == active { continue }   // активный не трогаем
            pause(bundleID: bid)
        }
    }

    /// Поставить КОНКРЕТНЫЙ плеер на паузу (по bundle ID).
    static func pause(bundleID: String) {
        let src = "tell application id \"\(bundleID)\" to pause"
        DispatchQueue.global(qos: .userInitiated).async {
            var err: NSDictionary?
            NSAppleScript(source: src)?.executeAndReturnError(&err)
            if let err { NSLog("[mediactl] pause \(bundleID) err=\(err)") }
        }
    }
}
