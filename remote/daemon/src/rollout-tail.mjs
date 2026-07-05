// 实时跟踪 rollout JSONL 文件的追加写入（只读实时查看的数据源）
import { watch } from "node:fs";
import { open, stat } from "node:fs/promises";

const SNAPSHOT_MAX_ITEMS = 200;

// 解析 buffer 中的完整 JSONL 行，返回 { items, rest }
export function parseJsonlChunk(text) {
  const items = [];
  let rest = text;
  for (;;) {
    const idx = rest.indexOf("\n");
    if (idx === -1) break;
    const line = rest.slice(0, idx).trim();
    rest = rest.slice(idx + 1);
    if (!line) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      // 半行或损坏行：跳过（追加中的文件可能读到未写完的行，由 rest 缓冲兜底）
    }
  }
  return { items, rest };
}

// 一次性按条目窗口读取 rollout（offset/limit 为条目序号，非字节）。
// 观众回放"从头读"的数据源：首屏 [0,200)，随后向前翻页。返回 { items, total }。
export async function readRolloutWindow(path, offset, limit) {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (info.size === 0) return { items: [], total: 0 };
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    const { items } = parseJsonlChunk(buffer.toString("utf8"));
    const start = Math.max(0, offset | 0);
    const n = Math.max(0, limit | 0);
    return { items: items.slice(start, start + n), total: items.length };
  } finally {
    await handle.close();
  }
}

export class RolloutTail {
  #path;
  #onItems;
  #onError;
  #offset = 0;
  #pendingText = "";
  #watcher = null;
  #reading = false;
  #dirty = false;
  #closed = false;

  constructor(path, { onItems, onError = () => {} }) {
    this.#path = path;
    this.#onItems = onItems;
    this.#onError = onError;
  }

  // 回填尾部最多 SNAPSHOT_MAX_ITEMS 条，然后开始监听增量。
  // snapshot 附带 total（rollout 总条数），手机端据此判断"上面还有没有更早的"。
  async start() {
    const all = await this.#readFrom(0);
    this.#onItems(all.slice(-SNAPSHOT_MAX_ITEMS), { snapshot: true, total: all.length });
    this.#watcher = watch(this.#path, () => this.#scheduleRead());
    // Windows 下 fs.watch 对被占用文件可能丢事件，用低频轮询兜底
    this.#poller = setInterval(() => this.#scheduleRead(), 1500);
    this.#poller.unref?.();
  }

  // 手机端「下拉加载更早」：按更大的 limit 重发一次尾部快照。
  // 用非破坏性全量读，不动增量 offset，实时 tail 不受影响。
  async resnapshot(limit) {
    const all = await this.#readAllPure();
    const n = Math.max(1, Math.min(all.length, limit | 0));
    this.#onItems(all.slice(-n), { snapshot: true, total: all.length });
  }

  // 从头读整份文件并解析，不改动 #offset/#pendingText（仅供快照重发用）
  async #readAllPure() {
    const handle = await open(this.#path, "r");
    try {
      const info = await handle.stat();
      if (info.size === 0) return [];
      const buffer = Buffer.alloc(info.size);
      await handle.read(buffer, 0, info.size, 0);
      const { items } = parseJsonlChunk(buffer.toString("utf8"));
      return items;
    } finally {
      await handle.close();
    }
  }

  #poller = null;

  #scheduleRead() {
    if (this.#closed) return;
    if (this.#reading) {
      this.#dirty = true;
      return;
    }
    this.#reading = true;
    this.#readAppended()
      .catch((err) => this.#onError(err))
      .finally(() => {
        this.#reading = false;
        if (this.#dirty) {
          this.#dirty = false;
          this.#scheduleRead();
        }
      });
  }

  async #readAppended() {
    const info = await stat(this.#path);
    if (info.size <= this.#offset) return;
    const items = await this.#readFrom(this.#offset);
    if (items.length > 0 && !this.#closed) {
      this.#onItems(items, { snapshot: false });
    }
  }

  async #readFrom(offset) {
    const handle = await open(this.#path, "r");
    try {
      const info = await handle.stat();
      if (info.size <= offset) return [];
      const length = info.size - offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      this.#offset = info.size;
      const { items, rest } = parseJsonlChunk(this.#pendingText + buffer.toString("utf8"));
      // 未换行的尾部留待下次拼接；offset 已推进，用文本缓冲衔接
      this.#pendingText = rest;
      return items;
    } finally {
      await handle.close();
    }
  }

  close() {
    this.#closed = true;
    this.#watcher?.close();
    if (this.#poller) clearInterval(this.#poller);
  }
}
