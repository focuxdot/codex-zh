// 单个远端设备连接的 E2E 会话：握手 -> 鉴权 -> 方法路由（见 PROTOCOL.md §2/§3）
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import {
  APP_PROTOCOL,
  consumePairToken,
  findDeviceByToken,
  isDeviceExpired,
  isViewerDevice,
  issueViewerToken,
  loadOrCreateConfig,
  mergeDevicesByClient,
  saveConfig,
} from "./config.mjs";
import { deriveSessionKey, open as sealedOpen, seal } from "./crypto.mjs";
import { readRolloutWindow, RolloutTail } from "./rollout-tail.mjs";

// 手机端鉴权时上报的设备短标签（如「iPhone · 微信」）净化后作 device.name 显示用：
// 去控制字符/换行、掐头空白、限长，避免污染配置或菜单显示。非字符串一律成空串。
function sanitizeDeviceName(s) {
  if (typeof s !== "string") return "";
  return s.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 40);
}

// 手机端上报的浏览器身份 id（clientId）：本 app 自己生成、存在手机 localStorage 里的随机 id，
// 只用于"同一浏览器归并成一台设备"，不参与鉴权。净化为 [A-Za-z0-9_-]、限长；太短的当无效
// （避免脏值误把不同设备归并到一起）。非字符串一律成空串。
function sanitizeClientId(s) {
  if (typeof s !== "string") return "";
  const t = s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return t.length >= 8 ? t : "";
}

// 围观（只读）连接的方法白名单：默认拒绝，未列出的方法（含未来新增）一律 403。
// session.watch 另有 scope 校验、image.fetch 另有会话归属校验、session.more 另有频控。
const VIEWER_METHODS = new Set([
  "ping",
  "session.watch",
  "session.unwatch",
  "session.more",
  "image.fetch",
  "share.react",
]);

// 观众端 session.more 最小间隔：链接在群里意味着观众不可信，
// 反复触发会迫使 daemon 重读重发大快照（读放大）。
// 观众读放大频控：session.more 与 session.watch 都会迫使 daemon 重读整份
// rollout（回放窗口/尾部快照），二者共用同一最小间隔
const VIEWER_READ_MIN_INTERVAL_MS = 2000;

// 喝彩表情枚举：无文字即无骂人、无审核、无注入面
const REACT_EMOJI = new Set(["👏", "🔥", "❤️", "😂", "🤯"]);

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
// sessions 记录图片的来源会话集合：缓存按内容哈希去重，同一张图可能出现在
// 多个会话，观众取图时校验其 scope 在集合内（全权设备不受限）。
const imageCache = new Map(); // id -> { data: b64, mime, sessions: Set<sessionId> }
let imageCacheChars = 0;
const IMAGE_CACHE_BUDGET = 32 * 1024 * 1024; // base64 字符数预算（≈24MB 原始字节）
const IMAGE_MAX_CHARS = 12 * 1024 * 1024;

