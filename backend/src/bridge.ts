/**
 * 和浏览器插件（ai-web）的连接：插件连 ws://中转站:端口/ext，协议见插件仓库 docs/protocol.md。
 *  - 同一时间只认一个插件（新连上的顶替旧的）
 *  - call(site, cmd, args)：发命令、等结果；同一个网站的命令排队，一个做完再做下一个
 *  - ask 的生成进度通过 onProgress 回调给调用方
 */
import { EventEmitter } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { extToken } from "./auth.ts";
import { ACTIVE_SITE_IDS, siteName, type SiteId } from "./sites.ts";

export interface SiteState { site: string; name: string; open: boolean; ready: boolean; url?: string; chatId?: string; title?: string }
export interface BridgeStatus { connected: boolean; name: string | null; version: string | null; since: number | null; sites: SiteState[] }

interface Pending { resolve: (d: CallResult) => void; onProgress?: (p: Progress) => void; timer: ReturnType<typeof setTimeout> }
export interface CallResult { ok: boolean; data: Record<string, unknown> & { error?: string } }
export interface Progress { answer: string; thinkingLen: number; done: boolean; busy: boolean }

class Bridge extends EventEmitter {
  private ws: WebSocket | null = null;
  private info: { name: string | null; version: string | null; since: number | null } = { name: null, version: null, since: null };
  private sites = new Map<string, SiteState>();
  private pending = new Map<string, Pending>();
  private queues = new Map<string, Promise<unknown>>();
  private seq = 0;
  private wss = new WebSocketServer({ noServer: true });

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    let authed = false;
    ws.on("message", (raw) => {
      let m: Record<string, any>;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === "hello") {
        if (m.token !== extToken()) { ws.send(JSON.stringify({ type: "error", error: "插件口令不对（在中转站网页“设置”里看）", fatal: true })); setTimeout(() => ws.close(), 100); return; }
        ws.send(JSON.stringify({ type: "welcome", server: "AI 多方会议中转站" }));
        if (m.test) { setTimeout(() => ws.close(), 200); return; }
        authed = true;
        if (this.ws && this.ws !== ws) { try { this.ws.close(); } catch {} }
        this.ws = ws;
        this.info = { name: m.name ?? null, version: m.version ?? null, since: Date.now() };
        this.sites.clear();
        for (const s of m.sites || []) this.sites.set(s.site, s);
        this.emit("status");
        return;
      }
      if (!authed) return;
      if (m.type === "ping") { ws.send(JSON.stringify({ type: "pong", t: m.t })); return; }
      if (m.type === "event" && m.event === "tab" && m.site) { this.sites.set(m.site, m.data); this.emit("status"); return; }
      if (m.type === "progress") { const p = this.pending.get(m.id); p?.onProgress?.({ answer: m.answer ?? "", thinkingLen: m.thinkingLen ?? 0, done: !!m.done, busy: !!m.busy }); return; }
      if (m.type === "result") {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve({ ok: !!m.ok, data: m.data || {} });
      }
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.info = { name: null, version: null, since: null };
      this.sites.clear();
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, data: { error: "插件断开了", disconnected: true } }); this.pending.delete(id); }
      this.emit("status");
    });
    ws.on("error", () => {});
  }

  get connected(): boolean { return !!this.ws && this.ws.readyState === 1; }

  status(): BridgeStatus {
    return {
      connected: this.connected, ...this.info,
      sites: ACTIVE_SITE_IDS.map((s) => ({ site: s, name: siteName(s), open: false, ready: false, ...(this.sites.get(s) || {}) })),
    };
  }

  /** 发一个命令，等结果。同一个网站排队执行。 */
  call(site: SiteId | "", cmd: string, args: Record<string, unknown> = {}, opts: { timeoutMs?: number; onProgress?: (p: Progress) => void; now?: boolean } = {}): Promise<CallResult> {
    const run = () => new Promise<CallResult>((resolve) => {
      if (!this.connected || !this.ws) { resolve({ ok: false, data: { error: "插件没有连上中转站", disconnected: true } }); return; }
      const id = `r${++this.seq}-${Date.now()}`;
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, data: { error: `插件 ${Math.round((opts.timeoutMs ?? 120000) / 1000)} 秒没有回结果` } }); }, opts.timeoutMs ?? 120000);
      this.pending.set(id, { resolve, onProgress: opts.onProgress, timer });
      this.ws.send(JSON.stringify({ type: "cmd", id, site, cmd, args }));
    });
    if (!site || opts.now) return run(); // now：不排队（比如“停止生成”要插到正在进行的 ask 前面）
    const prev = this.queues.get(site) ?? Promise.resolve();
    const next = prev.then(run, run);
    this.queues.set(site, next.catch(() => {}));
    return next;
  }

  /** 测试用：断开当前插件。 */
  dropForTest(): void { this.ws?.close(); }
}

export const bridge = new Bridge();
