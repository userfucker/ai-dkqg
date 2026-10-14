import type { Seat, SiteId } from "./types.ts";

export const SEAT_LABEL: Record<Seat, string> = { A: "甲", B: "乙", C: "丙", D: "丁" };
export const SITES: { id: SiteId; name: string }[] = [
  { id: "deepseek", name: "DeepSeek" }, { id: "glm", name: "智谱清言" }, { id: "kimi", name: "Kimi" }, { id: "qwen", name: "千问" },
];
export const siteName = (s: string | null | undefined) => SITES.find((x) => x.id === s)?.name ?? s ?? "";
export const SITE_COLOR: Record<string, string> = { deepseek: "#4d6bfe", glm: "#10b981", kimi: "#f59e0b", qwen: "#7c3aed" };

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
