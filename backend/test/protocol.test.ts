import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRound, hasQuestions, isStagnant, parseQuestions, parseStatus, planNext, type DraftRecord, type PlanInput, type Seat, type TurnRecord } from "../src/meetings/protocol.ts";
import { packMessage } from "../src/meetings/runner.ts";

const st = (agree: boolean, key = 0) => `<会议状态>\n合并稿版本：v1\n关键问题：${key}\n次要问题：0\n主持人要求未回应：0\n新论点：有\n是否同意定稿：${agree ? "是" : "否"}\n无法继续：否\n</会议状态>`;
let nid = 0;
const T = (seat: TurnRecord["seat"], kind: TurnRecord["kind"], round: number, text = "", status = text ? parseStatus(text) : null): TurnRecord => ({ id: ++nid, seat, kind, round, text, status, draftVersion: null });
const base = (turns: TurnRecord[], over: Partial<PlanInput> = {}): PlanInput => ({ seats: ["A", "B", "C"], penMode: "rotate", penSeat: "A", nextWriter: null, maxRounds: 5, finalizeStage: null, finalizeReason: null, turns, ...over });

test("状态块解析", () => {
  const s = parseStatus("正文\n" + st(true, 0));
  assert.equal(s?.agree, true);
  assert.equal(s?.keyIssues, 0);
  assert.equal(parseStatus("<会议状态>\n是否同意定稿：不同意\n</会议状态>")?.agree, false);
  assert.equal(parseStatus("没有状态块"), null);
});

test("提问解析", () => {
  assert.equal(hasQuestions("<提问>无</提问>"), false);
  const q = "<提问>\n### 问题 1：预算多少？\n为什么问：影响方案\n选项：A. 一万以内｜B. 不限\n默认假设：一万以内\n</提问>";
  assert.equal(hasQuestions(q), true);
  assert.deepEqual(parseQuestions(q)[0].options, ["A. 一万以内", "B. 不限"]);
});

test("流程：提问 → 等回答 → 独立陈述 → 轮流执笔 + 其他人同时审阅", () => {
  nid = 0;
  let turns: TurnRecord[] = [];
  assert.deepEqual(planNext(base(turns), null), { type: "ask", seats: ["A", "B", "C"] });
  turns = [T("A", "ask", 0, "<提问>\n### 问题 1：x？\n</提问>"), T("B", "ask", 0, "<提问>无</提问>"), T("C", "ask", 0, "<提问>无</提问>")];
  assert.equal(planNext(base(turns), null).type, "await_answers");
  turns.push(T("host", "answer", 0, "回答"));
  assert.deepEqual(planNext(base(turns), null), { type: "opening", seats: ["A", "B", "C"] });
  turns.push(T("A", "opening", 1, "a"), T("B", "opening", 1, "b"), T("C", "opening", 1, "c"));
  assert.deepEqual(planNext(base(turns), null), { type: "write", kind: "write", seat: "A", round: 2 });
  const w = T("A", "write", 2, "稿 " + st(false));
  turns.push(w);
  const d1: DraftRecord = { version: 1, seat: "A", turnId: w.id, content: "## 正文\n## 待议清单\n" };
  assert.deepEqual(planNext(base(turns), d1), { type: "parallel", kind: "review", seats: ["B", "C"], round: 2, reason: undefined });
  turns.push(T("B", "review", 2, st(true)));
  assert.deepEqual((planNext(base(turns), d1) as { seats: Seat[] }).seats, ["C"]);
  turns.push(T("C", "review", 2, st(false, 1)));
  assert.equal(evaluateRound(turns, ["A", "B", "C"], d1, null, {}), null);
  assert.deepEqual(planNext(base(turns), d1), { type: "write", kind: "write", seat: "B", round: 3 }); // 轮流：甲之后是乙
  assert.deepEqual(planNext(base(turns, { penMode: "fixed" }), d1), { type: "write", kind: "write", seat: "A", round: 3 });
});

test("达成一致：除执笔人以外都同意；主持人之后有新意见就不算", () => {
  nid = 0;
  const w = T("B", "write", 3, "稿");
  const d: DraftRecord = { version: 2, seat: "B", turnId: w.id, content: "" };
  const turns = [T("A", "opening", 1, "a"), w, T("A", "review", 3, st(true)), T("C", "review", 3, st(true))];
  assert.equal(evaluateRound(turns, ["A", "B", "C"], d, null, {})?.type, "consensus");
  const withHost = [T("A", "opening", 1, "a"), w, T("host", "host", 3, "再想想"), T("A", "review", 3, st(true)), T("C", "review", 3, st(true))];
  assert.equal(evaluateRound(withHost, ["A", "B", "C"], d, null, {}), null);
});

test("最大轮数：第 N 轮审阅完就结束", () => {
  nid = 0;
  const turns = [T("A", "opening", 1, "a"), T("B", "opening", 1, "b"), T("A", "write", 2, "x"), T("B", "review", 2, st(false))];
  assert.deepEqual(planNext(base(turns, { seats: ["A", "B"], maxRounds: 2 }), null), { type: "end", status: "max_rounds" });
});

test("定稿：执笔人写最终稿 → 其他人同时确认", () => {
  nid = 0;
  const turns = [T("A", "opening", 1, "a"), T("B", "opening", 1, "b"), T("C", "opening", 1, "c"), T("A", "write", 2, "x"), T("B", "review", 2, st(false)), T("C", "review", 2, st(false))];
  assert.deepEqual(planNext(base(turns, { finalizeStage: "write", finalizeReason: "host" }), null), { type: "write", kind: "final_write", seat: "B", round: 3, reason: "host" });
  const fw = T("B", "final_write", 3, "最终");
  turns.push(fw);
  const plan = planNext(base(turns, { finalizeStage: "confirm", finalizeReason: "host" }), null);
  assert.deepEqual(plan, { type: "parallel", kind: "confirm", seats: ["A", "C"], round: 3, reason: "host" });
  turns.push(T("A", "confirm", 3, st(true)), T("C", "confirm", 3, st(false)));
  const d: DraftRecord = { version: 2, seat: "B", turnId: fw.id, content: "c" };
  const o = evaluateRound(turns, ["A", "B", "C"], d, "host", {});
  assert.equal(o?.type, "finalized");
  assert.equal(o?.dissent.length, 1);
});

test("求同存异：连续两轮没进展", () => {
  nid = 0;
  const turns: TurnRecord[] = [T("A", "opening", 1, "a"), T("B", "opening", 1, "b")];
  for (let r = 2; r <= 4; r++) turns.push(T(r % 2 ? "B" : "A", "write", r, st(false, 2)), T(r % 2 ? "A" : "B", "review", r, st(false, 2)));
  assert.equal(isStagnant(turns, []), true);
});

test("长消息放进附件", () => {
  const head = "说明\n".repeat(10).trim();
  const material = Array.from({ length: 150 }, (_, i) => `第${i + 1}行`).join("\n");
  const short = packMessage({ head, material: "短材料", materialLabel: "材料" }, "a.txt", 100);
  assert.equal(short.files.length, 0);
  const long = packMessage({ head, material, materialLabel: "议题" }, "a.txt", 100);
  assert.equal(long.files[0].content, material);
  assert.match(long.text, /附件《a\.txt》/);
  assert.ok(long.text.startsWith("说明"));
  const huge = packMessage({ head: material, material: "x", materialLabel: "议题" }, "b.txt", 100);
  assert.ok(huge.files[0].content.startsWith("第1行"));
});
