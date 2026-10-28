import AppKit
import WebKit

/// WKWebView does not honour `-webkit-app-region` (Electron-only). Keep the last
/// left mouse-down so `startWindowDrag` can call `NSWindow.performDrag` after the
/// page detects a drag region.
final class ShellWebView: WKWebView {
    private(set) var lastLeftMouseDown: NSEvent?

    override func mouseDown(with event: NSEvent) {
        if event.type == .leftMouseDown {
            lastLeftMouseDown = event
        }
        super.mouseDown(with: event)
    }
}
