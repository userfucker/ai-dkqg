import type { Seat, SiteId } from "./types.ts";

export const SEAT_LABEL: Record<Seat, string> = { A: "甲", B: "乙", C: "丙", D: "丁" };
export const SITES: { id: SiteId; name: string }[] = [
  { id: "deepseek", name: "DeepSeek" }, { id: "glm", name: "智谱清言" }, { id: "kimi", name: "Kimi" }, { id: "doubao", name: "豆包" }, { id: "qwen", name: "千问" },
];
/** 能参会的网站（千问已停用：消息超过一万多字就用不了） */
export const ACTIVE_SITES = SITES.filter((s) => s.id !== "qwen");
export const siteName = (s: string | null | undefined) => SITES.find((x) => x.id === s)?.name ?? s ?? "";
export const SITE_COLOR: Record<string, string> = { deepseek: "#4d6bfe", glm: "#10b981", kimi: "#f59e0b", qwen: "#7c3aed", doubao: "#0891b2" };

/** 会议状态：文字 + 颜色（tailwind 类） */
export function statusInfo(status: string, pauseReason?: string | null): { text: string; cls: string; ended: boolean } {
  const ended = ["consensus", "finalized", "divergent", "insufficient", "max_rounds", "stopped"].includes(status);
  const map: Record<string, [string, string]> = {
    running: ["发言中", "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"],
    waiting: ["等待主持人", "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300"],
    interrupted: ["已中断", "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"],
    error: ["出错", "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"],
    consensus: ["达成一致", "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"],
    finalized: ["主持人定稿", "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"],
    divergent: ["求同存异", "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300"],
    insufficient: ["条件不足", "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"],
    max_rounds: ["达到最大轮数", "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"],
    stopped: ["已终止", "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"],
  };
  if (status === "paused") {
    const why: Record<string, string> = { questions: "等你回答提问", host: "已暂停", typing: "你正在输入", no_ext: "等插件连上", retry: "网站限流，稍后重试", restart: "服务重启过，已暂停" };
    return { text: why[pauseReason ?? ""] ?? "已暂停", cls: pauseReason === "questions" ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300" : "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300", ended: false };
  }
  const [text, cls] = map[status] ?? [status, "bg-zinc-200 text-zinc-700"];
  return { text, cls, ended };
}

/** 需要主持人处理（标题闪烁用） */
export const needsHost = (status: string, pauseReason?: string | null) => status === "error" || status === "interrupted" || (status === "paused" && ["questions", "no_ext", "restart"].includes(pauseReason ?? ""));

export const KIND_TEXT: Record<string, string> = { ask: "提问", answer: "回答提问", opening: "独立陈述", write: "执笔", review: "审阅", final_write: "执笔（最终稿）", confirm: "定稿确认", host: "主持人", notice: "系统" };

/** 北京时间 */
export function bj(ms: number, withDate = true): string {
  const s = new Date(ms + 8 * 3600e3).toISOString();
  return withDate ? `${s.slice(5, 10)} ${s.slice(11, 16)}` : s.slice(11, 19);
}
export const secs = (ms: number | null | undefined) => (ms == null ? "" : ms < 60000 ? `${Math.round(ms / 1000)} 秒` : `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`);

// ---- 会议页（照 webui 的 MeetingView）

/** 用时："4分0秒" / "12秒" */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`;
}
/** 完成时间（北京时间）："2026年10月5日14时21分57秒完成" */
export function formatFinishedAt(ms: number): string {
  const d = new Date(ms + 8 * 3600e3);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日${d.getUTCHours()}时${String(d.getUTCMinutes()).padStart(2, "0")}分${String(d.getUTCSeconds()).padStart(2, "0")}秒完成`;
}
/** 会议计时："03:25" / "1:03:25" */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 每个网站的颜色（发言人名字、卡片边框） */
export const SITE_CLS: Record<string, { text: string; border: string; bg: string }> = {
  deepseek: { text: "text-blue-700 dark:text-blue-400", border: "border-blue-300 dark:border-blue-800", bg: "bg-blue-500" },
  glm: { text: "text-emerald-700 dark:text-emerald-400", border: "border-emerald-300 dark:border-emerald-800", bg: "bg-emerald-500" },
  kimi: { text: "text-orange-600 dark:text-orange-400", border: "border-orange-300 dark:border-orange-800", bg: "bg-orange-500" },
  doubao: { text: "text-cyan-700 dark:text-cyan-400", border: "border-cyan-300 dark:border-cyan-800", bg: "bg-cyan-600" },
  qwen: { text: "text-violet-700 dark:text-violet-400", border: "border-violet-300 dark:border-violet-800", bg: "bg-violet-500" },
};
export const siteCls = (site: string | null | undefined) => SITE_CLS[site ?? ""] ?? { text: "text-zinc-700", border: "border-zinc-300", bg: "bg-zinc-400" };

/** 合并稿里某一栏（“## 标题”到下一个“## ”之间） */
export function draftSection(draft: string, title: string): string | null {
  const lines = draft.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^##\\s*${title}`).test(l.trim()));
  if (start < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) { if (/^#{1,2}\s/.test(l.trim())) break; out.push(l); }
  return out.join("\n").trim();
}
export const isEmptySection = (text: string | null) => !text || /^[（(]?(无|没有|暂无)/.test(text.trim());

/** 去掉 Markdown 符号的纯文字（“复制明文”用） */
export function markdownToPlainText(md: string): string {
  return md
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "· ")
    .replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return; }
  // 局域网 http 页面没有 clipboard API：用老办法
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
}
