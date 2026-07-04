// Codex-ZH 远程接管 —— 菜单栏控制程序（LSUIElement / accessory）。
//
// 与 CodexZhConfig.swift 一致：纯视图，所有逻辑 shell 到 Node 后端 remote-backend.mjs
// （argv 子命令进，单个 JSON 出）。状态图标 + 下拉菜单：启用/停用、扫码配对（QR）、
// 已配对设备、通知设置。QR 用 CoreImage 本地生成，无第三方依赖。
//
// Args: CodexZhRemoteMenu <nodePath> <backendScript>

import Cocoa
import CoreImage
import Darwin

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
    FileHandle.standardError.write("usage: CodexZhRemoteMenu <node> <backend>\n".data(using: .utf8)!)
    exit(1)
}
let nodePath = arguments[1]
let backendScript = arguments[2]

// 单实例：启动器每次开 Codex 都会拉起本程序，启用后又有常驻 LaunchAgent；
// 用 flock 保证菜单栏只出现一个图标。锁随进程退出自动释放。
let lockDir = NSHomeDirectory() + "/.codex-zh/remote"
try? FileManager.default.createDirectory(atPath: lockDir, withIntermediateDirectories: true)
let lockFd = open(lockDir + "/menu.lock", O_CREAT | O_RDWR, 0o644)
if lockFd < 0 || flock(lockFd, LOCK_EX | LOCK_NB) != 0 {
    exit(0) // 已有实例在运行
}
// lockFd 故意不关闭，持有至进程退出

// —— 调后端：node backend <args...> → JSON ——
@discardableResult
func backend(_ args: [String]) -> [String: Any] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: nodePath)
    process.arguments = [backendScript] + args
    let stdout = Pipe()
    process.standardOutput = stdout
    process.standardError = Pipe()
    do { try process.run() } catch { return ["error": "无法启动后端"] }
    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
}

// 带临时文件输入的后端调用（notify-add）
@discardableResult
func backendWithInput(_ subcommand: String, _ payload: [String: Any]) -> [String: Any] {
    let tmp = NSTemporaryDirectory() + "codex-zh-remote-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).json"
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return ["error": "序列化失败"] }
    try? data.write(to: URL(fileURLWithPath: tmp))
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    return backend([subcommand, tmp])
}

