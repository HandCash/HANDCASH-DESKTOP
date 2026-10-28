import Foundation
import LocalAuthentication

/// Device-unlock factor: DEK sealed with Keychain AES-GCM, gated by Touch ID /
/// device owner auth. Same durable key as Electron (`handcash.brc100.deviceDek.v1`).
enum DeviceAuth {
    private static let deviceDekKey = "handcash.brc100.deviceDek.v1"

    static func status() -> [String: Any] {
        let available = canPrompt()
        let enrolled = available && DurableStore.shared.get(deviceDekKey) != nil
        return [
            "available": available,
            "enrolled": enrolled,
            "label": "Touch ID",
            "strongBox": true,
        ]
    }

    static func enroll(secret: String, completion: @escaping ([String: Any]) -> Void) {
        guard !secret.isEmpty else {
            completion(["ok": false, "error": "Unlock material required"])
            return
        }
        guard canPrompt() else {
            completion(["ok": false, "error": "OS keychain sealing is not available on this device"])
            return
        }
        prompt(reason: "Enable device unlock for HandCash") { result in
            switch result {
            case .failure(let err):
                completion(["ok": false, "error": err.text])
            case .success:
                guard KeychainSeal.isAvailable() else {
                    completion(["ok": false, "error": "OS keychain sealing is not available on this device"])
                    return
                }
                let sealed = KeychainSeal.seal(secret)
                guard KeychainSeal.isSealed(sealed) else {
                    completion(["ok": false, "error": "Could not store device unlock material"])
                    return
                }
                let wrote = DurableStore.shared.set(deviceDekKey, sealed, allowVaultIdentityReplace: false)
                completion(wrote
                    ? ["ok": true]
                    : ["ok": false, "error": "Could not store device unlock material"])
            }
        }
    }

    static func unlock(reason: String?, completion: @escaping ([String: Any]) -> Void) {
        let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let why = trimmed.isEmpty ? "Unlock HandCash" : trimmed
        guard canPrompt() else {
            completion(["ok": false, "error": "OS keychain sealing is not available"])
            return
        }
        guard let raw = DurableStore.shared.get(deviceDekKey), KeychainSeal.isSealed(raw) else {
            completion(["ok": false, "error": "Device unlock is not enabled"])
            return
        }
        prompt(reason: why) { result in
            switch result {
            case .failure(let err):
                completion(["ok": false, "error": err.text])
            case .success:
                do {
                    let secret = try KeychainSeal.unseal(raw)
                    guard !secret.isEmpty else {
                        completion(["ok": false, "error": "Device unlock failed"])
                        return
                    }
                    completion(["ok": true, "secret": secret])
                } catch let err as KeychainSeal.SealError {
                    completion(["ok": false, "error": err.message])
                } catch {
                    completion(["ok": false, "error": "Device unlock failed"])
                }
            }
        }
    }

    static func clear() -> [String: Any] {
        _ = DurableStore.shared.remove(deviceDekKey)
        return ["ok": true]
    }

    private static func canPrompt() -> Bool {
        guard KeychainSeal.isAvailable() else { return false }
        let ctx = LAContext()
        var error: NSError?
        return ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
            || ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    }

    private enum AuthFailure: Error {
        case message(String)
        var text: String {
            switch self {
            case .message(let s): return s
            }
        }
    }

    private static func prompt(reason: String, completion: @escaping (Result<Void, AuthFailure>) -> Void) {
        let ctx = LAContext()
        var bioError: NSError?
        let policy: LAPolicy =
            ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &bioError)
            ? .deviceOwnerAuthenticationWithBiometrics
            : .deviceOwnerAuthentication
        ctx.evaluatePolicy(policy, localizedReason: reason) { ok, err in
            DispatchQueue.main.async {
                if ok {
                    completion(.success(()))
                    return
                }
                if let ns = err as NSError?,
                   ns.domain == LAErrorDomain,
                   ns.code == LAError.userCancel.rawValue
                    || ns.code == LAError.appCancel.rawValue
                    || ns.code == LAError.systemCancel.rawValue
                {
                    completion(.failure(.message("cancelled")))
                    return
                }
                let message = err?.localizedDescription ?? "Touch ID failed"
                let lower = message.lowercased()
                if lower.contains("cancel") || lower.contains("denied") {
                    completion(.failure(.message("cancelled")))
                } else {
                    completion(.failure(.message(message)))
                }
            }
        }
    }
}
