import AppKit
import WebKit

/// Owns the macOS "chrome" that lives outside the main SwiftUI window:
///   • a menu-bar (tray) status item,
///   • a floating mini-player panel (app_web/mini.html),
///   • a borderless full-screen visualizer ("цветомузыка").
/// All three reuse the same `AppModel` over the JS bridge (`SecondaryChannel`),
/// mirroring the Windows `splitter_app.py` tray / mini / GPU-viz behaviour.
final class AppChrome: NSObject {
    static var shared: AppChrome?

    private let model: AppModel

    private var statusItem: NSStatusItem?

    private var miniWindow: NSWindow?
    private var miniChannel: SecondaryChannel?

    private var vizWindow: NSWindow?
    private var vizChannel: SecondaryChannel?
    private var vizEscMonitor: Any?

    private var ru: Bool { (model.uiState["lang"] as? String ?? "ru") == "ru" }
    private func L(_ r: String, _ e: String) -> String { ru ? r : e }

    /// The SwiftUI WindowGroup window (located via the live web bridge).
    private var mainWindow: NSWindow? { model.bridge?.webView?.window }

    init(model: AppModel) {
        self.model = model
        super.init()
        AppChrome.shared = self
        setupTray()
    }

    // MARK: - Tray

    private func setupTray() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = item.button {
            btn.image = NSImage(systemSymbolName: "hifispeaker.2.fill",
                                accessibilityDescription: "Channel Splitter")
            btn.image?.isTemplate = true
            btn.toolTip = "Channel Splitter"
        }
        rebuildMenu(on: item)
        statusItem = item
    }

    private func rebuildMenu(on item: NSStatusItem) {
        let menu = NSMenu()
        func mk(_ title: String, _ sel: Selector, _ tip: String, _ key: String = "") -> NSMenuItem {
            let mi = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            mi.target = self
            mi.toolTip = tip
            return mi
        }
        menu.addItem(mk(L("Показать окно", "Show window"), #selector(menuShowMain),
                        L("Открыть главное окно приложения", "Bring the main window to front")))
        menu.addItem(mk(L("Мини-плеер", "Mini player"), #selector(menuToggleMini),
                        L("Показать/скрыть компактный плеер поверх окон", "Toggle the floating compact player")))
        menu.addItem(mk(L("Цветомузыка", "Visualizer"), #selector(menuOpenViz),
                        L("Полноэкранная визуализация звука (ESC — выход)", "Full-screen audio visualizer (ESC to exit)")))
        menu.addItem(.separator())
        menu.addItem(mk(L("Выход", "Quit"), #selector(menuQuit),
                        L("Полностью закрыть приложение", "Quit Channel Splitter"), "q"))
        item.menu = menu
    }

    @objc private func menuShowMain()   { showMain() }
    @objc private func menuToggleMini() { toggleMini() }
    @objc private func menuOpenViz()    { openViz() }
    @objc private func menuPlay() { NowPlaying.shared.send(.togglePlayPause) }
    @objc private func menuNext() { NowPlaying.shared.send(.next) }
    @objc private func menuPrev() { NowPlaying.shared.send(.previous) }
    @objc private func menuQuit() { NSApp.terminate(nil) }

    // MARK: - Main window show / hide

    private var mainHidden = false   // явное состояние видимости главного окна (для toggle)

    func showMain() {
        NSApp.unhide(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let w = mainWindow {
            if w.isMiniaturized { w.deminiaturize(nil) }   // развернуть из Dock
            w.makeKeyAndOrderFront(nil)
            w.orderFrontRegardless()
        }
        mainHidden = false
    }

    func hideMain() {
        mainWindow?.orderOut(nil)
        mainHidden = true
    }

    /// Кнопка в мини-плеере: показать ИЛИ скрыть главное окно (детерминированно по флагу).
    func toggleMain() {
        if mainHidden { showMain() } else { hideMain() }
    }

    // MARK: - Mini player

    func showMini() {
        if miniWindow == nil { buildMini() }
        guard let win = miniWindow else { return }
        positionMini(win)
        win.orderFrontRegardless()
    }

    func hideMini() { miniWindow?.orderOut(nil) }

    func toggleMini() {
        if let w = miniWindow, w.isVisible { hideMini() } else { showMini() }
    }

    /// Move the mini window by a pixel delta (web Y grows down, AppKit Y grows up).
    /// Driven by mini.js pointer-drag — WKWebView doesn't honour `-webkit-app-region`.
    func moveMini(_ dx: CGFloat, _ dy: CGFloat) {
        guard let w = miniWindow else { return }
        var o = w.frame.origin
        o.x += dx; o.y -= dy
        w.setFrameOrigin(o)
    }

    private func positionMini(_ win: NSWindow) {
        guard let scr = NSScreen.main?.visibleFrame else { return }
        let m: CGFloat = 16
        win.setFrameOrigin(NSPoint(x: scr.maxX - win.frame.width - m,
                                   y: scr.minY + m))
    }

    private func buildMini() {
        let (web, channel) = Bridge.makeSecondaryWebView(model: model)
        miniChannel = channel
        if let dir = appWebDirURL() {
            web.loadFileURL(dir.appendingPathComponent("mini.html"), allowingReadAccessTo: dir)
        }
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 92),
                            styleMask: [.titled, .closable, .nonactivatingPanel, .fullSizeContentView],
                            backing: .buffered, defer: false)
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.standardWindowButton(.closeButton)?.isHidden = true   // без красной кнопки (есть ✕ в UI)
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        // Независимое окно: закрытие прячет, а не уничтожает; живёт само по себе,
        // даже когда главное окно закрыто/в трее (обновления идут по таймеру модели).
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = Bridge.uiBaseColor
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        web.frame = panel.contentView?.bounds ?? .zero
        web.autoresizingMask = [.width, .height]
        panel.contentView?.addSubview(web)
        miniWindow = panel
    }

    // MARK: - Visualizer (цветомузыка)

    func openViz() {
        if let win = vizWindow, win.isVisible {
            // Already open → cycle the colour mode (Windows: next_preset()).
            let cur = (model.vizState["color_mode"] as? NSNumber)?.intValue ?? 0
            let next = (cur + 1) % 3
            model.vizState["color_mode"] = next
            model.saveSettings()
            return
        }
        buildViz()
        vizWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        installVizEscMonitor()
    }

    func closeViz() {
        if let m = vizEscMonitor { NSEvent.removeMonitor(m); vizEscMonitor = nil }
        vizWindow?.orderOut(nil)
        vizWindow = nil
        vizChannel = nil
    }

    private func installVizEscMonitor() {
        vizEscMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] ev in
            if ev.keyCode == 53 { self?.closeViz(); return nil }   // 53 = ESC
            return ev
        }
    }

    private func buildViz() {
        let (web, channel) = Bridge.makeSecondaryWebView(model: model)
        vizChannel = channel
        if let dir = appWebDirURL() {
            web.loadFileURL(dir.appendingPathComponent("viz.html"), allowingReadAccessTo: dir)
        }
        let frame = (NSScreen.main ?? NSScreen.screens.first)?.frame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let win = NSWindow(contentRect: frame,
                           styleMask: [.borderless],
                           backing: .buffered, defer: false)
        win.level = .mainMenu + 1
        win.backgroundColor = .black
        win.isOpaque = true
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        win.setFrame(frame, display: true)
        web.frame = win.contentView?.bounds ?? .zero
        web.autoresizingMask = [.width, .height]
        win.contentView?.addSubview(web)
        vizWindow = win
    }
}
