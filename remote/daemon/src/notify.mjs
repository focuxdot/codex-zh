// Webhook 通知：任务完成 / 需要审批时主动推到手机，弥补国内 Web Push 不可用。
// 关键约束：通知走第三方明文渠道，只发摘要（事件类型 + 会话名），
// 绝不含命令原文、代码、文件路径（见 remote/PRD-remote.md 安全需求）。
const TIMEOUT_MS = 8000;

// 构造单个 provider 的请求。返回 { url, init } 供 fetch 调用。
export function buildRequest(n, title, body) {
  switch (n.type) {
    case "bark": {
      // Bark（iOS，开源自托管友好）。默认官方服务器，可用 server 覆盖。
      const base = (n.server || "https://api.day.app").replace(/\/$/, "");
      return {
        url: `${base}/${encodeURIComponent(n.key)}`,
        init: json({ title, body, group: "Codex-ZH" }),
      };
    }
    case "serverchan":
      // Server 酱（微信推送）
      return {
        url: `https://sctapi.ftqq.com/${encodeURIComponent(n.key)}.send`,
        init: json({ title, desp: body }),
      };
    case "wecom":
      // 企业微信群机器人
      return { url: n.url, init: json({ msgtype: "text", text: { content: `${title}\n${body}` } }) };
    case "dingtalk":
      // 钉钉群机器人
      return { url: n.url, init: json({ msgtype: "text", text: { content: `${title}\n${body}` } }) };
    case "custom":
      // 自定义 webhook：收 {title, body, source}
      return { url: n.url, init: json({ title, body, source: "codex-zh-remote" }) };
    default:
      return null;
  }
}

function json(obj) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  };
}

// 脱敏展示（日志用）：不暴露完整 key/url
export function redact(n) {
  if (n.key) return `${n.type}:${n.key.slice(0, 4)}…`;
  if (n.url) {
    try {
      return `${n.type}:${new URL(n.url).host}`;
    } catch {
      return n.type;
    }
  }
  return n.type;
}

export class Notifier {
  #notifiers;
  #fetch;
  #log;

  constructor(notifiers = [], { fetch = globalThis.fetch, log = () => {} } = {}) {
    this.#notifiers = notifiers;
    this.#fetch = fetch;
    this.#log = log;
  }

  get count() {
    return this.#notifiers.length;
  }

  // 并发发送到所有已配置渠道；单个失败不影响其他，只记日志
  async send(title, body) {
    if (this.#notifiers.length === 0) return;
    await Promise.allSettled(
      this.#notifiers.map(async (n) => {
        const req = buildRequest(n, title, body);
        if (!req?.url) return;
        try {
          const res = await this.#fetch(req.url, {
            ...req.init,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!res.ok) this.#log(`通知发送失败 ${redact(n)}: HTTP ${res.status}`);
        } catch (err) {
          this.#log(`通知发送异常 ${redact(n)}: ${err.message}`);
        }
      }),
    );
  }
}
