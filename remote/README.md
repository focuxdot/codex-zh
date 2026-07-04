# Codex-ZH Remote

手机远程查看/接管电脑上 Codex 的子系统。产品与架构见 [docs/PRD-remote.md](../docs/PRD-remote.md)，协议见 [PROTOCOL.md](PROTOCOL.md)。

> **普通用户（Mac 版）**：装好 Codex-ZH 后无需以下命令行——在配置窗口点「手机远程接管…」，
> 从菜单栏「启用手机远程接管」，扫码即可。下面是开发者/自建视角的说明。

## 目录

| 目录 | 说明 |
| --- | --- |
| `daemon/` | 电脑端守护进程（Node.js，零依赖）：拉起 codex app-server、出站连接 relay、端到端加密、配对与设备管理、rollout 实时推送 |
| `relay-worker/` | relay 官方形态：Cloudflare Worker + Durable Objects |
| `relay-node/` | relay 自托管/本地开发形态：零依赖 Node 单进程（含手写 RFC 6455 WebSocket 服务端） |
| `web/` | 手机端网页（vanilla JS + WebCrypto，无构建、零依赖）：状态看板、markdown 对话流、内嵌审批卡、目录选择器、分层连接诊断 |
| `scripts/smoke.mjs` | 端到端冒烟：relay + daemon + 模拟客户端全链路 |
| `scripts/web-e2e-backend.mjs` | 浏览器 e2e 后端：一条命令拉起 relay + daemon + 手机页静态服务并输出配对 URL，本机浏览器直接打开即可调试真实链路 |

## 本地跑通（开发）

```bash
# 1. 启动本地 relay
node remote/relay-node/server.mjs --port 8787

# 2. 启动 daemon（首次运行生成密钥与 daemonId，写入 ~/.codex-zh/remote/daemon.json）
node remote/daemon/src/main.mjs start --relay ws://127.0.0.1:8787

# 3. 生成配对链接（另开终端）
node remote/daemon/src/main.mjs pair

# 4. 浏览器打开配对链接。手机端页面已托管在
#    https://focuxdot.github.io/codex-zh/remote/ （pages.yml 从 remote/web/ 复制发布），
#    本地开发也可自行用任意 HTTP 服务托管 web/index.html 并用 --web 指定
```

端到端冒烟（自动完成上述全流程 + 断言）：

```bash
npm run remote:smoke
```

## 通知（任务完成 / 需要审批时推到手机）

国内 Web Push 不可用，改由 daemon 主动 webhook 推送。任务完成（人不在时）
或 Codex 请求审批时，会推到你配置的渠道。通知只含事件类型与会话名，不含
命令原文或代码。

```bash
node remote/daemon/src/main.mjs notify --add bark --key <你的BarkKey>
node remote/daemon/src/main.mjs notify --add wecom --url <企业微信机器人URL>
node remote/daemon/src/main.mjs notify --test        # 发测试通知
node remote/daemon/src/main.mjs notify --list         # 查看已配置渠道
```

支持 `bark`（iOS，`--key`，可选 `--server` 自托管）、`serverchan`（微信，`--key`）、
`wecom` / `dingtalk`（群机器人，`--url`）、`custom`（自定义 webhook，`--url`，
收 `{title,body,source,link?}`）。通知带深链（`<webUrl>#s=<会话id>`）：Bark 点通知
直接打开手机端并落到对应会话，其余渠道在正文附链接。

## 部署 relay（Cloudflare Worker）

官方实例域名：`relay.wokey.ai`（已写入 `wrangler.toml` 与 daemon 默认配置）。部署前提：`wokey.ai` 已接入 Cloudflare DNS。

```bash
cd remote/relay-worker
npx wrangler login     # 首次：浏览器授权 Cloudflare 账号
npx wrangler deploy    # 部署并自动创建 relay.wokey.ai 自定义域路由
curl https://relay.wokey.ai/   # 验证：应返回 "codex-zh relay ok"
```

注意：

- `workers.dev` 子域在国内不可用，自定义域是硬性要求。
- Durable Objects 使用 SQLite 存储类（免费额度可用）；WebSocket 使用 Hibernation API 控制计费。
- relay 代码更新后需重新 `wrangler deploy`。协议为向后兼容增量（如 status 帧的 `lastSeen`
  字段），旧 relay 不影响核心功能，只是手机端缺"上次在线"等增强信息。
- 自托管用户：改掉 `wrangler.toml` 的 `routes` 部署到自己账号，daemon 用 `start --relay wss://...` 指向自建实例。
- web 页面可托管在任意 HTTPS 静态站（GitHub Pages / 同一 Worker）；daemon 用 `--web https://...` 指定配对链接的页面地址。

## Mac 版集成（r0.6）

