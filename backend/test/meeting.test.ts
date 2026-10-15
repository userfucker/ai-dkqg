/** 用假插件（WebSocket 客户端，按会议格式扮演几个 AI）跑完整场会议。 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import type { Server, AddressInfo } from "node:net";
import WebSocket from "ws";
import { useMemoryDb, setSetting } from "../src/db.ts";
useMemoryDb();
const { createApp } = await import("../src/app.ts");
const { bridge } = await import("../src/bridge.ts");
const { extToken } = await import("../src/auth.ts");
const { createAndStart, runCommand, getMeetingDetail } = await import("../src/meetings/runner.ts");
const { minutesMarkdown } = await import("../src/meetings/minutes.ts");

let server: Server, port = 0;
const log: { site: string; cmd: string; args: any }[] = [];
const current: Record<string, string | null> = {};
let chatSeq = 0;

const st = (agree: boolean, key: number) => `<会议状态>\n合并稿版本：v1\n关键问题：${key}\n次要问题：0\n主持人要求未回应：0\n新论点：有\n是否同意定稿：${agree ? "是" : "否"}\n无法继续：否\n</会议状态>`;
function fakeAI(text: string, files: { content: string }[] = []): string {
  const full = text + "\n" + files.map((f) => f.content).join("\n");
  const me = /你是(甲|乙|丙|丁)/.exec(full)?.[1] ?? "?";
  if (full.includes("这一轮只提问")) return me === "甲" ? "<提问>\n### 问题 1：预算多少？\n为什么问：影响方案\n选项：A. 一万以内｜B. 不限\n默认假设：一万以内\n</提问>" : "<提问>无</提问>";
  if (full.includes("本轮独立陈述")) return `${me}：我的观点是这样。\n<会议状态>\n无法继续：否\n</会议状态>`;
  const round = Number(/第 (\d+)\/\d+ 轮/.exec(full)?.[1] ?? 0);
  if (full.includes("本轮执笔")) {
    const v = /【合并稿 v(\d+)】/.exec(full)?.[1] ?? "1";
    return `采纳：无\n<合并稿 v${v}>\n# 议题\n测试\n## 主持人要求\n无\n## 正文\n第 ${round} 轮的方案\n## 待议清单\n${round >= 3 ? "✔ 1. 预算（已解决）" : "1. 关键：预算"}\n## 备注\n无\n</合并稿>\n${st(false, round >= 3 ? 0 : 1)}`;
  }
  if (full.includes("本轮审阅")) return `认可。\n${st(round >= 3, round >= 3 ? 0 : 1)}`;
  if (full.includes("定稿确认")) return st(true, 0);
  return "？";
}

let ext: WebSocket | null = null;
function connectExt(): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    ext = ws;
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", role: "extension", token: extToken(), name: "假插件", version: "test", sites: [] })));
    ws.on("message", async (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "welcome") { setTimeout(resolve, 50); return; }
      if (m.type !== "cmd") return;
      log.push({ site: m.site, cmd: m.cmd, args: m.args });
      const reply = (data: any, ok = true) => ws.send(JSON.stringify({ type: "result", id: m.id, site: m.site, cmd: m.cmd, ok, data }));
      if (m.cmd === "state") return reply({ ok: true, chatId: current[m.site] ?? null });
      if (m.cmd === "openChat") { current[m.site] = m.args.chatId; return reply({ ok: true }); }
      if (m.cmd === "stop") return reply({ ok: true });
      if (m.cmd === "ask") {
        if (m.args.newChat) current[m.site] = `${m.site}-chat-${++chatSeq}`;
        const answer = fakeAI(m.args.text, m.args.files);
        ws.send(JSON.stringify({ type: "progress", id: m.id, site: m.site, answer: answer.slice(0, 5), thinkingLen: 3, done: false }));
        await new Promise((r) => setTimeout(r, 10));
        return reply({ ok: true, answer, thinking: "想一想", done: true, chatId: current[m.site], url: `https://x/${current[m.site]}` });
      }
      reply({ ok: false, error: "假插件不支持 " + m.cmd }, false);
    });
  });
}

const waitFor = async (fn: () => boolean, ms = 10000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 20)); } };

before(async () => {
  server = serve({ fetch: createApp().fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server;
  server.on("upgrade", (req, socket, head) => bridge.handleUpgrade(req as any, socket, head));
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
  setSetting("attach_lines", "40"); // 让附件一定会用上
  await connectExt();
});
after(() => { ext?.close(); server.close(); });

test("三方会议：提问 → 回答 → 独立陈述 → 轮流执笔 + 审阅 → 第 3 轮达成一致", async () => {
  const r = createAndStart({ topic: "测试议题", promptId: null, promptName: null, promptContent: "", participants: ["deepseek", "kimi", "glm"], penMode: "rotate", penSeat: "A", maxRounds: 6, waitSeconds: 0 });
  assert.ok(r.ok);
  const id = (r as { id: string }).id;
  // 一次只能开一场
  assert.equal(createAndStart({ topic: "第二场", promptId: null, promptName: null, promptContent: "", participants: ["deepseek", "kimi"], penMode: "rotate", penSeat: "A", maxRounds: 3, waitSeconds: 0 }).ok, false);

  await waitFor(() => getMeetingDetail(id)?.pauseReason === "questions");
  const d0 = getMeetingDetail(id)!;
  assert.equal(d0.turns.filter((t) => t.kind === "ask").length, 3);
  assert.equal(d0.turns.find((t) => t.seat === "A")?.questions?.[0].text, "预算多少？");
  // 提问消息：只提问不作答；规则 + 议题
  const askMsg = log.find((x) => x.cmd === "ask")!.args;
  assert.equal(askMsg.newChat, true);
  assert.match(askMsg.text + (askMsg.files[0]?.content ?? ""), /测试议题/);

  current["kimi"] = "别的对话"; // 模拟有人在 Kimi 上切走了
  assert.deepEqual(runCommand(id, "answer", { text: "预算一万" }), { ok: true });
  await waitFor(() => ["consensus", "error", "max_rounds"].includes(getMeetingDetail(id)!.status));
  const d = getMeetingDetail(id)!;
  assert.equal(d.status, "consensus", d.error ?? "");
  assert.equal(d.currentRound, 3);
  assert.equal(d.drafts.length, 2);
  assert.equal(d.drafts[1].seat, "B"); // 轮流执笔：第 2 轮甲、第 3 轮乙
  assert.match(d.finalDraft ?? "", /第 3 轮的方案/);
  assert.ok(d.participants.every((p) => p.chatId?.includes("-chat-")));
  // Kimi 被切走后，中转站先切回会议的对话
  assert.ok(log.some((x) => x.site === "kimi" && x.cmd === "openChat"));
  // 超过 40 行的消息用了附件
  assert.ok(d.turns.some((t) => t.attach), "应该有附件");
  assert.ok(log.some((x) => x.cmd === "ask" && x.args.files?.length && /附件《第\d+轮-/.test(x.args.text)));
  // 主持人的回答转给了所有人
  const opening = log.filter((x) => x.cmd === "ask" && /本轮独立陈述/.test(x.args.text + (x.args.files?.[0]?.content ?? "")));
  assert.equal(opening.length, 3);
  assert.ok(opening.every((x) => /预算一万/.test(x.args.text + (x.args.files?.[0]?.content ?? ""))));
  const md = minutesMarkdown(id)!;
  assert.match(md.text, /## 会议结论/);
  assert.match(md.text, /合并稿 v2/);
});

test("插件断开：会议暂停，重新连上后自动继续；主持人终止", async () => {
  const r = createAndStart({ topic: "第二个议题", promptId: null, promptName: null, promptContent: "", participants: ["glm", "deepseek"], penMode: "fixed", penSeat: "B", maxRounds: 10, waitSeconds: -1 });
  assert.ok(r.ok, (r as any).error);
  const id = (r as { id: string }).id;
  await waitFor(() => getMeetingDetail(id)?.pauseReason === "questions");
  ext!.close();
  await waitFor(() => !bridge.connected);
  runCommand(id, "answer", { text: "" });
  await waitFor(() => getMeetingDetail(id)?.pauseReason === "no_ext");
  await connectExt();
  // 一直等我（waitSeconds = -1）：独立陈述完停在“等主持人”
  await waitFor(() => getMeetingDetail(id)?.turns.filter((t) => t.kind === "opening").length === 2 && getMeetingDetail(id)?.status === "paused", 8000);
  assert.equal(getMeetingDetail(id)?.pauseReason, "host");
  runCommand(id, "message", { text: "请聚焦成本" });
  await waitFor(() => getMeetingDetail(id)?.status === "paused" && getMeetingDetail(id)!.currentRound >= 2);
  const writer = log.filter((x) => x.cmd === "ask" && x.site === "deepseek").at(-1)!; // 固定执笔：乙（DeepSeek）
  assert.match(writer.args.text + (writer.args.files?.[0]?.content ?? ""), /请聚焦成本/);
  assert.deepEqual(runCommand(id, "stop", {}), { ok: true });
  assert.equal(getMeetingDetail(id)?.status, "stopped");
});
