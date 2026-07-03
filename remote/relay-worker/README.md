# 自建 Codex-ZH Remote relay（Cloudflare Worker）

relay 是零知识转发器：只按 `daemonId` 撮合 daemon 与手机的 WebSocket 连接、
逐字节转发**端到端加密**的载荷，读不到会话内容，也不持有任何令牌或密钥。
官方实例是 `relay.wokey.ai`；你也可以用本目录部署自己的 relay。

## 为什么要自建

- 不想依赖官方实例（可用性、隐私偏好）。
- 官方实例限流或下线时的退路。
- 协议与官方完全一致，daemon 只需改 `--relay` 指向你的地址即可。

## 前提

- 一个 Cloudflare 账号（免费版即可）。
- 一个域名接入 Cloudflare DNS。**`workers.dev` 子域在国内被 DNS 污染不可用**，
  官方与自建都必须绑定自有域名。
- 本机装了 Node.js（用 `npx wrangler`，无需全局安装）。

## 部署步骤

1. 把 `wrangler.toml` 里的路由改成你的域名：

   ```toml
   # 原：relay.wokey.ai
   routes = [{ pattern = "relay.你的域名", zone_name = "你的域名" }]
   ```

   > 用 `zone_name` 路由（叠加在已有 DNS 记录上）还是 `custom_domain`
   > 取决于该子域是否已有解析：
   > - 该子域尚无记录 → 可用 `[{ pattern = "relay.你的域名", custom_domain = true }]`，
   >   wrangler 部署时自动创建并托管 DNS。
   > - 该子域已有记录（如泛解析） → 用 `zone_name` 路由，避免 409 冲突。

2. 登录并部署：

   ```bash
   cd remote/relay-worker
   npx wrangler login      # 首次：浏览器授权
   npx wrangler deploy
   ```

3. 验证：

   ```bash
   curl https://relay.你的域名/          # 应返回 "codex-zh relay ok"
   ```

## 让 daemon 使用你的 relay

```bash
node remote/daemon/src/main.mjs start --relay wss://relay.你的域名
```

`--relay` 会持久化到 `~/.codex-zh/remote/daemon.json`。之后生成的配对码会
自动带上这个 relay 地址，手机扫码即用你的实例，无需额外配置。

## 计费与运维

- Durable Objects 使用 SQLite 存储类，配 WebSocket Hibernation API（空闲连接
  不计 duration），小规模用量落在免费额度内；超出后 Workers 付费档约 $5/月。
- relay 无状态、无数据库、不落盘任何流量，运维成本极低。

## 不想用 Cloudflare？

`remote/relay-node/` 是协议完全一致的零依赖 Node 单进程变体，可部署到任意
VPS（配合你自己的 TLS 反代）：

```bash
node remote/relay-node/server.mjs --port 8787 --host 0.0.0.0
```

daemon 指向 `wss://你的域名`（经反代加 TLS）即可。
