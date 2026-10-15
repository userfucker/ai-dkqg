/**
 * AI 会议的推进（从 webui 的 backend/meetings/runner.ts 搬过来，引擎换成浏览器插件里的网页版 AI）。
 *
 * 会议在服务器后台推进，网页只是观看：关掉网页会议照常进行。每位参会者就是某个网站上的一个对话，
 * 它自己记得整场会议，每一轮只发增量。第一次发言时新建对话、记下对话 id；以后每轮发言前先确认
 * 网页停在这个对话上（不在就切回去）。
 *
 * 进程内只记“此刻”的东西（正在发言的实时文字、倒计时计时器）；会议本身的状态全在数据库里，
 * 服务重启后正在进行的会议标记为“已中断”，点“继续”从上一次完整的发言接着开。
 *
 * 出错：插件断开 → 暂停，插件重新连上后自动继续；网站说限流 / 额度用完 / 太忙 → 暂停，10 分钟后自动重试；
 * 其他错误 → 停在“出错”，主持人可以重试或给这个席位换 AI。
 */
import { randomUUID } from "node:crypto";
import { bridge, type Progress } from "../bridge.ts";
import { broadcastAll, broadcastMeeting } from "../events.ts";
import { getSetting } from "../db.ts";
import { isSite, siteName, type SiteId } from "../sites.ts";
import {
  ALL_SEATS, SEAT_LABEL, buildAskMessage, buildConfirmMessage, buildFinalWriteMessage, buildOpeningMessage, buildReviewMessage, buildWriteMessage,
  displayText, estimateCalls, evaluateRound, extractDraft, hasQuestions, hostAfter, isSeat, isStagnant, lastRoundDissent, openingsInsufficient,
  parseQuestions, parseStatus, participantName, planNext,
  type BuildContext, type BuiltMessage, type DraftRecord, type FinalizeReason, type ParticipantInfo, type PenMode, type Seat, type TurnKind, type TurnRecord,
} from "./protocol.ts";
import {
  activeMeeting, createMeeting, getDrafts, getMeeting, getParticipants, getTurns, insertDraft, insertTurn, isEnded, listMeetings, rememberChat,
  setTurnDraftVersion, updateMeeting, updateParticipant, type MeetingRow, type MeetingStatus, type ParticipantRow,
} from "./store.ts";

// ---- 进程内状态 ---------------------------------------------------------------

interface LiveTurn { seat: Seat; site: string; kind: TurnKind; round: number; text: string; thinkingLen: number; startedAt: number; attach: { name: string; lines: number } | null }
interface Runtime { timer: ReturnType<typeof setTimeout> | null; running: boolean; live: Map<Seat, LiveTurn> }
const runtimes = new Map<string, Runtime>();
function rt(id: string): Runtime {
  let r = runtimes.get(id);
  if (!r) { r = { timer: null, running: false, live: new Map() }; runtimes.set(id, r); }
  return r;
}

const RETRY_MS = 10 * 60_000;
const ASK_TIMEOUT = 10 * 60_000;
export const attachLines = () => Number(getSetting("attach_lines") || 100);

// ---- 给网页的数据 -------------------------------------------------------------

function infosOf(parts: ParticipantRow[]): Partial<Record<Seat, ParticipantInfo>> {
  const out: Partial<Record<Seat, ParticipantInfo>> = {};
  for (const p of parts) out[p.seat] = { seat: p.seat, site: p.site, name: siteName(p.site) };
  return out;
}

export function meetingSummary(m: MeetingRow) {
  const parts = getParticipants(m.id);
  return {
    id: m.id, title: m.title, status: m.status, pauseReason: m.pause_reason, currentRound: m.current_round, maxRounds: m.max_rounds,
    participants: parts.map((p) => ({ seat: p.seat, site: p.site })), createdAt: m.created_at, updatedAt: m.updated_at,
  };
}

