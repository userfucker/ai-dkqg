export type Seat = "A" | "B" | "C" | "D";
export type SiteId = "deepseek" | "glm" | "kimi" | "qwen";

export interface SiteState { site: SiteId; name: string; open: boolean; ready: boolean; url?: string; chatId?: string; title?: string }
export interface BridgeStatus { connected: boolean; name: string | null; version: string | null; since: number | null; sites: SiteState[] }

export interface MeetingSummary {
  id: string; title: string; status: string; pauseReason: string | null; currentRound: number; maxRounds: number;
  participants: { seat: Seat; site: SiteId; dropped?: boolean }[]; createdAt: number; updatedAt: number;
}
export interface TurnStatus { draftVersion: number | null; keyIssues: number | null; minorIssues: number | null; hostUnanswered: number | null; newPoints: boolean | null; agree: boolean | null; cannotContinue: boolean | null; cannotContinueReason: string | null }
export interface Question { n: number; text: string; why: string; options: string[]; assumption: string }
export interface Turn {
  id: number; round: number; seat: Seat | "host" | "system"; kind: string; site: SiteId | null; text: string; status: TurnStatus | null;
  draftVersion: number | null; durationMs: number | null; thinkingLen: number | null; attach: { name: string; lines: number } | null; createdAt: number;
  questions: Question[] | null; hasQuestions?: boolean;
  meta: { skipped?: boolean; answers?: Record<string, string>; extra?: string } | null;
}
export interface Draft { version: number; seat: Seat; turnId: number; content: string }
export interface Live { seat: Seat; site: SiteId; kind: string; round: number; text: string; thinkingLen: number; startedAt: number; attach: { name: string; lines: number } | null; busy?: boolean }
export interface MeetingDetail {
  id: string; title: string; topic: string; promptId: number | null; promptName: string | null; penMode: "fixed" | "rotate"; penSeat: Seat; nextWriter: Seat | null;
  maxRounds: number; waitSeconds: number; status: string; pauseReason: string | null; pauseDetail: { message?: string } | null; currentRound: number;
  deadlineAt: number | null; finalizeStage: string | null; finalizeReason: string | null; pauseAfter: boolean; finalDraft: string | null; endNote: string | null;
  error: string | null; retryAt: number | null; elapsedMs: number; activeSince: number | null; createdAt: number; updatedAt: number;
  participants: { seat: Seat; site: SiteId; name: string; chatId: string | null; chatUrl: string | null; dropped?: boolean }[];
  turns: Turn[]; drafts: Draft[]; live: Live[]; running: boolean; estimate: { perSeat: number; total: number }; serverNow: number;
}
export interface Prompt { id: number; name: string; content: string; is_default: number; updated_at: number }
