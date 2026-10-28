import AppKit
import Foundation
import WebKit

/// In-wallet app tabs: child WKWebViews over the panel content box (Mobile-shaped).
/// Guests talk to the local BRC-100 bridge over HTTP like a normal browser — no
/// wallet JS is injected into the guest page.
final class AppBrowserGuestHost: NSObject, WKNavigationDelegate {
    static let shared = AppBrowserGuestHost()

    typealias EventHandler = (_ event: [String: Any]) -> Void

    private weak var parentView: WKWebView?
    private var guests: [String: Guest] = [:]
    var onEvent: EventHandler?

    func attach(parent: WKWebView) {
        parentView = parent
    }

    func create(id: String, url: String, bounds: CGRect, visible: Bool) throws {
        guard let parent = parentView, let parentSuperview = parent.superview else {
            throw GuestError.noParent
        }
        destroy(id: id)

        let config = WKWebViewConfiguration()
        if #available(macOS 14.0, *) {
            config.websiteDataStore = WKWebsiteDataStore(forIdentifier: Self.storeId)
        } else {
            config.websiteDataStore = .nonPersistent()
        }
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.setValue(false, forKey: "drawsBackground")

        let guest = Guest(id: id, view: view)
        guests[id] = guest
        parentSuperview.addSubview(view)
        apply(bounds: bounds, visible: visible, to: view)

        if let target = URL(string: url) {
            emit(["id": id, "type": "loading", "url": url])
            view.load(URLRequest(url: target))
        } else {
            emit(["id": id, "type": "failed", "url": url, "description": "Invalid app URL"])
        }
    }

    func setBounds(id: String, bounds: CGRect, visible: Bool) {
        guard let guest = guests[id] else { return }
        apply(bounds: bounds, visible: visible, to: guest.view)
    }

    func navigate(id: String, action: String) {
        guard let guest = guests[id] else { return }
        switch action {
        case "back": guest.view.goBack()
        case "forward": guest.view.goForward()
        case "reload": guest.view.reload()
        case "stop": guest.view.stopLoading()
        default: break
        }
    }

    func capture(id: String, width: Int, completion: @escaping (String?) -> Void) {
        guard let guest = guests[id] else {
            completion(nil)
            return
        }
        let view = guest.view
        let config = WKSnapshotConfiguration()
        if width > 0, view.bounds.width > 0 {
            let scale = CGFloat(width) / view.bounds.width
            config.snapshotWidth = NSNumber(value: Double(width))
            _ = scale
        }
        view.takeSnapshot(with: config) { image, _ in
            guard let image,
                  let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7])
            else {
                completion(nil)
                return
            }
            completion("data:image/jpeg;base64," + jpeg.base64EncodedString())
        }
    }

    func destroy(id: String) {
        guard let guest = guests.removeValue(forKey: id) else { return }
        guest.view.navigationDelegate = nil
        guest.view.stopLoading()
        guest.view.removeFromSuperview()
    }

    func destroyAll() {
        for id in Array(guests.keys) { destroy(id: id) }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard let guest = guest(for: webView) else { return }
        emit([
            "id": guest.id,
            "type": "loading",
            "url": webView.url?.absoluteString ?? "",
        ])
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let guest = guest(for: webView) else { return }
        emit([
            "id": guest.id,
            "type": "loaded",
            "url": webView.url?.absoluteString ?? "",
            "canGoBack": webView.canGoBack,
            "canGoForward": webView.canGoForward,
        ])
        emit([
            "id": guest.id,
            "type": "navigated",
            "url": webView.url?.absoluteString ?? "",
            "canGoBack": webView.canGoBack,
            "canGoForward": webView.canGoForward,
        ])
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        fail(webView, error: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(webView, error: error)
    }

    private func fail(_ webView: WKWebView, error: Error) {
        let ns = error as NSError
        // NSURLErrorCancelled (-999) is common on redirects.
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        guard let guest = guest(for: webView) else { return }
        emit([
            "id": guest.id,
            "type": "failed",
            "url": webView.url?.absoluteString ?? "",
            "description": error.localizedDescription,
        ])
    }

    private func guest(for webView: WKWebView) -> Guest? {
        guests.values.first { $0.view === webView }
    }

    private func apply(bounds: CGRect, visible: Bool, to view: WKWebView) {
        // Off-screen when covered (matches Mobile OFFSCREEN).
        guard visible, bounds.width >= 2, bounds.height >= 2, let parent = parentView else {
            view.frame = CGRect(x: -100_000, y: -100_000, width: max(bounds.width, 2), height: max(bounds.height, 2))
            view.isHidden = true
            return
        }
        // CSS getBoundingClientRect is top-left; AppKit frames are bottom-left.
        let flipped = CGRect(
            x: bounds.minX,
            y: parent.bounds.height - bounds.minY - bounds.height,
            width: bounds.width,
            height: bounds.height
        )
        view.frame = flipped
        view.isHidden = false
    }

    private func emit(_ event: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            self?.onEvent?(event)
        }
    }

    private static let storeId = UUID(uuidString: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890")!

    private struct Guest {
        let id: String
        let view: WKWebView
    }

    enum GuestError: Error {
        case noParent
    }
}
