// 单个远端设备连接的 E2E 会话：握手 -> 鉴权 -> 方法路由（见 PROTOCOL.md §2/§3）
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import {
  APP_PROTOCOL,
  consumePairToken,
  findDeviceByToken,
  loadOrCreateConfig,
  saveConfig,
} from "./config.mjs";
import { deriveSessionKey, open as sealedOpen, seal } from "./crypto.mjs";
import { RolloutTail } from "./rollout-tail.mjs";

// 把 app-server 审批请求里的 fileChanges 压缩成 [{path,kind,diff}]。
// 兼容两种序列化（{type:"update",unified_diff} / {update:{unified_diff}}）；
// 总量限预算，保证整帧远小于 relay 的 256KiB 上限。
function summarizeFileChanges(fileChanges) {
  if (!fileChanges || typeof fileChanges !== "object") return null;
  const files = [];
  let budget = 24_000;
  for (const [path, change] of Object.entries(fileChanges).slice(0, 20)) {
    let kind = "update";
    let diff = "";
    if (change?.type) {
      kind = change.type;
      diff = change.unified_diff ?? change.content ?? "";
    } else if (change?.update) {
      diff = change.update.unified_diff ?? "";
    } else if (change?.add) {
      kind = "add";
      diff = change.add.content ?? "";
    } else if (change?.delete) {
      kind = "delete";
    }
    diff = String(diff).slice(0, Math.max(0, Math.min(4000, budget)));
    budget -= diff.length;
    files.push({ path, kind, diff });
  }
  return files.length ? files : null;
}

// —— 会话内图片 ——
// 图片以裸 base64 内嵌在 rollout 条目里（生成图的 result、用户贴图的 data URL），
// 单条必超 48KB 截断上限。发送前抽出缓存、替换为 imageRef 引用，手机端经
// image.fetch 分块拉取。id 是内容哈希：同一图片重复出现不重复占内存。
const imageCache = new Map(); // id -> { data: b64, mime }
let imageCacheChars = 0;
const IMAGE_CACHE_BUDGET = 32 * 1024 * 1024; // base64 字符数预算（≈24MB 原始字节）
const IMAGE_MAX_CHARS = 12 * 1024 * 1024;

