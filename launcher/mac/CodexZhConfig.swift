// Native macOS relay-config window for Codex-ZH.
//
// A single window (mirroring the Windows WinForms page): preset popup, Base URL,
// API Key, model, an advanced toggle (Provider ID / display name), a connection
// test button, and 跳过 / 保存 / 保存并启动 actions. All provider/config logic is
// delegated to the Node backend (wizard-backend.mjs) so nothing is duplicated here.
//
// Args: CodexZhConfig <nodePath> <backendScript> <codexHome>
// Prints exactly one outcome line to stdout on exit: launch | saved | skip | cancel

import Cocoa

let arguments = CommandLine.arguments
guard arguments.count >= 4 else {
    FileHandle.standardError.write("usage: CodexZhConfig <node> <backend> <codexHome>\n".data(using: .utf8)!)
    print("cancel")
    exit(1)
}
let nodePath = arguments[1]
let backendScript = arguments[2]
let codexHome = arguments[3]

struct Preset {
    var id: String
    var provider: String
    var providerName: String
    var baseUrl: String
    var model: String
    var wireApi: String
    var apiKey: String
}

func runBackend(_ args: [String]) -> [String: Any]? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: nodePath)
    process.arguments = [backendScript] + args
    let stdout = Pipe()
    process.standardOutput = stdout
    process.standardError = Pipe()
    do { try process.run() } catch { return nil }
    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

func finish(_ outcome: String) -> Never {
    FileHandle.standardOutput.write((outcome + "\n").data(using: .utf8)!)
    exit(0)
}

final class ConfigController: NSObject, NSWindowDelegate {
    let window: NSWindow
    var presets: [Preset] = []

    let presetPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let baseUrlField = NSTextField()
    let apiKeyField = NSTextField()
    let modelField = NSTextField()
    let advancedToggle = NSButton(checkboxWithTitle: "高级设置", target: nil, action: nil)
    let providerField = NSTextField()
    let nameField = NSTextField()
    let statusLabel = NSTextField(labelWithString: "")
    let testButton = NSButton(title: "测试连接", target: nil, action: nil)
    let advancedRows = NSStackView()

