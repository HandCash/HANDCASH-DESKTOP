import AppKit
import Foundation
import WebKit

/// Injects window.handcash and handles async host calls.
/// BRC-100 HTTP and device-peer LAN (:3340) run in the Node sidecar (BridgeSidecar).
final class HandcashBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "handcash"

    private let uiOrigin: URL
    private weak var webView: WKWebView?
    private let appVersion: String
    private let sidecar = BridgeSidecar()

    init(uiOrigin: URL, appVersion: String = "0.0.0-native") {
        self.uiOrigin = uiOrigin
        self.appVersion = appVersion
        super.init()
        sidecar.onPushToRenderer = { [weak self] channel, payload in
            self?.pushToRenderer(channel: channel, payload: payload)
        }
        sidecar.onStatus = { [weak self] _, _, _, _ in
            self?.pushBridgeStatus()
        }
        MacUpdate.shared.configure(currentVersion: appVersion)
        MacUpdate.shared.onStatus = { [weak self] status in
            self?.pushToRenderer(channel: "update-status", payload: status)
        }
        AppBrowserGuestHost.shared.onEvent = { [weak self] event in
            self?.pushToRenderer(channel: "app-browser-guest", payload: event)
        }
    }

    func install(on controller: WKUserContentController) {
        controller.add(self, name: Self.handlerName)
        controller.addUserScript(
            WKUserScript(
                source: Self.loadPageScript(),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
    }

    func attach(webView: WKWebView) {
        self.webView = webView
        AppBrowserGuestHost.shared.attach(parent: webView)
        sidecar.startIfNeeded()
    }

    func shutdown() {
        AppBrowserGuestHost.shared.destroyAll()
        sidecar.stop()
    }

    private var isPackaged: Bool {
        ProcessInfo.processInfo.environment["HANDCASH_UI_ROOT"] != nil
            || Bundle.main.bundlePath.hasSuffix(".app")
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == Self.handlerName,
              let body = message.body as? [String: Any],
              let id = body["id"] as? String,
              let method = body["method"] as? String
        else { return }

        let params = body["params"] as? [String: Any] ?? [:]
        DispatchQueue.main.async { [weak self] in
            self?.dispatch(id: id, method: method, params: params)
        }
    }

    private func dispatch(id: String, method: String, params: [String: Any]) {
        switch method {
        case "getAppInfo":
            replyOk(id, [
                "version": appVersion,
                "name": "HandCash",
                "isPackaged": isPackaged,
                "platform": "darwin",
            ])
        case "getBridgeStatus":
            replyOk(id, sidecar.statusSnapshot())
        case "restartBridge":
            sidecar.stop()
            sidecar.startIfNeeded()
            replyOk(id, sidecar.statusSnapshot())
        case "announceBridgeReady":
            sidecar.notifyRendererReady()
            replyOk(id, true)
        case "respondHttp":
            if let payload = params["response"] {
                sidecar.sendFromRenderer(channel: "http-response", payload: payload)
            }
            replyOk(id, true)
        case "notePromptOpen":
            let open = params["open"] as? Bool ?? false
            sidecar.sendFromRenderer(channel: "bridge:prompt-open", payload: open)
            replyOk(id, true)
        case "respondDevicePeerHttp":
            if let payload = params["response"] {
                sidecar.sendFromRenderer(channel: "device-peer-http-response", payload: payload)
            }
            replyOk(id, true)
        case "openExternal":
            openExternal(id: id, params: params)
        case "focusWindow":
            NSApp.activate(ignoringOtherApps: true)
            webView?.window?.makeKeyAndOrderFront(nil)
            replyOk(id, true)
        case "startWindowDrag":
            startWindowDrag(id: id)
        case "releasePromptFocus":
            replyOk(id, true)
        case "clipboardWrite":
            clipboardWrite(id: id, params: params)
        case "copyScreenshot":
            copyScreenshot(id: id)
        case "safeStorageAvailable":
            replyOk(id, DurableStore.shared.safeStorageAvailable())
        case "vaultOpenError":
            if let err = DurableStore.shared.vaultOpenError {
                replyOk(id, err)
            } else {
                replyOk(id, NSNull())
            }
        case "getUpdateStatus":
            replyOk(id, MacUpdate.shared.statusSnapshot())
        case "checkForUpdates":
            MacUpdate.shared.check(shouldOpen: false) { [weak self] status in
                self?.replyOk(id, status)
            }
        case "downloadUpdate":
            // Mac BETA: "download" opens the DMG (no ShipIt).
            MacUpdate.shared.check(shouldOpen: true) { [weak self] status in
                self?.replyOk(id, status)
            }
        case "setUpdateMode":
            let mode = params["mode"] as? String ?? "default"
            replyOk(id, MacUpdate.shared.setMode(mode))
        case "installUpdate":
            MacUpdate.shared.installOrOpen { [weak self] result in
                switch result {
                case .success: self?.replyOk(id, true)
                case .failure(let err): self?.replyError(id, err.localizedDescription)
                }
            }
        case "appBrowserGuestCreate":
            appBrowserCreate(id: id, params: params)
        case "appBrowserGuestSetBounds":
            appBrowserSetBounds(id: id, params: params)
        case "appBrowserGuestNavigate":
            appBrowserNavigate(id: id, params: params)
        case "appBrowserGuestCapture":
            appBrowserCapture(id: id, params: params)
        case "appBrowserGuestDestroy":
            if let guestId = params["id"] as? String {
                AppBrowserGuestHost.shared.destroy(id: guestId)
            }
            replyOk(id, true)
        case "deviceAuthStatus":
            replyOk(id, DeviceAuth.status())
        case "deviceAuthEnroll":
            let secret = params["secret"] as? String ?? ""
            DeviceAuth.enroll(secret: secret) { [weak self] value in
                self?.replyOk(id, value)
            }
        case "deviceAuthUnlock":
            let reason = params["reason"] as? String
            DeviceAuth.unlock(reason: reason) { [weak self] value in
                self?.replyOk(id, value)
            }
        case "deviceAuthClear":
            replyOk(id, DeviceAuth.clear())
        case "wipeWalletStorage":
            replyOk(id, ["removed": DurableStore.shared.wipeAll()])
        default:
            replyError(id, "stub: " + method + " not implemented in thin Mac shell")
        }
    }

    private func pushToRenderer(channel: String, payload: Any) {
        guard let webView else { return }
        let body: [String: Any] = ["channel": channel, "payload": payload]
        guard let data = try? JSONSerialization.data(withJSONObject: body),
              let json = String(data: data, encoding: .utf8)
        else { return }
        let script = "window.__handcashNativePush && window.__handcashNativePush(" + json + ")"
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private func pushBridgeStatus() {
        pushToRenderer(channel: "bridge-status", payload: sidecar.statusSnapshot())
    }

    /// WKWebView ignores `-webkit-app-region`. The page posts this on mousedown in a
    /// drag region; we replay the stored left mouse-down into `NSWindow.performDrag`.
    /// Prefer `ShellWebView.lastLeftMouseDown` — the script bridge is async, so
    /// `NSApp.currentEvent` is often no longer a left mouse-down when we run.
    private func startWindowDrag(id: String) {
        guard let window = webView?.window else {
            replyOk(id, false)
            return
        }
        let event: NSEvent?
        if let shell = webView as? ShellWebView, let stored = shell.lastLeftMouseDown {
            event = stored
        } else if let current = NSApp.currentEvent,
                  current.type == .leftMouseDown || current.type == .leftMouseDragged
        {
            event = current
        } else {
            event = nil
        }
        guard let event else {
            replyOk(id, false)
            return
        }
        window.performDrag(with: event)
        replyOk(id, true)
    }

    private func openExternal(id: String, params: [String: Any]) {
        guard let urlString = params["url"] as? String,
              let url = URL(string: urlString),
              url.scheme == "https" || url.scheme == "http" || url.scheme == "mailto"
        else {
            replyError(id, "invalid url")
            return
        }
        NSWorkspace.shared.open(url)
        replyOk(id, true)
    }

    private func clipboardWrite(id: String, params: [String: Any]) {
        guard let text = params["text"] as? String else {
            replyError(id, "text required")
            return
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        replyOk(id, true)
    }

    /// View → Copy Screenshot / ⌘⇧S — same contract as Electron `clipboard:screenshot`.
    /// No content-protection / sharingType lock: OS capture stays allowed too.
    func copyScreenshotToClipboard(completion: (([String: Any]) -> Void)? = nil) {
        guard let webView else {
            completion?(["ok": false, "error": "No window to capture"])
            return
        }
        webView.takeSnapshot(with: nil) { [weak self] image, error in
            guard let self else { return }
            guard let image else {
                let message = error?.localizedDescription ?? "Capture was empty"
                completion?(["ok": false, "error": message])
                return
            }
            let board = NSPasteboard.general
            board.clearContents()
            board.writeObjects([image])
            let payload: [String: Any] = [
                "at": Int(Date().timeIntervalSince1970 * 1000),
                "version": self.appVersion,
            ]
            self.pushToRenderer(channel: "screenshot:copied", payload: payload)
            completion?(["ok": true, "version": self.appVersion])
        }
    }

    private func copyScreenshot(id: String) {
        copyScreenshotToClipboard { [weak self] result in
            self?.replyOk(id, result)
        }
    }

    private func replyOk(_ id: String, _ value: Any) {
        sendReply(id: id, payload: ["ok": true, "value": value])
    }

    private func replyError(_ id: String, _ error: String) {
        sendReply(id: id, payload: ["ok": false, "error": error])
    }

    private func sendReply(id: String, payload: [String: Any]) {
        guard let webView else { return }
        var body = payload
        body["id"] = id
        guard let data = try? JSONSerialization.data(withJSONObject: body),
              let json = String(data: data, encoding: .utf8)
        else { return }
        let script = "window.__handcashNativeReply && window.__handcashNativeReply(" + json + ")"
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private func guestBounds(_ params: [String: Any]) -> (CGRect, Bool) {
        let x = CGFloat(params["x"] as? Double ?? Double(params["x"] as? Int ?? 0))
        let y = CGFloat(params["y"] as? Double ?? Double(params["y"] as? Int ?? 0))
        let w = CGFloat(params["width"] as? Double ?? Double(params["width"] as? Int ?? 0))
        let h = CGFloat(params["height"] as? Double ?? Double(params["height"] as? Int ?? 0))
        let visible = params["visible"] as? Bool ?? false
        return (CGRect(x: x, y: y, width: w, height: h), visible)
    }

    private func appBrowserCreate(id: String, params: [String: Any]) {
        guard let guestId = params["id"] as? String,
              let url = params["url"] as? String
        else {
            replyError(id, "id and url required")
            return
        }
        let (bounds, visible) = guestBounds(params)
        do {
            try AppBrowserGuestHost.shared.create(id: guestId, url: url, bounds: bounds, visible: visible)
            replyOk(id, true)
        } catch {
            replyError(id, "This device cannot open apps inside HandCash.")
        }
    }

    private func appBrowserSetBounds(id: String, params: [String: Any]) {
        guard let guestId = params["id"] as? String else {
            replyError(id, "id required")
            return
        }
        let (bounds, visible) = guestBounds(params)
        AppBrowserGuestHost.shared.setBounds(id: guestId, bounds: bounds, visible: visible)
        replyOk(id, true)
    }

    private func appBrowserNavigate(id: String, params: [String: Any]) {
        guard let guestId = params["id"] as? String,
              let action = params["action"] as? String
        else {
            replyError(id, "id and action required")
            return
        }
        AppBrowserGuestHost.shared.navigate(id: guestId, action: action)
        replyOk(id, true)
    }

    private func appBrowserCapture(id: String, params: [String: Any]) {
        guard let guestId = params["id"] as? String else {
            replyError(id, "id required")
            return
        }
        let width = params["width"] as? Int ?? Int(params["width"] as? Double ?? 0)
        AppBrowserGuestHost.shared.capture(id: guestId, width: width) { [weak self] dataUrl in
            var body: [String: Any] = [:]
            if let dataUrl {
                body["dataUrl"] = dataUrl
            } else {
                body["dataUrl"] = NSNull()
            }
            self?.replyOk(id, body)
        }
    }

    private static func loadPageScript() -> String {
        let candidates: [String] = {
            var paths: [String] = []
            if let env = ProcessInfo.processInfo.environment["HANDCASH_SHELL_PAGE_JS"] {
                paths.append(env)
            }
            if let res = Bundle.main.resourceURL?
                .appendingPathComponent("handcash-page.js").path
            {
                paths.append(res)
            }
            paths.append(
                URL(fileURLWithPath: #filePath)
                    .deletingLastPathComponent()
                    .appendingPathComponent("handcash-page.js")
                    .path
            )
            return paths
        }()
        for path in candidates {
            if let text = try? String(contentsOfFile: path, encoding: .utf8) {
                return text
            }
        }
        NSLog("[HandCashShell] missing handcash-page.js")
        return "console.error('[HandCashShell] handcash-page.js missing');"
    }
}
