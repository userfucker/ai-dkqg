/**
 * 接口（除 /api/auth/* 外都要先登录）：
 *  认证   GET /api/auth/state · POST /api/auth/setup · POST /api/auth/login · POST /api/auth/logout
 *  状态   GET /api/status · GET /api/events?meeting=ID（SSE 实时推送）
 *  会议   GET/POST /api/meetings · GET/DELETE /api/meetings/:id · POST /api/meetings/:id/command
 *         GET /api/meetings/:id/minutes（导出纪要） · GET /api/meeting-rules
 *  风格   GET/POST /api/prompts · PUT/DELETE /api/prompts/:id
 *  会话   GET /api/chats · GET /api/chats/site/:site · POST /api/chats/delete · POST /api/chats/open
 *  网站   POST /api/sites/:site/:action（open / focus / reload）
 *  设置   GET/PUT /api/settings · POST /api/settings/ext-token · POST /api/settings/password
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { STATIC_DIR, VERSION } from "./config.ts";
import { checkPassword, extToken, hasPassword, isLoggedIn, login, logout, noteFail, regenerateExtToken, requireAuth, setPassword, tooManyFails } from "./auth.ts";
import { bridge } from "./bridge.ts";
import { addViewer } from "./events.ts";
import { setSetting } from "./db.ts";
import { isSite, SITE_IDS, siteName, type SiteId } from "./sites.ts";
import { deletePrompt, getPrompt, listPrompts, savePrompt } from "./prompts.ts";
import { meetingRules, isSeat, ALL_SEATS } from "./meetings/protocol.ts";
import { attachLines, broadcastList, createAndStart, getMeetingDetail, meetingSummary, runCommand, viewerLeft } from "./meetings/runner.ts";
import { deleteMeeting, getMeeting, isEnded, listChats, listMeetings, markChatDeleted } from "./meetings/store.ts";
import { minutesMarkdown } from "./meetings/minutes.ts";

type Body = Record<string, unknown>;
const body = async (c: { req: { json: () => Promise<unknown> } }): Promise<Body> => { try { return ((await c.req.json()) as Body) || {}; } catch { return {}; } };
const ipOf = (c: { req: { header: (k: string) => string | undefined } }) => c.req.header("x-forwarded-for")?.split(",")[0].trim() || c.req.header("x-real-ip") || "local";

export function createApp(): Hono {
  const app = new Hono();

  // ---- 认证
  app.get("/api/auth/state", (c) => c.json({ setup: !hasPassword(), loggedIn: isLoggedIn(c), version: VERSION }));
  app.post("/api/auth/setup", async (c) => {
    if (hasPassword()) return c.json({ error: "已经设置过密码了" }, 400);
    const { password } = await body(c);
    if (typeof password !== "string" || password.length < 6) return c.json({ error: "密码至少 6 位" }, 400);
    setPassword(password);
    login(c);
    return c.json({ ok: true });
  });
  app.post("/api/auth/login", async (c) => {
    const ip = ipOf(c);
    if (tooManyFails(ip)) return c.json({ error: "密码错误次数太多，10 分钟后再试" }, 429);
    const { password } = await body(c);
    if (typeof password !== "string" || !checkPassword(password)) { noteFail(ip); return c.json({ error: "密码不对" }, 401); }
    login(c);
    return c.json({ ok: true });
  });
  app.post("/api/auth/logout", (c) => { logout(c); return c.json({ ok: true }); });

  app.use("/api/*", async (c, next) => (c.req.path.startsWith("/api/auth/") ? next() : requireAuth(c, next)));

  // ---- 状态 / 实时推送
  app.get("/api/status", (c) => c.json({ version: VERSION, bridge: bridge.status(), attachLines: attachLines() }));
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const meetingId = c.req.query("meeting") || null;
      const send = (event: string, data: unknown) => { void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {}); };
      const removeViewer = addViewer({ meetingId, send });
      let left = false;
      const remove = () => { if (left) return; left = true; removeViewer(); if (meetingId) viewerLeft(meetingId); };
      stream.onAbort(remove);
      send("bridge", bridge.status());
      send("meetings", listMeetings().map(meetingSummary));
      if (meetingId) { const d = getMeetingDetail(meetingId); if (d) send("detail", d); }
      while (!stream.aborted) {
        await stream.sleep(20_000);
        send("ping", Date.now());
      }
      remove();
    }),
  );

  // ---- 会议
  app.get("/api/meeting-rules", (c) => c.json({ rules: meetingRules() }));
  app.get("/api/meetings", (c) => c.json({ meetings: listMeetings().map(meetingSummary) }));
  app.post("/api/meetings", async (c) => {
    const b = await body(c);
    const promptId = typeof b.promptId === "number" ? b.promptId : null;
    const prompt = promptId ? getPrompt(promptId) : undefined;
    if (promptId && !prompt) return c.json({ error: "会议风格不存在" }, 400);
    const r = createAndStart({
      topic: String(b.topic ?? ""), title: typeof b.title === "string" ? b.title : undefined,
      promptId, promptName: prompt?.name ?? null, promptContent: prompt?.content ?? "",
      participants: Array.isArray(b.participants) ? b.participants.map(String) : [],
      penMode: b.penMode === "fixed" ? "fixed" : "rotate", penSeat: isSeat(b.penSeat) ? b.penSeat : "A",
      maxRounds: Number(b.maxRounds ?? 10), waitSeconds: Number(b.waitSeconds ?? 0),
    });
    return r.ok ? c.json(r) : c.json({ error: r.error }, 400);
  });
  app.get("/api/meetings/:id", (c) => {
    const d = getMeetingDetail(c.req.param("id"));
    return d ? c.json({ meeting: d }) : c.json({ error: "会议不存在" }, 404);
  });
  app.post("/api/meetings/:id/command", async (c) => {
    const b = await body(c);
    const r = runCommand(c.req.param("id"), String(b.action ?? ""), b);
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, (r.status ?? 400) as 400);
  });
  app.delete("/api/meetings/:id", async (c) => {
    const id = c.req.param("id");
    const m = getMeeting(id);
    if (!m) return c.json({ error: "会议不存在" }, 404);
    if (!isEnded(m.status)) runCommand(id, "stop", {});
    let chatResult: unknown = null;
    if (c.req.query("deleteChats") === "1") chatResult = await deleteChats(listChats().filter((x) => x.meeting_id === id && !x.deleted_at).map((x) => ({ site: x.site, chatId: x.chat_id })));
    deleteMeeting(id);
    broadcastList();
    return c.json({ ok: true, chats: chatResult });
  });
  app.get("/api/meetings/:id/minutes", (c) => {
    const r = minutesMarkdown(c.req.param("id"));
    if (!r) return c.json({ error: "会议不存在" }, 404);
    return c.body(r.text, 200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(r.name)}` });
  });

  // ---- 会议风格提示词
  app.get("/api/prompts", (c) => c.json({ prompts: listPrompts() }));
  const savePromptReq = async (c: any, id?: number) => {
    const b = await body(c);
    const name = String(b.name ?? "").trim(), content = String(b.content ?? "").trim();
    if (!name) return c.json({ error: "名字不能为空" }, 400);
    return c.json({ ok: true, id: savePrompt({ id, name: name.slice(0, 60), content: content.slice(0, 20000), isDefault: !!b.isDefault }) });
  };
  app.post("/api/prompts", (c) => savePromptReq(c));
  app.put("/api/prompts/:id", (c) => savePromptReq(c, Number(c.req.param("id"))));
  app.delete("/api/prompts/:id", (c) => { deletePrompt(Number(c.req.param("id"))); return c.json({ ok: true }); });

  // ---- 会话管理
  app.get("/api/chats", (c) => {
    const meetings = new Map(listMeetings().map((m) => [m.id, m]));
    return c.json({
      chats: listChats().map((x) => ({ meetingId: x.meeting_id, meetingTitle: meetings.get(x.meeting_id)?.title ?? "", meetingStatus: meetings.get(x.meeting_id)?.status ?? "", site: x.site, siteName: siteName(x.site), chatId: x.chat_id, url: x.url, seat: x.seat, createdAt: x.created_at, deletedAt: x.deleted_at })),
    });
  });
  app.get("/api/chats/site/:site", async (c) => {
    const site = c.req.param("site");
    if (!isSite(site)) return c.json({ error: "不认识的网站" }, 400);
    const r = await bridge.call(site, "listChats", { max: Number(c.req.query("max") || 300) }, { timeoutMs: 180_000 });
    if (!r.ok) return c.json({ error: r.data.error ?? "获取失败" }, 502);
    const mine = new Map(listChats().filter((x) => x.site === site).map((x) => [x.chat_id, x]));
    const titles = new Map(listMeetings().map((m) => [m.id, m.title]));
    const list = ((r.data.list as { id: string }[]) || []).map((x) => ({ ...x, meetingId: mine.get(x.id)?.meeting_id ?? null, meetingTitle: titles.get(mine.get(x.id)?.meeting_id ?? "") ?? null }));
    return c.json({ list, current: r.data.current ?? null });
  });
  app.post("/api/chats/delete", async (c) => {
    const b = await body(c);
    const items = (Array.isArray(b.items) ? b.items : []).filter((x: any) => x && isSite(x.site) && typeof x.chatId === "string") as { site: SiteId; chatId: string }[];
    if (!items.length) return c.json({ error: "没有要删除的对话" }, 400);
    if (busySites().some((s) => items.some((x) => x.site === s))) return c.json({ error: "会议正在用这个网站，等这一轮发言结束再删" }, 409);
    return c.json(await deleteChats(items));
  });
  app.post("/api/chats/open", async (c) => {
    const b = await body(c);
    if (!isSite(b.site) || typeof b.chatId !== "string") return c.json({ error: "参数不对" }, 400);
    const r = await bridge.call(b.site, "openChat", { chatId: b.chatId }, { timeoutMs: 150_000 });
    if (r.ok) await bridge.call(b.site, "focus", {}, { timeoutMs: 30_000 });
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.data.error }, 502);
  });
  app.post("/api/sites/:site/:action", async (c) => {
    const site = c.req.param("site"), action = c.req.param("action");
    if (!isSite(site) || !["open", "focus", "reload"].includes(action)) return c.json({ error: "参数不对" }, 400);
    const r = await bridge.call(site, action, {}, { timeoutMs: 150_000 });
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.data.error }, 502);
  });

  // ---- 设置
  app.get("/api/settings", (c) => c.json({ attachLines: attachLines(), extToken: extToken(), version: VERSION }));
  app.put("/api/settings", async (c) => {
    const b = await body(c);
    const n = Number(b.attachLines);
    if (!Number.isInteger(n) || n < 10 || n > 100000) return c.json({ error: "行数要在 10 到 100000 之间" }, 400);
    setSetting("attach_lines", String(n));
    return c.json({ ok: true });
  });
  app.post("/api/settings/ext-token", (c) => c.json({ extToken: regenerateExtToken() }));
  app.post("/api/settings/password", async (c) => {
    const b = await body(c);
    if (typeof b.old !== "string" || !checkPassword(b.old)) return c.json({ error: "原密码不对" }, 400);
    if (typeof b.password !== "string" || b.password.length < 6) return c.json({ error: "新密码至少 6 位" }, 400);
    setPassword(b.password);
    login(c);
    return c.json({ ok: true });
  });

  // ---- 网页（单页应用）
  if (existsSync(STATIC_DIR)) {
    const root = relative(process.cwd(), STATIC_DIR) || ".";
    app.use("/*", serveStatic({ root }));
    const index = join(STATIC_DIR, "index.html");
    app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.json({ error: "没有这个接口" }, 404) : c.html(readFileSync(index, "utf8"))));
  } else {
    app.get("/", (c) => c.text("网页还没构建：先运行 npm run build（见 README）"));
  }
  return app;
}

/** 正在发言的网站（不能同时去删它的对话）。 */
function busySites(): string[] {
  const out: string[] = [];
  for (const m of listMeetings()) {
    if (m.status !== "running") continue;
    const d = getMeetingDetail(m.id);
    for (const l of d?.live ?? []) out.push(l.site);
  }
  return out;
}

async function deleteChats(items: { site: string; chatId: string }[]) {
  const bySite = new Map<string, string[]>();
  for (const x of items) bySite.set(x.site, [...(bySite.get(x.site) || []), x.chatId]);
  const results: { site: string; chatId: string; ok: boolean; error?: string }[] = [];
  for (const [site, ids] of bySite) {
    const r = await bridge.call(site as SiteId, "deleteChats", { ids }, { timeoutMs: 15 * 60_000 });
    const per = new Map(((r.data.results as { id: string; ok: boolean; error?: string }[]) || []).map((x) => [x.id, x]));
    for (const id of ids) {
      const x = per.get(id);
      const ok = !!x?.ok;
      if (ok) markChatDeleted(site, id);
      results.push({ site, chatId: id, ok, error: ok ? undefined : x?.error ?? r.data.error });
    }
  }
  return { ok: results.every((x) => x.ok), deleted: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results };
}

export { SITE_IDS, ALL_SEATS };
