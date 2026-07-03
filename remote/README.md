# Codex-ZH Remote（r0.2）

手机远程查看/接管电脑上 Codex 的子系统。产品与架构见 [docs/PRD-remote.md](../docs/PRD-remote.md)，协议见 [PROTOCOL.md](PROTOCOL.md)。

## 目录

| 目录 | 说明 |
| --- | --- |
| `daemon/` | 电脑端守护进程（Node.js，零依赖）：拉起 codex app-server、出站连接 relay、端到端加密、配对与设备管理、rollout 实时推送 |
| `relay-worker/` | relay 官方形态：Cloudflare Worker + Durable Objects |
| `relay-node/` | relay 自托管/本地开发形态：零依赖 Node 单进程（含手写 RFC 6455 WebSocket 服务端） |
| `web/` | 手机端网页（vanilla JS + WebCrypto，无构建） |
| `scripts/smoke.mjs` | 端到端冒烟：relay + daemon + 模拟客户端全链路 |

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
- 自托管用户：改掉 `wrangler.toml` 的 `routes` 部署到自己账号，daemon 用 `start --relay wss://...` 指向自建实例。
- web 页面可托管在任意 HTTPS 静态站（GitHub Pages / 同一 Worker）；daemon 用 `--web https://...` 指定配对链接的页面地址。

## r0.2 范围与已知边界

- 已实现：E2E 加密（X25519 + HKDF + AES-256-GCM，方向绑定 AAD）、扫码配对与设备令牌、会话列表、实时查看（只读，含大快照分块与超大条目截断）、daemon 断线指数退避重连、relay 双变体。
- 未实现（r0.3+）：PWA 完整体验与多 daemon 切换、接管/发消息/新建会话/远程审批、webhook 通知、托盘、电源管理。
- 客户端连接断开后需手动刷新页面重连（自动重连在 r0.3 做）。
