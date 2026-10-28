import CryptoKit
import Foundation
import WebKit

/// File-backed durable store for the thin Mac shell (Mobile-shaped).
/// Vault keys (`handcash.brc100.vault*`) are AES-GCM sealed with a Keychain-held
/// key when available — see KeychainSeal and docs/thin-desktop-shell.md.
final class DurableStore {
    static let shared = DurableStore(directory: DurableStore.defaultDirectory())

    private static let vaultKey = "handcash.brc100.vault.v1"
    private static let vaultBackupKey = "handcash.brc100.vault.backup.v1"
    private static let vaultHistoryPrefix = "handcash.brc100.vault.history."
    private static let maxVaultHistory = 10
    private static let vaultSealStatusKey = "handcash.brc100.vaultSealStatus"
    private static let maxPlainName = 200
    private static let hashedPrefix = "h-"
    private static let keySidecar = ".key"
    private static let tmpSuffix = ".tmp"

    private let dir: URL
    private let fm = FileManager.default
    private var cache: [String: String?] = [:]
    private let diskLock = NSLock()
    private let writer = DispatchQueue(label: "io.handcash.desktop.durable-writer")
    private(set) var vaultOpenError: String?

    static func defaultDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base
            .appendingPathComponent("HandCash", isDirectory: true)
            .appendingPathComponent("thin-shell", isDirectory: true)
            .appendingPathComponent("durable", isDirectory: true)
    }

    init(directory: URL) {
        dir = directory
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var url = dir
            try url.setResourceValues(values)
        } catch {
            NSLog("[DurableStore] prepare failed: %@", error.localizedDescription)
        }
    }

    func get(_ key: String) -> String? {
        if key.isEmpty { return nil }
        if let held = cache[key] { return held }
        guard let raw = readFile(key) else {
            cache[key] = .some(nil)
            return nil
        }
        do {
            let plain = try openIfVault(key, raw)
            cache[key] = .some(plain)
            if key == Self.vaultKey { vaultOpenError = nil }
            return plain
        } catch let err as KeychainSeal.SealError {
            if key == Self.vaultKey { vaultOpenError = err.message }
            NSLog("[DurableStore] unseal failed: %@", err.message)
            cache[key] = .some(nil)
            return nil
        } catch {
            if key == Self.vaultKey {
                vaultOpenError = "Could not decrypt wallet vault from OS keychain."
            }
            cache[key] = .some(nil)
            return nil
        }
    }

    func set(_ key: String, _ value: String, allowVaultIdentityReplace: Bool) -> Bool {
        if key.isEmpty { return false }
        if value.isEmpty { return remove(key) }
        if key == Self.vaultKey, let previous = get(key), previous != value {
            if !vaultReplaceAllowed(previous, value, allowVaultIdentityReplace) { return false }
            if !archiveVault(previous) { return false }
        }
        let toStore = sealIfVault(key, value)
        let ok = put(key, toStore, cachePlain: value)
        if ok, key == Self.vaultKey {
            vaultOpenError = nil
            _ = put(
                Self.vaultSealStatusKey,
                KeychainSeal.isSealed(toStore) ? "sealed" : "unsealed",
                cachePlain: KeychainSeal.isSealed(toStore) ? "sealed" : "unsealed"
            )
        }
        return ok
    }

    func safeStorageAvailable() -> Bool {
        KeychainSeal.isAvailable()
    }

    func remove(_ key: String) -> Bool {
        if key.isEmpty { return false }
        diskLock.lock()
        defer { diskLock.unlock() }
        let url = fileURL(for: key)
        try? fm.removeItem(at: url)
        try? fm.removeItem(at: sidecarURL(for: key))
        cache[key] = .some(nil)
        return true
    }

    func keys() -> [String] {
        diskLock.lock()
        defer { diskLock.unlock() }
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return [] }
        var out: [String] = []
        for name in names where !name.hasSuffix(Self.tmpSuffix) && !name.hasSuffix(Self.keySidecar) {
            if name.hasPrefix(Self.hashedPrefix) {
                let side = dir.appendingPathComponent(name + Self.keySidecar)
                if let k = try? String(contentsOf: side, encoding: .utf8) { out.append(k) }
            } else {
                out.append(name)
            }
        }
        return out
    }

    func wipeAll() -> Int {
        diskLock.lock()
        defer { diskLock.unlock() }
        let before = (try? fm.contentsOfDirectory(atPath: dir.path))?.count ?? 0
        try? fm.removeItem(at: dir)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        cache.removeAll()
        return before
    }

    func drain() {
        writer.sync {}
    }

    private func put(_ key: String, _ value: String, cachePlain: String? = nil) -> Bool {
        diskLock.lock()
        defer { diskLock.unlock() }
        let url = fileURL(for: key)
        let tmp = url.appendingPathExtension("tmp")
        do {
            try value.write(to: tmp, atomically: true, encoding: .utf8)
            if fm.fileExists(atPath: url.path) { try fm.removeItem(at: url) }
            try fm.moveItem(at: tmp, to: url)
            if key.count > Self.maxPlainName {
                try key.write(to: sidecarURL(for: key), atomically: true, encoding: .utf8)
            }
            cache[key] = .some(cachePlain ?? value)
            return true
        } catch {
            NSLog("[DurableStore] put failed: %@", error.localizedDescription)
            try? fm.removeItem(at: tmp)
            return false
        }
    }

    private func readFile(_ key: String) -> String? {
        diskLock.lock()
        defer { diskLock.unlock() }
        return try? String(contentsOf: fileURL(for: key), encoding: .utf8)
    }

    private func isVaultKey(_ key: String) -> Bool {
        key.hasPrefix("handcash.brc100.vault")
    }

    /** Same identity may update (fingerprint, password rewrap); only a new identity needs allow. */
    private func vaultReplaceAllowed(_ previous: String, _ next: String, _ allow: Bool) -> Bool {
        guard
            let before = identityKey(previous),
            let after = identityKey(next)
        else {
            NSLog("[DurableStore] vault guard parse failed — refusing write")
            return false
        }
        if before.isEmpty || after.isEmpty || before == after { return true }
        if !allow {
            NSLog(
                "[DurableStore] blocked vault identity overwrite %@ → %@",
                String(before.prefix(12)),
                String(after.prefix(12))
            )
            return false
        }
        NSLog("[DurableStore] allowing vault identity replace (recovery)")
        return true
    }

    private func identityKey(_ json: String) -> String? {
        guard
            let data = json.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object["identityKey"] as? String ?? ""
    }

    /** Keep the replaced vault, as Electron/Mobile do: a backup plus the last ten. */
    private func archiveVault(_ previous: String) -> Bool {
        let sealed = sealIfVault(Self.vaultBackupKey, previous)
        if !put(Self.vaultBackupKey, sealed, cachePlain: previous) { return false }
        let stamp = String(Int64(Date().timeIntervalSince1970 * 1000))
        let historyKey = Self.vaultHistoryPrefix + stamp
        let historySealed = sealIfVault(historyKey, previous)
        if !put(historyKey, historySealed, cachePlain: previous) { return false }
        var history = keys().filter { $0.hasPrefix(Self.vaultHistoryPrefix) }.sorted()
        while history.count > Self.maxVaultHistory {
            _ = remove(history.removeFirst())
        }
        return true
    }

    private func sealIfVault(_ key: String, _ value: String) -> String {
        guard isVaultKey(key) else { return value }
        if !KeychainSeal.isAvailable() { return value }
        return KeychainSeal.seal(value)
    }

    private func openIfVault(_ key: String, _ raw: String) throws -> String {
        guard isVaultKey(key) else { return raw }
        return try KeychainSeal.unseal(raw)
    }

    private func fileURL(for key: String) -> URL {
        if key.count <= Self.maxPlainName {
            return dir.appendingPathComponent(key, isDirectory: false)
        }
        let digest = sha256Hex(key)
        return dir.appendingPathComponent(Self.hashedPrefix + digest, isDirectory: false)
    }

    private func sidecarURL(for key: String) -> URL {
        URL(fileURLWithPath: fileURL(for: key).path + Self.keySidecar)
    }

    private func sha256Hex(_ text: String) -> String {
        let digest = SHA256.hash(data: Data(text.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

/// Sync custody I/O via window.prompt — same shape as Mobile DurableStorePrompt.
final class DurableStorePrompt: NSObject, WKUIDelegate {
    static let requestType = "HandcashDurableStore"

    private let fallback: WKUIDelegate?
    private let store: DurableStore
    private let origin: URL

    static let pageScript = """
    (function () {
      if (window.HandcashDurableStore) return;
      var T = 'HandcashDurableStore';
      var held = new Map();
      function ask(msg) {
        var raw = window.prompt(JSON.stringify(Object.assign({ type: T }, msg)));
        var res = raw == null ? null : JSON.parse(raw);
        if (!res || res.error) throw new Error('durable store: ' + (res && res.error || 'no answer'));
        return res;
      }
      function attempt(msg) {
        if (msg.key === 'handcash.brc100.vault.v1') {
          held.forEach(function (_, k) { if (k.indexOf('handcash.brc100.vault.') === 0) held.delete(k); });
        }
        try { return ask(msg).ok === true; } catch (e) { console.warn(String(e)); return false; }
      }
      Object.defineProperty(window, 'HandcashDurableStore', {
        value: Object.freeze({
          get: function (key) {
            key = String(key);
            if (held.has(key)) return held.get(key);
            var value = ask({ op: 'get', key: key }).value;
            held.set(key, value == null ? null : value);
            return value == null ? null : value;
          },
          set: function (key, value, allowVaultIdentityReplace) {
            key = String(key);
            value = String(value);
            var ok = attempt({ op: 'set', key: key, value: value, allow: allowVaultIdentityReplace === true });
            if (ok) held.set(key, value === '' ? null : value); else held.delete(key);
            return ok;
          },
          remove: function (key) {
            key = String(key);
            var ok = attempt({ op: 'remove', key: key });
            if (ok) held.set(key, null); else held.delete(key);
            return ok;
          },
          keys: function () {
            return JSON.stringify(ask({ op: 'keys' }).keys);
          },
        }),
        writable: false,
        configurable: false,
      });
    })();
    """

    init(fallback: WKUIDelegate?, store: DurableStore, origin: URL) {
        self.fallback = fallback
        self.store = store
        self.origin = origin
    }

    /// Wire the prompt delegate. Caller must add `pageScript` to the
    /// WKWebViewConfiguration before creating the web view.
    static func attach(to webView: WKWebView, store: DurableStore, origin: URL) -> DurableStorePrompt {
        let prompt = DurableStorePrompt(fallback: webView.uiDelegate, store: store, origin: origin)
        webView.uiDelegate = prompt
        return prompt
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        if let reply = answer(prompt, frame: frame) {
            completionHandler(reply)
            return
        }
        completionHandler(nil)
    }

    private func answer(_ prompt: String, frame: WKFrameInfo) -> String? {
        guard prompt.hasPrefix("{\"type\":\"\(Self.requestType)\"") else { return nil }
        guard frame.isMainFrame, trusted(frame.securityOrigin) else {
            return reply(["error": "untrusted frame"])
        }
        guard
            let data = prompt.data(using: .utf8),
            let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            msg["type"] as? String == Self.requestType,
            let op = msg["op"] as? String
        else { return reply(["error": "bad request"]) }

        let key = msg["key"] as? String ?? ""
        switch op {
        case "get":
            return reply(["value": store.get(key).map { $0 as Any } ?? NSNull()])
        case "set":
            guard let value = msg["value"] as? String else { return reply(["error": "value required"]) }
            return reply([
                "ok": store.set(key, value, allowVaultIdentityReplace: msg["allow"] as? Bool == true),
            ])
        case "remove":
            return reply(["ok": store.remove(key)])
        case "keys":
            return reply(["keys": store.keys()])
        default:
            return reply(["error": "unknown op"])
        }
    }

    private func trusted(_ source: WKSecurityOrigin) -> Bool {
        source.protocol == origin.scheme && source.host == origin.host
    }

    private func reply(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8)
        else { return "{\"error\":\"encode failed\"}" }
        return text
    }
}