Remote 随 `Codex-ZH.app` 分发，普通用户零命令行、零 Node 安装即可开启。

**入口与生命周期**
- 入口：**打开 Codex-ZH 时启动器自动拉起菜单栏控制程序**（`launcher/mac/CodexZhRemoteMenu.swift`），
  不依赖配置窗口（已配置过中转站的用户不会再看到配置窗口）。配置窗口的「手机远程接管…」
  按钮是备用入口。菜单程序自带 flock 单实例锁，与启用后常驻的 LaunchAgent 版本不重复。
- 菜单栏「启用手机远程接管」→ `launcher/mac/remote-backend.mjs enable`：写两个 LaunchAgent
  到 `~/Library/LaunchAgents/`（`ai.wokey.codex-zh.remote` daemon + `…remote-menu` 菜单），
  `RunAtLoad`+`KeepAlive`（开机自启 + 崩溃自动拉起），并把 daemon 的 `codexCommand`
  指向 bundle 内 `Contents/Resources/codex`（与 app 同版本，根治版本偏差）。
- **默认关闭（opt-in）**：不启用则零后台进程、零登录项、零网络暴露。「停用远程」bootout
  两个 agent 并删除 plist。
- 会话共享：daemon LaunchAgent 设 `CODEX_HOME=~/.codex`，与 Codex GUI 同一会话仓库。
- daemon 用 bundle 自带的 `Contents/Resources/cua_node/bin/node` 运行，无需用户装 Node。
- 扫码配对二维码：菜单「扫码配对」用 CoreImage 本地生成（无第三方依赖）。

**构建**：`scripts/build-codex-zh-staging-mac.mjs` 在签名前把 `remote/` 树拷进
`Contents/Resources/codex-zh/remote/`（排除 `node_modules`/`.wrangler`），并 `swiftc` 编译
菜单程序到 `bin/CodexZhRemoteMenu`；单次 `codesign --deep` 覆盖全部新增文件。运行时只写
bundle 外文件（LaunchAgent plist、`~/.codex-zh/*`），不破坏签名封印。

**第二台 Mac 运行验证清单**（本机只做构建/只读校验；具体测试设备记录放在本地私有文档）：
1. 拖入 /Applications、去隔离（`xattr -dr com.apple.quarantine`）、能打开不报"已损坏"。
2. 配置窗口 →「手机远程接管…」→ 菜单栏出现图标 → 「启用手机远程接管」。
3. `launchctl list | grep codex-zh.remote` 两个 agent 已加载；`~/.codex-zh/remote/daemon.log`
   显示"已连接 relay"。
4. 「扫码配对」→ 手机扫码 → 会话列表出现本机 Codex 的真实会话（验证 CODEX_HOME 共享）
   → 发消息 / 审批全链路。
5. 手机连着时 `pgrep -fl caffeinate` 有 daemon 起的防睡眠进程。
6. 菜单「通知设置」配 Bark → 「发送测试」→ 手机收到。
7. 重启 → daemon + 菜单图标自动回来。
8. 「停用远程」→ 两个 agent 消失、plist 删除、图标消失。

## 进度与已知边界

已实现：
- E2E 加密（X25519 + HKDF + AES-256-GCM，方向绑定 AAD）、扫码配对与设备令牌、relay 双变体（Cloudflare Worker / Node）
- 会话列表、实时查看、发消息、接管、停止、新建会话、远程审批（广播给所有设备，先到先得）
- 手机端 PWA（可安装、离线壳）、多电脑切换、断线自动重连、回前台立即重连
- **手机端 UI（对标 Claude App 聊天范式）**：首页状态看板（大字回答"几个在跑/几个等审批"）、
  Codex 回复 markdown 渲染（手写纯 DOM 渲染器，无依赖、防注入）、命令折叠行、用户消息气泡 +
  乐观发送（失败自动回填输入框）、设计 token 化 + 跟随系统亮/暗色
- **审批决策卡**：命令原文 + 执行目录上下文；高危命令（`rm -rf`/`sudo`/强推等）红框警示；
  普通命令可"批准，且本会话内不再询问"（`acceptForSession`，协议原生支持）；当前会话的审批卡
  内嵌对话流，其余全局置顶；**文件修改审批直接展示着色 diff**（daemon 转发文件清单与截断
  diff，预算 24KB，不再是"详情见电脑端"）
- **新建会话目录选择器**：从最近会话提取常用目录点选即建（数据来自 `sessions.list` 的 `cwd`，
  无协议改动），手输路径仅作兜底
- **分层连接诊断**：状态胶囊按"最深断层"显示（重连中/电脑离线/引擎重启中/在线），点开看
  三层链路（手机↔中继 / 中继↔电脑 / Codex 引擎）各自状态与建议；relay 提供离线时刻
  （`lastSeen`，Worker 变体存 DO storage），daemon 广播引擎崩溃/恢复（`daemon.status`）
