import Foundation

/// Launches the Node sidecar (BRC-100 + device-peer :3340) and mediates stdio JSON ↔ WKWebView.
final class BridgeSidecar {
    typealias PushHandler = (_ channel: String, _ payload: Any) -> Void
    typealias StatusHandler = (_ online: Bool, _ httpUrl: String, _ httpsUrl: String, _ error: String?) -> Void

    private var process: Process?
    private var stdinHandle: FileHandle?
    private let queue = DispatchQueue(label: "io.handcash.desktop.bridge-sidecar")
    private var httpUrl = ""
    private var httpsUrl = ""
    private var online = false
    private var lastError: String?
    private var devicePeerLanUrls: [String] = []
    private var devicePeerOnline = false

    var onPushToRenderer: PushHandler?
    var onStatus: StatusHandler?

    func statusSnapshot() -> [String: Any] {
        [
            "online": online,
            "httpsUrl": httpsUrl,
            "httpUrl": httpUrl,
            "devicePeerPort": 3340,
            "devicePeerLanUrls": devicePeerLanUrls,
            "devicePeerOnline": devicePeerOnline,
            "error": lastError ?? NSNull(),
        ]
    }

    func startIfNeeded() {
        queue.async { [weak self] in
            self?.startLocked()
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.writeLine(["v": 1, "type": "shutdown"])
            self.process?.terminate()
            self.process = nil
            self.stdinHandle = nil
            self.online = false
            self.devicePeerOnline = false
            self.devicePeerLanUrls = []
            self.lastError = "sidecar stopped"
            self.emitStatus()
        }
    }

    func notifyRendererReady() {
        queue.async { [weak self] in
            self?.writeLine(["v": 1, "type": "renderer-ready"])
        }
    }

    func sendFromRenderer(channel: String, payload: Any) {
        queue.async { [weak self] in
            self?.writeLine([
                "v": 1,
                "type": "from-renderer",
                "channel": channel,
                "payload": payload,
            ])
        }
    }

    private func startLocked() {
        if process?.isRunning == true { return }

        guard let node = Self.resolveNode(),
              let script = Self.resolveSidecarScript()
        else {
            online = false
            lastError =
                "thin shell: bridge sidecar missing (npm run build:sidecar → dist-sidecar/bridgeSidecar.cjs)"
            emitStatus()
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = [script]
        var env = ProcessInfo.processInfo.environment
        if env["HANDCASH_USER_DATA"] == nil {
            let support = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first!
            env["HANDCASH_USER_DATA"] = support
                .appendingPathComponent("HandCashDesktopNative", isDirectory: true)
                .path
        }
        proc.environment = env

        let inPipe = Pipe()
        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardInput = inPipe
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.consumeStdout(handle.availableData)
        }
        errPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            NSLog("[bridge-sidecar stderr] %@", text)
        }

        proc.terminationHandler = { [weak self] p in
            self?.queue.async {
                guard let self else { return }
                self.online = false
                if self.lastError == nil {
                    self.lastError = "sidecar exited \(p.terminationStatus)"
                }
                self.process = nil
                self.stdinHandle = nil
                self.emitStatus()
            }
        }

        do {
            try proc.run()
            process = proc
            stdinHandle = inPipe.fileHandleForWriting
            lastError = "starting…"
            online = false
            emitStatus()
        } catch {
            online = false
            lastError = "failed to launch sidecar: \(error.localizedDescription)"
            emitStatus()
        }
    }

    private var stdoutBuffer = Data()

    private func consumeStdout(_ chunk: Data) {
        guard !chunk.isEmpty else { return }
        queue.async { [weak self] in
            guard let self else { return }
            self.stdoutBuffer.append(chunk)
            while let range = self.stdoutBuffer.range(of: Data([0x0A])) {
                let lineData = self.stdoutBuffer.subdata(in: self.stdoutBuffer.startIndex..<range.lowerBound)
                self.stdoutBuffer.removeSubrange(self.stdoutBuffer.startIndex...range.lowerBound)
                if let line = String(data: lineData, encoding: .utf8),
                   let obj = Self.parseJSON(line)
                {
                    self.handleOut(obj)
                }
            }
        }
    }

    private func handleOut(_ obj: [String: Any]) {
        let type = obj["type"] as? String ?? ""
        switch type {
        case "ready":
            httpUrl = obj["httpUrl"] as? String ?? ""
            httpsUrl = obj["httpsUrl"] as? String ?? ""
            devicePeerLanUrls = obj["devicePeerLanUrls"] as? [String] ?? []
            devicePeerOnline = obj["devicePeerOnline"] as? Bool ?? false
            online = true
            lastError = nil
            emitStatus()
        case "log":
            let level = obj["level"] as? String ?? "info"
            let message = obj["message"] as? String ?? ""
            NSLog("[bridge-sidecar %@] %@", level, message)
        case "to-renderer":
            let channel = obj["channel"] as? String ?? ""
            let payload = obj["payload"] ?? NSNull()
            DispatchQueue.main.async { [weak self] in
                self?.onPushToRenderer?(channel, payload)
            }
        case "fatal":
            online = false
            lastError = obj["message"] as? String ?? "sidecar fatal"
            emitStatus()
        default:
            NSLog("[bridge-sidecar] unknown type %@", type)
        }
    }

    private func writeLine(_ obj: [String: Any]) {
        guard let handle = stdinHandle,
              let data = try? JSONSerialization.data(withJSONObject: obj),
              var line = String(data: data, encoding: .utf8)
        else { return }
        line.append("\n")
        if let bytes = line.data(using: .utf8) {
            handle.write(bytes)
        }
    }

    private func emitStatus() {
        let snap = (online, httpUrl, httpsUrl, lastError)
        DispatchQueue.main.async { [weak self] in
            self?.onStatus?(snap.0, snap.1, snap.2, snap.3)
        }
    }

    private static func parseJSON(_ line: String) -> [String: Any]? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let data = trimmed.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return obj
    }

    private static func resolveNode() -> String? {
        if let env = ProcessInfo.processInfo.environment["HANDCASH_NODE"],
           FileManager.default.isExecutableFile(atPath: env)
        {
            return env
        }
        // Packaged .app: Resources/node
        if let res = Bundle.main.resourceURL?.appendingPathComponent("node").path,
           FileManager.default.isExecutableFile(atPath: res)
        {
            return res
        }
        for candidate in ["/usr/local/bin/node", "/opt/homebrew/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    private static func resolveSidecarScript() -> String? {
        if let env = ProcessInfo.processInfo.environment["HANDCASH_BRIDGE_SIDECAR"],
           FileManager.default.fileExists(atPath: env)
        {
            return env
        }
        // Packaged .app: Resources/bridgeSidecar.cjs
        if let res = Bundle.main.resourceURL?.appendingPathComponent("bridgeSidecar.cjs").path,
           FileManager.default.fileExists(atPath: res)
        {
            return res
        }
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // HandCashShell
            .deletingLastPathComponent() // Sources
            .deletingLastPathComponent() // native-macos
            .deletingLastPathComponent() // HANDCASH-DESKTOP
        for rel in ["dist-sidecar/bridgeSidecar.cjs", "dist-electron/bridgeSidecar.js"] {
            let path = repoRoot.appendingPathComponent(rel).path
            if FileManager.default.fileExists(atPath: path) { return path }
        }
        return nil
    }
}
