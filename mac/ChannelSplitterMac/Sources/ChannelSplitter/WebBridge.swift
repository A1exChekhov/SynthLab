import SwiftUI
import WebKit

/// Locate the bundled app_web directory (Contents/Resources/app_web inside the .app,
/// or the source Resources/app_web during `swift run`). Shared by the main window,
/// the mini player, and the fullscreen visualizer.
func appWebDirURL() -> URL? {
    if let r = Bundle.main.resourceURL {
        let inApp = r.appendingPathComponent("app_web")
        if FileManager.default.fileExists(atPath: inApp.appendingPathComponent("index.html").path) {
            return inApp
        }
    }
    let here = URL(fileURLWithPath: #filePath)
    let dev = here.deletingLastPathComponent()  // Sources/ChannelSplitter
        .deletingLastPathComponent()            // Sources
        .deletingLastPathComponent()            // package root
        .appendingPathComponent("Resources/app_web")
    if FileManager.default.fileExists(atPath: dev.appendingPathComponent("index.html").path) {
        return dev
    }
    return nil
}

/// Hosts the Windows web UI (app_web/index.html) inside a WKWebView and bridges
/// `window.pywebview.api.<method>(...)` calls to the Swift `AppModel` backend,
/// mirroring the Python `AppCore` js_api 1:1.
struct WebRootView: NSViewRepresentable {
    @EnvironmentObject var model: AppModel

    func makeCoordinator() -> Bridge { Bridge(model: model) }

    func makeNSView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let ucc = WKUserContentController()
        ucc.add(context.coordinator, name: "bridge")
        // Inject the pywebview shim at documentStart so app.js sees window.pywebview.api immediately.
        let shim = WKUserScript(source: Bridge.shimJS,
                                injectionTime: .atDocumentStart,
                                forMainFrameOnly: true)
        ucc.addUserScript(shim)
        cfg.userContentController = ucc

        let web = WKWebView(frame: .zero, configuration: cfg)
        web.setValue(false, forKey: "drawsBackground") // dark UI, no white flash
        // Match the page's base color so any uncovered region (overscroll, brief layout
        // gaps) blends into the UI instead of showing a black strip.
        web.underPageBackgroundColor = Bridge.uiBaseColor
        web.autoresizingMask = [.width, .height]       // always fill the hosting window
        context.coordinator.webView = web

        if let dir = appWebDirURL() {
            web.loadFileURL(dir.appendingPathComponent("index.html"),
                            allowingReadAccessTo: dir)
        }

        // Paint the hosting NSWindow with the dark UI base color as soon as it exists,
        // so any uncovered region — especially the extra space when the user enters
        // native full-screen and the content is shorter than the display — shows the
        // dark UI color instead of a black strip. (The window only gets attached a beat
        // after makeNSView, so retry briefly.)
        func paintWindow(_ tries: Int) {
            if let win = web.window {
                win.backgroundColor = Bridge.uiBaseColor
                win.isOpaque = true
                // Closing the main window hides it to the tray instead of quitting.
                if win.delegate == nil { win.delegate = context.coordinator }
            } else if tries > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { paintWindow(tries - 1) }
            }
        }
        DispatchQueue.main.async { paintWindow(20) }
        return web
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

/// WKScriptMessageHandler: receives {id, method, args} from JS, dispatches to AppModel,
/// and resolves the JS Promise via window.__cs_resolve(id, <json>).
final class Bridge: NSObject, WKScriptMessageHandler, NSWindowDelegate {
    let model: AppModel
    weak var webView: WKWebView?

    /// Red-button / Cmd-W hides the main window to the tray instead of quitting the app
    /// (the menu-bar item's "Show window" brings it back). Mirrors Windows tray behaviour.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    init(model: AppModel) {
        self.model = model
        super.init()
        model.bridge = self
    }

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let id = (body["id"] as? NSNumber)?.intValue,
              let method = body["method"] as? String else { return }
        let args = (body["args"] as? [Any]) ?? []
        model.handleBridge(method: method, args: args) { [weak self] result in
            self?.resolve(id: id, value: result)
        }
    }

    /// Push a value back into the pending JS Promise. `value` must be JSON-serializable
    /// (or nil → null). Strings/numbers/bools/arrays/dictionaries are encoded as a JS literal.
    func resolve(id: Int, value: Any?) {
        let json: String
        if let value, !(value is NSNull) {
            if let data = try? JSONSerialization.data(
                withJSONObject: JSONSerialization.isValidJSONObject(value) ? value : [value],
                options: []),
               var s = String(data: data, encoding: .utf8) {
                if !JSONSerialization.isValidJSONObject(value) {
                    // we wrapped a scalar in an array — unwrap [x] → x
                    s = String(s.dropFirst().dropLast())
                }
                json = s
            } else {
                json = "null"
            }
        } else {
            json = "null"
        }
        let js = "window.__cs_resolve && window.__cs_resolve(\(id), \(json));"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    /// The page's base (bottom-of-gradient) color, used to paint the window so no black
    /// strip shows through the transparent WKWebView.
    static let uiBaseColor = NSColor(srgbRed: 0x0e/255.0, green: 0x0f/255.0, blue: 0x11/255.0, alpha: 1)

    /// Resize the hosting NSWindow to the content size requested by the web UI (fitWindow()).
    func resizeWindow(width: CGFloat, height: CGFloat) {
        guard let win = webView?.window else { return }
        if win.backgroundColor != Bridge.uiBaseColor { win.backgroundColor = Bridge.uiBaseColor }
        let maxW = (win.screen?.visibleFrame.width ?? 2000) - 20
        let maxH = (win.screen?.visibleFrame.height ?? 1400) - 40
        let w = min(max(width, 400), maxW)
        let h = min(max(height, 300), maxH)

        // Convert desired content size → frame size, keeping the TOP-LEFT corner fixed
        // so the window shrinks from the bottom (no creeping, no black strip).
        let oldFrame = win.frame
        let newFrame = win.frameRect(forContentRect:
            NSRect(x: oldFrame.minX, y: oldFrame.minY, width: w, height: h))
        let topLeftY = oldFrame.maxY
        var f = newFrame
        f.origin.x = oldFrame.minX
        f.origin.y = topLeftY - f.height
        win.setFrame(f, display: true, animate: false)
    }

    /// Build a WKWebView wired to the shared `model` (same JS bridge contract as the
    /// main window) for secondary windows like the mini player and the visualizer.
    /// Does NOT reassign `model.bridge` — the main window keeps that role.
    static func makeSecondaryWebView(model: AppModel) -> (WKWebView, SecondaryChannel) {
        let cfg = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        let channel = SecondaryChannel(model: model)
        ucc.add(channel, name: "bridge")
        ucc.addUserScript(WKUserScript(source: Bridge.shimJS,
                                       injectionTime: .atDocumentStart,
                                       forMainFrameOnly: true))
        cfg.userContentController = ucc
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.setValue(false, forKey: "drawsBackground")
        web.underPageBackgroundColor = Bridge.uiBaseColor
        channel.webView = web
        return (web, channel)
    }

    static let shimJS = """
    (function(){
      if (window.pywebview && window.pywebview.api) return;
      var seq = 1, pending = {};
      window.__cs_resolve = function(id, val){
        var p = pending[id]; if(!p) return; delete pending[id];
        try { p.res(val); } catch(e){ p.rej(e); }
      };
      function call(method, args){
        return new Promise(function(res, rej){
          var id = seq++; pending[id] = {res:res, rej:rej};
          try { window.webkit.messageHandlers.bridge.postMessage({id:id, method:method, args:args}); }
          catch(e){ rej(e); }
        });
      }
      var methods = ["open_url","save_settings","set_ui","refresh_devices",
        "add_output","remove_output","set_output","add_source","add_loopback",
        "remove_source","set_source","set_input","toggle","test_output","set_eq","set_eq_on",
        "eq_reset","eq_presets","eq_save","eq_apply","eq_delete","set_fx","set_master",
        "resize_window","show_main","hide_main","show_mini","hide_mini","toggle_mini","mini_move",
        "quit_app","open_viz","set_viz","media_playpause","media_next","media_prev",
        "media_stop","hold_toggle","calibrate","get_state","meters","now_playing_art",
        "tuner_play","tuner_stop"];
      var api = {};
      methods.forEach(function(m){
        api[m] = function(){ return call(m, Array.prototype.slice.call(arguments)); };
      });
      window.pywebview = { api: api };
    })();
    """
}

/// Message handler for secondary windows (mini player, visualizer). Shares the same
/// `AppModel` and JS-bridge contract as `Bridge`, but does not own `model.bridge`.
final class SecondaryChannel: NSObject, WKScriptMessageHandler {
    let model: AppModel
    weak var webView: WKWebView?

    init(model: AppModel) { self.model = model; super.init() }

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let id = (body["id"] as? NSNumber)?.intValue,
              let method = body["method"] as? String else { return }
        let args = (body["args"] as? [Any]) ?? []
        model.handleBridge(method: method, args: args) { [weak self] result in
            self?.resolve(id: id, value: result)
        }
    }

    private func resolve(id: Int, value: Any?) {
        let json: String
        if let value, !(value is NSNull),
           let data = try? JSONSerialization.data(
                withJSONObject: JSONSerialization.isValidJSONObject(value) ? value : [value], options: []),
           var s = String(data: data, encoding: .utf8) {
            if !JSONSerialization.isValidJSONObject(value) { s = String(s.dropFirst().dropLast()) }
            json = s
        } else {
            json = "null"
        }
        let js = "window.__cs_resolve && window.__cs_resolve(\(id), \(json));"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
