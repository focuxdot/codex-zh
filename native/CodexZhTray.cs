// Codex-ZH Windows 托盘远程控制器 —— 对齐 macOS 菜单栏 app（CodexZhRemoteMenu.swift）。
//
// 纯视图：每个操作都 shell 出到 Node 后端 launcher\win\remote-backend.mjs
//（argv 子命令进、单个 JSON 出）。系统托盘图标（三态）+ 右键菜单：扫码配对（QR，未开启时
// 点它即隐式开启远程）、已配对设备、通知设置、停用。二维码 BMP 由后端渲染，这里只显示。
//
// 用法（由 CodexZhLauncher 启动 Codex 时拉起）：
//   CodexZhTray.exe <nodePath> <backendMjsPath>
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CodexZh
{
    static class Program
    {
        static string NodePath;
        static string BackendPath;

        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        [STAThread]
        static void Main(string[] args)
        {
            if (args.Length < 2)
            {
                MessageBox.Show("用法: CodexZhTray.exe <nodePath> <backend.mjs>", "Codex-叉叉");
                return;
            }
            NodePath = args[0];
            BackendPath = args[1];

            // 单实例：命名 Mutex（对齐 Mac 的 flock），已有实例则静默退出
            bool created;
            using (var mutex = new Mutex(true, "Global\\CodexZhRemoteTray", out created))
            {
                if (!created) return;
                try { SetProcessDPIAware(); } catch { }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayContext(NodePath, BackendPath));
            }
        }
    }

    // —— Node 后端调用：argv 进，单 JSON 出 ——
    static class Backend
    {
        public static string Node;
        public static string Script;

        static string Quote(string s) { return "\"" + s + "\""; } // 参数均为路径/子命令，无内嵌引号

        public static Dictionary<string, object> Call(params string[] args)
        {
            try
            {
                var sb = new StringBuilder();
                sb.Append(Quote(Script));
                foreach (var a in args) { sb.Append(' '); sb.Append(Quote(a)); }
                var psi = new ProcessStartInfo
                {
                    FileName = Node,
                    Arguments = sb.ToString(),
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                };
                using (var p = Process.Start(psi))
                {
                    // 后台线程抽干 stderr，避免其写满管道缓冲区（>4KB）与主线程读 stdout 互相死锁。
                    var errThread = new Thread(() => { try { p.StandardError.ReadToEnd(); } catch { } }) { IsBackground = true };
                    errThread.Start();
                    string outText = p.StandardOutput.ReadToEnd();
                    errThread.Join();
                    p.WaitForExit();
                    var ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                    var obj = ser.DeserializeObject(outText) as Dictionary<string, object>;
                    return obj ?? new Dictionary<string, object>();
                }
            }
            catch (Exception ex)
            {
                return new Dictionary<string, object> { { "error", "无法启动后端: " + ex.Message } };
            }
        }

        // 需要结构化输入的命令（notify-add）：写临时 JSON 文件，传路径
        public static Dictionary<string, object> CallWithInput(string command, string json)
        {
            string tmp = Path.Combine(Path.GetTempPath(), "codex-zh-tray-" + Guid.NewGuid().ToString("N") + ".json");
            try
            {
                File.WriteAllText(tmp, json, new UTF8Encoding(false));
                return Call(command, tmp);
            }
            finally
            {
                try { File.Delete(tmp); } catch { }
            }
        }

        public static string Str(Dictionary<string, object> d, string k)
        {
            return d != null && d.ContainsKey(k) && d[k] != null ? d[k].ToString() : null;
        }
        public static bool Bool(Dictionary<string, object> d, string k)
        {
            return d != null && d.ContainsKey(k) && d[k] is bool && (bool)d[k];
        }
        public static long Long(Dictionary<string, object> d, string k)
        {
            if (d == null || !d.ContainsKey(k) || d[k] == null) return 0;
            try { return Convert.ToInt64(d[k]); } catch { return 0; }
        }
        public static bool HasKey(Dictionary<string, object> d, string k)
        {
            return d != null && d.ContainsKey(k) && d[k] != null;
        }
    }

    enum IconState { Disabled, Running, Warning }

    static class TrayIcons
    {
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool DestroyIcon(IntPtr handle);

        // 三态图标只绘制一次并缓存复用：RefreshIcon 在每次右键打开菜单时都会被调用，
        // 若每次都重绘会持续泄漏 HICON/Bitmap/Brush（GDI 句柄上限约 1 万，耗尽即崩）。
        static readonly Dictionary<IconState, Icon> cache = new Dictionary<IconState, Icon>();

        public static Icon Get(IconState state)
        {
            Icon icon;
            if (cache.TryGetValue(state, out icon)) return icon;
            icon = Build(state);
            cache[state] = icon;
            return icon;
        }

        // 运行时绘制三态图标（无需附带 .ico 资源）：信号弧 + 状态色。
        //  Disabled=灰+斜杠  Running=绿  Warning=橙
        static Icon Build(IconState state)
        {
            using (var bmp = new Bitmap(32, 32))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    Color c = state == IconState.Running ? Color.FromArgb(60, 190, 90)
                            : state == IconState.Warning ? Color.FromArgb(230, 160, 40)
                            : Color.FromArgb(150, 150, 150);
                    using (var pen = new Pen(c, 2.4f))
                    using (var dot = new SolidBrush(c))
                    {
                        // 三段信号弧（左下为原点向右上发散）+ 圆点
                        g.DrawArc(pen, 6, 6, 20, 20, 200, 50);
                        g.DrawArc(pen, 2, 2, 28, 28, 200, 50);
                        g.FillEllipse(dot, 6, 22, 6, 6);
                    }
                    if (state == IconState.Disabled)
                    {
                        using (var slash = new Pen(Color.FromArgb(210, 70, 70), 2.6f))
                            g.DrawLine(slash, 5, 27, 27, 5); // 斜杠 = 未启用
                    }
                    if (state == IconState.Warning)
                    {
                        using (var f = new Font("Segoe UI", 12, FontStyle.Bold))
                            g.DrawString("!", f, Brushes.OrangeRed, 18, 12);
                    }
                }
                // GetHicon 分配的 HICON 不受 Icon 管理：Clone 出独立副本后立即 DestroyIcon，
                // 避免句柄泄漏（缓存的 3 个副本随进程存活，无需再释放）。
                IntPtr hicon = bmp.GetHicon();
                try
                {
                    using (var tmp = Icon.FromHandle(hicon))
                        return (Icon)tmp.Clone();
                }
                finally
                {
                    DestroyIcon(hicon);
                }
            }
        }
    }

    class TrayContext : ApplicationContext
    {
        readonly NotifyIcon tray;
        readonly List<Form> windows = new List<Form>();

        // 共享字体：控件不负责释放赋给它的 Font，每次开窗新建会泄漏 GDI 字体对象。
        // 复用随进程存活的静态实例即可根治（无控件会去 Dispose 它们）。
        static readonly Font FontBase = new Font("Microsoft YaHei UI", 9f);
        static readonly Font FontTitle = new Font("Microsoft YaHei UI", 13.5f, FontStyle.Bold);
        static readonly Font FontSectionBold = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold);
        static readonly Font FontRowName = new Font("Microsoft YaHei UI", 9.5f);
        static readonly Font FontRowSub = new Font("Microsoft YaHei UI", 8.5f);

        public TrayContext(string node, string backend)
        {
            Backend.Node = node;
            Backend.Script = backend;

            tray = new NotifyIcon
            {
                Visible = true,
                Icon = TrayIcons.Get(IconState.Disabled),
                Text = "Codex-叉叉 远程",
                ContextMenuStrip = new ContextMenuStrip { Font = FontBase },
            };
            // 每次打开菜单前现取 status 重建（对齐 Mac menuNeedsUpdate，无定时器）。
            // 遵循 Windows 原生约定：仅右键弹菜单（左键不做处理）。
            tray.ContextMenuStrip.Opening += (s, e) => { e.Cancel = false; RebuildMenu(); };
            RefreshIcon(Backend.Call("status"));
        }

        void RefreshIcon(Dictionary<string, object> st)
        {
            bool enabled = Backend.Bool(st, "enabled");
            bool running = Backend.Bool(st, "running");
            IconState s = !enabled ? IconState.Disabled : (running ? IconState.Running : IconState.Warning);
            tray.Icon = TrayIcons.Get(s);
            tray.Text = !enabled ? "Codex-叉叉 远程：未启用"
                      : running ? "Codex-叉叉 远程：运行中" : "Codex-叉叉 远程：已启用但未运行";
        }

        void RebuildMenu()
        {
            var st = Backend.Call("status");
            RefreshIcon(st);
            bool enabled = Backend.Bool(st, "enabled");
            bool running = Backend.Bool(st, "running");
            long deviceCount = Backend.Long(st, "deviceCount");

            var m = tray.ContextMenuStrip;
            m.Items.Clear();

            string stateText = !enabled ? "○ 远程未开启" : (running ? "● 远程运行中" : "⚠ 已启用但未运行");
            AddInfo(m, stateText);
            if (enabled) AddInfo(m, "已配对设备：" + deviceCount);
            m.Items.Add(new ToolStripSeparator());

            // 「启动远程」用于已配对设备直接恢复连接；「扫码配对手机」仍会按需隐式启动远程。
            if (enabled)
            {
                if (!running) AddItem(m, "启动远程", (s, e) => DoEnable());
                AddItem(m, "扫码配对手机", (s, e) => DoPair());
                AddItem(m, "已配对设备", (s, e) => DoDevices());
                AddItem(m, "通知设置", (s, e) => DoNotify());
                m.Items.Add(new ToolStripSeparator());
                AddItem(m, "停用远程", (s, e) => DoDisable());
            }
            else
            {
                // 未开启态也保留单独启动入口：手机已配对时不必再打开二维码。
                AddItem(m, "启动远程", (s, e) => DoEnable());
                AddItem(m, "扫码配对手机", (s, e) => DoPair());
            }
            m.Items.Add(new ToolStripSeparator());
            AddItem(m, "退出并停止远程", (s, e) => DoQuit());
        }

        static void AddInfo(ContextMenuStrip m, string text)
        {
            var it = new ToolStripMenuItem(text) { Enabled = false };
            m.Items.Add(it);
        }
        static void AddItem(ContextMenuStrip m, string text, EventHandler onClick)
        {
            var it = new ToolStripMenuItem(text);
            it.Click += onClick;
            m.Items.Add(it);
        }

        // —— 动作 ——
        void DoDisable()
        {
            Backend.Call("disable");
            RefreshIcon(Backend.Call("status"));
        }
        bool EnsureRemoteEnabled()
        {
            var st = Backend.Call("status");
            if (Backend.Bool(st, "enabled") && Backend.Bool(st, "running")) return true;

            var en = Backend.Call("enable");
            if (Backend.HasKey(en, "error"))
            {
                Alert("开启失败", Backend.Str(en, "error"));
                return false;
            }
            RefreshIcon(Backend.Call("status"));
            return true;
        }
        void DoEnable()
        {
            if (EnsureRemoteEnabled()) Alert("远程已启动", "手机网页现在可以连接这台电脑。");
        }
        // 扫码 = 开启。未启用时先隐式开启远程（装自启 + 拉 daemon），daemon 在用户扫码的
        // 几秒间隙里完成 relay 预热；已启用则直接出码，不重启 daemon（避免打断在连的会话）。
        void DoPair()
        {
            if (!EnsureRemoteEnabled()) return;
            var res = Backend.Call("pair");
            string url = Backend.Str(res, "url");
            if (url == null) { Alert("配对失败", Backend.Str(res, "error") ?? "未知错误"); return; }
            ShowQR(url, Backend.Str(res, "qrPath"));
        }
        void DoDevices()
        {
            var res = Backend.Call("devices");
            ShowDevices(res);
        }
        void DoNotify() { ShowNotify(); }
        void DoQuit()
        {
            Backend.Call("disable");
            tray.Visible = false;
            tray.Dispose();
            ExitThread();
        }

        // —— 扫码配对窗 ——
        void ShowQR(string url, string qrPath)
        {
            var form = MakeWindow("微信扫码 · 配对C叉叉", 480, 700);
            // 单列 TableLayoutPanel：每个控件 Anchor=None → 在列内水平居中。
            // （FlowLayoutPanel TopDown 只会靠左堆叠，无法居中。）
            var root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 7,
                AutoScroll = true,
                Padding = new Padding(30, 22, 30, 22),
            };
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
            for (int i = 0; i < 7; i++) root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            form.Controls.Add(root);

            Action<Control, int> addCentered = (c, bottom) =>
            {
                c.Anchor = AnchorStyles.None;                 // 单元格内水平+垂直居中
                c.Margin = new Padding(0, 0, 0, bottom);
                root.Controls.Add(c);
            };

            addCentered(new Label { Text = "微信扫码 · 配对C叉叉", Font = FontTitle, AutoSize = true }, 6);

            // 诚实披露：点「扫码配对」已隐式开启远程，让「远程现在是开着的」这件事对用户可见。
            addCentered(new Label { Text = "● 远程已开启", ForeColor = Color.Gray, AutoSize = true }, 12);

            // 二维码白底卡片（后端已白底黑点；再垫白底防深色主题不可扫）
            var card = new Panel { Width = 300, Height = 300, BackColor = Color.White };
            var pic = new PictureBox { Width = 268, Height = 268, Left = 16, Top = 16, SizeMode = PictureBoxSizeMode.Zoom };
            // 经流读入并拷成内存位图：Image.FromFile 会长期锁住临时 BMP（后端下次可能覆盖），
            // 且 PictureBox 不负责释放其 Image，故手动在关窗时 Dispose。
            try
            {
                if (qrPath != null && File.Exists(qrPath))
                    using (var fs = File.OpenRead(qrPath))
                    using (var img = Image.FromStream(fs))
                        pic.Image = new Bitmap(img);
            }
            catch { }
            form.FormClosed += (s2, e2) => { if (pic.Image != null) { pic.Image.Dispose(); pic.Image = null; } };
            card.Controls.Add(pic);
            addCentered(card, 12);

            addCentered(new Label { Text = "扫码链接长期有效，请勿轻易转发", ForeColor = Color.Gray, AutoSize = true }, 8);

            var linkPreview = new Label { Text = LinkForDisplay(url), Width = 390, Height = 24, TextAlign = ContentAlignment.MiddleCenter, AutoEllipsis = true };
            addCentered(linkPreview, 4);

            var copyPerm = new Button { Text = "复制配对链接", Width = 380, Height = 34, FlatStyle = FlatStyle.System };
            copyPerm.Click += (s, e) => { Clipboard.SetText(url); Flash((Button)s, "复制配对链接"); };
            addCentered(copyPerm, 4);

            addCentered(new Label { Text = "↑ 点击链接即可复制到剪贴板", ForeColor = Color.Gray, AutoSize = true }, 16);

            var copyOnce = new Button { Text = "复制邀请链接（一次性 · 5 分钟）", Width = 380, Height = 34, FlatStyle = FlatStyle.System };
            copyOnce.Click += (s, e) =>
            {
                var r = Backend.Call("pair-once");
                string once = Backend.Str(r, "url");
                if (once == null) { Alert("生成失败", Backend.Str(r, "error") ?? "未知错误"); return; }
                Clipboard.SetText(once);
                Flash((Button)s, "复制邀请链接（一次性 · 5 分钟）");
            };
            addCentered(copyOnce, 0);

            form.Show();
        }

        // —— 已配对设备窗 ——
        void ShowDevices(Dictionary<string, object> res)
        {
            var form = MakeWindow("已配对设备", 480, 500);
            var root = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(20), AutoScroll = true };
            form.Controls.Add(root);

            object[] devices = (res != null && res.ContainsKey("devices")) ? res["devices"] as object[] : new object[0];
            if (devices == null || devices.Length == 0)
            {
                root.Controls.Add(new Label { Text = "暂无已配对设备", ForeColor = Color.Gray, AutoSize = true });
                form.Show();
                return;
            }

            int unused = 0;
            foreach (var od in devices)
            {
                var d = od as Dictionary<string, object>;
                if (d == null) continue;
                string id = Backend.Str(d, "deviceId") ?? "?";
                string id6 = id.Length >= 6 ? id.Substring(0, 6) : id;
                bool viewer = Backend.Str(d, "role") == "viewer";
                string name = Backend.Str(d, "name");
                if (string.IsNullOrEmpty(name)) name = "设备 " + id6;
                long lastSeen = Backend.Long(d, "lastSeenAt");
                long createdAt = Backend.Long(d, "createdAt");
                if (!viewer && lastSeen == 0) unused++;

                string title = viewer ? "🔗 " + name + "（只读）" : name;
                string sub;
                if (viewer)
                {
                    long exp = Backend.Long(d, "expiresAt");
                    long viewers = Backend.Long(d, "viewers");
                    string expTxt = !Backend.HasKey(d, "expiresAt") ? "永久" : (exp <= NowMs() ? "已过期" : "至 " + FmtEpoch(exp));
                    string watch = viewers > 0 ? viewers + " 人正在围观" : "暂无人围观";
                    sub = expTxt + " · " + watch + " · #" + id6;
                }
                else if (lastSeen > 0) sub = "最近连接：" + FmtEpoch(lastSeen) + " · #" + id6;
                else if (createdAt > 0) sub = "从未连接（配对于 " + FmtEpoch(createdAt) + "） · #" + id6;
                else sub = "从未连接 · #" + id6;

                var rowPanel = new Panel { Width = 420, Height = 50, Margin = new Padding(0, 0, 0, 6) };
                var col = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, Left = 0, Top = 2, Width = 315, Height = 48, WrapContents = false };
                col.Controls.Add(new Label { Text = title, AutoSize = true, Font = FontRowName });
                col.Controls.Add(new Label { Text = sub, AutoSize = true, ForeColor = Color.Gray, Font = FontRowSub });
                rowPanel.Controls.Add(col);

                string devId = id;
                var btn = new Button { Text = viewer ? "撤销" : "移除", Width = 76, Height = 30, Left = 338, Top = 8, FlatStyle = FlatStyle.System };
                btn.Click += (s, e) => { Backend.Call("revoke", devId); form.Close(); ShowDevices(Backend.Call("devices")); };
                rowPanel.Controls.Add(btn);
                root.Controls.Add(rowPanel);
            }

            if (unused > 0)
            {
                root.Controls.Add(new Label { Text = "有 " + unused + " 条从未连接的链接（生成过但没被扫过）", ForeColor = Color.Gray, AutoSize = true, Margin = new Padding(0, 8, 0, 4) });
                var prune = new Button { Text = "清理从未连接的链接（" + unused + "）", Width = 400, Height = 32, FlatStyle = FlatStyle.System };
                prune.Click += (s, e) =>
                {
                    var confirm = MessageBox.Show("将作废所有生成过但从未被扫过的链接（可能是外泄/转发但没用的）。已连过的设备不受影响。", "清理从未连接的链接", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);
                    if (confirm != DialogResult.OK) return;
                    var r = Backend.Call("prune-unused");
                    form.Close();
                    ShowDevices(Backend.Call("devices"));
                    Alert("已清理", "已作废 " + Backend.Long(r, "removed") + " 条从未使用的链接。");
                };
                root.Controls.Add(prune);
            }

            form.Show();
        }

        // —— 通知设置窗 ——
        static readonly string[] NotifyTypes = { "bark", "serverchan", "wecom", "dingtalk", "custom" };
        void ShowNotify()
        {
            var form = MakeWindow("通知设置", 480, 480);
            var root = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(20), AutoScroll = true };
            form.Controls.Add(root);

            root.Controls.Add(new Label { Text = "添加通知渠道", Font = FontSectionBold, AutoSize = true, Margin = new Padding(0, 0, 0, 6) });
            var combo = new ComboBox { Width = 400, DropDownStyle = ComboBoxStyle.DropDownList };
            combo.Items.AddRange(new object[] { "Bark", "Server酱", "企业微信", "钉钉", "自定义" });
            combo.SelectedIndex = 0;
            root.Controls.Add(combo);
            var field = new TextBox { Width = 400, Margin = new Padding(0, 6, 0, 6) };
            root.Controls.Add(field);
            root.Controls.Add(new Label { Text = "Bark/Server酱 填 Key；其余填 Webhook URL", ForeColor = Color.Gray, AutoSize = true, MaximumSize = new Size(400, 0), Margin = new Padding(0, 0, 0, 6) });

            var btnRow = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, Width = 400, Height = 38, WrapContents = false };
            var addBtn = new Button { Text = "添加", Width = 90, Height = 28, FlatStyle = FlatStyle.System };
            var testBtn = new Button { Text = "发送测试", Width = 100, Height = 28, FlatStyle = FlatStyle.System };
            btnRow.Controls.Add(addBtn);
            btnRow.Controls.Add(testBtn);
            root.Controls.Add(btnRow);

            addBtn.Click += (s, e) =>
            {
                string val = field.Text.Trim();
                if (val.Length == 0) { Alert("请填写", "请填入 Key 或 Webhook URL"); return; }
                string type = NotifyTypes[combo.SelectedIndex];
                string json = (type == "bark" || type == "serverchan")
                    ? "{\"type\":\"" + type + "\",\"key\":\"" + JsonEsc(val) + "\"}"
                    : "{\"type\":\"" + type + "\",\"url\":\"" + JsonEsc(val) + "\"}";
                Backend.CallWithInput("notify-add", json);
                form.Close();
                ShowNotify();
            };
            testBtn.Click += (s, e) =>
            {
                var r = Backend.Call("notify-test");
                Alert("已发送", "已向 " + Backend.Long(r, "count") + " 个渠道发送测试通知，请检查手机。");
            };

            root.Controls.Add(new Label { Text = "已配置：", AutoSize = true, Margin = new Padding(0, 10, 0, 4) });
            var list = Backend.Call("notify-list");
            object[] notifiers = (list != null && list.ContainsKey("notifiers")) ? list["notifiers"] as object[] : new object[0];
            foreach (var on in notifiers ?? new object[0])
            {
                var n = on as Dictionary<string, object>;
                if (n == null) continue;
                long idx = Backend.Long(n, "index");
                string label = Backend.Str(n, "label") ?? "";
                var rowPanel = new Panel { Width = 420, Height = 34 };
                rowPanel.Controls.Add(new Label { Text = label, AutoSize = true, Left = 0, Top = 6, Width = 310 });
                var del = new Button { Text = "删除", Width = 76, Height = 28, Left = 338, Top = 2, FlatStyle = FlatStyle.System };
                long capIdx = idx;
                del.Click += (s, e) => { Backend.Call("notify-remove", capIdx.ToString()); form.Close(); ShowNotify(); };
                rowPanel.Controls.Add(del);
                root.Controls.Add(rowPanel);
            }

            form.Show();
        }

        // —— 窗口/提示基建 ——
        Form MakeWindow(string title, int w, int h)
        {
            var form = new Form
            {
                Text = title,
                Width = w,
                Height = h,
                StartPosition = FormStartPosition.CenterScreen,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                MaximizeBox = false,
                MinimizeBox = false,
                ShowInTaskbar = true,
                AutoScaleMode = AutoScaleMode.Dpi,
                Font = FontBase,
            };
            windows.Add(form);
            form.FormClosed += (s, e) => windows.Remove(form);
            form.TopMost = true;
            return form;
        }

        void Alert(string title, string message)
        {
            MessageBox.Show(message ?? "", title, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        static void Flash(Button b, string restore)
        {
            b.Text = "已复制 ✓";
            b.Enabled = false;
            var t = new System.Windows.Forms.Timer { Interval = 1200 };
            t.Tick += (s, e) => { b.Text = restore; b.Enabled = true; t.Stop(); t.Dispose(); };
            t.Start();
        }

        // —— 显示辅助 ——
        static long NowMs() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }
        static string FmtEpoch(long ms)
        {
            if (ms <= 0) return "";
            var dt = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms).ToLocalTime();
            return dt.ToString("MM-dd HH:mm");
        }
        // 展示用：隐去 github.io 之前的用户名前缀（剪贴板仍复制完整 url）
        static string LinkForDisplay(string url)
        {
            int i = url.IndexOf("github.io");
            if (i >= 0) return url.Substring(i);
            return url.Replace("https://", "").Replace("http://", "");
        }
        static string MiddleTruncate(string s, int max)
        {
            if (s.Length <= max) return s;
            int head = (max - 1) / 2;
            int tail = max - 1 - head;
            return s.Substring(0, head) + "…" + s.Substring(s.Length - tail);
        }
        static string JsonEsc(string s)
        {
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }
}
