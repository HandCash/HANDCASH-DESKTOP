import AppKit
import Foundation
import WebKit

/// Thin Mac host: one window, OS WKWebView, wallet UI on localhost:5173.
final class ShellAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var webView: ShellWebView?
    private var bridge: HandcashBridge?
    private var durablePrompt: DurableStorePrompt?
    private var uiSidecar: Process?

    private var uiOrigin: URL {
        if let env = ProcessInfo.processInfo.environment["HANDCASH_UI_ORIGIN"],
           let url = URL(string: env)
        {
            return url
        }
        return URL(string: "http://localhost:5173")!
    }

    private var appVersion: String {
        ProcessInfo.processInfo.environment["HANDCASH_APP_VERSION"]
            ?? Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
            ?? "0.0.0-native"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        startPackagedUiIfNeeded()

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        // User scripts must be registered before the WKWebView exists.
        config.userContentController.addUserScript(
            WKUserScript(
                source: DurableStorePrompt.pageScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        let bridge = HandcashBridge(uiOrigin: uiOrigin, appVersion: appVersion)
        bridge.install(on: config.userContentController)
        self.bridge = bridge

        let webView = ShellWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        self.webView = webView

        durablePrompt = DurableStorePrompt.attach(
            to: webView,
            store: DurableStore.shared,
            origin: uiOrigin
        )
        bridge.attach(webView: webView)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "HandCash"
        // UI titlebar owns the brand; keep the system strip for traffic lights only.
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 360, height: 420)
        window.contentView = webView
        window.center()
        window.delegate = self
        // Default sharing allows macOS Cmd+Shift+3/4; do not set .none or content protection.
        window.sharingType = .readWrite
        window.makeKeyAndOrderFront(nil)
        self.window = window

        installMainMenu()
        NSApp.activate(ignoringOtherApps: true)
        webView.load(URLRequest(url: uiOrigin))
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// Matches Electron View → Copy Screenshot (⌘⇧S).
    @objc private func copyScreenshotMenu(_ sender: Any?) {
        bridge?.copyScreenshotToClipboard(completion: nil)
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()

        let appName = "HandCash"
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "About \(appName)",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(
            withTitle: "Hide \(appName)",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        )
        let hideOthers = NSMenuItem(
            title: "Hide Others",
            action: #selector(NSApplication.hideOtherApplications(_:)),
            keyEquivalent: "h"
        )
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(
            withTitle: "Show All",
            action: #selector(NSApplication.unhideAllApplications(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(
            withTitle: "Quit \(appName)",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        let viewMenu = NSMenu(title: "View")
        let shot = NSMenuItem(
            title: "Copy Screenshot",
            action: #selector(copyScreenshotMenu(_:)),
            keyEquivalent: "s"
        )
        shot.keyEquivalentModifierMask = [.command, .shift]
        shot.target = self
        viewMenu.addItem(shot)
        viewMenu.addItem(NSMenuItem.separator())
        viewMenu.addItem(
            withTitle: "Reload",
            action: #selector(reloadPage(_:)),
            keyEquivalent: "r"
        )
        let viewItem = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(
            withTitle: "Minimize",
            action: #selector(NSWindow.performMiniaturize(_:)),
            keyEquivalent: "m"
        )
        windowMenu.addItem(
            withTitle: "Zoom",
            action: #selector(NSWindow.performZoom(_:)),
            keyEquivalent: ""
        )
        let windowItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        windowItem.submenu = windowMenu
        mainMenu.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func reloadPage(_ sender: Any?) {
        webView?.reload()
    }

    func windowWillClose(_ notification: Notification) {
        bridge?.shutdown()
        DurableStore.shared.drain()
        stopPackagedUi()
    }

    /// Packaged .app: Resources/app is the Vite dist; serve it on :5173.
    private func startPackagedUiIfNeeded() {
        let uiRoot =
            ProcessInfo.processInfo.environment["HANDCASH_UI_ROOT"]
            ?? Bundle.main.resourceURL?.appendingPathComponent("app").path
        guard let uiRoot,
              FileManager.default.fileExists(atPath: (uiRoot as NSString).appendingPathComponent("index.html"))
        else { return }

        let node = ProcessInfo.processInfo.environment["HANDCASH_NODE"]
            ?? Bundle.main.resourceURL?.appendingPathComponent("node").path
        let script = ProcessInfo.processInfo.environment["HANDCASH_UI_SIDECAR"]
            ?? Bundle.main.resourceURL?.appendingPathComponent("uiSidecar.cjs").path

        guard let node, let script,
              FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.fileExists(atPath: script)
        else {
            NSLog("[HandCashShell] packaged UI present but node/uiSidecar missing")
            return
        }

        // So HandcashBridge.isPackaged and child processes see the root.
        setenv("HANDCASH_UI_ROOT", uiRoot, 1)

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = [script]
        var env = ProcessInfo.processInfo.environment
        env["HANDCASH_UI_ROOT"] = uiRoot
        proc.environment = env
        do {
            try proc.run()
            uiSidecar = proc
            // Brief wait so :5173 is listening before load.
            Thread.sleep(forTimeInterval: 0.35)
        } catch {
            NSLog("[HandCashShell] failed to start ui sidecar: %@", error.localizedDescription)
        }
    }

    private func stopPackagedUi() {
        uiSidecar?.terminate()
        uiSidecar = nil
    }
}
