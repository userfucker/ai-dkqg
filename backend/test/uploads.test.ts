/** 议题里上传的文件：存、删、大小上限、不能跑出目录；开会时只在每个 AI 第一次发言时原格式发过去。 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, AddressInfo } from "node:net";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "aid-up-"));
process.env.AID_RETRY_DELAY_MS = "20";
const { serve } = await import("@hono/node-server");
const WebSocket = (await import("ws")).default;
const { useMemoryDb, setSetting } = await import("../src/db.ts");
useMemoryDb();
const { createApp } = await import("../src/app.ts");
const { bridge } = await import("../src/bridge.ts");
const { extToken } = await import("../src/auth.ts");
const { createAndStart, runCommand, getMeetingDetail } = await import("../src/meetings/runner.ts");
const up = await import("../src/uploads.ts");

let server: Server, port = 0, ws: any;
const asks: { site: string; text: string; files: any[] }[] = [];
const st = (agree: boolean) => `<会议状态>\n合并稿版本：v1\n关键问题：0\n次要问题：0\n主持人要求未回应：0\n新论点：无\n是否同意定稿：${agree ? "是" : "否"}\n无法继续：否\n</会议状态>`;
const answer = (full: string) => {
  if (full.includes("这一轮只提问")) return "<提问>无</提问>";
  if (full.includes("本轮独立陈述")) return "观点。\n<会议状态>\n无法继续：否\n</会议状态>";
  if (full.includes("本轮执笔")) return `<合并稿 v1>\n# 议题\n测试\n## 正文\n方案\n## 待议清单\n✔ 1. 已解决\n</合并稿>\n${st(true)}`;
  return `认可。\n${st(true)}`;
};
before(async () => {
  server = serve({ fetch: createApp().fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server;
  server.on("upgrade", (req, socket, head) => bridge.handleUpgrade(req as any, socket, head));
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
  const cur: Record<string, string> = {};
  let seq = 0;
  await new Promise<void>((resolve) => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", role: "extension", token: extToken(), name: "假插件", version: "1.5.0", sites: [] })));
    ws.on("message", (raw: Buffer) => {
      const m = JSON.parse(String(raw));
      if (m.type === "welcome") return setTimeout(resolve, 50);
      if (m.type !== "cmd") return;
      const reply = (data: any) => ws.send(JSON.stringify({ type: "result", id: m.id, site: m.site, cmd: m.cmd, ok: true, data }));
      if (m.cmd === "state") return reply({ ok: true, chatId: cur[m.site] ?? null });
      if (m.cmd === "ask") {
        if (m.args.newChat) cur[m.site] = `${m.site}-${++seq}`;
        asks.push({ site: m.site, text: m.args.text, files: m.args.files || [] });
        const full = m.args.text + "\n" + (m.args.files || []).map((f: any) => f.content || "").join("\n");
        return reply({ ok: true, answer: answer(full), done: true, chatId: cur[m.site] });
      }
      reply({ ok: true });
    });
  });
});
after(() => { ws?.close(); server.close(); });

test("存文件：重名加 (2)、超过上限拒绝、路径跑不出 uploads、删除", () => {
  const a = up.saveUpload("draft01", "资料.txt", Buffer.from("第一份"));
  const b = up.saveUpload("draft01", "资料.txt", Buffer.from("第二份"));
  assert.ok(a.ok && b.ok);
  assert.equal((b as any).path, "uploads/draft01/资料(2).txt");
  setSetting("upload_max_mb", "0.001");
  const big = up.saveUpload("draft01", "大.bin", Buffer.alloc(5000));
  assert.equal(big.ok, false);
  assert.match((big as any).error, /上限 0.001 MB/);
  setSetting("upload_max_mb", "2");
  assert.equal(up.uploadPath("uploads/../../etc/passwd"), null, "不能跑出 uploads 目录");
  assert.equal(up.saveUpload("../x", "a.txt", Buffer.from("x")).ok, false);
  assert.ok(up.deleteUpload((b as any).path));
  assert.equal(existsSync(up.uploadPath((b as any).path)!), false);
});

test("开会：第一次发言把议题里的文件原格式带上，之后不再带；议题里那一行换成附件说明", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const f1 = up.saveUpload("draft02", "需求说明.pdf", Buffer.from("%PDF-1.4 测试")) as any;
  const f2 = up.saveUpload("draft02", "截图.png", png) as any;
  const topic = `讨论一下这个需求\n查看 ${f1.path} 文件\n查看 ${f2.path} 文件`;
  const r = createAndStart({ topic, promptId: null, promptName: null, promptContent: "", participants: ["deepseek", "kimi"], penMode: "rotate", penSeat: "A", maxRounds: 4, waitSeconds: 0 });
  assert.ok(r.ok, (r as any).error);
  const id = (r as any).id;
  const t0 = Date.now();
  while (getMeetingDetail(id)?.pauseReason !== "questions" && Date.now() - t0 < 8000) await new Promise((x) => setTimeout(x, 20));
  runCommand(id, "answer", { text: "" });
  while (!["consensus", "error", "max_rounds", "divergent"].includes(getMeetingDetail(id)!.status) && Date.now() - t0 < 15000) await new Promise((x) => setTimeout(x, 20));
  for (const site of ["deepseek", "kimi"]) {
    const mine = asks.filter((a) => a.site === site);
    assert.ok(mine.length >= 2, `${site} 至少发言两次`);
    const ups = (a: any) => a.files.filter((f: any) => f.b64);
    assert.deepEqual(ups(mine[0]).map((f: any) => [f.name, f.mime]), [["需求说明.pdf", "application/pdf"], ["截图.png", "image/png"]], `${site} 第一次带上两个文件（原格式）`);
    assert.equal(Buffer.from(ups(mine[0])[1].b64, "base64").length, png.length);
    assert.ok(mine.slice(1).every((a) => !ups(a).length), `${site} 之后不再带`);
    const firstFull = mine[0].text + mine[0].files.map((f: any) => f.content || "").join("");
    assert.match(firstFull, /附件《需求说明\.pdf》已经随这条消息上传/);
    assert.ok(!/查看 uploads\//.test(firstFull), "发给 AI 的议题里没有服务器路径");
  }
  // 会议详情里的议题还是原样（页面上显示成可以点的链接）
  assert.match(getMeetingDetail(id)!.topic, /查看 uploads\/draft02\/需求说明\.pdf 文件/);
});
