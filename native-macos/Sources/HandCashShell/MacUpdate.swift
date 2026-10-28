import AppKit
import Foundation

/// Mac BETA: HandCash GitHub releases → arch-matched DMG (ShipIt-unsafe).
/// Feeds the titlebar update pill; never Alignity's feed. No electron-updater.
final class MacUpdate {
    static let shared = MacUpdate()

    typealias StatusHandler = (_ status: [String: Any]) -> Void

    private let lock = NSLock()
    private var mode: String = "default"
    private var phase: String = "idle"
    private var availableVersion: String?
    private var error: String?
    private var canInstall = false
    private var currentVersion: String = "0.0.0"
    private var checkTask: URLSessionDataTask?
    private var pollTimer: Timer?

    var onStatus: StatusHandler?

    private let hint =
        "Installer opened — drag HandCash into Applications to finish updating."

    func configure(currentVersion: String) {
        lock.lock()
        self.currentVersion = currentVersion
        lock.unlock()
        push()
        applyModePolling()
    }

    func statusSnapshot() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return [
            "phase": phase,
            "mode": mode,
            "currentVersion": currentVersion,
            "availableVersion": availableVersion ?? NSNull(),
            "percent": NSNull(),
            "error": error ?? NSNull(),
            "canInstall": canInstall,
        ]
    }

    func setMode(_ next: String) -> [String: Any] {
        let allowed = ["default", "manual", "none"]
        lock.lock()
        if allowed.contains(next) { mode = next }
        lock.unlock()
        applyModePolling()
        return statusSnapshot()
    }

    func check(shouldOpen: Bool, completion: @escaping ([String: Any]) -> Void) {
        lock.lock()
        let ver = currentVersion
        let currentMode = mode
        phase = "checking"
        error = nil
        lock.unlock()
        push()

        if currentMode == "none" {
            lock.lock()
            phase = "idle"
            availableVersion = nil
            canInstall = false
            lock.unlock()
            let snap = statusSnapshot()
            completion(snap)
            push()
            return
        }

        var req = URLRequest(
            url: URL(string: "https://api.github.com/repos/HandCash/HANDCASH-DESKTOP/releases?per_page=20")!
        )
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("HandCash-Desktop/\(ver)", forHTTPHeaderField: "User-Agent")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.timeoutInterval = 25

        checkTask?.cancel()
        checkTask = URLSession.shared.dataTask(with: req) { [weak self] data, response, err in
            guard let self else { return }
            DispatchQueue.main.async {
                self.handleCheck(
                    data: data,
                    response: response,
                    err: err,
                    currentVersion: ver,
                    shouldOpen: shouldOpen,
                    completion: completion
                )
            }
        }
        checkTask?.resume()
    }

    func installOrOpen(completion: @escaping (Result<Void, Error>) -> Void) {
        lock.lock()
        let ver = availableVersion
        lock.unlock()
        guard let ver, let url = Self.dmgURL(version: ver) else {
            completion(.failure(NSError(
                domain: "MacUpdate",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "no update ready"]
            )))
            return
        }
        NSWorkspace.shared.open(url)
        lock.lock()
        phase = "ready"
        canInstall = true
        error = hint
        lock.unlock()
        push()
        completion(.success(()))
    }

    private func handleCheck(
        data: Data?,
        response: URLResponse?,
        err: Error?,
        currentVersion: String,
        shouldOpen: Bool,
        completion: @escaping ([String: Any]) -> Void
    ) {
        if let err {
            lock.lock()
            phase = "error"
            error = err.localizedDescription
            canInstall = false
            lock.unlock()
            let snap = statusSnapshot()
            completion(snap)
            push()
            return
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        else {
            lock.lock()
            phase = "error"
            error = "GitHub release check failed (\(status))"
            canInstall = false
            lock.unlock()
            let snap = statusSnapshot()
            completion(snap)
            push()
            return
        }

        let arch: String = {
            #if arch(arm64)
            return "arm64"
            #else
            return "x64"
            #endif
        }()

        if let release = Self.selectRelease(releases: json, current: currentVersion, arch: arch) {
            lock.lock()
            phase = "available"
            availableVersion = release.version
            canInstall = true
            error = nil
            lock.unlock()
            if shouldOpen, let url = URL(string: release.dmgUrl) {
                NSWorkspace.shared.open(url)
                lock.lock()
                phase = "ready"
                canInstall = true
                error = hint
                lock.unlock()
            }
        } else {
            lock.lock()
            phase = "not-available"
            availableVersion = nil
            canInstall = false
            error = nil
            lock.unlock()
        }
        let snap = statusSnapshot()
        completion(snap)
        push()
    }

    private func push() {
        let snap = statusSnapshot()
        DispatchQueue.main.async { [weak self] in
            self?.onStatus?(snap)
        }
    }

    private func applyModePolling() {
        pollTimer?.invalidate()
        pollTimer = nil
        lock.lock()
        let m = mode
        lock.unlock()
        guard m == "default" else { return }
        // Background poll ~4h, matching Electron autoUpdate.
        pollTimer = Timer.scheduledTimer(withTimeInterval: 4 * 60 * 60, repeats: true) { [weak self] _ in
            self?.check(shouldOpen: false) { _ in }
        }
    }

    private struct Release {
        let version: String
        let dmgUrl: String
    }

    private static func selectRelease(
        releases: [[String: Any]],
        current: String,
        arch: String
    ) -> Release? {
        var candidates: [Release] = []
        for release in releases {
            if release["draft"] as? Bool == true { continue }
            let tag = (release["tag_name"] as? String ?? "").trimmingCharacters(in: .whitespaces)
            let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
            guard semverCompare(version, current) > 0 else { continue }
            let expected = "HandCash-\(version)-\(arch)-mac.dmg"
            guard let assets = release["assets"] as? [[String: Any]] else { continue }
            guard let asset = assets.first(where: { ($0["name"] as? String) == expected }),
                  let url = asset["browser_download_url"] as? String
            else { continue }
            candidates.append(Release(version: version, dmgUrl: url))
        }
        candidates.sort { semverCompare($0.version, $1.version) > 0 }
        return candidates.first
    }

    private static func dmgURL(version: String) -> URL? {
        let arch: String = {
            #if arch(arm64)
            return "arm64"
            #else
            return "x64"
            #endif
        }()
        let tag = version.hasPrefix("v") ? version : "v\(version)"
        let semver = version.hasPrefix("v") ? String(version.dropFirst()) : version
        return URL(
            string:
                "https://github.com/HandCash/HANDCASH-DESKTOP/releases/download/\(tag)/HandCash-\(semver)-\(arch)-mac.dmg"
        )
    }

    /// Returns positive if a > b.
    private static func semverCompare(_ a: String, _ b: String) -> Int {
        func parts(_ s: String) -> [Int] {
            let core = s.split(separator: "-").first.map(String.init) ?? s
            return core.split(separator: ".").prefix(3).map { Int($0) ?? 0 }
        }
        let left = parts(a)
        let right = parts(b)
        for i in 0..<3 {
            let l = i < left.count ? left[i] : 0
            let r = i < right.count ? right[i] : 0
            if l != r { return l - r }
        }
        return 0
    }
}