function sniffImageMime(b64) {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

function cacheImage(b64, mime) {
  if (typeof b64 !== "string" || b64.length > IMAGE_MAX_CHARS) return null;
  const id = createHash("sha256")
    .update(b64.slice(0, 64)).update(b64.slice(-64)).update(String(b64.length))
    .digest("base64url").slice(0, 16);
  const existing = imageCache.get(id);
  if (existing) {
    imageCache.delete(id); // LRU：重插到队尾
    imageCache.set(id, existing);
  } else {
    imageCache.set(id, { data: b64, mime });
    imageCacheChars += b64.length;
    for (const [key, value] of imageCache) {
      if (imageCacheChars <= IMAGE_CACHE_BUDGET) break;
      imageCache.delete(key);
      imageCacheChars -= value.data.length;
    }
  }
  return { id, mime, size: Math.floor(b64.length * 0.75) };
}

// 手机端按轮 override 白名单：只放行已知字段与取值，不让远端注入任意 turn/start 参数。
// 字段形状与桌面端一致：sandboxPolicy 是 {type} 对象，approvalPolicy 是策略枚举。
const SANDBOX_TYPES = new Set(["readOnly", "workspaceWrite", "dangerFullAccess"]);
const APPROVAL_POLICIES = new Set(["untrusted", "on-request", "on-failure", "never"]);

export function sanitizeTurnOptions(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  if (typeof raw.model === "string" && raw.model.length > 0 && raw.model.length <= 64) {
    out.model = raw.model;
  }
  if (typeof raw.effort === "string" && /^[a-z]{1,16}$/.test(raw.effort)) out.effort = raw.effort;
  if (APPROVAL_POLICIES.has(raw.approvalPolicy)) out.approvalPolicy = raw.approvalPolicy;
  if (SANDBOX_TYPES.has(raw.sandboxPolicy?.type)) out.sandboxPolicy = { type: raw.sandboxPolicy.type };
  if (raw.plan === true) out.plan = true; // hub 展开为 collaborationMode {mode:"plan"}
  return Object.keys(out).length ? out : undefined;
}

export function extractImages(item) {
  const p = item?.payload;
  if (!p) return item;
  if (p.type === "image_generation_call" && typeof p.result === "string" && p.result.length > 4096) {
    const ref = cacheImage(p.result, sniffImageMime(p.result));
    return { ...item, payload: { ...p, result: null, imageRef: ref ?? { tooLarge: true } } };
  }
  if (p.type === "message" && Array.isArray(p.content)) {
    let changed = false;
    const content = p.content.map((c) => {
      if (typeof c?.image_url !== "string" || !c.image_url.startsWith("data:image/")) return c;
      const comma = c.image_url.indexOf(",");
      const b64 = c.image_url.slice(comma + 1);
      if (comma < 0 || b64.length <= 4096) return c;
      const mime = c.image_url.slice(5, c.image_url.indexOf(";"));
      changed = true;
      const ref = cacheImage(b64, mime);
      return { ...c, image_url: null, imageRef: ref ?? { tooLarge: true } };
    });
    if (changed) return { ...item, payload: { ...p, content } };
  }
  return item;
}

export class ClientSession {
  #cid;
  #daemon; // { config, configPath, privateKey, appServer, hub, log }
  #send; // (data) => void  发送 E2E 信封给该 client
  #close; // () => void     要求 relay 断开该 client
  #key = null;
  #device = null;
  #tail = null;
  #watchedThreadId = null;
  // 手机上传的附图缓冲（image.push 分块，session.send 引用后即弃）
  #uploads = new Map(); // id -> { mime, parts: [], chars, done }
  #uploadChars = 0;
  static #UPLOAD_BUDGET = 24 * 1024 * 1024; // 单连接缓冲上限（base64 字符）

  constructor(cid, daemon, { send, close }) {
    this.#cid = cid;
    this.#daemon = daemon;
    this.#send = send;
    this.#close = close;
  }

  // 收到该 client 的一帧信封
  async onEnvelope(envelope) {
    try {
      if (!this.#key) {
        if (envelope.v !== 1 || typeof envelope.k !== "string") {
          this.#close();
          return;
        }
        this.#key = deriveSessionKey(
          this.#daemon.privateKey,
          Buffer.from(envelope.k, "base64"),
          this.#daemon.config.daemonId,
        );
      }
      const message = sealedOpen(this.#key, "c2d", envelope);
      await this.#onMessage(message);
    } catch (err) {
      // 解密失败 = 非法对端，直接断开
      this.#daemon.log(`client ${this.#cid} 消息处理失败: ${err.message}`);
      this.#close();
    }
  }

  async #onMessage(message) {
    if (!this.#device) {
      if (message.method !== "auth") {
        this.#reply(message.id, null, { code: 401, message: "未鉴权" });
        this.#close();
        return;
      }
      await this.#auth(message);
      return;
    }
    switch (message.method) {
      case "ping":
        this.#notify("pong", {});
        return;
      case "sessions.list": {
        const sessions = await this.#daemon.appServer.listThreads(message.params?.limit ?? 50);
        const hub = this.#daemon.hub;
        const now = Date.now();
        this.#reply(message.id, {
          sessions: sessions.map(({ path, ...rest }) => ({
            ...rest,
            // 看板状态：running=本 daemon 正在驱动；active=会话文件近 60s 有写入
            // （覆盖桌面 GUI 正在跑的会话）；approvals=待决审批数
            running: hub.isRunning(rest.id),
            active: path ? this.#isFileActive(path, now) : false,
            approvals: hub.approvalCount(rest.id),
          })),
        });
        return;
      }
      case "session.watch":
        await this.#watch(message);
        return;
      case "session.unwatch":
        this.#stopWatch();
        this.#reply(message.id, { ok: true });
        return;
      case "session.more": {
        // 手机端「下拉加载更早」：按更大的 limit 重发一次尾部快照
        if (!this.#tail) {
          this.#reply(message.id, null, { code: 409, message: "未在监听会话" });
          return;
        }
        const limit = Math.max(1, Math.min(5000, Number(message.params?.limit) || 200));
        this.#reply(message.id, { ok: true });
        await this.#tail.resnapshot(limit); // 触发一条新的 session.snapshot 推送
        return;
      }
      case "session.send": {
        const { sessionId, text, images } = message.params ?? {};
        const hasText = typeof text === "string" && text.trim();
        const ids = Array.isArray(images) ? images.slice(0, 4) : [];
        if (!sessionId || (!hasText && !ids.length)) {
          this.#reply(message.id, null, { code: 400, message: "缺少 sessionId 或消息内容" });
          return;
        }
        let imageUrls;
        try {
          imageUrls = this.#takeUploads(ids); // 引用已上传完的附图，转 data URL
        } catch (err) {
          this.#reply(message.id, null, { code: 400, message: err.message });
          return;
        }
        try {
          const options = sanitizeTurnOptions(message.params?.options);
          const res = await this.#daemon.hub.sendMessage(sessionId, hasText ? text : "", imageUrls, options);
          this.#reply(message.id, res);
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `发送失败: ${err.message}` });
        }
        return;
      }
      case "goal.set": {
        // 会话目标（官方 App 的 Pursue goal）：goal 为空串/缺省即清除
        const { sessionId, goal } = message.params ?? {};
        if (!sessionId || (goal !== undefined && typeof goal !== "string") || (goal?.length ?? 0) > 4000) {
          this.#reply(message.id, null, { code: 400, message: "goal.set 参数非法" });
          return;
        }
        try {
          this.#reply(message.id, await this.#daemon.hub.setGoal(sessionId, goal?.trim() || null));
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `设定目标失败: ${err.message}` });
        }
        return;
      }
      case "goal.get": {
        const { sessionId } = message.params ?? {};
        if (!sessionId) {
          this.#reply(message.id, null, { code: 400, message: "缺少 sessionId" });
          return;
        }
        this.#reply(message.id, await this.#daemon.hub.getGoal(sessionId));
        return;
      }
      case "models.list": {
        // 代理 app-server 的 model/list：手机端模型选择器数据源（瘦身：只留展示与选择所需）
        try {
          const r = await this.#daemon.appServer.request("model/list", {});
          const models = (r?.data ?? [])
            .filter((m) => !m.hidden)
            .map((m) => ({
              id: m.id ?? m.model,
              name: m.displayName ?? m.model ?? m.id,
              description: m.description ?? "",
              efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
              defaultEffort: m.defaultReasoningEffort ?? null,
              isDefault: m.isDefault === true,
            }));
          this.#reply(message.id, { models });
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `获取模型列表失败: ${err.message}` });
        }
        return;
      }
      case "image.push": {
        // 手机端发消息附图：分块上传（image.fetch 的镜像方向），eof 齐后待 session.send 引用
        const { id, mime, data, eof } = message.params ?? {};
        if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id) || typeof data !== "string") {
          this.#reply(message.id, null, { code: 400, message: "image.push 参数非法" });
          return;
        }
        let up = this.#uploads.get(id);
        if (!up) {
          up = { mime: typeof mime === "string" ? mime : "image/jpeg", parts: [], chars: 0, done: false };
          this.#uploads.set(id, up);
        }
        up.chars += data.length;
        this.#uploadChars += data.length;
        if (up.chars > IMAGE_MAX_CHARS || this.#uploadChars > ClientSession.#UPLOAD_BUDGET) {
          this.#dropUpload(id);
          this.#reply(message.id, null, { code: 413, message: "图片过大或上传缓冲已满" });
          return;
        }
        up.parts.push(data);
        if (eof) up.done = true;
        this.#reply(message.id, { ok: true });
        return;
      }
      case "turn.interrupt": {
        const { sessionId } = message.params ?? {};
        try {
          this.#reply(message.id, await this.#daemon.hub.interrupt(sessionId));
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: err.message });
        }
        return;
      }
      case "session.new": {
        const cwd = message.params?.cwd;
        if (cwd && !this.#daemon.isCwdAllowed(cwd)) {
          this.#reply(message.id, null, { code: 403, message: "该目录不在允许列表中" });
          return;
        }
        try {
          this.#reply(message.id, await this.#daemon.hub.newThread(cwd));
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `新建失败: ${err.message}` });
        }
        return;
      }
      case "image.fetch": {
        // 分块返回缓存图片：单块 ≤96k base64 字符，信封远小于 relay 256KiB 上限
        const { id, offset = 0 } = message.params ?? {};
        const img = imageCache.get(id);
        if (!img) {
          this.#reply(message.id, null, { code: 404, message: "图片不在缓存（电脑端可能重启过，重新打开会话可恢复）" });
          return;
        }
        const CHUNK = 96_000;
        const data = img.data.slice(offset, offset + CHUNK);
        this.#reply(message.id, {
          data,
          mime: img.mime,
          size: img.data.length,
          eof: offset + CHUNK >= img.data.length,
        });
        return;
      }
      case "approval.respond": {
        const { approvalKey, decision } = message.params ?? {};
        const allowed = ["accept", "acceptForSession", "decline", "cancel"];
        if (!allowed.includes(decision)) {
          this.#reply(message.id, null, { code: 400, message: "非法审批决定" });
          return;
        }
        this.#reply(message.id, this.#daemon.hub.respondApproval(approvalKey, decision));
        return;
      }
      default:
        this.#reply(message.id, null, { code: 400, message: `未知方法: ${message.method}` });
    }
  }

  async #auth(message) {
    const params = message.params ?? {};
    if (params.pairToken) {
      const paired = consumePairToken(this.#daemon.configPath, params.pairToken);
      if (!paired) {
        this.#reply(message.id, null, { code: 403, message: "配对码无效或已过期" });
        this.#close();
        return;
      }
      this.#daemon.config = paired.config;
      this.#device = paired.device;
      // 一次性配对即连接：写入 lastSeenAt，使设备页「最近连接」反映刚连过（createDevice 建时留空）
      paired.device.lastSeenAt = Date.now();
      saveConfig(this.#daemon.configPath, this.#daemon.config);
      this.#reply(message.id, {
        deviceId: paired.device.deviceId,
        deviceToken: paired.deviceToken,
        daemonName: paired.config.daemonName,
        protocol: APP_PROTOCOL,
        engine: this.#daemon.appServer.healthy ? "ok" : "down",
      });
      this.#daemon.hub.registerClient(this);
      this.#daemon.log(`新设备配对成功: ${paired.device.deviceId}`);
      return;
    }
    if (params.deviceToken) {
      // 重读配置，保证撤销立即生效
      this.#daemon.config = loadOrCreateConfig(this.#daemon.configPath);
      const device = findDeviceByToken(this.#daemon.config, params.deviceToken);
      if (!device) {
        this.#reply(message.id, null, { code: 403, message: "设备令牌无效（可能已被撤销）" });
        this.#close();
        return;
      }
      device.lastSeenAt = Date.now();
      saveConfig(this.#daemon.configPath, this.#daemon.config);
      this.#device = device;
      this.#reply(message.id, {
        deviceId: device.deviceId,
        deviceToken: params.deviceToken,
        daemonName: this.#daemon.config.daemonName,
        protocol: APP_PROTOCOL,
        engine: this.#daemon.appServer.healthy ? "ok" : "down",
      });
      this.#daemon.hub.registerClient(this);
      return;
    }
    this.#reply(message.id, null, { code: 400, message: "缺少配对码或设备令牌" });
    this.#close();
  }

  async #watch(message) {
    const sessionId = message.params?.sessionId;
    const threads = await this.#daemon.appServer.listThreads(200);
    const thread = threads.find((t) => t.id === sessionId);
    if (!thread?.path) {
      this.#reply(message.id, null, { code: 404, message: "会话不存在" });
      return;
    }
    this.#stopWatch();
    this.#watchedThreadId = sessionId;
    // 历史与增量走 rollout 文件 tail；实时流式事件（发消息后的增量输出、
    // 审批）走 app-server 事件，由 hub 推送。二者互补。
    this.#daemon.hub.subscribe(sessionId, this);
    this.#tail = new RolloutTail(thread.path, {
      onItems: (items, meta) => this.#sendItems(sessionId, items, meta),
      onError: (err) => this.#daemon.log(`tail ${sessionId} 失败: ${err.message}`),
    });
    this.#reply(message.id, { ok: true });
    await this.#tail.start();
  }

  #stopWatch() {
    this.#tail?.close();
    this.#tail = null;
    if (this.#watchedThreadId) {
      this.#daemon.hub.unsubscribe(this.#watchedThreadId, this);
      this.#watchedThreadId = null;
    }
  }

  #isFileActive(path, now) {
    try {
      return now - statSync(path).mtimeMs < 60_000;
    } catch {
      return false;
    }
  }

  // —— 附图上传缓冲 ——
  #dropUpload(id) {
    const up = this.#uploads.get(id);
    if (!up) return;
    this.#uploadChars -= up.chars;
    this.#uploads.delete(id);
  }

  // 取出已上传完的附图并转为 data URL（turn/start 的 {type:"image",url} 输入项）
  #takeUploads(ids) {
    const urls = [];
    for (const id of ids) {
      const up = this.#uploads.get(id);
      if (!up?.done) throw new Error("图片尚未完成上传，请重试");
      urls.push(`data:${up.mime};base64,${up.parts.join("")}`);
      this.#dropUpload(id);
    }
    return urls;
  }

  // —— hub 推送入口 ——
  pushLiveEvent(sessionId, method, params) {
    this.#notify("session.live", { sessionId, event: method, params });
  }

  pushApproval(approvalKey, sessionId, method, params) {
    this.#notify("approval.request", {
      approvalKey,
      sessionId,
      kind: /fileChange|Patch/i.test(method) ? "fileChange" : "command",
      command: params?.command ?? null,
      cwd: params?.cwd ?? null,
      reason: params?.reason ?? null,
      // 文件修改审批：附文件清单与截断 diff，手机上才有足够上下文做决定
      files: summarizeFileChanges(params?.fileChanges ?? params?.changes),
    });
  }

  pushApprovalResolved(approvalKey) {
    this.#notify("approval.resolved", { approvalKey });
  }

  pushEngineState(healthy) {
    this.#notify("daemon.status", { engine: healthy ? "ok" : "down" });
  }

  pushBoardChanged(payload) {
    this.#notify("board.changed", payload);
  }

  // 分块发送，保证每帧不超过 relay 的 256KiB 上限：
  // 首块用 session.snapshot（客户端清屏），后续块一律 session.event（追加）
  #sendItems(sessionId, items, meta) {
    const snapshot = typeof meta === "object" ? meta.snapshot : meta; // 兼容旧签名
    const total = typeof meta === "object" ? meta.total : undefined;
    const MAX_CHUNK_CHARS = 64_000;
    const MAX_ITEM_CHARS = 48_000;
    let chunk = [];
    let size = 0;
    let first = snapshot;
    const flush = () => {
      if (chunk.length === 0 && !first) return;
      // total 只随快照的首个分片下发（手机端据此判断还有没有更早历史）
      const payload = first && total !== undefined
        ? { sessionId, items: chunk, total }
        : { sessionId, items: chunk };
      this.#notify(first ? "session.snapshot" : "session.event", payload);
      first = false;
      chunk = [];
      size = 0;
    };
    for (const item of items) {
      let entry = extractImages(item); // 大图抽出缓存，条目瘦身后再做截断判断
      let serialized = JSON.stringify(entry);
      if (serialized.length > MAX_ITEM_CHARS) {
        entry = {
          timestamp: item.timestamp,
          type: item.type,
          payload: { type: item.payload?.type ?? item.type, truncated: true },
        };
        serialized = JSON.stringify(entry);
      }
      if (size + serialized.length > MAX_CHUNK_CHARS && chunk.length > 0) flush();
      chunk.push(entry);
      size += serialized.length;
    }
    flush();
  }

  #reply(id, result, error = null) {
    if (id === undefined) return;
    this.#sendMessage(error ? { id, error } : { id, result });
  }

  #notify(method, params) {
    this.#sendMessage({ method, params });
  }

  #sendMessage(message) {
    if (!this.#key) return;
    this.#send(seal(this.#key, "d2c", message));
  }

  dispose() {
    this.#stopWatch();
    this.#uploads.clear();
    this.#uploadChars = 0;
    this.#daemon.hub?.removeClient(this);
  }
}