    override init() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 360),
            styleMask: [.titled, .closable],
            backing: .buffered, defer: false)
        super.init()
        window.title = "Codex-叉叉 中转站配置"
        window.delegate = self
        window.center()
        buildLayout()
        loadPresets()
    }

    func labeledRow(_ title: String, _ control: NSView) -> NSStackView {
        let label = NSTextField(labelWithString: title)
        label.alignment = .right
        label.setContentHuggingPriority(.required, for: .horizontal)
        label.widthAnchor.constraint(equalToConstant: 96).isActive = true
        control.translatesAutoresizingMaskIntoConstraints = false
        control.widthAnchor.constraint(equalToConstant: 400).isActive = true
        let row = NSStackView(views: [label, control])
        row.orientation = .horizontal
        row.spacing = 12
        row.alignment = .firstBaseline
        return row
    }

    func buildLayout() {
        let content = NSView()
        window.contentView = content

        let title = NSTextField(labelWithString: "选择中转站")
        title.font = NSFont.boldSystemFont(ofSize: 18)

        for field in [baseUrlField, apiKeyField, modelField, providerField, nameField] {
            field.isEditable = true
            field.isSelectable = true
        }
        baseUrlField.placeholderString = "https://api.wokey.ai"
        modelField.placeholderString = "auto"
        apiKeyField.placeholderString = "sk-..."

        advancedToggle.target = self
        advancedToggle.action = #selector(toggleAdvanced)

        advancedRows.orientation = .vertical
        advancedRows.spacing = 10
        advancedRows.alignment = .leading
        advancedRows.addArrangedSubview(labeledRow("Provider ID", providerField))
        advancedRows.addArrangedSubview(labeledRow("显示名称", nameField))
        let wireLabel = NSTextField(labelWithString: "接口类型固定为 responses（Codex Desktop 要求）")
        wireLabel.textColor = .secondaryLabelColor
        advancedRows.addArrangedSubview(labeledRow("接口类型", wireLabel))
        advancedRows.isHidden = true

        statusLabel.maximumNumberOfLines = 2
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.preferredMaxLayoutWidth = 500
        statusLabel.textColor = .secondaryLabelColor

        testButton.target = self
        testButton.action = #selector(runTest)
        let skipButton = NSButton(title: "跳过本次", target: self, action: #selector(skip))
        let saveButton = NSButton(title: "保存", target: self, action: #selector(save))
        let launchButton = NSButton(title: "保存并启动", target: self, action: #selector(saveAndLaunch))
        launchButton.keyEquivalent = "\r"
        for button in [testButton, skipButton, saveButton, launchButton] {
            button.bezelStyle = .rounded
        }

        let leftButtons = NSStackView(views: [testButton])
        leftButtons.spacing = 10
        let rightButtons = NSStackView(views: [skipButton, saveButton, launchButton])
        rightButtons.spacing = 10
        let buttonRow = NSStackView(views: [leftButtons, NSView(), rightButtons])
        buttonRow.orientation = .horizontal
        buttonRow.distribution = .equalSpacing

        let stack = NSStackView(views: [
            title,
            labeledRow("中转站模板", presetPopup),
            labeledRow("接口地址", baseUrlField),
            labeledRow("API Key", apiKeyField),
            labeledRow("模型", modelField),
            advancedToggle,
            advancedRows,
            statusLabel,
            buttonRow,
        ])
        stack.orientation = .vertical
        stack.spacing = 12
        stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            buttonRow.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48),
        ])

        presetPopup.target = self
        presetPopup.action = #selector(presetChanged)
    }

    func loadPresets() {
        guard let result = runBackend(["presets", codexHome]),
              let rawPresets = result["presets"] as? [[String: Any]] else {
            setStatus("无法加载中转站模板。", isError: true)
            return
        }
        presets = rawPresets.map { item in
            Preset(
                id: item["id"] as? String ?? "",
                provider: item["provider"] as? String ?? "",
                providerName: item["providerName"] as? String ?? "",
                baseUrl: item["baseUrl"] as? String ?? "",
                model: item["model"] as? String ?? "",
                wireApi: item["wireApi"] as? String ?? "responses",
                apiKey: item["apiKey"] as? String ?? "")
        }
        presetPopup.removeAllItems()
        presetPopup.addItems(withTitles: presets.map { $0.id })

        let current = result["current"] as? [String: Any]
        if let current = current {
            applyValues(
                provider: current["provider"] as? String ?? "",
                providerName: current["providerName"] as? String ?? "",
                baseUrl: current["baseUrl"] as? String ?? "",
                model: current["model"] as? String ?? "",
                apiKey: current["apiKey"] as? String ?? "")
            if let idx = presets.firstIndex(where: { $0.provider == (current["provider"] as? String) }) {
                presetPopup.selectItem(at: idx)
            }
        } else {
            let defaultId = result["defaultId"] as? String ?? presets.first?.id ?? ""
            if let idx = presets.firstIndex(where: { $0.id == defaultId }) {
                presetPopup.selectItem(at: idx)
            }
            applyPreset(at: presetPopup.indexOfSelectedItem)
        }
    }

    func applyPreset(at index: Int) {
        guard index >= 0 && index < presets.count else { return }
        let preset = presets[index]
        applyValues(provider: preset.provider, providerName: preset.providerName,
                    baseUrl: preset.baseUrl, model: preset.model, apiKey: preset.apiKey)
    }

    func applyValues(provider: String, providerName: String, baseUrl: String, model: String, apiKey: String) {
        providerField.stringValue = provider
        nameField.stringValue = providerName.isEmpty ? provider : providerName
        baseUrlField.stringValue = baseUrl
        modelField.stringValue = model
        apiKeyField.stringValue = apiKey
    }

    func gatherInput() -> [String: String] {
        var provider = providerField.stringValue.trimmingCharacters(in: .whitespaces)
        if provider.isEmpty { provider = presets[safe: presetPopup.indexOfSelectedItem]?.provider ?? "" }
        var name = nameField.stringValue.trimmingCharacters(in: .whitespaces)
        if name.isEmpty { name = provider }
        return [
            "provider": provider,
            "providerName": name,
            "baseUrl": baseUrlField.stringValue.trimmingCharacters(in: .whitespaces),
            "model": modelField.stringValue.trimmingCharacters(in: .whitespaces),
            "wireApi": "responses",
            "apiKey": apiKeyField.stringValue.trimmingCharacters(in: .whitespaces),
        ]
    }

    func writeTempInput(_ input: [String: String]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: input) else { return nil }
        let file = NSTemporaryDirectory() + "codex-zh-wizard-\(ProcessInfo.processInfo.processIdentifier).json"
        return (try? data.write(to: URL(fileURLWithPath: file))) != nil ? file : nil
    }

    func setStatus(_ message: String, isError: Bool) {
        statusLabel.stringValue = message
        statusLabel.textColor = isError ? .systemRed : .systemGreen
    }

    func setControlsEnabled(_ enabled: Bool) {
        for control in [testButton, presetPopup, baseUrlField, apiKeyField, modelField] as [NSControl] {
            control.isEnabled = enabled
        }
    }

    // Run a backend call off the main thread, then invoke completion on main.
    func callBackend(_ args: [String], completion: @escaping ([String: Any]?) -> Void) {
        setControlsEnabled(false)
        DispatchQueue.global().async {
            let result = runBackend(args)
            DispatchQueue.main.async {
                self.setControlsEnabled(true)
                completion(result)
            }
        }
    }

    @objc func presetChanged() { applyPreset(at: presetPopup.indexOfSelectedItem) }

    @objc func toggleAdvanced() {
        advancedRows.isHidden = advancedToggle.state != .on
        window.layoutIfNeeded()
    }

    @objc func runTest() {
        guard let file = writeTempInput(gatherInput()) else { return }
        setStatus("正在测试连接…", isError: false)
        statusLabel.textColor = .secondaryLabelColor
        callBackend(["test", file]) { result in
            let ok = result?["ok"] as? Bool ?? false
            self.setStatus(result?["message"] as? String ?? "连接测试失败。", isError: !ok)
        }
    }

    @objc func skip() { finish("skip") }

    @objc func save() {
        guard let file = writeTempInput(gatherInput()) else { return }
        callBackend(["save", file, codexHome]) { result in
            if result?["ok"] as? Bool == true {
                finish("saved")
            } else {
                self.setStatus(result?["message"] as? String ?? "保存失败。", isError: true)
            }
        }
    }

    @objc func saveAndLaunch() {
        let input = gatherInput()
        guard let file = writeTempInput(input) else { return }
        setStatus("正在测试连接…", isError: false)
        statusLabel.textColor = .secondaryLabelColor
        callBackend(["test", file]) { result in
            guard result?["ok"] as? Bool == true else {
                self.setStatus(result?["message"] as? String ?? "连接测试失败。", isError: true)
                return
            }
            self.callBackend(["save", file, codexHome]) { saveResult in
                if saveResult?["ok"] as? Bool == true {
                    finish("launch")
                } else {
                    self.setStatus(saveResult?["message"] as? String ?? "保存失败。", isError: true)
                }
            }
        }
    }

    func windowWillClose(_ notification: Notification) { finish("cancel") }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        return indices.contains(index) ? self[index] : nil
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let controller = ConfigController()
controller.window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
