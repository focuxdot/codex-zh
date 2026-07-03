# Codex-ZH Remote 协议 v1

三个角色：**daemon**（用户电脑上的守护进程）、**client**（手机/浏览器）、**relay**（中继，Cloudflare Worker 或自托管 Node 变体）。

设计原则：relay 是零知识转发器——只做按 `daemonId` 撮合与逐帧转发，所有应用层内容在 daemon 与 client 之间端到端加密，relay 不持有任何密钥或令牌。

## 1. Relay 连接与转发帧

WebSocket 端点：

- `wss://<relay>/v1/daemon/<daemonId>` — daemon 出站注册。同一 `daemonId` 仅一条活跃连接，新连接顶掉旧连接。
- `wss://<relay>/v1/client/<daemonId>` — client 连接。relay 为每条 client 连接分配连接内唯一的 `cid`。

`daemonId`：16 字节随机数的 base64url（daemon 首次运行生成，持久化）。

转发帧为 JSON 文本帧，单帧上限 256 KiB，超限即断开：

| 方向 | 帧 | 说明 |
| --- | --- | --- |
| relay → client | `{"t":"status","online":bool}` | 连接建立时告知 daemon 是否在线；daemon 上下线时推送 |
| relay → daemon | `{"t":"open","cid":"..."}` | 有 client 接入；daemon（重）上线时对每个已在线 client 补发一次 |
| client → relay | `{"t":"msg","data":{...}}` | data 为 E2E 信封（见 §2） |
| relay → daemon | `{"t":"msg","cid":"...","data":{...}}` | 转发并标注来源 cid |
| daemon → relay | `{"t":"msg","cid":"...","data":{...}}` | 回发给指定 cid |
| relay → client | `{"t":"msg","data":{...}}` | |
| relay → daemon | `{"t":"close","cid":"..."}` | client 断开 |
| daemon → relay | `{"t":"close","cid":"..."}` | 要求 relay 断开该 client（如鉴权失败） |
| daemon ↔ relay | `{"t":"hb"}` | daemon 每 25s 心跳，relay 原样回发 |

relay 不解析 `data` 内容。daemon 断开时，relay 向所有 client 推 `{"t":"status","online":false}` 并保持 client 连接，等 daemon 重连后推 `online:true`。

## 2. 端到端加密信封

密码学原语（Node `node:crypto` 与浏览器 WebCrypto 均原生支持）：

- 密钥协商：X25519
- 密钥派生：HKDF-SHA256，`salt = UTF8(daemonId)`，`info = "codex-zh-remote-v1"`，输出 32 字节
- 对称加密：AES-256-GCM，12 字节随机 IV，逐消息生成
- GCM AAD 绑定方向，防反射：client→daemon 为 `UTF8("czr1:c2d")`，daemon→client 为 `UTF8("czr1:d2c")`

流程：daemon 持有长期 X25519 密钥对，公钥随配对码分发。client 每次连接生成**临时**密钥对，首帧携带临时公钥：

```json
{"v":1,"k":"<b64 client 临时公钥 raw 32B>","n":"<b64 IV>","c":"<b64 密文>"}
```

双方以 `X25519(clientEphPriv, daemonPub)` 派生本连接会话密钥；此后所有信封只含 `{"n","c"}`。daemon 长期私钥泄露前的历史流量不可解（client 侧临时密钥即弃）。

## 3. 应用层消息（信封内明文）

JSON-RPC 风格：请求 `{"id",method,"params"}`，响应 `{"id","result"| "error":{"code","message"}}`，通知无 `id`。

### 3.1 鉴权（连接后第一条，其余消息在鉴权前一律拒绝）

```json
{"id":1,"method":"auth","params":{"pairToken":"..."}}        // 首次配对
{"id":1,"method":"auth","params":{"deviceToken":"..."}}      // 已配对设备
```

成功：`{"id":1,"result":{"deviceId":"...","deviceToken":"...","daemonName":"..."}}`（配对路径签发新 deviceToken；deviceToken 路径原样确认）。失败：error 后 daemon 发 `{"t":"close"}` 断开。

- pairToken：一次性、5 分钟时效，由 `pair` 命令生成；daemon 只存哈希。
- deviceToken：32 字节随机 base64url，daemon 只存 SHA-256 哈希与设备元数据（名称、创建时间、最后活跃）。

### 3.2 会话

```json
{"id":2,"method":"sessions.list","params":{"limit":50}}
// result: {"sessions":[{"id","preview","name","cwd","updatedAt","source","status"}]}

{"id":3,"method":"session.watch","params":{"sessionId":"..."}}
// result: {"ok":true}；随后：
//   {"method":"session.snapshot","params":{"sessionId","items":[...]}}   // 尾部回填
//   {"method":"session.event","params":{"sessionId","items":[...]}}      // 增量追加
{"id":4,"method":"session.unwatch","params":{}}
```

`items` 为 rollout JSONL 行解析后的对象（`{timestamp,type,payload}`），client 侧按类型渲染，未知类型显示摘要。每 client 连接同一时刻只 watch 一个会话。

### 3.3 心跳

client 可发 `{"method":"ping"}`，daemon 回 `{"method":"pong"}`（信封内，兼作链路探活）。

## 4. 配对码

`pair` 命令输出 URL：`https://<web>/#p=<base64url(JSON)>`，JSON：

```json
{"v":1,"relay":"wss://...","id":"<daemonId>","pk":"<b64 daemon 公钥>","name":"<电脑名>","tok":"<pairToken>"}
```

client 解析后连接 relay、完成 §2 握手、以 `tok` 走 §3.1 配对，成功后本地持久化 `{relay,id,pk,name,deviceToken}`（多台电脑各存一份）。

## 5. 版本

- 转发帧与信封含 `v:1`（信封仅首帧携带）；不兼容变更递增版本。
- relay 对未知 `t` 帧忽略不断开，保证旧 relay 兼容新端。
