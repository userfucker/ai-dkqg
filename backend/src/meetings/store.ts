/** AI 会议的数据库读写（表结构见 db.ts）。 */
import { getDb } from "../db.ts";
import type { DraftRecord, FinalizeReason, PenMode, Seat, TurnKind, TurnRecord, TurnStatus } from "./protocol.ts";

export type MeetingStatus =
  | "running" // 有 AI 正在发言
  | "waiting" // 控制点倒计时中
  | "paused" // 等主持人（主持人暂停 / 正在输入 / 一直等我 / 提问环节 / 插件没连上 / 网站限流）
  | "interrupted" // 服务重启时正在进行，可以继续
  | "error" // 出错，可以重试或换 AI
  | "consensus" // 达成一致（绿色）
  | "finalized" // 主持人要求定稿，有人保留意见
  | "divergent" // 求同存异
  | "insufficient" // 条件不足
  | "max_rounds" // 达到最大轮数
  | "stopped"; // 主持人终止

export const ENDED_STATUSES: MeetingStatus[] = ["consensus", "finalized", "divergent", "insufficient", "max_rounds", "stopped"];
export const isEnded = (s: string) => (ENDED_STATUSES as string[]).includes(s);

export interface MeetingRow {
  id: string;
  title: string;
  topic: string;
  prompt_id: number | null;
  prompt_name: string | null;
  prompt_content: string;
  pen_mode: PenMode;
  pen_seat: Seat;
  next_writer: Seat | null;
  max_rounds: number;
  wait_seconds: number;
  status: MeetingStatus;
  pause_reason: string | null;
  pause_detail: string | null;
  current_round: number;
  deadline_at: number | null;
  finalize_stage: "write" | "confirm" | null;
  finalize_reason: FinalizeReason | null;
  pause_after: number;
  final_draft: string | null;
  end_note: string | null;
  error: string | null;
  retry_at: number | null;
  elapsed_ms: number;
  active_since: number | null;
  created_at: number;
  updated_at: number;
}

export interface ParticipantRow {
  meeting_id: string;
  seat: Seat;
  site: string;
  chat_id: string | null;
  chat_url: string | null;
  seen_upto: number;
  joined_round: number;
  /** 1 = 连续两次发言失败，本场会议跳过它 */
  dropped: number;
}

interface TurnRow {
  id: number;
  meeting_id: string;
  round: number;
  seat: Seat | "host" | "system";
  kind: TurnKind;
  site: string | null;
  text: string;
  status_json: string | null;
  draft_version: number | null;
  duration_ms: number | null;
  thinking_len: number | null;
  attach_json: string | null;
  meta_json: string | null;
  created_at: number;
}

export interface FullTurn extends TurnRecord {
  site: string | null;
  durationMs: number | null;
  thinkingLen: number | null;
  attach: { name: string; lines: number } | null;
  /** 主持人回答提问时的结构化答案：{ answers: { "A-1": "选项或文字" }, extra } */
  meta: Record<string, unknown> | null;
  createdAt: number;
}

const timed = (s: string) => s === "running" || s === "waiting";

export function createMeeting(row: Omit<MeetingRow, "status" | "pause_reason" | "pause_detail" | "current_round" | "deadline_at" | "finalize_stage" | "finalize_reason" | "pause_after" | "final_draft" | "end_note" | "error" | "retry_at" | "elapsed_ms" | "active_since" | "created_at" | "updated_at" | "next_writer">, participants: { seat: Seat; site: string }[]): void {
  const db = getDb();
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO meetings (id, title, topic, prompt_id, prompt_name, prompt_content, pen_mode, pen_seat, max_rounds, wait_seconds, status, created_at, updated_at)
       VALUES (@id, @title, @topic, @prompt_id, @prompt_name, @prompt_content, @pen_mode, @pen_seat, @max_rounds, @wait_seconds, 'waiting', ${now}, ${now})`,
    ).run(row);
    for (const p of participants) db.prepare(`INSERT INTO meeting_participants (meeting_id, seat, site) VALUES (?, ?, ?)`).run(row.id, p.seat, p.site);
  })();
}

export function getMeeting(id: string): MeetingRow | undefined {
  return getDb().prepare(`SELECT * FROM meetings WHERE id = ?`).get(id) as MeetingRow | undefined;
}

export function listMeetings(): MeetingRow[] {
  return getDb().prepare(`SELECT * FROM meetings ORDER BY created_at DESC`).all() as MeetingRow[];
}

/** 还没结束的会议（一次只能开一场）。 */
export function activeMeeting(): MeetingRow | undefined {
  return listMeetings().find((m) => !isEnded(m.status));
}

export function updateMeeting(id: string, fields: Partial<Omit<MeetingRow, "id" | "created_at">>): void {
  const db = getDb();
  const now = Date.now();
  // 计时：只有“发言中 / 倒计时”时计时，状态切换时把这一段累计起来。
  if (fields.status !== undefined) {
    const cur = db.prepare(`SELECT status, elapsed_ms, active_since FROM meetings WHERE id = ?`).get(id) as { status: string; elapsed_ms: number; active_since: number | null } | undefined;
    if (cur) {
      const wasTimed = cur.active_since !== null;
      const willTime = timed(fields.status);
      if (wasTimed && !willTime) { fields.elapsed_ms = cur.elapsed_ms + (now - (cur.active_since as number)); fields.active_since = null; }
      if (!wasTimed && willTime) fields.active_since = now;
    }
  }
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE meetings SET ${sets}, updated_at = @__now WHERE id = @__id`).run({ ...fields, __now: now, __id: id });
}