export function getMeetingDetail(id: string) {
  const m = getMeeting(id);
  if (!m) return null;
  const parts = getParticipants(id);
  const r = runtimes.get(id);
  return {
    id: m.id, title: m.title, topic: m.topic, promptName: m.prompt_name, penMode: m.pen_mode, penSeat: m.pen_seat, nextWriter: m.next_writer,
    maxRounds: m.max_rounds, waitSeconds: m.wait_seconds, status: m.status, pauseReason: m.pause_reason,
    pauseDetail: m.pause_detail ? JSON.parse(m.pause_detail) : null, currentRound: m.current_round, deadlineAt: m.deadline_at,
    finalizeStage: m.finalize_stage, finalizeReason: m.finalize_reason, pauseAfter: !!m.pause_after, finalDraft: m.final_draft, endNote: m.end_note,
    error: m.error, retryAt: m.retry_at, elapsedMs: m.elapsed_ms, activeSince: m.active_since, createdAt: m.created_at, updatedAt: m.updated_at,
    participants: parts.map((p) => ({ seat: p.seat, site: p.site, name: siteName(p.site), chatId: p.chat_id, chatUrl: p.chat_url })),
    turns: getTurns(id).map((t) => ({
      id: t.id, round: t.round, seat: t.seat, kind: t.kind, site: t.site,
      text: isSeat(t.seat) ? displayText(t.text, t.draftVersion) : t.text,
      status: t.status, draftVersion: t.draftVersion, durationMs: t.durationMs, thinkingLen: t.thinkingLen, attach: t.attach, meta: t.meta, createdAt: t.createdAt,
      questions: t.kind === "ask" && hasQuestions(t.text) ? parseQuestions(t.text) : null,
      hasQuestions: t.kind === "ask" ? hasQuestions(t.text) : undefined,
    })),
    drafts: getDrafts(id),
    live: r ? [...r.live.values()] : [],
    running: !!r?.running,
    estimate: estimateCalls(parts.length, m.max_rounds),
    serverNow: Date.now(),
  };
}
export type MeetingDetail = NonNullable<ReturnType<typeof getMeetingDetail>>;

function notify(id: string): void {
  const d = getMeetingDetail(id);
  if (d) broadcastMeeting(id, "detail", d);
  broadcastAll("meetings", listMeetings().map(meetingSummary));
}

// ---- 控制点 -------------------------------------------------------------------

function clearTimer(id: string): void {
  const r = rt(id);
  if (r.timer) clearTimeout(r.timer);
  r.timer = null;
}

/** 一轮结束后进入控制点：倒计时 / 一直等 / 不等直接继续。 */
function startCheckpoint(id: string): void {
  const m = getMeeting(id);
  if (!m || isEnded(m.status)) return;
  clearTimer(id);
  if (m.pause_after) { updateMeeting(id, { status: "paused", pause_reason: "host", pause_after: 0, deadline_at: null }); notify(id); return; }
  const wait = m.wait_seconds;
  if (wait === 0) { continueNow(id); return; }
  if (wait < 0) { updateMeeting(id, { status: "paused", pause_reason: "host", deadline_at: null }); notify(id); return; }
  updateMeeting(id, { status: "waiting", deadline_at: Date.now() + wait * 1000, pause_reason: null });
  rt(id).timer = setTimeout(() => { rt(id).timer = null; if (getMeeting(id)?.status === "waiting") void advance(id); }, wait * 1000);
  notify(id);
}

/** 不停下来、马上接着跑下一步。 */
function continueNow(id: string): void {
  updateMeeting(id, { status: "waiting", deadline_at: Date.now(), pause_reason: null });
  notify(id);
  setImmediate(() => void advance(id));
}

function pause(id: string, reason: string, detail: Record<string, unknown> | null = null, retryAt: number | null = null): void {
  clearTimer(id);
  updateMeeting(id, { status: "paused", pause_reason: reason, pause_detail: detail ? JSON.stringify(detail) : null, deadline_at: null, retry_at: retryAt });
  notify(id);
}

// ---- 推进 ---------------------------------------------------------------------

