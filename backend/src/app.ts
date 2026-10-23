/**
 * 接口（除 /api/auth/* 外都要先登录）：
 *  认证   GET /api/auth/state · POST /api/auth/setup · POST /api/auth/login · POST /api/auth/logout
 *  状态   GET /api/status · GET /api/events?meeting=ID（SSE 实时推送）
 *  会议   GET/POST /api/meetings · GET/DELETE /api/meetings/:id · POST /api/meetings/:id/command
 *         GET /api/meetings/:id/minutes（导出纪要） · GET /api/meeting-rules
 *  风格   GET/POST /api/prompts · PUT/DELETE /api/prompts/:id
 *  对话   POST /api/chats/open（在浏览器里打开某个 AI 的对话）
 *  网站   POST /api/sites/:site/:action（open / focus / reload）
 *  文件   POST /api/uploads?draft=&name=（议题里上传，原始内容）· GET/DELETE /api/uploads/<路径>
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
import { isSite, SITE_IDS } from "./sites.ts";
import { deletePrompt, getPrompt, listPrompts, savePrompt } from "./prompts.ts";
import { meetingRules, isSeat, ALL_SEATS } from "./meetings/protocol.ts";
import { attachLines, broadcastList, createAndStart, getMeetingDetail, meetingSummary, runCommand, viewerLeft } from "./meetings/runner.ts";
import { deleteMeeting, getMeeting, isEnded, listMeetings } from "./meetings/store.ts";
import { minutesMarkdown } from "./meetings/minutes.ts";
import { deleteTopicUploads, deleteUpload, mimeOf, saveUpload, topicFiles, uploadMaxMb, uploadPath } from "./uploads.ts";

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
  app.get("/api/status", (c) => c.json({ version: VERSION, bridge: bridge.status(), attachLines: attachLines(), uploadMaxMb: uploadMaxMb() }));
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
    // 议题里上传的文件一起删（“重新讨论”的会议还在用的不删）
    const still = new Set(listMeetings().filter((x) => x.id !== id).flatMap((x) => topicFiles(getMeeting(x.id)?.topic ?? "").map((f) => f.rel)));
    if (!topicFiles(m.topic).some((f) => still.has(f.rel))) deleteTopicUploads(m.topic);
    deleteMeeting(id);
    broadcastList();
    return c.json({ ok: true }); // AI 网站上的对话不删
  });
  app.get("/api/meetings/:id/minutes", (c) => {
    const r = minutesMarkdown(c.req.param("id"));
    if (!r) return c.json({ error: "会议不存在" }, 404);
    return c.body(r.text, 200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(r.name)}` });
  });

  // ---- 议题里上传的文件
  app.post("/api/uploads", async (c) => {
    const buf = Buffer.from(await c.req.arrayBuffer());
    const r = saveUpload(c.req.query("draft") ?? "", c.req.query("name") ?? "文件", buf);
    return r.ok ? c.json(r) : c.json({ error: r.error }, 400);
  });
  app.get("/api/uploads/*", (c) => {
    const rel = decodeURIComponent(c.req.path.slice("/api/".length));
    const abs = uploadPath(rel);
    if (!abs || !existsSync(abs)) return c.json({ error: "文件不存在（可能已经删了）" }, 404);
    const name = rel.split("/").pop() ?? "文件", mime = mimeOf(name);
    const inline = /^(image\/|text\/|application\/pdf|application\/json)/.test(mime);
    return c.body(readFileSync(abs), 200, { "content-type": mime, "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`, "cache-control": "no-cache" });
  });
  app.delete("/api/uploads/*", (c) => {
    const rel = decodeURIComponent(c.req.path.slice("/api/".length));
    return deleteUpload(rel) ? c.json({ ok: true }) : c.json({ error: "文件不存在" }, 404);
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

  // ---- 在电脑的浏览器里打开某个 AI 的对话（会议页“更多”里用）
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
  app.get("/api/settings", (c) => c.json({ attachLines: attachLines(), uploadMaxMb: uploadMaxMb(), extToken: extToken(), version: VERSION }));
  app.put("/api/settings", async (c) => {
    const b = await body(c);
    if (b.attachLines !== undefined) {
      const n = Number(b.attachLines);
      if (!Number.isInteger(n) || n < 10 || n > 100000) return c.json({ error: "行数要在 10 到 100000 之间" }, 400);
      setSetting("attach_lines", String(n));
    }
    if (b.uploadMaxMb !== undefined) {
      const mb = Number(b.uploadMaxMb);
      if (!(mb > 0 && mb <= 100)) return c.json({ error: "上传文件上限要在 0～100 MB 之间" }, 400);
      setSetting("upload_max_mb", String(mb));
    }
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

export { SITE_IDS, ALL_SEATS };