export function deleteMeeting(id: string): void {
  getDb().prepare(`DELETE FROM meetings WHERE id = ?`).run(id);
}

export function getParticipants(id: string): ParticipantRow[] {
  return getDb().prepare(`SELECT * FROM meeting_participants WHERE meeting_id = ? ORDER BY seat`).all(id) as ParticipantRow[];
}

export function updateParticipant(id: string, seat: Seat, fields: Partial<Omit<ParticipantRow, "meeting_id" | "seat">>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  getDb().prepare(`UPDATE meeting_participants SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE meeting_id = @__id AND seat = @__seat`).run({ ...fields, __id: id, __seat: seat });
}

function toTurn(r: TurnRow): FullTurn {
  return {
    id: r.id, round: r.round, seat: r.seat, kind: r.kind, site: r.site, text: r.text,
    status: r.status_json ? (JSON.parse(r.status_json) as TurnStatus) : null,
    draftVersion: r.draft_version, durationMs: r.duration_ms, thinkingLen: r.thinking_len,
    attach: r.attach_json ? JSON.parse(r.attach_json) : null, meta: r.meta_json ? JSON.parse(r.meta_json) : null, createdAt: r.created_at,
  };
}

export function getTurns(id: string): FullTurn[] {
  return (getDb().prepare(`SELECT * FROM meeting_turns WHERE meeting_id = ? ORDER BY id`).all(id) as TurnRow[]).map(toTurn);
}

export function insertTurn(t: { meetingId: string; round: number; seat: Seat | "host" | "system"; kind: TurnKind; text: string; site?: string | null; status?: TurnStatus | null; durationMs?: number | null; thinkingLen?: number | null; attach?: { name: string; lines: number } | null; meta?: Record<string, unknown> | null }): number {
  const r = getDb()
    .prepare(`INSERT INTO meeting_turns (meeting_id, round, seat, kind, site, text, status_json, duration_ms, thinking_len, attach_json, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(t.meetingId, t.round, t.seat, t.kind, t.site ?? null, t.text, t.status ? JSON.stringify(t.status) : null, t.durationMs ?? null, t.thinkingLen ?? null, t.attach ? JSON.stringify(t.attach) : null, t.meta ? JSON.stringify(t.meta) : null, Date.now());
  return Number(r.lastInsertRowid);
}

export function setTurnDraftVersion(turnId: number, version: number): void {
  getDb().prepare(`UPDATE meeting_turns SET draft_version = ? WHERE id = ?`).run(version, turnId);
}

export function getDrafts(id: string): DraftRecord[] {
  return (getDb().prepare(`SELECT version, seat, turn_id AS turnId, content FROM meeting_drafts WHERE meeting_id = ? ORDER BY version`).all(id) as DraftRecord[]);
}

export function insertDraft(id: string, seat: Seat, turnId: number, content: string): number {
  const db = getDb();
  const v = ((db.prepare(`SELECT MAX(version) AS v FROM meeting_drafts WHERE meeting_id = ?`).get(id) as { v: number | null }).v ?? 0) + 1;
  db.prepare(`INSERT INTO meeting_drafts (meeting_id, version, seat, turn_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, v, seat, turnId, content, Date.now());
  return v;
}

// ---- 会议用过的对话（会话管理）

export interface ChatRow { meeting_id: string; site: string; chat_id: string; url: string | null; seat: string | null; created_at: number; deleted_at: number | null }

export function rememberChat(meetingId: string, site: string, chatId: string, url: string | null, seat: Seat): void {
  getDb().prepare(`INSERT INTO meeting_chats (meeting_id, site, chat_id, url, seat, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(site, chat_id) DO UPDATE SET url = COALESCE(excluded.url, url)`).run(meetingId, site, chatId, url, seat, Date.now());
}
export function listChats(): ChatRow[] {
  return getDb().prepare(`SELECT * FROM meeting_chats ORDER BY created_at DESC`).all() as ChatRow[];
}
export function markChatDeleted(site: string, chatId: string): void {
  getDb().prepare(`UPDATE meeting_chats SET deleted_at = ? WHERE site = ? AND chat_id = ?`).run(Date.now(), site, chatId);
}
