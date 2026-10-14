/** 导出会议纪要（Markdown）：基本信息、提问环节、每次发言（执笔写出的合并稿折叠在发言下面）、最终结论。 */
import { getMeetingDetail } from "./runner.ts";
import { SEAT_LABEL, isSeat, type Seat } from "./protocol.ts";

const STATUS_TEXT: Record<string, string> = {
  running: "进行中", waiting: "等待主持人", paused: "已暂停", interrupted: "已中断", error: "出错",
  consensus: "达成一致", finalized: "主持人定稿", divergent: "求同存异", insufficient: "条件不足", max_rounds: "达到最大轮数", stopped: "已终止",
};
const KIND_TEXT: Record<string, string> = { ask: "提问", answer: "主持人回答", opening: "独立陈述", write: "执笔", review: "审阅", final_write: "执笔（最终稿）", confirm: "定稿确认", host: "主持人意见", notice: "系统" };
const bj = (ms: number) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

export function minutesMarkdown(id: string): { name: string; text: string } | null {
  const d = getMeetingDetail(id);
  if (!d) return null;
  const who = (seat: string) => {
    if (!isSeat(seat)) return seat === "host" ? "主持人" : "系统";
    const p = d.participants.find((x) => x.seat === seat);
    return `${SEAT_LABEL[seat as Seat]}（${p?.name ?? ""}）`;
  };
  const L: string[] = [];
  L.push(`# AI 会议纪要：${d.title}`, "");
  L.push(`- 时间：${bj(d.createdAt)}（北京时间）`);
  L.push(`- 参会：${d.participants.map((p) => `${SEAT_LABEL[p.seat as Seat]} ${p.name}`).join("，")}`);
  L.push(`- 执笔方式：${d.penMode === "fixed" ? `固定执笔（${SEAT_LABEL[d.penSeat as Seat]}）` : "轮流执笔"}　最大轮数：${d.maxRounds}`);
  if (d.promptName) L.push(`- 会议风格：${d.promptName}`);
  L.push(`- 结果：**${STATUS_TEXT[d.status] ?? d.status}**${d.endNote ? `（${d.endNote}）` : ""}`, "");
  L.push("## 议题", "", d.topic, "");
  if (d.finalDraft) L.push("## 会议结论", "", d.finalDraft, "");
  L.push("## 会议过程", "");
  for (const t of d.turns) {
    if (t.kind === "notice") { L.push(`> ${t.text}`, ""); continue; }
    const round = t.kind === "ask" || t.kind === "answer" ? "提问环节" : `第 ${t.round} 轮`;
    L.push(`### ${round} · ${who(t.seat)} · ${KIND_TEXT[t.kind] ?? t.kind}`, "");
    const st = t.status;
    if (st && t.kind !== "opening") {
      const tags = [st.agree === true ? "同意定稿" : st.agree === false ? "不同意定稿" : null, st.keyIssues != null ? `关键问题 ${st.keyIssues}` : null, st.minorIssues != null ? `次要问题 ${st.minorIssues}` : null, st.cannotContinue ? "无法继续" : null].filter(Boolean);
      if (tags.length) L.push(`*状态：${tags.join(" · ")}*`, "");
    }
    if (t.attach) L.push(`*（这一轮的材料用附件《${t.attach.name}》发送，${t.attach.lines} 行）*`, "");
    L.push(t.text, "");
    if (t.draftVersion) {
      const draft = d.drafts.find((x) => x.version === t.draftVersion);
      if (draft) L.push(`<details><summary>合并稿 v${draft.version}</summary>`, "", draft.content, "", "</details>", "");
    }
  }
  const name = `AI会议纪要-${d.title.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 30)}-${bj(d.createdAt).replace(/[-: ]/g, "")}.md`;
  return { name, text: L.join("\n") };
}
