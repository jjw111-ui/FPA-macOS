import Cocoa

@main
final class FPAApp: NSObject, NSApplicationDelegate {
    private var serverProcess: Process?
    private var serverURL: URL?
    private var statusItem: NSStatusItem?
    private var statusMenuItem: NSMenuItem?
    private var openMenuItem: NSMenuItem?
    private var outputBuffer = ""
    private let outputQueue = DispatchQueue(label: "com.fpa.launcher.output")
    private var logHandle: FileHandle?
    private var isQuitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        configureMenu()
        do {
            try launchServer()
        } catch {
            showLaunchError(error.localizedDescription)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        isQuitting = true
        serverProcess?.terminate()
        logHandle?.closeFile()
    }

    private func configureMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "FPA"
        item.button?.toolTip = "FPA · 你的设计搭子"

        let menu = NSMenu()
        let status = NSMenuItem(title: "正在启动…", action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)

        let open = NSMenuItem(title: "打开 FPA", action: #selector(openFPA), keyEquivalent: "o")
        open.target = self
        open.isEnabled = false
        menu.addItem(open)

        let data = NSMenuItem(title: "打开数据文件夹", action: #selector(openDataDirectory), keyEquivalent: "d")
        data.target = self
        menu.addItem(data)
        menu.addItem(.separator())

        let quit = NSMenuItem(title: "退出 FPA", action: #selector(quitFPA), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        item.menu = menu
        statusItem = item
        statusMenuItem = status
        openMenuItem = open
    }

    private var dataDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("FPA", isDirectory: true)
    }

    private func launchServer() throws {
        guard let resources = Bundle.main.resourceURL else {
            throw LauncherError("找不到应用资源目录。")
        }

        let node = resources.appendingPathComponent("node/bin/node")
        let app = resources.appendingPathComponent("app", isDirectory: true)
        let server = app.appendingPathComponent("scripts/portable-server.mjs")
        guard FileManager.default.isExecutableFile(atPath: node.path) else {
            throw LauncherError("缺少 macOS Node 运行时。")
        }
        guard FileManager.default.fileExists(atPath: server.path) else {
            throw LauncherError("缺少 FPA 本地服务。")
        }

        try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        let logs = dataDirectory.appendingPathComponent("logs", isDirectory: true)
        try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        let log = logs.appendingPathComponent("fpa.log")
        if !FileManager.default.fileExists(atPath: log.path) {
            FileManager.default.createFile(atPath: log.path, contents: nil)
        }
        logHandle = try FileHandle(forWritingTo: log)
        logHandle?.seekToEndOfFile()

        let stdout = Pipe()
        let stderr = Pipe()
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.consume(handle.availableData)
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.consume(handle.availableData)
        }

        let process = Process()
        process.executableURL = node
        process.arguments = [
            server.path,
            "--port", "5250",
            "--data-dir", dataDirectory.path
        ]
        process.currentDirectoryURL = app
        process.standardOutput = stdout
        process.standardError = stderr
        process.terminationHandler = { [weak self] task in
            DispatchQueue.main.async {
                guard let self, !self.isQuitting else { return }
                self.statusMenuItem?.title = "本地服务已停止"
                self.openMenuItem?.isEnabled = false
                if task.terminationStatus != 0 {
                    self.showLaunchError("本地服务意外停止，请查看数据目录中的 logs/fpa.log。")
                }
            }
        }
        try process.run()
        serverProcess = process
    }

    private func consume(_ data: Data) {
        guard !data.isEmpty else { return }
        outputQueue.async { [weak self] in
            guard let self else { return }
            self.logHandle?.write(data)
            guard self.serverURL == nil else { return }
            let text = String(decoding: data, as: UTF8.self)
            self.outputBuffer += text
            if self.outputBuffer.count > 16_384 {
                self.outputBuffer = String(self.outputBuffer.suffix(8_192))
            }
            guard let range = self.outputBuffer.range(of: #"http://127\.0\.0\.1:\d+/"#, options: .regularExpression),
                  let url = URL(string: String(self.outputBuffer[range])) else { return }
            DispatchQueue.main.async {
                guard self.serverURL == nil else { return }
                self.serverURL = url
                self.statusMenuItem?.title = "运行中 · \(url.port ?? 5250)"
                self.openMenuItem?.isEnabled = true
                NSWorkspace.shared.open(url)
            }
        }
    }

    @objc private func openFPA() {
        if let serverURL { NSWorkspace.shared.open(serverURL) }
    }

    @objc private func openDataDirectory() {
        try? FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dataDirectory)
    }

    @objc private func quitFPA() {
        NSApp.terminate(nil)
    }

    private func showLaunchError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "FPA 无法启动"
        alert.informativeText = message
        alert.addButton(withTitle: "退出")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
        NSApp.terminate(nil)
    }
}

private struct LauncherError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