func makeQRImage(_ text: String, size: CGFloat) -> NSImage? {
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    filter.setValue(text.data(using: .utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let output = filter.outputImage else { return nil }
    let scale = size / output.extent.width
    let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let context = CIContext()
    guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
    return NSImage(cgImage: cg, size: NSSize(width: size, height: size))
}

func copyToPasteboard(_ text: String) {
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(text, forType: .string)
}

// 中部截断长链接用于展示（完整串仍复制），如 https://…abcd#d=…wxyz
func middleTruncate(_ s: String, _ max: Int) -> String {
    guard s.count > max else { return s }
    let head = max / 2 - 1
    let tail = max - head - 1
    return String(s.prefix(head)) + "…" + String(s.suffix(tail))
}

final class MenuController: NSObject, NSMenuDelegate {
    let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var windows: [NSWindow] = []
    var qrPermURL = "" // 当前扫码页展示的永久链接（点击复制用）

    override init() {
        super.init()
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        refreshIcon(status())
    }

    func status() -> [String: Any] { backend(["status"]) }

    func refreshIcon(_ st: [String: Any]) {
        let enabled = st["enabled"] as? Bool ?? false
        let running = st["running"] as? Bool ?? false
        guard let button = statusItem.button else { return }
        // 用不同图标形状区分状态（不用变暗——深色菜单栏下变暗会看不见）：
        // 未启用=带斜杠天线，运行中=实心天线，异常=感叹号三角。全部满不透明。
        // 模板图像(isTemplate)自动适配深色/浅色菜单栏（浅色黑、深色白）。
        let candidates: [String]
        if !enabled { candidates = ["antenna.radiowaves.left.and.right.slash", "antenna.radiowaves.left.and.right"] }
        else if running { candidates = ["antenna.radiowaves.left.and.right"] }
        else { candidates = ["exclamationmark.triangle"] }
        var img: NSImage?
        for name in candidates {
            if let i = NSImage(systemSymbolName: name, accessibilityDescription: "Codex 远程") { img = i; break }
        }
        if let img = img {
            img.isTemplate = true
            button.image = img
            button.title = ""
        } else {
            button.image = nil
            button.title = enabled ? "📶" : "📴" // 极端兜底：符号都取不到时用 emoji
        }
        button.appearsDisabled = false
    }

    // 每次打开菜单时刷新
    func menuNeedsUpdate(_ menu: NSMenu) {
        let st = status()
        refreshIcon(st)
        menu.removeAllItems()
        let enabled = st["enabled"] as? Bool ?? false
        let running = st["running"] as? Bool ?? false
        let devices = st["deviceCount"] as? Int ?? 0

        let stateText: String
        if !enabled { stateText = "远程未启用" }
        else if running { stateText = "● 远程运行中" }
        else { stateText = "⚠ 已启用但未运行" }
        let head = NSMenuItem(title: stateText, action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
        if enabled { menu.addItem(withTitle: "已配对设备：\(devices)", action: nil, keyEquivalent: "").isEnabled = false }
        menu.addItem(.separator())

        if enabled {
            add(menu, "扫码配对…", #selector(doPair))
            add(menu, "已配对设备…", #selector(doDevices))
            add(menu, "通知设置…", #selector(doNotify))
            menu.addItem(.separator())
            add(menu, "停用远程", #selector(doDisable))
        } else {
            add(menu, "启用手机远程接管", #selector(doEnable))
        }
        menu.addItem(.separator())
        add(menu, "退出（不影响远程运行）", #selector(doQuit))
    }

    func add(_ menu: NSMenu, _ title: String, _ sel: Selector) {
        let item = NSMenuItem(title: title, action: sel, keyEquivalent: "")
        item.target = self
        menu.addItem(item)
    }

    @objc func doEnable() {
        let res = backend(["enable"])
        if res["error"] != nil { alert("启用失败", "\(res["error"]!)") }
        else { alert("已启用", "手机远程接管已开启并设为开机自启。点菜单里的「扫码配对」用手机连接。") }
        refreshIcon(status())
    }

    @objc func doDisable() {
        backend(["disable"])
        refreshIcon(status())
    }

    @objc func doPair() {
        let res = backend(["pair"])
        guard let url = res["url"] as? String else { alert("配对失败", "\(res["error"] ?? "未知错误")"); return }
        showQR(url)
    }

    @objc func doDevices() {
        let res = backend(["devices"])
        let devices = res["devices"] as? [[String: Any]] ?? []
        showDevices(devices)
    }

    @objc func doNotify() { showNotify() }

    @objc func doQuit() { NSApp.terminate(nil) }

    // —— 窗口 ——
    @discardableResult
    func makeWindow(_ title: String, _ content: NSView, width: CGFloat, height: CGFloat) -> NSWindow {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = title
        w.contentView = content
        w.center()
        w.isReleasedWhenClosed = false
        windows.append(w)
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
        return w
    }

    func showQR(_ url: String) {
        qrPermURL = url
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)

        let title = NSTextField(labelWithString: "扫码配对（永久）")
        title.font = .boldSystemFont(ofSize: 16)

        let imgView = NSImageView()
        imgView.image = makeQRImage(url, size: 260)
        imgView.translatesAutoresizingMaskIntoConstraints = false
        imgView.widthAnchor.constraint(equalToConstant: 260).isActive = true
        imgView.heightAnchor.constraint(equalToConstant: 260).isActive = true

        let note = NSTextField(labelWithString: "扫码即永久连接。链接含长期凭据，别转发给别人。")
        note.textColor = .secondaryLabelColor
        note.alignment = .center
        note.font = .systemFont(ofSize: 12)
        note.maximumNumberOfLines = 2
        note.translatesAutoresizingMaskIntoConstraints = false
        note.widthAnchor.constraint(equalToConstant: 300).isActive = true

        // 永久链接：整块可点、点击即复制完整 url（字号放大）
        let copyBtn = NSButton(title: middleTruncate(url, 44), target: self, action: #selector(copyPermLink(_:)))
        copyBtn.bezelStyle = .rounded
        copyBtn.font = .systemFont(ofSize: 13, weight: .medium)
        copyBtn.toolTip = "点击复制永久链接"
        copyBtn.translatesAutoresizingMaskIntoConstraints = false
        copyBtn.widthAnchor.constraint(equalToConstant: 300).isActive = true

        let hint = NSTextField(labelWithString: "↑ 点击链接即可复制到剪贴板")
        hint.textColor = .tertiaryLabelColor
        hint.font = .systemFont(ofSize: 11)

        // 一次性链接：临时发出去用，5 分钟内有效、仅一次
        let onceBtn = NSButton(title: "复制一次性链接（5 分钟）", target: self, action: #selector(copyOnceLink(_:)))
        onceBtn.bezelStyle = .rounded
        onceBtn.font = .systemFont(ofSize: 12)

        stack.addArrangedSubview(title)
        stack.addArrangedSubview(imgView)
        stack.addArrangedSubview(note)
        stack.addArrangedSubview(copyBtn)
        stack.addArrangedSubview(hint)
        stack.setCustomSpacing(20, after: hint)
        stack.addArrangedSubview(onceBtn)
        makeWindow("扫码配对", stack, width: 360, height: 470)
    }

    @objc func copyPermLink(_ sender: NSButton) {
        copyToPasteboard(qrPermURL)
        flashCopied(sender, restore: middleTruncate(qrPermURL, 44))
    }

    @objc func copyOnceLink(_ sender: NSButton) {
        let res = backend(["pair-once"])
        guard let url = res["url"] as? String else { alert("生成失败", "\(res["error"] ?? "未知错误")"); return }
        copyToPasteboard(url)
        flashCopied(sender, restore: "复制一次性链接（5 分钟）")
    }

    // 复制后短暂把按钮标题变为「已复制 ✓」再复原
    func flashCopied(_ button: NSButton, restore: String) {
        button.title = "已复制 ✓"
        button.isEnabled = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            button.title = restore
            button.isEnabled = true
        }
    }

    func showDevices(_ devices: [[String: Any]]) {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        if devices.isEmpty {
            stack.addArrangedSubview(NSTextField(labelWithString: "暂无已配对设备"))
        }
        for d in devices {
            let row = NSStackView()
            row.orientation = .horizontal
            row.spacing = 10
            let id = d["deviceId"] as? String ?? "?"
            let name = (d["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "设备 \(id.prefix(6))"
            let label = NSTextField(labelWithString: name)
            label.translatesAutoresizingMaskIntoConstraints = false
            label.widthAnchor.constraint(equalToConstant: 220).isActive = true
            let btn = NSButton(title: "移除", target: self, action: #selector(revokeTapped(_:)))
            btn.identifier = NSUserInterfaceItemIdentifier(id)
            row.addArrangedSubview(label)
            row.addArrangedSubview(btn)
            stack.addArrangedSubview(row)
        }
        makeWindow("已配对设备", stack, width: 340, height: max(120, CGFloat(60 + devices.count * 36)))
    }

    @objc func revokeTapped(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        backend(["revoke", id])
        sender.superview?.superview?.window?.close()
        showDevices(backend(["devices"])["devices"] as? [[String: Any]] ?? [])
    }

    func showNotify() {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)

        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        popup.addItems(withTitles: ["Bark", "Server酱", "企业微信", "钉钉", "自定义"])
        let field = NSTextField()
        field.placeholderString = "Bark/Server酱 填 Key；其余填 Webhook URL"
        field.translatesAutoresizingMaskIntoConstraints = false
        field.widthAnchor.constraint(equalToConstant: 320).isActive = true
        notifyPopup = popup
        notifyField = field

        let addBtn = NSButton(title: "添加", target: self, action: #selector(notifyAddTapped))
        let testBtn = NSButton(title: "发送测试", target: self, action: #selector(notifyTestTapped))
        let btnRow = NSStackView(views: [addBtn, testBtn])
        btnRow.spacing = 10

        stack.addArrangedSubview(NSTextField(labelWithString: "添加通知渠道"))
        stack.addArrangedSubview(popup)
        stack.addArrangedSubview(field)
        stack.addArrangedSubview(btnRow)
        stack.addArrangedSubview(NSTextField(labelWithString: "已配置："))
        let list = backend(["notify-list"])["notifiers"] as? [[String: Any]] ?? []
        for n in list {
            let label = n["label"] as? String ?? ""
            let idx = n["index"] as? Int ?? 0
            let row = NSStackView()
            row.spacing = 10
            let l = NSTextField(labelWithString: label)
            l.translatesAutoresizingMaskIntoConstraints = false
            l.widthAnchor.constraint(equalToConstant: 220).isActive = true
            let rm = NSButton(title: "删除", target: self, action: #selector(notifyRemoveTapped(_:)))
            rm.identifier = NSUserInterfaceItemIdentifier(String(idx))
            row.addArrangedSubview(l)
            row.addArrangedSubview(rm)
            stack.addArrangedSubview(row)
        }
        makeWindow("通知设置", stack, width: 380, height: max(240, CGFloat(220 + list.count * 34)))
    }

    var notifyPopup: NSPopUpButton?
    var notifyField: NSTextField?

    @objc func notifyAddTapped() {
        guard let popup = notifyPopup, let field = notifyField else { return }
        let value = field.stringValue.trimmingCharacters(in: .whitespaces)
        if value.isEmpty { alert("请填写", "请填入 Key 或 Webhook URL"); return }
        let types = ["bark", "serverchan", "wecom", "dingtalk", "custom"]
        let type = types[popup.indexOfSelectedItem]
        var payload: [String: Any] = ["type": type]
        if type == "bark" || type == "serverchan" { payload["key"] = value } else { payload["url"] = value }
        backendWithInput("notify-add", payload)
        for w in windows where w.title == "通知设置" { w.close() }
        showNotify()
    }

    @objc func notifyTestTapped() {
        let res = backend(["notify-test"])
        let count = res["count"] as? Int ?? 0
        alert("已发送", "已向 \(count) 个渠道发送测试通知，请检查手机。")
    }

    @objc func notifyRemoveTapped(_ sender: NSButton) {
        guard let idx = sender.identifier?.rawValue else { return }
        backend(["notify-remove", idx])
        for w in windows where w.title == "通知设置" { w.close() }
        showNotify()
    }

    func alert(_ title: String, _ message: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        a.addButton(withTitle: "好")
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = MenuController()
app.run()