function sniffImageMime(b64) {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

function cacheImage(b64, mime, sessionId) {
  if (typeof b64 !== "string" || b64.length > IMAGE_MAX_CHARS) return null;
  const id = createHash("sha256")
    .update(b64.slice(0, 64)).update(b64.slice(-64)).update(String(b64.length))
    .digest("base64url").slice(0, 16);
  const existing = imageCache.get(id);
  if (existing) {
    imageCache.delete(id); // LRU：重插到队尾
    imageCache.set(id, existing);
    if (sessionId) existing.sessions.add(sessionId);
  } else {
    imageCache.set(id, { data: b64, mime, sessions: new Set(sessionId ? [sessionId] : []) });
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

export function extractImages(item, sessionId) {
  const p = item?.payload;
  if (!p) return item;
  if (p.type === "image_generation_call" && typeof p.result === "string" && p.result.length > 4096) {
    const ref = cacheImage(p.result, sniffImageMime(p.result), sessionId);
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
      const ref = cacheImage(b64, mime, sessionId);
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
  // 回放模式（观众看已结束的会话，从头读）：记文件路径与已下发条目数
  #replayPath = null;
  #replayOffset = 0;
  // 回放帧被 outbox 溢出丢弃时的最低条目偏移：drain 排空后从这里补读续传
  // （#enqueue 在此非空时并入丢弃后续回放帧，保证被丢条目连续、追加补齐即无重无漏）
  #replayLow = null;
  #enqueueReplayFrom = null; // #sendItems 入队时给帧打回放偏移标（瞬时游标）
  #resendingReplay = false; // 补发单飞闸（见 #resendReplay）
  // 手机上传的附图缓冲（image.push 分块，session.send 引用后即弃）
  #uploads = new Map(); // id -> { mime, parts: [], chars, done }
  #uploadChars = 0;
  static #UPLOAD_BUDGET = 24 * 1024 * 1024; // 单连接缓冲上限（base64 字符）
  // 观众连接的低优先级发送队列（控制通道优先：审批与全权设备帧永远直发，
  // 上行饱和时延迟/丢弃观众帧，观众端经尾部快照追平）
  #outbox = []; // [{ message, size }]
  #outboxChars = 0;
  #drainTimer = null;
  #needsResnapshot = false;
  #congestedSince = 0; // 观众帧开始积压的时刻；0 = 未拥塞
  #lastMoreAt = 0; // session.more 频控（仅观众）
  #lastWatchAt = 0; // session.watch 频控（仅观众；fromStart 每次都是整文件读）
  // share.react 令牌桶：突发 5、平均 2/s（连点狂按被吸收，刷子被拒）
  #reactTokens = 5;
  #reactRefillAt = Date.now();
  static #OUTBOX_MAX_FRAMES = 200;
  static #OUTBOX_MAX_CHARS = 2 * 1024 * 1024;
  static #SEND_HIGH_WATER = 1 << 20; // relay WebSocket bufferedAmount 高水位

  constructor(cid, daemon, { send, close }) {
    this.#cid = cid;
    this.#daemon = daemon;
    this.#send = send;
    this.#close = close;
  }

  // —— 供 hub/main 读取的连接身份（#device 保持私有）——
  get deviceId() {
    return this.#device?.deviceId ?? null;
  }

  get isViewer() {
    return isViewerDevice(this.#device);
  }

  get scopeSessionId() {
    return this.#device?.scope?.sessionId ?? null;
  }

  // 观众帧持续积压的起始时刻（拥塞提示用）；未拥塞为 0
  get congestedSince() {
    return this.#congestedSince;
  }

  // 撤销/过期时由 daemon 主动断开该连接；对端重连后鉴权得 403 进入终态
  kick() {
    this.#close();
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
    // 只读围观连接：默认拒绝，白名单放行（未来新增方法天然被拒）
    if (this.isViewer && !VIEWER_METHODS.has(message.method)) {
      this.#reply(message.id, null, { code: 403, message: "只读围观连接无权执行该操作" });
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
        if (this.isViewer) {
          const now = Date.now();
          if (now - this.#lastMoreAt < VIEWER_READ_MIN_INTERVAL_MS) {
            this.#reply(message.id, null, { code: 429, message: "操作过于频繁，请稍候" });
            return;
          }
          this.#lastMoreAt = now;
        }
        const limit = Math.max(1, Math.min(5000, Number(message.params?.limit) || 200));
        // 回放模式：从上次位置继续向后读，以 session.event（追加）下发——
        // 与尾部模式的"重发更大快照"语义相反，读一个创造过程应从头往后读
        if (this.#replayPath) {
          const from = this.#replayOffset;
          const { items, total } = await readRolloutWindow(this.#replayPath, from, limit);
          this.#reply(message.id, {
            ok: true,
            mode: "replay",
            total,
            done: from + items.length >= total,
          });
          this.#sendItems(this.#watchedThreadId, items, { snapshot: false, replayFrom: from });
          this.#replayOffset = from + items.length;
          return;
        }
        if (!this.#tail) {
          this.#reply(message.id, null, { code: 409, message: "未在监听会话" });
          return;
        }
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
        // 观众只能取本会话抽出的图片（缓存按内容哈希跨会话去重，故校验来源集合）
        if (this.isViewer && !img.sessions.has(this.scopeSessionId)) {
          this.#reply(message.id, null, { code: 403, message: "该图片不属于本会话" });
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
      // —— 围观链接（仅全权设备：viewer 已被上方白名单挡住）——
      // 配置写路径一律"从盘 fresh-load → 改 → 存 → 回写内存"：deviceToken 鉴权
      // 每次都整体重读配置，直接改内存旧引用会被下一次鉴权覆盖丢失。
      case "share.create": {
        const { sessionId, ttl } = message.params ?? {};
        if (!sessionId || (ttl !== "24h" && ttl !== null && ttl !== undefined)) {
          this.#reply(message.id, null, { code: 400, message: "share.create 参数非法（ttl 仅支持 \"24h\" 或 null）" });
          return;
        }
        const threads = await this.#daemon.appServer.listThreads(200);
        const thread = threads.find((t) => t.id === sessionId);
        if (!thread) {
          this.#reply(message.id, null, { code: 404, message: "会话不存在" });
          return;
        }
        const fresh = loadOrCreateConfig(this.#daemon.configPath);
        const { device } = issueViewerToken(this.#daemon.configPath, fresh, {
          sessionId,
          sessionName: thread.name || "",
          ttlMs: ttl === "24h" ? 24 * 3600_000 : null,
        });
        this.#daemon.config = fresh;
        this.#reply(message.id, { url: device.url, deviceId: device.deviceId });
        return;
      }
      case "share.revoke": {
        const { deviceId } = message.params ?? {};
        if (!deviceId) {
          this.#reply(message.id, null, { code: 400, message: "缺少 deviceId" });
          return;
        }
        const fresh = loadOrCreateConfig(this.#daemon.configPath);
        const target = (fresh.devices ?? []).find((d) => d.deviceId === deviceId);
        // 仅允许撤销围观条目：全权设备撤销走桌面设备页，协议面不扩权
        if (!target || !isViewerDevice(target)) {
          this.#reply(message.id, null, { code: 404, message: "围观链接不存在" });
          return;
        }
        fresh.devices = fresh.devices.filter((d) => d !== target);
        saveConfig(this.#daemon.configPath, fresh);
        this.#daemon.config = fresh;
        this.#daemon.hub.finishLink?.(deviceId); // 围观战报（有访客才发），先交账再踢人
        this.#daemon.kickDevice?.(deviceId); // 撤销即全场踢（config-watch 是兜底）
        this.#reply(message.id, { ok: true });
        return;
      }
      case "share.react": {
        // 围观层互动：只进 daemon 的通知广播，绝不进会话与 agent 上下文
        const { emoji } = message.params ?? {};
        if (!REACT_EMOJI.has(emoji)) {
          this.#reply(message.id, null, { code: 400, message: "不支持的表情" });
          return;
        }
        const now = Date.now();
        this.#reactTokens = Math.min(5, this.#reactTokens + ((now - this.#reactRefillAt) / 1000) * 2);
        this.#reactRefillAt = now;
        if (this.#reactTokens < 1) {
          this.#reply(message.id, null, { code: 429, message: "喝彩太快了，歇一下" });
          return;
        }
        this.#reactTokens -= 1;
        const sessionId = this.isViewer ? this.scopeSessionId : message.params?.sessionId;
        if (!sessionId) {
          this.#reply(message.id, null, { code: 400, message: "缺少 sessionId" });
          return;
        }
        // 创作者按链接静音全部互动：muted 按 deviceId 查当前配置（#device 可能是旧引用）
        if (this.isViewer) {
          const entry = (this.#daemon.config.devices ?? []).find((d) => d.deviceId === this.deviceId);
          if (entry?.muted === true) {
            this.#reply(message.id, { ok: true }); // 静默丢弃：不计数、不广播、不提示
            return;
          }
        }
        this.#daemon.hub.addReaction(sessionId, emoji, this.isViewer ? this.deviceId : null);
        this.#reply(message.id, { ok: true });
        return;
      }
      case "share.mute": {
        // 仅全权（viewer 被白名单挡住）：按链接静音全部互动，防打扰是底线
        const { deviceId, muted } = message.params ?? {};
        if (!deviceId || typeof muted !== "boolean") {
          this.#reply(message.id, null, { code: 400, message: "share.mute 参数非法" });
          return;
        }
        const fresh = loadOrCreateConfig(this.#daemon.configPath);
        const target = (fresh.devices ?? []).find((d) => d.deviceId === deviceId);
        if (!target || !isViewerDevice(target)) {
          this.#reply(message.id, null, { code: 404, message: "围观链接不存在" });
          return;
        }
        target.muted = muted;
        saveConfig(this.#daemon.configPath, fresh);
        this.#daemon.config = fresh;
        this.#reply(message.id, { ok: true });
        return;
      }
      case "share.list": {
        // 分享弹窗数据源：该会话已存在的围观链接（决策 5：先展示、显式再生成）
        const { sessionId } = message.params ?? {};
        if (!sessionId) {
          this.#reply(message.id, null, { code: 400, message: "缺少 sessionId" });
          return;
        }
        const fresh = loadOrCreateConfig(this.#daemon.configPath);
        this.#daemon.config = fresh;
        const links = (fresh.devices ?? [])
          .filter((d) => isViewerDevice(d) && d.scope?.sessionId === sessionId && !isDeviceExpired(d))
          .map((d) => ({
            deviceId: d.deviceId,
            url: d.url ?? null,
            createdAt: d.createdAt,
            expiresAt: d.expiresAt ?? null,
            muted: d.muted === true,
            viewers: this.#daemon.hub.viewerCountByDevice?.(d.deviceId) ?? 0,
          }));
        this.#reply(message.id, { links });
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
      // 手机上报的 UA 短标签作可读设备名（如「iPhone · 微信」）
      const pairName = sanitizeDeviceName(params.name);
      if (pairName) paired.device.name = pairName;
      // 同一浏览器归并：作废该浏览器名下的旧凭据，只留这条（详见 mergeDevicesByClient）
      const pairCid = sanitizeClientId(params.clientId);
      let pairMerged = [];
      if (pairCid) {
        paired.device.clientId = pairCid;
        pairMerged = mergeDevicesByClient(this.#daemon.config, paired.device.deviceId, pairCid);
      }
      saveConfig(this.#daemon.configPath, this.#daemon.config);
      this.#reply(message.id, {
        deviceId: paired.device.deviceId,
        deviceToken: paired.deviceToken,
        daemonName: paired.config.daemonName,
        protocol: APP_PROTOCOL,
        engine: this.#daemon.appServer.healthy ? "ok" : "down",
      });
      this.#daemon.hub.registerClient(this);
      for (const id of pairMerged) this.#daemon.kickDevice?.(id); // 旧凭据若还连着，一并踢下线
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
      const viewer = isViewerDevice(device);
      let devMerged = []; // 全权设备按 clientId 归并后被作废的旧条目（分支外踢下线用）
      if (isDeviceExpired(device)) {
        this.#reply(message.id, null, {
          code: 403,
          message: viewer ? "围观链接已过期" : "设备令牌已过期",
        });
        this.#close();
        return;
      }
      if (viewer) {
        // 熔断背板（非产品限制）：仅防病态场景（脚本海量建连打爆内存），
        // 按 scope.sessionId 跨该会话全部围观链接聚合计数，正常传播碰不到。
        const limit = this.#daemon.config.viewerLimit ?? 100;
        if (this.#daemon.hub.viewerCount(device.scope?.sessionId) >= limit) {
          this.#reply(message.id, null, {
            code: 403,
            message: `围观人数已达上限（${limit}），为保护分享者的电脑暂不接待新观众`,
          });
          this.#close();
          return;
        }
        // 围观链接是共享条目：不用观众 UA 改写条目名（会被 N 个观众反复变脸）；
        // lastSeenAt 写盘节流——观众每次进出都写配置文件没有必要
        if (!device.lastSeenAt || Date.now() - device.lastSeenAt > 10 * 60_000) {
          device.lastSeenAt = Date.now();
          saveConfig(this.#daemon.configPath, this.#daemon.config);
        }
      } else {
        device.lastSeenAt = Date.now();
        // 永久链接设备建时无名；每次连接用手机上报的 UA 短标签刷新可读名
        const devName = sanitizeDeviceName(params.name);
        if (devName) device.name = devName;
        // 同一浏览器归并：作废该浏览器名下的旧凭据，只留这条
        const devCid = sanitizeClientId(params.clientId);
        if (devCid) {
          device.clientId = devCid;
          devMerged = mergeDevicesByClient(this.#daemon.config, device.deviceId, devCid);
        }
        saveConfig(this.#daemon.configPath, this.#daemon.config);
      }
      this.#device = device;
      this.#reply(message.id, {
        deviceId: device.deviceId,
        deviceToken: params.deviceToken,
        daemonName: this.#daemon.config.daemonName,
        protocol: APP_PROTOCOL,
        engine: this.#daemon.appServer.healthy ? "ok" : "down",
        // 观众端据此跳过看板直进会话只读视图
        ...(viewer
          ? {
              role: "viewer",
              scope: { sessionId: device.scope?.sessionId ?? null },
              sessionName: device.sessionName ?? "",
            }
          : {}),
      });
      this.#daemon.hub.registerClient(this);
      for (const id of devMerged) this.#daemon.kickDevice?.(id); // 同浏览器旧凭据若还连着，踢下线
      if (devMerged.length) this.#daemon.log(`归并同浏览器旧设备 ${devMerged.length} 条`);
      return;
    }
    this.#reply(message.id, null, { code: 400, message: "缺少配对码或设备令牌" });
    this.#close();
  }

  async #watch(message) {
    const sessionId = message.params?.sessionId;
    if (this.isViewer && sessionId !== this.scopeSessionId) {
      this.#reply(message.id, null, { code: 403, message: "该链接仅可围观指定会话" });
      return;
    }
    // 频控与 session.more 同源：watch（尤其 fromStart）每次都触发整文件读 +
    // 大快照重加密，链接是会转发给陌生人的，不能留无限读放大入口
    if (this.isViewer) {
      const now = Date.now();
      if (now - this.#lastWatchAt < VIEWER_READ_MIN_INTERVAL_MS) {
        this.#reply(message.id, null, { code: 429, message: "操作过于频繁，请稍候" });
        return;
      }
      this.#lastWatchAt = now;
    }
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
    // 回放模式（fromStart）：分享跑完的会话是主场景，读一个创造过程应从头
    // 往后读。仅对已结束的会话生效——在跑（或文件近 60s 活跃，覆盖桌面 GUI
    // 驱动）时忽略之，回落尾部实时模式。已知边界：回放中会话复活不自动转直播。
    const running =
      this.#daemon.hub.isRunning(sessionId) || this.#isFileActive(thread.path, Date.now());
    if (message.params?.fromStart && !running) {
      this.#replayPath = thread.path;
      const { items, total } = await readRolloutWindow(thread.path, 0, 200);
      this.#reply(message.id, { ok: true, mode: "replay", total });
      this.#sendItems(sessionId, items, { snapshot: true, total, replayFrom: 0 });
      this.#replayOffset = items.length;
      return;
    }
    this.#tail = new RolloutTail(thread.path, {
      onItems: (items, meta) => this.#sendItems(sessionId, items, meta),
      onError: (err) => this.#daemon.log(`tail ${sessionId} 失败: ${err.message}`),
    });
    this.#reply(message.id, { ok: true, mode: "tail" });
    await this.#tail.start();
  }

  #stopWatch() {
    this.#tail?.close();
    this.#tail = null;
    this.#replayPath = null;
    this.#replayOffset = 0;
    this.#replayLow = null;
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

  // —— 围观层（喝彩/人数/战报）：观众收到的走 outbox 低优先级，天然不挤审批 ——
  pushShareReaction(payload) {
    this.#notify("share.reaction", payload);
  }

  pushViewerCount(payload) {
    this.#notify("viewer.count", payload);
  }

  pushShareSummary(payload) {
    this.#notify("share.summary", payload);
  }

  // 分块发送，保证每帧不超过 relay 的 256KiB 上限：
  // 首块用 session.snapshot（客户端清屏），后续块一律 session.event（追加）
  #sendItems(sessionId, items, meta) {
    const snapshot = typeof meta === "object" ? meta.snapshot : meta; // 兼容旧签名
    const total = typeof meta === "object" ? meta.total : undefined;
    // 回放帧带条目偏移入队：outbox 溢出丢弃时才知道该从哪补读（游标随分片推进）
    let replayCursor = typeof meta === "object" && typeof meta.replayFrom === "number"
      ? meta.replayFrom
      : null;
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
      this.#enqueueReplayFrom = replayCursor;
      this.#notify(first ? "session.snapshot" : "session.event", payload);
      this.#enqueueReplayFrom = null;
      if (replayCursor !== null) replayCursor += chunk.length;
      first = false;
      chunk = [];
      size = 0;
    };
    for (const item of items) {
      let entry = extractImages(item, sessionId); // 大图抽出缓存（记来源会话），条目瘦身后再做截断判断
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
    // 控制通道优先：RPC 应答与全权设备帧直发；观众的通知帧（快照/增量等）
    // 走低优先级 outbox，按 relay 上行水位排空——上行饱和时排在观众帧后面的
    // 不只是观众画面，还有审批推送与分享者自己的操作回执。
    // pong 例外直发：它是连接活性信号，压进积压队列会让观众端误判断线
    if (this.isViewer && message.id === undefined && message.method !== "pong") {
      this.#enqueue(message);
      return;
    }
    this.#send(seal(this.#key, "d2c", message));
  }

  #enqueue(message) {
    // 溢出补发待跑期间，后续回放帧直接并入补发范围而不入队：这些帧的区间
    // 都落在 [#replayLow, 实时 #replayOffset) 内，先送达会与补发内容重复；
    // 丢掉它们让「被丢弃的回放条目」保持连续，补发按序追加即无重无漏
    if (this.#replayLow !== null && this.#enqueueReplayFrom !== null) return;
    const size = JSON.stringify(message).length;
    this.#outbox.push({ message, size, replayFrom: this.#enqueueReplayFrom });
    this.#outboxChars += size;
    if (
      this.#outbox.length > ClientSession.#OUTBOX_MAX_FRAMES ||
      this.#outboxChars > ClientSession.#OUTBOX_MAX_CHARS
    ) {
      // 积压超限：整段丢弃（观众允许跳帧），水位回落后追平——尾部模式重发
      // 快照即可；回放模式记下被丢帧的最低条目偏移，排空后从那里补读续传
      for (const frame of this.#outbox) {
        if (frame.replayFrom === null) continue;
        if (this.#replayLow === null || frame.replayFrom < this.#replayLow) {
          this.#replayLow = frame.replayFrom;
        }
      }
      this.#outbox.length = 0;
      this.#outboxChars = 0;
      this.#needsResnapshot = true;
    }
    this.#drainOutbox();
  }

  #drainOutbox() {
    if (this.#drainTimer) return; // 已有排空调度在等水位
    while (this.#outbox.length > 0) {
      const buffered = this.#daemon.getBufferedAmount?.() ?? 0;
      if (buffered >= ClientSession.#SEND_HIGH_WATER) {
        if (!this.#congestedSince) this.#congestedSince = Date.now();
        this.#drainTimer = setTimeout(() => {
          this.#drainTimer = null;
          this.#drainOutbox();
        }, 50);
        this.#drainTimer.unref?.();
        return;
      }
      const { message, size } = this.#outbox.shift();
      this.#outboxChars -= size;
      this.#send(seal(this.#key, "d2c", message));
    }
    this.#congestedSince = 0;
    if (this.#needsResnapshot) {
      this.#needsResnapshot = false;
      if (this.#replayPath && this.#replayLow !== null) {
        const from = this.#replayLow;
        this.#replayLow = null;
        this.#resendReplay(from);
      } else {
        this.#tail?.resnapshot(200).catch(() => {});
      }
    }
  }

  // 回放丢帧补发：配合 #enqueue 的并入丢弃，被丢的回放条目是 [from, 实时
  // #replayOffset) 的连续段，按原序追加补齐即无重无漏。单飞——溢出清空队列后
  // drain 会立刻再触发本方法，并发第二条补发流会重发，故只把更低起点并入
  async #resendReplay(from) {
    if (this.#resendingReplay) {
      if (this.#replayLow === null || from < this.#replayLow) this.#replayLow = from;
      return;
    }
    this.#resendingReplay = true;
    try {
      let at = from;
      // 上界取「触发补发时已答复的偏移」：补发期间并发 session.more 的帧
      // 走正常队列送达，越过它们会重发；仅当又有丢弃时随之外扩
      let target = this.#replayOffset;
      while (this.#replayPath) {
        if (this.#replayLow !== null) {
          // 补发期间又有丢弃：并入最低点重来，上界外扩到当下已答复的偏移
          at = Math.min(at, this.#replayLow);
          this.#replayLow = null;
          target = this.#replayOffset;
        }
        if (at >= target) break;
        if (
          this.#outbox.length > 0 ||
          (this.#daemon.getBufferedAmount?.() ?? 0) >= ClientSession.#SEND_HIGH_WATER
        ) {
          // 背压：水位没回落或上一批帧没送完就等——溢出会清空 outbox，
          // 只看队列长度会在高水位下读了丢、丢了读地空转
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 50);
            t.unref?.();
          });
          continue;
        }
        const { items } = await readRolloutWindow(this.#replayPath, at, 200);
        if (items.length === 0) break;
        this.#sendItems(this.#watchedThreadId, items, { snapshot: false, replayFrom: at });
        at += items.length;
      }
    } catch {
      // 文件被清理等：回放本身已不可继续，保持静默（连接层语义不变）
    } finally {
      this.#resendingReplay = false;
    }
  }

  dispose() {
    this.#stopWatch();
    this.#uploads.clear();
    this.#uploadChars = 0;
    if (this.#drainTimer) {
      clearTimeout(this.#drainTimer);
      this.#drainTimer = null;
    }
    this.#outbox.length = 0;
    this.#outboxChars = 0;
    this.#daemon.hub?.removeClient(this);
  }
}
