import CryptoKit
import Foundation
import Security

/// AES-GCM seal for vault / device-DEK bytes, key held in the Mac Keychain.
/// Prefix differs from Electron `sealed:v1:` (Chromium safeStorage) — those
/// blobs are not interchangeable.
enum KeychainSeal {
    static let sealedPrefix = "sealed:native:v1:"
    private static let service = "io.handcash.desktop.thin-shell"
    private static let account = "vault-seal-key-v1"

    static func isAvailable() -> Bool {
        (try? loadOrCreateKey()) != nil
    }

    static func isSealed(_ value: String) -> Bool {
        value.hasPrefix(sealedPrefix)
    }

    /// Seal plaintext. Returns original value if Keychain is unavailable.
    static func seal(_ plaintext: String) -> String {
        if plaintext.hasPrefix(sealedPrefix) { return plaintext }
        guard let key = try? loadOrCreateKey() else { return plaintext }
        guard let data = plaintext.data(using: .utf8) else { return plaintext }
        do {
            let sealed = try AES.GCM.seal(data, using: key)
            guard let combined = sealed.combined else { return plaintext }
            return sealedPrefix + combined.base64EncodedString()
        } catch {
            NSLog("[KeychainSeal] seal failed: %@", error.localizedDescription)
            return plaintext
        }
    }

    /// Unseal or pass through. Throws if the value is sealed but cannot open.
    static func unseal(_ value: String) throws -> String {
        guard value.hasPrefix(sealedPrefix) else { return value }
        guard let key = try? loadOrCreateKey() else {
            throw SealError.keystoreUnavailable
        }
        let b64 = String(value.dropFirst(sealedPrefix.count))
        guard let combined = Data(base64Encoded: b64) else {
            throw SealError.corrupt
        }
        do {
            let box = try AES.GCM.SealedBox(combined: combined)
            let plain = try AES.GCM.open(box, using: key)
            guard let text = String(data: plain, encoding: .utf8) else {
                throw SealError.corrupt
            }
            return text
        } catch let err as SealError {
            throw err
        } catch {
            throw SealError.decryptFailed
        }
    }

    enum SealError: Error {
        case keystoreUnavailable
        case corrupt
        case decryptFailed

        var message: String {
            switch self {
            case .keystoreUnavailable:
                return "Wallet vault is locked by the OS keychain and cannot be opened."
            case .corrupt, .decryptFailed:
                return "Could not decrypt wallet vault from OS keychain."
            }
        }
    }

    private static func loadOrCreateKey() throws -> SymmetricKey {
        if let existing = try loadKeyData() {
            return SymmetricKey(data: existing)
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw SealError.keystoreUnavailable }
        let data = Data(bytes)
        try storeKeyData(data)
        return SymmetricKey(data: data)
    }

    private static func loadKeyData() throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw SealError.keystoreUnavailable
        }
        return data
    }

    private static func storeKeyData(_ data: Data) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: data,
        ]
        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw SealError.keystoreUnavailable }
    }
}