- **过程完整可见**：命令与工具调用按现行 rollout 格式渲染（`response_item` 的
  `function_call` / `function_call_output` 以 call_id 配对——旧的 `event_msg exec_command_*`
  仅作兼容），折叠行带 ✓/✗ 退出码角标、点开看输出（GUI harness 前言自动剥离）；
  `patch_apply_end` 渲染为红绿着色的 diff 卡
- **流式预览**：`session.live` 的 agent message delta 实时打字预览（正式内容仍以 rollout
  tail 为准，tail 到达即无缝替换）；运行状态条显示耗时；`turn/failed` 明确报错而非静默卡住
  （daemon 看板同步修复了 failed/aborted 不清运行态的问题）
- **体验细节**：智能滚动（翻历史不被新内容打断 + 「↓」回底按钮）、快捷回复、桌面 Enter 发送
  （中文输入法安全）、未配对引导页、更新横幅点击即刷新（PWA 无下拉刷新）、通知深链直达会话
- **驱动方感知**：桌面 GUI 驱动的会话从 rollout tail 的 `task_started`/`task_complete` 推断
  运行状态（这类会话没有 live 事件），状态条显示"桌面端正在运行"且不出现无效的停止按钮；
  daemon 驱动状态以 `board.changed` 为准。列表行带最后进展摘要；轮次结束自动回填会话名；
  电脑离线时禁用发送（输入保留）；超长回复"展开全部"而非一刀切截断
- **会话内图片**：rollout 内嵌的 base64 图片（生成图 / 用户贴图）由 daemon 抽出缓存
  （内容哈希去重，LRU 32MB），条目替换为 `imageRef`，手机端经 `image.fetch` 分块拉取显示
  ——零文件系统访问，数据本来就在会话流里（此前这类条目超 48KB 直接被截断，图片不可见）
- **列表搜索 + 上下文用量**：首页底栏常驻搜索胶囊（按名称/摘要/目录过滤）；
  tail 的 `token_count` 换算上下文占用百分比记在 `app.ctxPct`（常显标签按需求移除，留作预警数据源）
- **一体化输入卡片（对标 Claude App composer）**：输入行 + 底部操作排（➕ 附图 / 运行提示 /
  上下文用量 / 发送）合为一张圆角卡片；发送键空内容置灰；输入框最高约四成屏高；
  停止时按钮置灰 +「正在停止…」即时反馈
- **➕ 动作菜单（对齐官方 Codex App 的 Remote Control）**：计划模式（`collaborationMode
  {mode:"plan"}`，daemon 以 `capabilities.experimentalApi` 解锁，settings.model 由引擎默认
  兜底，会话级开关 + 「计划 ✕」胶囊退出）、设定目标（`thread/goal/set|get|clear` 代理，
  prompt 回显当前目标）、发文件（文本文件 ≤64KB 以代码块拼进消息——引擎输入模态只有
  文本+图片，二进制文档明确拒绝）、拍照 / 选照片 / 粘贴剪贴板图片。官方 App 的 Plugins
  区（Documents/PDF/GitHub 等）是 ChatGPT 云端连接器生态，本地 app-server 无对应物，不做
- **发图片**：canvas 压缩（长边 1568px JPEG，小图原样直传），
  经 `image.push` 分块上传（`image.fetch` 的镜像方向，单连接缓冲 24MB 上限），daemon 转成
  `turn/start` 的 `{type:"image",url:"data:..."}` 输入项（与桌面端贴图同路径，无临时文件）；
  乐观气泡带缩略图与上传进度，失败回填附件区
- **运行中排队追加**：daemon 驱动运行时发送不再禁用——消息进本地队列（气泡标
  「本轮结束后发送 · 点按撤回」），轮次结束自动逐条发出；离线保持排队；退出会话时未发文本并入草稿
- **按轮权限/模型选择**：操作排「权限」「模型」胶囊——权限预设（跟随电脑配置 / 只读 / 代理 /
  完全访问，后者红色警示 + 二次确认）映射 `turn/start` 的 `approvalPolicy`+`sandboxPolicy`
  （与桌面端字段一致，bundle 证实）；模型与推理力度来自 `models.list`（daemon 代理 app-server
  `model/list`，实测可用），选择随消息按轮生效、localStorage 记住；daemon 侧白名单过滤
  override 字段，手机端不能注入任意 turn/start 参数