/** 跑下一步。同一场会议同时只会有一个在跑。 */
export async function advance(id: string): Promise<void> {
  const r = rt(id);
  if (r.running) return;
  const m = getMeeting(id);
  if (!m || isEnded(m.status)) return;
  if (!bridge.connected) { pause(id, "no_ext"); return; }
  r.running = true;
  clearTimer(id);
  updateMeeting(id, { status: "running", deadline_at: null, pause_reason: null, pause_detail: null, error: null, retry_at: null });
  notify(id);
  try {
    await step(id);
  } catch (error) {
    console.error("AI 会议推进失败", id, error);
    const cur = getMeeting(id);
    if (cur && !isEnded(cur.status)) updateMeeting(id, { status: "error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    r.running = false;
    r.live.clear();
    const cur = getMeeting(id);
    if (cur?.status === "running") updateMeeting(id, { status: "paused", pause_reason: "host" }); // 保险：不会停在“发言中”
    notify(id);
  }
}

const latestDraftOf = (id: string): DraftRecord | null => getDrafts(id).at(-1) ?? null;
const seatsOf = (id: string): Seat[] => getParticipants(id).map((p) => p.seat).sort((a, b) => ALL_SEATS.indexOf(a) - ALL_SEATS.indexOf(b));

function planFor(id: string) {
  const m = getMeeting(id) as MeetingRow;
  return planNext(
    { seats: seatsOf(id), penMode: m.pen_mode, penSeat: m.pen_seat, nextWriter: m.next_writer, maxRounds: m.max_rounds, finalizeStage: m.finalize_stage, finalizeReason: m.finalize_reason, turns: getTurns(id) },
    latestDraftOf(id),
  );
}

const stoppedMeanwhile = (id: string) => { const m = getMeeting(id); return !m || isEnded(m.status) || m.status !== "running"; };

async function step(id: string): Promise<void> {
  const plan = planFor(id);

  if (plan.type === "end") { endMaxRounds(id); return; }
  if (plan.type === "await_answers") { pause(id, "questions"); return; }

  if (plan.type === "ask" || plan.type === "opening") {
    const results = await Promise.all(plan.seats.map((seat) => runTurn(id, seat, plan.type as TurnKind, plan.type === "ask" ? 0 : 1)));
    if (stoppedMeanwhile(id)) return;
    const failed = results.find((x) => !x.ok);
    if (failed) { failTurn(id, failed); return; }
    if (plan.type === "ask") {
      if (planFor(id).type === "await_answers") pause(id, "questions");
      else continueNow(id);
      return;
    }
    const note = openingsInsufficient(getTurns(id), seatsOf(id), infosOf(getParticipants(id)));
    if (note) { endMeeting(id, "insufficient", latestDraftOf(id), note); return; }
    startCheckpoint(id);
    return;
  }

  if (plan.type === "write") {
    const res = await runTurn(id, plan.seat, plan.kind, plan.round, plan.reason ?? null);
    if (stoppedMeanwhile(id)) return;
    if (!res.ok) { failTurn(id, res); return; }
    const fields: Partial<MeetingRow> = { next_writer: null };
    if (plan.kind === "final_write") fields.finalize_stage = "confirm";
    updateMeeting(id, fields);
    continueNow(id); // 写完马上请其他人审阅 / 确认，不停下来
    return;
  }

  // 其他参会者同时审阅 / 确认
  const results = await Promise.all(plan.seats.map((seat) => runTurn(id, seat, plan.kind, plan.round, plan.reason ?? null)));
  if (stoppedMeanwhile(id)) return;
  const failed = results.find((x) => !x.ok);
  if (failed) { failTurn(id, failed); return; }

  const turns = getTurns(id);
  const m = getMeeting(id) as MeetingRow;
  const outcome = evaluateRound(turns, seatsOf(id), latestDraftOf(id), plan.kind === "confirm" ? m.finalize_reason ?? "host" : null, infosOf(getParticipants(id)));
  if (outcome) {
    endMeeting(id, outcome.type, outcome.draft, outcome.note, withDissent(id, outcome.draft?.content ?? null, outcome.dissent));
    return;
  }
  // 连续两轮没有实际进展：按“求同存异”收尾——执笔人写最终稿，其他人确认各自的立场。
  if (plan.kind === "review" && !m.finalize_stage && m.current_round < m.max_rounds && isStagnant(turns, getDrafts(id))) {
    updateMeeting(id, { finalize_stage: "write", finalize_reason: "divergence" });
    insertTurn({ meetingId: id, round: m.current_round, seat: "system", kind: "notice", text: "最近两轮都没有实际进展，会议按“求同存异”收尾：执笔人写最终稿，其他参会者确认各自的立场" });
  }
  const next = planFor(id);
  if (next.type === "end") { endMaxRounds(id); return; } // 轮数用完就不再等
  startCheckpoint(id);
}

/** 不同意的意见原样附在结论后面。 */
function withDissent(id: string, content: string | null, dissent: TurnRecord[]): string | null {
  if (!content || dissent.length === 0) return content;
  const infos = infosOf(getParticipants(id));
  const extra = dissent.map((t) => {
    const p = isSeat(t.seat) ? infos[t.seat] : undefined;
    return `## ${p ? participantName(p) : t.seat}的保留意见\n\n${displayText(t.text, null)}`;
  });
  return `${content}\n\n${extra.join("\n\n")}`;
}

function endMaxRounds(id: string): void {
  const dissent = lastRoundDissent(getTurns(id));
  const who = dissent.map((t) => SEAT_LABEL[t.seat as Seat]).join("、");
  const draft = latestDraftOf(id);
  endMeeting(id, "max_rounds", draft, who ? `到了最大轮数，${who}还有保留意见` : "到了最大轮数", withDissent(id, draft?.content ?? null, dissent));
}

function endMeeting(id: string, status: MeetingStatus, draft: DraftRecord | null, note: string | null, content: string | null = draft?.content ?? null): void {
  clearTimer(id);
  updateMeeting(id, { status, final_draft: content, end_note: note, deadline_at: null, pause_reason: null, finalize_stage: null, finalize_reason: null, pause_after: 0, retry_at: null });
  notify(id);
}

interface TurnResult { ok: boolean; turnId?: number; error?: string; disconnected?: boolean; seat?: Seat }

const RETRY_RE = /额度|限流|频繁|繁忙|稍后再试|稍后重试|太多|上限|次数|拥挤|服务器忙|忙碌|busy|rate|limit|429|too many|overload/i;

/** 发言失败：插件断开 → 等插件；网站限流 → 10 分钟后自动重试；其他 → 出错。 */
function failTurn(id: string, res: TurnResult): void {
  const who = res.seat ? `${SEAT_LABEL[res.seat]}（${siteName(getParticipants(id).find((p) => p.seat === res.seat)?.site ?? "")}）` : "";
  const error = `${who}发言失败：${res.error ?? "未知错误"}`;
  if (res.disconnected || !bridge.connected) { pause(id, "no_ext", { message: error }); return; }
  if (RETRY_RE.test(res.error ?? "")) { pause(id, "retry", { message: error }, Date.now() + RETRY_MS); return; }
  updateMeeting(id, { status: "error", error });
  notify(id);
}

// ---- 一次发言 -----------------------------------------------------------------

const countLines = (s: string) => s.split("\n").length;
const KIND_FILE: Partial<Record<TurnKind, string>> = { ask: "议题", opening: "材料", write: "材料", review: "审阅材料", final_write: "材料", confirm: "最终稿" };

/** 消息超过设置的行数（默认 100 行）就把材料放进 txt 附件；说明本身也太长就整条放进附件。 */
export function packMessage(b: BuiltMessage, fileName: string, limit = attachLines()): { text: string; files: { name: string; content: string }[]; attach: { name: string; lines: number } | null } {
  const full = b.material ? `${b.head}\n\n${b.material}` : b.head;
  if (countLines(full) <= limit) return { text: full, files: [], attach: null };
  if (b.material && countLines(b.head) + 2 <= limit) {
    const n = countLines(b.material);
    return {
      text: `${b.head}\n\n【本轮材料】${b.materialLabel}在附件《${fileName}》里（共 ${n} 行）。请先完整阅读附件，再按上面的要求回复。`,
      files: [{ name: fileName, content: b.material }], attach: { name: fileName, lines: n },
    };
  }
  const n = countLines(full);
  return { text: `这一轮的消息比较长，完整内容在附件《${fileName}》里（共 ${n} 行）。请完整阅读附件，然后严格按附件里的要求回复。`, files: [{ name: fileName, content: full }], attach: { name: fileName, lines: n } };
}

async function runTurn(id: string, seat: Seat, kind: TurnKind, round: number, reason: FinalizeReason | null = null): Promise<TurnResult> {
  const m = getMeeting(id) as MeetingRow;
  const parts = getParticipants(id);
  const me = parts.find((p) => p.seat === seat) as ParticipantRow;
  const infos = infosOf(parts);
  const turns = getTurns(id);
  const latest = latestDraftOf(id);
  const maxSeen = turns.reduce((n, t) => Math.max(n, t.id), 0);
  // 换了 AI 的席位（对话是新的）：把之前的会议记录一起发过去
  const joining = !me.chat_id && kind !== "ask" && kind !== "opening";
  const ctx: BuildContext = {
    topic: m.topic, promptContent: m.prompt_content, me: infos[seat] as ParticipantInfo,
    others: parts.filter((p) => p.seat !== seat).map((p) => infos[p.seat] as ParticipantInfo),
    round, maxRounds: m.max_rounds, penMode: m.pen_mode,
    unseen: joining ? [] : turns.filter((t) => t.id > me.seen_upto && t.seat !== seat && (t.seat === "host" || isSeat(t.seat))),
    participants: infos, latestDraft: latest, hostAfterLatestDraft: latest ? hostAfter(turns, latest.turnId) : false,
    qa: { asks: turns.filter((t) => t.kind === "ask"), answer: turns.filter((t) => t.kind === "answer").map((t) => t.text).join("\n\n") || null },
    finalizeReason: reason,
    joinHistory: joining ? turns.filter((t) => (isSeat(t.seat) && t.kind !== "ask") || (t.seat === "host" && t.kind === "host")) : null,
  };
  const built =
    kind === "ask" ? buildAskMessage(ctx)
    : kind === "opening" ? buildOpeningMessage(ctx)
    : kind === "review" ? buildReviewMessage(ctx)
    : kind === "final_write" ? buildFinalWriteMessage(ctx)
    : kind === "confirm" ? buildConfirmMessage(ctx)
    : buildWriteMessage(ctx);
  const fileName = `第${round}轮-${SEAT_LABEL[seat]}-${KIND_FILE[kind] ?? "材料"}.txt`;
  const msg = packMessage(built, fileName);

  const r = rt(id);
  r.live.set(seat, { seat, site: me.site, kind, round, text: "", thinkingLen: 0, startedAt: Date.now(), attach: msg.attach });
  notify(id);
  const t0 = Date.now();
  const res = await askAI(me, msg.text, msg.files, (p) => {
    const live = r.live.get(seat);
    if (!live) return;
    live.text = p.answer;
    live.thinkingLen = p.thinkingLen;
    broadcastMeeting(id, "live", { seat, text: p.answer, thinkingLen: p.thinkingLen });
  });
  r.live.delete(seat);
  if (!res.ok) return { ok: false, error: res.error, disconnected: res.disconnected, seat };
  if (getMeeting(id)?.status !== "running") return { ok: false, error: "会议已停止", seat };

  if (res.chatId && res.chatId !== me.chat_id) {
    updateParticipant(id, seat, { chat_id: res.chatId, chat_url: res.url ?? null });
    rememberChat(id, me.site, res.chatId, res.url ?? null, seat);
  }
  const status = kind === "ask" ? null : parseStatus(res.answer);
  const turnId = insertTurn({ meetingId: id, round, seat, kind, site: me.site, text: res.answer, status, durationMs: Date.now() - t0, thinkingLen: res.thinkingLen, attach: msg.attach });
  if (kind === "write" || kind === "final_write") {
    const draft = extractDraft(res.answer);
    if (draft) setTurnDraftVersion(turnId, insertDraft(id, seat, turnId, draft));
  }
  // 只记“发消息那一刻”已有的发言：这一轮期间别人新增的（比如主持人意见），下次再转达给它。
  updateParticipant(id, seat, { seen_upto: Math.max(me.seen_upto, maxSeen) });
  updateMeeting(id, { current_round: Math.max(m.current_round, round) });
  return { ok: true, turnId, seat };
}

/** 让插件在这位参会者的对话里发消息、等回答。第一次发言新建对话。 */
async function askAI(p: ParticipantRow, text: string, files: { name: string; content: string }[], onProgress: (p: Progress) => void): Promise<{ ok: boolean; answer: string; thinkingLen: number; chatId?: string; url?: string; error?: string; disconnected?: boolean }> {
  const site = p.site as SiteId;
  const fail = (d: { error?: string; disconnected?: boolean }) => ({ ok: false, answer: "", thinkingLen: 0, error: d.error ?? "插件没有说原因", disconnected: !!d.disconnected });
  if (p.chat_id) {
    const st = await bridge.call(site, "state", {}, { timeoutMs: 150_000 });
    if (!st.ok) return fail(st.data);
    if (st.data.chatId !== p.chat_id) {
      const o = await bridge.call(site, "openChat", { chatId: p.chat_id }, { timeoutMs: 150_000 });
      if (!o.ok) return fail({ ...o.data, error: `切回会议的对话失败：${o.data.error ?? ""}` });
    }
  }
  const r = await bridge.call(site, "ask", { text, files, newChat: !p.chat_id, timeoutMs: ASK_TIMEOUT }, { timeoutMs: ASK_TIMEOUT + 300_000, onProgress });
  if (!r.ok) return fail(r.data);
  const answer = String(r.data.answer ?? "");
  if (!answer.trim()) return fail({ error: "AI 没有返回任何内容" });
  return { ok: true, answer, thinkingLen: String(r.data.thinking ?? "").length, chatId: (r.data.chatId as string) || undefined, url: (r.data.url as string) || undefined };
}

// ---- 新建会议 -----------------------------------------------------------------

export interface CreateInput { topic: string; title?: string; promptId: number | null; promptName: string | null; promptContent: string; participants: string[]; penMode: PenMode; penSeat: Seat; maxRounds: number; waitSeconds: number }

export function createAndStart(input: CreateInput): { ok: true; id: string } | { ok: false; error: string } {
  const topic = input.topic.trim();
  if (!topic) return { ok: false, error: "议题不能为空" };
  const sites = input.participants;
  if (sites.length < 2 || sites.length > 4) return { ok: false, error: "参会的 AI 要 2 到 4 个" };
  if (!sites.every(isSite)) return { ok: false, error: "有不认识的网站" };
  if (new Set(sites).size !== sites.length) return { ok: false, error: "同一个网站只能参会一次" };
  if (!Number.isInteger(input.maxRounds) || input.maxRounds < 2 || input.maxRounds > 30) return { ok: false, error: "最大轮数要在 2 到 30 之间" };
  if (![0, 30, 60, -1].includes(input.waitSeconds)) return { ok: false, error: "每轮等待只能选 0、30、60 秒或一直等" };
  const seats = ALL_SEATS.slice(0, sites.length);
  if (!seats.includes(input.penSeat)) return { ok: false, error: "执笔人不在参会者里" };
  const busy = activeMeeting();
  if (busy) return { ok: false, error: `已经有一场会议还没结束（${busy.title}）。一次只能开一场，先终止或等它结束。` };
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  const title = (input.title?.trim() || topic.split("\n").find((l) => l.trim()) || "AI 会议").replace(/^#+\s*/, "").slice(0, 40);
  createMeeting(
    { id, title, topic, prompt_id: input.promptId, prompt_name: input.promptName, prompt_content: input.promptContent, pen_mode: input.penMode, pen_seat: input.penSeat, max_rounds: input.maxRounds, wait_seconds: input.waitSeconds },
    seats.map((seat, i) => ({ seat, site: sites[i] })),
  );
  setImmediate(() => void advance(id));
  return { ok: true, id };
}

// ---- 主持人操作 ---------------------------------------------------------------

export type CommandResult = { ok: true } | { ok: false; error: string; status?: number };

export function runCommand(id: string, action: string, payload: Record<string, unknown>): CommandResult {
  const m = getMeeting(id);
  if (!m) return { ok: false, error: "会议不存在", status: 404 };
  const r = rt(id);
  const ended = isEnded(m.status);
  const idle = !r.running && !ended;
  const seats = seatsOf(id);

  switch (action) {
    case "continue": {
      if (ended) return { ok: false, error: "会议已经结束" };
      if (idle && m.pause_reason === "questions") return runCommand(id, "answer", { text: "" });
      if (idle) void advance(id);
      return { ok: true };
    }
    case "answer": {
      // 主持人回答提问；text 为空 = 跳过，按默认假设开始。
      if (ended) return { ok: false, error: "会议已经结束" };
      if (planFor(id).type !== "await_answers") return { ok: false, error: "现在不是提问环节" };
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      // 网页上逐题回答时，另外存一份结构化的答案（“提问”那一页用）
      const answers = payload.answers && typeof payload.answers === "object" ? Object.fromEntries(Object.entries(payload.answers as Record<string, unknown>).filter(([k, v]) => /^[A-D]-\d+$/.test(k) && typeof v === "string" && v.trim()).map(([k, v]) => [k, String(v).slice(0, 5000)])) : null;
      const extra = typeof payload.extra === "string" ? payload.extra.trim().slice(0, 20000) : "";
      insertTurn({
        meetingId: id, round: 0, seat: "host", kind: "answer",
        text: text ? text.slice(0, 50_000) : "（主持人跳过了提问，请按各自写的默认假设进行）",
        meta: { skipped: !text, answers: answers ?? {}, extra },
      });
      if (idle) void advance(id); else notify(id);
      return { ok: true };
    }
    case "message": {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) return { ok: false, error: "内容不能为空" };
      if (ended) return { ok: false, error: "会议已经结束" };
      if (planFor(id).type === "await_answers") return runCommand(id, "answer", { text });
      insertTurn({ meetingId: id, round: m.current_round, seat: "host", kind: "host", text: text.slice(0, 20_000) });
      if (idle && (m.status === "waiting" || m.status === "paused")) void advance(id);
      else notify(id);
      return { ok: true };
    }
    case "hold": {
      // 主持人开始输入：倒计时停住，一直等到发送或清空。
      if (m.status === "waiting" && !r.running) { clearTimer(id); updateMeeting(id, { status: "paused", pause_reason: "typing", deadline_at: null }); notify(id); }
      return { ok: true };
    }
    case "release": {
      if (m.status === "paused" && m.pause_reason === "typing") startCheckpoint(id);
      return { ok: true };
    }
    case "pause": {
      if (ended) return { ok: false, error: "会议已经结束" };
      if (r.running) updateMeeting(id, { pause_after: 1 });
      else { clearTimer(id); updateMeeting(id, { status: "paused", pause_reason: "host", deadline_at: null, retry_at: null }); }
      notify(id);
      return { ok: true };
    }
    case "stop": {
      if (ended) return { ok: false, error: "会议已经结束" };
      // 正在发言的网站点“停止生成”
      for (const live of r.live.values()) void bridge.call(live.site as SiteId, "stop", {}, { now: true });
      endMeeting(id, "stopped", latestDraftOf(id), "主持人终止了会议");
      return { ok: true };
    }
    case "finalize": {
      if (ended) return { ok: false, error: "会议已经结束" };
      if (getTurns(id).filter((t) => t.kind === "opening").length < seats.length) return { ok: false, error: "第 1 轮结束后才能要求定稿" };
      if (m.finalize_stage) return { ok: true };
      updateMeeting(id, { finalize_stage: "write", finalize_reason: "host" });
      insertTurn({ meetingId: id, round: m.current_round, seat: "system", kind: "notice", text: "主持人要求合并定稿" });
      if (idle) void advance(id); else notify(id);
      return { ok: true };
    }
    case "set_pen": {
      const seat = isSeat(payload.seat) && seats.includes(payload.seat) ? payload.seat : null;
      if (!seat) return { ok: false, error: "请选择参会者" };
      if (ended) return { ok: false, error: "会议已经结束" };
      if (m.pen_mode === "fixed") updateMeeting(id, { pen_seat: seat, next_writer: null });
      else updateMeeting(id, { next_writer: seat });
      insertTurn({ meetingId: id, round: m.current_round, seat: "system", kind: "notice", text: m.pen_mode === "fixed" ? `主持人把执笔人改为${SEAT_LABEL[seat]}` : `主持人指定下一轮由${SEAT_LABEL[seat]}执笔` });
      notify(id);
      return { ok: true };
    }
    case "set_pen_mode": {
      const penMode = payload.penMode === "fixed" || payload.penMode === "rotate" ? payload.penMode : null;
      const penSeat = isSeat(payload.penSeat) && seats.includes(payload.penSeat) ? payload.penSeat : null;
      if (!penMode || !penSeat) return { ok: false, error: "请选择执笔方式和执笔人" };
      if (r.running) return { ok: false, error: "请等这一轮发言结束再切换执笔方式" };
      updateMeeting(id, { pen_mode: penMode, pen_seat: penSeat, next_writer: penMode === "rotate" ? penSeat : null });
      insertTurn({ meetingId: id, round: m.current_round, seat: "system", kind: "notice", text: penMode === "fixed" ? `主持人把执笔方式改为固定执笔（${SEAT_LABEL[penSeat]}执笔）` : `主持人把执笔方式改为轮流执笔（下一轮由${SEAT_LABEL[penSeat]}执笔）` });
      notify(id);
      return { ok: true };
    }
    case "set_max_rounds": {
      const n = Number(payload.maxRounds);
      if (!Number.isInteger(n) || n < 2 || n > 30) return { ok: false, error: "最大轮数要在 2 到 30 之间" };
      if (n < m.current_round) return { ok: false, error: `已经进行到第 ${m.current_round} 轮` };
      if (ended && n <= m.current_round) return { ok: false, error: `会议已经开到第 ${m.current_round} 轮，要继续请把最大轮数设得比它大` };
      if (ended && activeMeeting()) return { ok: false, error: "已经有别的会议在进行，一次只能开一场" };
      updateMeeting(id, { max_rounds: n });
      insertTurn({ meetingId: id, round: m.current_round, seat: "system", kind: "notice", text: `主持人把最大轮数调整为 ${n}` });
      if (ended) {
        insertTurn({ meetingId: id, round: m.current_round, seat: "system", kind: "notice", text: "主持人重新开启了会议" });
        updateMeeting(id, { status: "paused", pause_reason: "host", final_draft: null, end_note: null });
      }
      notify(id);
      return { ok: true };
    }
    case "set_site": {
      // 给某个席位换 AI：新网站开一个新对话，第一次发言时把之前的会议记录一起发过去。
      const seat = isSeat(payload.seat) && seats.includes(payload.seat) ? payload.seat : null;
      const site = isSite(payload.site) ? payload.site : null;
      if (!seat || !site) return { ok: false, error: "请选择席位和网站" };
      if (r.running) return { ok: false, error: "请等这一轮发言结束再换 AI" };
      if (ended) return { ok: false, error: "会议已经结束" };
      const parts = getParticipants(id);
      if (parts.some((p) => p.site === site && p.seat !== seat)) return { ok: false, error: `${siteName(site)}已经在参会了` };
      const old = parts.find((p) => p.seat === seat) as ParticipantRow;
      if (old.site === site) return { ok: true };
      updateParticipant(id, seat, { site, chat_id: null, chat_url: null, seen_upto: 0, joined_round: m.current_round });
      insertTurn({ meetingId: id, round: m.current_round, seat: "system", kind: "notice", text: `主持人把${SEAT_LABEL[seat]}从 ${siteName(old.site)} 换成 ${siteName(site)}（新对话，会把之前的会议记录发给它）` });
      notify(id);
      return { ok: true };
    }
    case "set_wait": {
      const w = Number(payload.waitSeconds);
      if (![0, 30, 60, -1].includes(w)) return { ok: false, error: "只能选 0、30、60 秒或一直等" };
      updateMeeting(id, { wait_seconds: w });
      notify(id);
      return { ok: true };
    }
    default:
      return { ok: false, error: "未知操作" };
  }
}

// ---- 后台检查 -----------------------------------------------------------------

/** 插件连上：因为插件没连上而暂停的会议自动继续。 */
bridge.on("status", () => {
  broadcastAll("bridge", bridge.status());
  if (!bridge.connected) return;
  for (const m of listMeetings()) if (m.status === "paused" && m.pause_reason === "no_ext") setTimeout(() => void advance(m.id), 3000);
});

let watcher: ReturnType<typeof setInterval> | null = null;
/** 每 30 秒：网站限流暂停的会议，到时间自动重试。 */
export function startWatcher(): void {
  if (watcher) return;
  watcher = setInterval(() => {
    for (const m of listMeetings()) {
      if (m.status === "paused" && m.pause_reason === "retry" && m.retry_at && m.retry_at <= Date.now()) void advance(m.id);
    }
  }, 30_000);
  watcher.unref?.();
}

/** 服务启动时：上次正在进行 / 倒计时中的会议停在原地，等主持人点继续。 */
export function recoverOnStartup(): void {
  for (const m of listMeetings()) {
    if (m.status === "running") updateMeeting(m.id, { status: "interrupted", deadline_at: null });
    else if (m.status === "waiting") updateMeeting(m.id, { status: "paused", pause_reason: "restart", deadline_at: null });
  }
}

/** 测试用：等当前这一步跑完。 */
export async function waitIdle(id: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (rt(id).running || getMeeting(id)?.status === "running") {
    if (Date.now() - start > timeoutMs) throw new Error("waitIdle timeout");
    await new Promise((res) => setTimeout(res, 20));
  }
}
export function isRunning(id: string): boolean { return rt(id).running; }