- **首页对标官方 App**：头部居中标题 + `● 电脑名` 副标题（异常时变状态文字）；右上 ⋯ 菜单
  （组织方式：按项目 ✓ / 时间线，localStorage 记住；管理：切换电脑 / 连接状态）；会话列表按
  cwd 聚合成可折叠项目组（折叠态持久化），组头右侧一键在该项目下新建会话；桌面版给每个
  新聊天建的托管目录（`~/Documents/Codex/<日期>/<聊天名>`，本机会话历史证实）和家目录本身/
  桌面/文档/下载//tmp 等非项目 cwd 不套文件夹组头，单独平铺在「聊天」区；底栏搜索胶囊 +
  「新会话」按钮；操作排裸排版（加号/权限图标/模型号无按钮圈，模型显示简写版本号如 `5.5 高`，
  未指定时静默预取 `models.list` 显示电脑端默认模型）；快捷短语行与常驻上下文百分比按需求移除
- **色系统一（全页审计后收敛）**：主操作只有一种颜色语言——发送键与首页「新会话」同为反色
  单色圆钮，accent 蓝退居链接/选中态/光标；「选中/当前」一律 accent（弹层行 `--accent-bg`
  底 + 蓝「当前」徽标），绿色严格保留给在线/运行中/成功；全站图标收敛为单色线条 SVG
  （➕ 菜单六项、权限盾牌与首页一套风格），文案与工具行不再用彩色 emoji（iOS 上会渲染成全彩破坏裸排版）
- **外观切换**：⋯ 菜单「外观」组——跟随系统 / 浅色 / 深色（`czr-theme`，`html[data-theme]`
  强制覆盖 media query，头部内联脚本首帧前应用防闪烁；手动锁定时 `theme-color` meta 同步改写，
  状态栏颜色跟着走）
- **多电脑管理**：标题 ▾ 弹层支持删除旧电脑的本机配对记录（电脑侧授权需在电脑上撤销）、
  附「添加电脑」指引；新打开页面进入 daemon 驱动中的会话时以 `sessions.list` 的 `running`
  为准（不丢停止按钮）；新会话空态给首任务引导语
- 电源管理：有设备在线或任务运行时阻止系统睡眠（允许关屏），空闲释放。`--no-prevent-sleep` 关闭
- webhook 通知：任务完成（无设备在线时）/ 需要审批时推到 Bark / Server酱 / 企业微信 / 钉钉 / 自定义渠道，仅摘要不含命令
- 协议版本化：relay 转发（URL `/v1/`）、E2E 信封、应用协议（auth 交换）三层独立版本，daemon 更新时提示手机刷新
- **链路活性分层（消灭"显示在线但发不出去"的僵尸连接）**：手机端仅前台每 25s 发 relay 层
  hb（切后台/锁屏即停，零后台流量），上一拍没回即强制重建，回前台/网络恢复（`online` 事件）
  先验活再信 `readyState`；旧 relay 不应答 hb 时自动退化为不检测（能力探测，平滑升级）；
  daemon 心跳补验收（发出 10s 没回包判死链重连，退避上限 60s→15s）；Worker 用
  `setWebSocketAutoResponse` 边缘应答 hb——DO 不再被每 25s 唤醒，空闲真正休眠（省 duration 计费）；
  断线重连首跳 300ms。需 `wrangler deploy` + 电脑端重启 daemon 后手机才启用僵尸检测
- 自建 relay 文档：见 [relay-worker/README.md](relay-worker/README.md)
- **Mac 版集成：菜单栏控制程序 + LaunchAgent（开机自启/崩溃拉起）+ 扫码 QR，默认关、opt-in**
- **桌面同步提示（Mac）**：手机远程改写会话后，桌面 Codex 顶部弹「会话「X」已被手机远程更新 → 刷新查看」，一键刷新即可看到手机的回合。
  信号来自 daemon：手机驱动的回合 `turn/completed` 时，daemon 写 `~/.codex-zh/remote/desktop-refresh.json`（见 `remote/daemon/src/desktop-signal.mjs`）——
  桌面自己的回合走独立 app-server，永不误触发。打了补丁的桌面 bundle（`scripts/lib/remote-refresh-inject.mjs`，随 `customize-codex-default-zh-cn.mjs` 注入）
  的 main 进程 `fs.watch` 该信号文件、广播给渲染进程，preload 弹横幅。之所以用一键刷新：桌面渲染进程把会话缓存在内存、仅首次加载时拉一次
  `thread/turns/list`；reload 清缓存后 app-server 会新鲜查询共享 SQLite，手机的回合即出现。（app-server 走 MessagePort 传输，无法在 preload 直接嗅探，故改用 daemon 侧信号。）

未实现（后续）：
- Windows 安装器集成（托盘 = 菜单栏等价物，后端逻辑复用）
- 桌面同步提示的 Windows 接线（preload minify 标识符不同，需另验锚点）与「无缝逐字流式」（需注入渲染进程内部状态，脆弱，暂缓）
