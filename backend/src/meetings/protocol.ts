/**
 * AI 会议的“会议规则”——从 webui 的 backend/meetings/protocol.ts 搬过来，改成 2～4 方（甲乙丙丁）。
 * 全是纯函数：拼每一轮发给参会者的消息、解析发言末尾的状态块、取出合并稿、决定下一步谁做什么、
 * 判断是否结束。
 *
 * 和 webui 的区别：
 *  - 参会者是网页版 AI（DeepSeek / 智谱清言 / Kimi / 千问），不能读写文件：去掉了文件快照、工程目录这些规则；
 *  - 2～4 方：第 2 轮起每一轮由一位执笔人写出新版本合并稿，其他参会者同时审阅；
 *    执笔方式：固定执笔（一直是同一位）/ 轮流执笔（甲→乙→丙→丁→甲…）；
 *  - 达成一致：最新合并稿之后，除执笔人以外的每一位都同意定稿、没有关键问题，主持人也没有新意见；
 *  - 消息分成“说明”和“材料”两部分，材料太长时由 runner 放进 txt 附件。
 *
 * 程序靠这里规定的固定格式（<合并稿 vN>…</合并稿>、<会议状态>…</会议状态>、<提问>…</提问>）
 * 判断会议进度，所以这一层写死在代码里，网页上只读展示。主持人设置的“会议风格”原样插在规则后面。
 */

export type Seat = "A" | "B" | "C" | "D";
export const ALL_SEATS: Seat[] = ["A", "B", "C", "D"];
export type PenMode = "fixed" | "rotate";
export type TurnKind =
  | "ask" // 提问环节：开会前向主持人提问
  | "answer" // 主持人回答提问
  | "opening" // 第 1 轮独立陈述
  | "write" // 执笔：写出新版本合并稿
  | "review" // 审阅：其他参会者同时审阅最新合并稿
  | "final_write" // 收尾：执笔人写最终稿（主持人要求定稿 / 求同存异）
  | "confirm" // 收尾：其他参会者确认最终稿
  | "host" // 主持人意见
  | "notice"; // 系统提示（只给人看）

export const SEAT_LABEL: Record<Seat, string> = { A: "甲", B: "乙", C: "丙", D: "丁" };

export interface TurnStatus {
  draftVersion: number | null;
  keyIssues: number | null;
  minorIssues: number | null;
  hostUnanswered: number | null;
  newPoints: boolean | null;
  agree: boolean | null;
  cannotContinue: boolean | null;
  cannotContinueReason: string | null;
}

export type FinalizeReason = "host" | "divergence";

export interface ParticipantInfo {
  seat: Seat;
  site: string;
  /** 网站名，例如 DeepSeek */
  name: string;
}

export interface TurnRecord {
  id: number;
  round: number;
  seat: Seat | "host" | "system";
  kind: TurnKind;
  text: string;
  status: TurnStatus | null;
  draftVersion: number | null;
}

export interface DraftRecord {
  version: number;
  seat: Seat;
  turnId: number;
  content: string;
}

export const isSeat = (s: unknown): s is Seat => s === "A" || s === "B" || s === "C" || s === "D";

export function participantName(p: ParticipantInfo): string {
  return `${SEAT_LABEL[p.seat]}（${p.name}）`;
}

// ---- 解析 ---------------------------------------------------------------------

const STATUS_BLOCK = /<会议状态>([\s\S]*?)<\/会议状态>/g;
const DRAFT_BLOCK = /<合并稿[^>]*>([\s\S]*?)<\/合并稿>/g;
const ASK_BLOCK = /<提问>([\s\S]*?)<\/提问>/g;

function lastMatch(re: RegExp, text: string): RegExpExecArray | null {
  re.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  return last;
}

function numberAfter(block: string, label: RegExp): number | null {
  const m = new RegExp(`${label.source}\\s*[：:]\\s*[v第]?\\s*(\\d+)`).exec(block);
  return m ? Number(m[1]) : null;
}

function yesNoAfter(block: string, label: RegExp, yes: RegExp, no: RegExp): boolean | null {
  const m = new RegExp(`${label.source}\\s*[：:]\\s*([^\\n]*)`).exec(block);
  if (!m) return null;
  const value = m[1].trim();
  // 先判断否定——“不同意”“否”里都可能夹着肯定的字。
  if (no.test(value)) return false;
  if (yes.test(value)) return true;
  return null;
}

/** 解析发言末尾的 <会议状态>（取最后一个）。没有状态块返回 null。 */
export function parseStatus(text: string): TurnStatus | null {
  const m = lastMatch(STATUS_BLOCK, text);
  if (!m) return null;
  const block = m[1];
  return {
    draftVersion: numberAfter(block, /合并稿版本/),
    keyIssues: numberAfter(block, /关键问题/),
    minorIssues: numberAfter(block, /次要问题/),
    hostUnanswered: numberAfter(block, /主持人要求未回应/),
    newPoints: yesNoAfter(block, /新论点/, /有|是/, /无|没有|否/),
    agree: yesNoAfter(block, /是否同意定稿/, /是|同意/, /否|不同意|暂不/),
    cannotContinue: yesNoAfter(block, /无法继续/, /^是/, /^(否|不|能|可以)/),
    cannotContinueReason: (() => {
      const r = /无法继续\s*[：:]\s*是\s*[（(：:，,]?\s*([^\n]*)/.exec(block);
      const reason = r?.[1].replace(/[）)]\s*$/, "").trim();
      return reason ? reason.slice(0, 300) : null;
    })(),
  };
}

export interface MeetingQuestion {
  n: number;
  text: string;
  why: string;
  options: string[];
  assumption: string;
}

/** 提问环节的回复里有没有要问主持人的问题。 */
export function hasQuestions(text: string): boolean {
  const m = lastMatch(ASK_BLOCK, text);
  if (m) {
    const body = m[1].trim();
    return !!body && !/^(无|没有|不需要|无需)/.test(body);
  }
  const t = text.trim();
  return !!t && !/(没有|无|不需要|无需)(要|需要)?(提问|问题|补充)/.test(t);
}

/** 按固定格式拆出每个问题（“### 问题 1：…”、“选项：”、“默认假设：”）。拆不出来返回空数组。 */
export function parseQuestions(text: string): MeetingQuestion[] {
  const m = lastMatch(ASK_BLOCK, text);
  const body = m ? m[1] : text;
  const heads = [...body.matchAll(/^\s*#{0,4}\s*\**\s*问题\s*(\d+)\s*\**\s*[：:.、]\s*(.*)$/gm)];
  const out: MeetingQuestion[] = [];
  heads.forEach((h, i) => {
    const start = (h.index ?? 0) + h[0].length;
    const end = heads[i + 1]?.index ?? body.length;
    const rest = body.slice(start, end);
    const field = (label: RegExp) => new RegExp(`^\\s*[-*]?\\s*\\**${label.source}\\**\\s*[：:]\\s*(.*)$`, "m").exec(rest)?.[1].trim() ?? "";
    const optionsLine = field(/选项/);
    let options = optionsLine ? optionsLine.split(/\s*[｜|]\s*/).filter(Boolean) : [];
    if (options.length === 1) options = optionsLine.split(/\s+(?=[B-H][.．、)）])/).map((o) => o.trim()).filter(Boolean);
    out.push({ n: Number(h[1]), text: h[2].replace(/\*+$/, "").trim(), why: field(/为什么问/), options, assumption: field(/默认假设/) });
  });
  return out;
}

/** 合并稿里某一栏（“## 标题”到下一个“## ”之间）的内容，没有返回 null。 */
export function draftSection(draft: string, title: string): string | null {
  const lines = draft.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^##\\s*${title}`).test(l.trim()));
  if (start < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(l.trim())) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

/** 待议清单里已经解决（打 ✔）的条数。 */
export function resolvedCount(draft: string): number {
  const section = draftSection(draft, "待议清单") ?? "";
  return section.split("\n").filter((l) => /[✔✓☑]|已解决/.test(l)).length;
}

/** 发言里的合并稿正文（取最后一个），没有返回 null。模型忘了包标签、但内容就是合并稿栏目的，也收下。 */
export function extractDraft(text: string): string | null {
  const m = lastMatch(DRAFT_BLOCK, text);
  const content = m?.[1].trim();
  if (content) return content;
  if (/##\s*正文/.test(text) && /##\s*待议清单/.test(text)) return text.replace(STATUS_BLOCK, "").trim();
  return null;
}

/** 给人看的发言：去掉状态块；合并稿正文另外展示，这里换成一行说明。 */
export function displayText(text: string, draftVersion: number | null): string {
  let out = text.replace(STATUS_BLOCK, "");
  if (draftVersion !== null) out = out.replace(DRAFT_BLOCK, `\n（已写出合并稿 v${draftVersion}，见合并稿）\n`);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// ---- 拼消息 -------------------------------------------------------------------

export const STATUS_FORMAT = `<会议状态>
合并稿版本：v（你这次写出的版本号；没写新版本就写你看到的最新版本号）
关键问题：（待议清单里还没解决、并且你们 AI 自己能解决的关键问题数量；只能由主持人来做的测试或确认不算）
次要问题：（次要问题数量）
主持人要求未回应：（数量）
新论点：有 / 无
是否同意定稿：是 / 否
无法继续：否 / 是（原因）
</会议状态>`;

export const DRAFT_FORMAT = `<合并稿 vN>
# 议题
（议题原文；主持人调整过方向的，写调整后的；提问环节里主持人补充的背景也写进来）
## 主持人要求
（主持人每一条意见编号列出，每条标明"已回应：在正文哪里体现"或"未采纳：理由"；没有就写"无"）
## 正文
（全体参会者共同认可的结论和方案；采纳别人的内容注明"（采纳甲/乙/丙/丁）"）
## 待议清单
（还没解决、AI 自己能解决的分歧，编号；每条标明"关键"或"次要"，写出各方的主张；已解决的打 ✔ 并保留一行）
## 需要主持人测试或确认的事
（只能由主持人来做的测试或确认，编号；每条写：测什么、怎么操作、预期结果、失败时怎么办。只能靠测试判断谁对的分歧也写在这里。没有就写"无"）
## 需主持人回答
（需要主持人提供的信息：每条写问题和你们目前采用的假设；没有就写"无"）
## 备注
（次要问题、保留意见）
</合并稿>`;

export const ASK_FORMAT = `<提问>
### 问题 1：（一句话问题）
为什么问：（不同的回答会让方案怎么变）
选项：A. …｜B. …｜C. 不确定
默认假设：（主持人不回答时你按什么处理）
### 问题 2：……
</提问>`;

/** 会议规则全文（随议题一起发给每位参会者；网页上只读展示）。 */
export function meetingRules(): string {
  return `【AI 会议规则】
1. 这是一场多位 AI 参会者（按甲、乙、丙、丁称呼）在主持人主持下的协作会议。你们是同一个团队的专家，目标是共同写出一份最好的结论（"合并稿"），不是辩论输赢。
2. 会议先有一个提问环节：每位参会者先读议题，各自向主持人提问，弄清背景和要求；这一环节只提问、不作答。主持人回答（或跳过）后进入第 1 轮。认为没有要问的，可以不问。
3. 第 1 轮：每位参会者各自独立陈述观点，互相看不到。
4. 第 2 轮起，讨论只围绕"合并稿"进行：每一轮由一位执笔人把大家的观点合并/修改成新版本的合并稿，其他参会者同时审阅，逐条给出修改建议。
5. 修改或审阅时，先写"我从别人那里采纳了什么"（没有就写"无"），再写补充和修改。
6. 每个异议都必须附带具体的修改建议，并标明"关键"或"次要"。只挑毛病、不给办法的意见无效。次要问题不阻止定稿，写进"备注"。
7. 已经解决的问题不要再提；已经撤回的结论，没有新证据不要换个说法再提出来。
8. 主持人的意见优先于一切：执笔人必须在合并稿"主持人要求"栏逐条回应（采纳并说明体现在哪里，或者说明不采纳的理由）。有未回应的主持人要求时不能定稿。
9. 分清"AI 能解决的"和"只能由人来做的"：你们能推理、写代码和文档（写在回复里），但不能替主持人上机测试，也不知道只有主持人才知道的情况。只能由主持人来做的事不算关键问题，写进合并稿"需要主持人测试或确认的事"；只能靠测试判断谁对的分歧也写进这一栏。只要有一方认为某件事 AI 还能继续做，它就仍然是关键问题。
10. 缺少只有主持人才知道的信息时，写进合并稿"需主持人回答"，同时写明你们先采用的假设，然后照常讨论，不要停下来等。
11. 定稿的标准：AI 能解决的关键问题都解决了，剩下的都已写进"需要主持人测试或确认的事"，就可以同意定稿——不要求、也不可能保证百分百没有错误。
12. 说某件事"已完成 / 已验证"时，写清依据。
13. 内容较长时，主持人会把材料放在 txt 附件里发给你。附件就是这一轮消息的一部分，必须完整阅读后再回答。
14. 合并稿必须完整写在回复正文里，用下面的格式包起来：
${DRAFT_FORMAT}
15. 第 1 轮起，每次发言最后都必须附上状态块（第 1 轮只需要写"无法继续"一行）：
${STATUS_FORMAT}
"无法继续"只有在议题在现有条件下确实做不到、或者缺的信息不经主持人回答就完全没法往下讨论时才写"是"；仅仅因为需要主持人测试，不算无法继续。
16. 用中文回复。`;
}

/** 发给参会者的一条消息：说明（一定直接发）+ 材料（太长时放进 txt 附件）。 */
export interface BuiltMessage {
  head: string;
  material: string;
  /** 材料是什么（附件说明里用），例如“议题”“其他参会者的发言和合并稿 v3” */
  materialLabel: string;
}

export interface BuildContext {
  topic: string;
  promptContent: string;
  me: ParticipantInfo;
  others: ParticipantInfo[];
  round: number;
  maxRounds: number;
  penMode: PenMode;
  /** 自上次发言以来，别人（其他参会者 / 主持人）的新发言，按时间先后。 */
  unseen: TurnRecord[];
  participants: Partial<Record<Seat, ParticipantInfo>>;
  latestDraft: DraftRecord | null;
  /** 最新版合并稿之后主持人有没有新意见（有就不能同意定稿）。 */
  hostAfterLatestDraft: boolean;
  qa: { asks: TurnRecord[]; answer: string | null } | null;
  finalizeReason?: FinalizeReason | null;
  /** 中途加入（换了 AI）：之前的会议记录 */
  joinHistory?: TurnRecord[] | null;
}

const kindLabel = (t: TurnRecord) =>
  t.kind === "opening" ? "第 1 轮独立陈述" : t.kind === "review" ? `第 ${t.round} 轮审阅意见` : t.kind === "confirm" ? `第 ${t.round} 轮定稿确认` : t.kind === "final_write" ? `第 ${t.round} 轮最终稿` : `第 ${t.round} 轮执笔`;

function turnsBlock(turns: TurnRecord[], participants: BuildContext["participants"]): string {
  const parts: string[] = [];
  const hosts = turns.filter((t) => t.seat === "host" && t.kind === "host");
  if (hosts.length > 0) {
    parts.push(`【主持人意见】（执笔人必须在合并稿"主持人要求"栏逐条回应）\n` + hosts.map((t, i) => `${i + 1}. ${t.text}`).join("\n"));
  }
  for (const t of turns) {
    if (!isSeat(t.seat) || t.kind === "ask") continue;
    const p = participants[t.seat];
    const who = p ? participantName(p) : SEAT_LABEL[t.seat];
    parts.push(`【${who} 的${kindLabel(t)}】\n${t.text.replace(STATUS_BLOCK, "").trim()}`);
  }
  return parts.join("\n\n");
}

function header(ctx: BuildContext, role: string): string {
  return `【AI 会议 · 第 ${ctx.round}/${ctx.maxRounds} 轮 · 你是${SEAT_LABEL[ctx.me.seat]}，本轮${role}】`;
}

const REMINDER =
  '提醒：用中文回复；先写采纳了别人什么（没有就写"无"）；异议必须附修改建议并标明关键/次要；只能由主持人来做的测试或确认写进"需要主持人测试或确认的事"，不算关键问题；次要问题写进备注、不阻止定稿；主持人要求必须逐条回应。';

function endingHint(ctx: BuildContext, writer: boolean): string {
  if (ctx.round === ctx.maxRounds) {
    return writer
      ? "这是最后一轮：请把成果整理成最终版本，不要再开新的话题。"
      : "这是最后一轮：请确认合并稿能不能作为会议结论；不同意的地方写清楚，你的意见会附在会议结论后面。";
  }
  if (ctx.round === ctx.maxRounds - 1) return "还剩两轮：请把成果整理完整，不要再开新的话题。";
  return "";
}

function intro(ctx: BuildContext): string {
  const style = ctx.promptContent.trim() ? `\n\n【会议风格要求】\n${ctx.promptContent.trim()}` : "";
  const others = ctx.others.map(participantName).join("、");
  return `${meetingRules()}${style}

【参会者】你是${participantName(ctx.me)}；其他参会者：${others}。议题材料里如果提到其他 AI 的回复，那是参考材料，不是这场会议的参会者。`;
}

/** 提问环节：先读议题，向主持人提问，不作答。 */
export function buildAskMessage(ctx: BuildContext): BuiltMessage {
  return {
    head: `${intro(ctx)}

【AI 会议 · 提问环节 · 你是${SEAT_LABEL[ctx.me.seat]}】
请先完整阅读议题，然后向主持人提问，弄清议题的背景和要求（主持人的描述可能不完整）。
- 这一轮只提问，不要作答，不要给出方案，也不需要状态块。其他参会者也在同时提问，你们互相看不到。
- 只问会改变方案的问题，每个问题写明为什么问、默认假设；能做成选择题的尽量做成选择题。不要问议题里已经写清楚的。
用下面的格式写：
${ASK_FORMAT}
你认为没有需要问的，只写 <提问>无</提问>。`,
    material: `【议题】\n${ctx.topic}`,
    materialLabel: "议题",
  };
}

function qaBlock(ctx: BuildContext): string {
  const qa = ctx.qa;
  if (!qa || qa.asks.length === 0) return "";
  const asks = qa.asks
    .filter((t) => hasQuestions(t.text))
    .map((t) => {
      const p = isSeat(t.seat) ? ctx.participants[t.seat] : undefined;
      return `【${p ? participantName(p) : t.seat}的提问】\n${(lastMatch(ASK_BLOCK, t.text)?.[1] ?? t.text).trim()}`;
    });
  if (asks.length === 0) return "";
  return `【提问环节】\n${asks.join("\n\n")}\n\n【主持人的回答】\n${qa.answer?.trim() || "（主持人没有回答）"}\n主持人没有回答的问题，按提问方写的默认假设处理。`;
}

/** 第 1 轮：独立陈述。参加过提问环节的，规则和议题已经发过，这里只补上主持人的回答。 */
export function buildOpeningMessage(ctx: BuildContext): BuiltMessage {
  const asked = !!ctx.qa?.asks.some((t) => t.seat === ctx.me.seat);
  const qa = qaBlock(ctx);
  const head = `${asked ? "" : `${intro(ctx)}\n\n`}${header(ctx, "独立陈述")}
请独立、完整地给出你对议题的观点、方案和理由（这一轮你看不到其他参会者的观点）。同时说明：哪些是你们 AI 能做到的，哪些需要主持人来测试或确认，哪些在现有条件下确实做不到。这一轮不需要写合并稿。
最后附上：
<会议状态>
无法继续：否 / 是（原因）
</会议状态>`;
  const material = [asked ? "" : `【议题】\n${ctx.topic}`, qa].filter(Boolean).join("\n\n");
  return { head, material, materialLabel: asked ? "提问环节的问题和主持人的回答" : "议题" };
}

function joinBlock(ctx: BuildContext): string {
  if (!ctx.joinHistory) return "";
  return `【你是中途加入的参会者，下面是之前的会议记录】\n【议题】\n${ctx.topic}\n\n${qaBlock(ctx)}\n\n${turnsBlock(ctx.joinHistory, ctx.participants)}${ctx.latestDraft ? `\n\n【目前最新的合并稿 v${ctx.latestDraft.version}】\n${ctx.latestDraft.content}` : ""}`;
}

/** 执笔：写新版本合并稿。 */
export function buildWriteMessage(ctx: BuildContext): BuiltMessage {
  const next = (ctx.latestDraft?.version ?? 0) + 1;
  const lines: string[] = [ctx.joinHistory ? intro(ctx) : "", header(ctx, "执笔")].filter(Boolean);
  if (!ctx.latestDraft) {
    lines.push(`任务：把大家第 1 轮的观点合并成【合并稿 v1】：一致的直接写进正文；你认为别人更好的观点写进正文并注明采纳；还有分歧的放进待议清单，写明各方的主张；只能由主持人做的测试或确认写进"需要主持人测试或确认的事"。`);
  } else {
    lines.push(`任务：在合并稿 v${ctx.latestDraft.version} 的基础上写出完整的【合并稿 v${next}】：处理其他参会者的审阅意见和待议清单（给出折中方案、采纳别人的主张，或说明必须保留分歧的理由），并改进正文。`);
  }
  if (ctx.hostAfterLatestDraft) lines.push("主持人有新意见，这一版必须在\"主持人要求\"栏逐条回应。");
  const hint = endingHint(ctx, true);
  if (hint) lines.push(hint);
  lines.push(`${REMINDER}\n合并稿用 <合并稿 v${next}>…</合并稿> 包起来；合并稿之外用几句话说明这次采纳了什么、改了什么。最后附上状态块。`);
  const material = [joinBlock(ctx), turnsBlock(ctx.unseen, ctx.participants)].filter(Boolean).join("\n\n");
  return { head: lines.join("\n\n"), material, materialLabel: "上一轮以来其他参会者的发言和主持人意见" };
}

/** 审阅最新版本。 */
export function buildReviewMessage(ctx: BuildContext): BuiltMessage {
  const v = ctx.latestDraft?.version ?? 0;
  const lines: string[] = [ctx.joinHistory ? intro(ctx) : "", header(ctx, "审阅")].filter(Boolean);
  lines.push(
    `任务：审阅合并稿 v${v}，不要重写整份合并稿。先写你认可和采纳的部分；需要修改的地方逐条给出具体修改建议，标明关键/次要。如果 v${v} 已经可以作为最终结论（AI 能解决的关键问题都解决了，次要问题可以写进备注${ctx.hostAfterLatestDraft ? "；但主持人有新意见还没在合并稿里回应，所以这一轮不能同意定稿" : ""}），请在状态块里写"是否同意定稿：是"。其他参会者也在同时审阅，你们互相看不到。`,
  );
  const hint = endingHint(ctx, false);
  if (hint) lines.push(hint);
  lines.push(`${REMINDER}\n最后附上状态块。`);
  const material = [joinBlock(ctx), turnsBlock(ctx.unseen, ctx.participants)].filter(Boolean).join("\n\n");
  return { head: lines.join("\n\n"), material, materialLabel: `执笔人写出的合并稿 v${v} 和其他新发言` };
}

/** 收尾：执笔人写最终稿（主持人要求定稿，或者连续没有进展、按求同存异收尾）。 */
export function buildFinalWriteMessage(ctx: BuildContext): BuiltMessage {
  const next = (ctx.latestDraft?.version ?? 0) + 1;
  const lines: string[] = [ctx.joinHistory ? intro(ctx) : "", header(ctx, "执笔（定稿）")].filter(Boolean);
  if (ctx.finalizeReason === "divergence") {
    lines.push(`【会议按"求同存异"收尾】系统检测到最近两轮都没有实际进展（没有解决待议项、关键问题没有减少）。请写出最终版【合并稿 v${next}】：共识写进正文；仍有的分歧留在待议清单，每条写清各方的主张、理由、需要什么证据或条件才能分出对错，以及建议主持人怎么选；只能由主持人做的测试或确认写进"需要主持人测试或确认的事"；主持人要求逐条回应。之后其他参会者只确认，不再修改。合并稿用 <合并稿 v${next}>…</合并稿> 包起来，最后附上状态块。`);
  } else {
    lines.push(`【主持人要求立即定稿】请写出最终版【合并稿 v${next}】：吸收目前所有共识；仍有分歧的关键问题留在待议清单并写明各方立场；只能由主持人做的测试或确认写进"需要主持人测试或确认的事"；次要问题放进备注；主持人要求逐条回应。合并稿用 <合并稿 v${next}>…</合并稿> 包起来，最后附上状态块。`);
  }
  const material = [joinBlock(ctx), turnsBlock(ctx.unseen, ctx.participants)].filter(Boolean).join("\n\n");
  return { head: lines.join("\n\n"), material, materialLabel: "上一轮以来其他参会者的发言和主持人意见" };
}

/** 收尾：其他参会者确认最终稿。 */
export function buildConfirmMessage(ctx: BuildContext): BuiltMessage {
  const v = ctx.latestDraft?.version ?? 0;
  const why = ctx.finalizeReason === "divergence" ? `会议按"求同存异"收尾，合并稿 v${v} 是最终版。` : `主持人已要求定稿，合并稿 v${v} 是最终版。`;
  const lines: string[] = [ctx.joinHistory ? intro(ctx) : "", header(ctx, "定稿确认")].filter(Boolean);
  lines.push(`${why}不要重写。请说明你是否同意把它作为会议结论；特别检查待议清单里写的你的立场是否准确——不准确的直接写出更正，你的确认意见会原样附在会议结论后面。最后附上状态块（"是否同意定稿：是/否"）。`);
  const material = [joinBlock(ctx), turnsBlock(ctx.unseen, ctx.participants)].filter(Boolean).join("\n\n");
  return { head: lines.join("\n\n"), material, materialLabel: `最终稿 v${v}` };
}

// ---- 下一步 -------------------------------------------------------------------

export type NextStep =
  | { type: "ask"; seats: Seat[] }
  | { type: "await_answers" }
  | { type: "opening"; seats: Seat[] }
  | { type: "write"; kind: "write" | "final_write"; seat: Seat; round: number; reason?: FinalizeReason }
  | { type: "parallel"; kind: "review" | "confirm"; seats: Seat[]; round: number; reason?: FinalizeReason }
  | { type: "end"; status: "max_rounds" };

export interface PlanInput {
  seats: Seat[];
  penMode: PenMode;
  penSeat: Seat;
  nextWriter: Seat | null;
  maxRounds: number;
  finalizeStage: "write" | "confirm" | null;
  finalizeReason: FinalizeReason | null;
  turns: TurnRecord[];
}

const aiTurns = (turns: TurnRecord[]) => turns.filter((t) => isSeat(t.seat));
const WORK = new Set<TurnKind>(["write", "final_write", "review", "confirm"]);

export function hostAfter(turns: TurnRecord[], turnId: number): boolean {
  return turns.some((t) => t.seat === "host" && t.kind === "host" && t.id > turnId);
}

/** 轮流执笔时下一位执笔人：按席位顺序排在上一位执笔人后面的那位。 */
export function nextInOrder(seats: Seat[], last: Seat): Seat {
  const i = seats.indexOf(last);
  return seats[(i + 1) % seats.length];
}

function lastWrite(turns: TurnRecord[]): TurnRecord | undefined {
  return aiTurns(turns).filter((t) => t.kind === "write" || t.kind === "final_write").at(-1);
}

function writerFor(input: PlanInput): Seat {
  if (input.nextWriter && input.seats.includes(input.nextWriter)) return input.nextWriter;
  if (input.penMode === "fixed") return input.seats.includes(input.penSeat) ? input.penSeat : input.seats[0];
  const lw = lastWrite(input.turns);
  if (!lw) return input.seats.includes(input.penSeat) ? input.penSeat : input.seats[0];
  return nextInOrder(input.seats, lw.seat as Seat);
}

export function planNext(input: PlanInput, latestDraft: DraftRecord | null): NextStep {
  const ai = aiTurns(input.turns);
  const openings = new Set(ai.filter((t) => t.kind === "opening").map((t) => t.seat));
  // 提问环节：还没有任何独立陈述时先提问；有人提了问题就等主持人回答（或跳过）。
  if (openings.size === 0) {
    const asked = new Set(ai.filter((t) => t.kind === "ask").map((t) => t.seat));
    const missingAsk = input.seats.filter((s) => !asked.has(s));
    if (missingAsk.length > 0) return { type: "ask", seats: missingAsk };
    const anyQuestion = ai.some((t) => t.kind === "ask" && hasQuestions(t.text));
    const answered = input.turns.some((t) => t.kind === "answer");
    if (anyQuestion && !answered) return { type: "await_answers" };
  }
  const missing = input.seats.filter((s) => !openings.has(s));
  if (missing.length > 0 && !ai.some((t) => WORK.has(t.kind))) return { type: "opening", seats: missing };

  const lw = lastWrite(input.turns);
  const reason = input.finalizeReason ?? "host";
  const maxRound = Math.max(1, ...ai.map((t) => t.round));

  // 写完之后，其他人这一轮还没审阅 / 确认完：接着做
  if (lw) {
    const kind = lw.kind === "final_write" ? "confirm" : "review";
    const done = new Set(ai.filter((t) => t.id > lw.id && t.kind === kind).map((t) => t.seat));
    const todo = input.seats.filter((s) => s !== lw.seat && !done.has(s));
    if (todo.length > 0 && (kind === "confirm" || input.finalizeStage !== "write")) {
      return { type: "parallel", kind, seats: todo, round: lw.round, reason: kind === "confirm" ? reason : undefined };
    }
  }
  const round = maxRound + 1;
  if (input.finalizeStage === "write") return { type: "write", kind: "final_write", seat: writerFor(input), round, reason };
  if (round > input.maxRounds) return { type: "end", status: "max_rounds" };
  return { type: "write", kind: "write", seat: writerFor(input), round };
}

// ---- 结束判定 -----------------------------------------------------------------

export type EndStatus = "consensus" | "finalized" | "divergent" | "insufficient" | "max_rounds";
export type Outcome = { type: EndStatus; draft: DraftRecord | null; note: string | null; dissent: TurnRecord[] } | null;

function reasonOf(t: TurnRecord, participants: BuildContext["participants"]): string {
  const p = isSeat(t.seat) ? participants[t.seat] : undefined;
  return `${p ? participantName(p) : t.seat}：${t.status?.cannotContinueReason ?? "（没写原因）"}`;
}

/** 第 1 轮所有人都说“无法继续”：按“条件不足”结束。 */
export function openingsInsufficient(turns: TurnRecord[], seats: Seat[], participants: BuildContext["participants"]): string | null {
  const openings = aiTurns(turns).filter((t) => t.kind === "opening");
  const all = seats.map((s) => openings.find((t) => t.seat === s));
  if (all.every((t) => t?.status?.cannotContinue === true)) {
    return `所有参会者都认为在现有条件下无法继续——${all.map((t) => reasonOf(t as TurnRecord, participants)).join("；")}`;
  }
  return null;
}

/**
 * 一轮（执笔 + 全部审阅，或者最终稿 + 全部确认）做完后判断会议是否结束。
 * 达成一致：最新合并稿之后，除执笔人以外的每一位都发过言、同意定稿、没有关键问题，主持人也没有新意见。
 */
export function evaluateRound(turns: TurnRecord[], seats: Seat[], latestDraft: DraftRecord | null, reason: FinalizeReason | null, participants: BuildContext["participants"]): Outcome {
  const ai = aiTurns(turns);
  const lw = lastWrite(turns);
  if (!lw) return null;
  const after = ai.filter((t) => t.id > lw.id);
  const responders = seats.filter((s) => s !== lw.seat).map((s) => after.filter((t) => t.seat === s).at(-1)).filter(Boolean) as TurnRecord[];
  const agreed = (t: TurnRecord) => t.status?.agree === true && (t.status.keyIssues === null || t.status.keyIssues === 0);
  const allAgree = !!latestDraft && latestDraft.turnId === lw.id && responders.length === seats.length - 1 && responders.every(agreed) && !hostAfter(turns, latestDraft.turnId);

  if (lw.kind === "final_write") {
    if (allAgree) return { type: "consensus", draft: latestDraft, note: null, dissent: [] };
    const dissent = responders.filter((t) => !agreed(t));
    const who = dissent.map((t) => SEAT_LABEL[t.seat as Seat]).join("、");
    if (reason === "divergence") return { type: "divergent", draft: latestDraft, note: who ? `${who}对最终稿有保留意见` : null, dissent };
    return { type: "finalized", draft: latestDraft, note: who ? `${who}对最终稿有保留意见` : null, dissent };
  }
  if (allAgree) return { type: "consensus", draft: latestDraft, note: null, dissent: [] };

  // 条件不足：这一轮所有人（执笔人 + 审阅人）都说“无法继续”
  const roundTurns = [lw, ...responders];
  if (roundTurns.length === seats.length && roundTurns.every((t) => t.status?.cannotContinue === true)) {
    return { type: "insufficient", draft: latestDraft, note: `所有参会者都认为在现有条件下无法继续——${roundTurns.map((t) => reasonOf(t, participants)).join("；")}`, dissent: [] };
  }
  return null;
}

/** 到了最大轮数还没一致：最后一轮审阅里不同意的意见，附在结论后面。 */
export function lastRoundDissent(turns: TurnRecord[]): TurnRecord[] {
  const lw = lastWrite(turns);
  if (!lw) return [];
  return aiTurns(turns).filter((t) => t.id > lw.id && (t.kind === "review" || t.kind === "confirm") && !(t.status?.agree === true && !t.status.keyIssues));
}

/** 一轮的“进展”：合并稿里多解决了待议项、所有审阅的关键问题总数变少、或者同意的人变多。 */
function roundStats(turns: TurnRecord[], writeTurn: TurnRecord, drafts: DraftRecord[]) {
  const ai = aiTurns(turns);
  const next = ai.find((t) => t.id > writeTurn.id && (t.kind === "write" || t.kind === "final_write"));
  const reviews = ai.filter((t) => t.id > writeTurn.id && (!next || t.id < next.id) && t.kind === "review");
  const draft = drafts.find((d) => d.turnId === writeTurn.id);
  const all = [writeTurn, ...reviews];
  return {
    resolved: draft ? resolvedCount(draft.content) : null,
    key: reviews.reduce((n, t) => n + (t.status?.keyIssues ?? 0), 0),
    agrees: reviews.filter((t) => t.status?.agree === true).length,
    noNewPoints: all.length > 0 && all.every((t) => t.status?.newPoints === false),
    complete: reviews.length > 0,
  };
}

/** 最近两轮都没有实际进展、也没人同意定稿、期间主持人没说话（第 4 轮之前不算）：该按“求同存异”收尾了。 */
export function isStagnant(turns: TurnRecord[], drafts: DraftRecord[]): boolean {
  const writes = aiTurns(turns).filter((t) => t.kind === "write");
  if (writes.length < 3) return false;
  const [w0, w1, w2] = writes.slice(-3);
  if (w2.round < 4) return false;
  if (turns.some((t) => t.seat === "host" && t.kind === "host" && t.id > w1.id)) return false;
  const s0 = roundStats(turns, w0, drafts), s1 = roundStats(turns, w1, drafts), s2 = roundStats(turns, w2, drafts);
  if (!s2.complete) return false;
  const progressed = (a: typeof s0, b: typeof s0) => {
    if (b.noNewPoints) return false;
    if (b.agrees > a.agrees) return true;
    if (a.resolved !== null && b.resolved !== null && b.resolved > a.resolved) return true;
    if (b.key < a.key) return true;
    return false;
  };
  if (s1.agrees > 0 || s2.agrees > 0) return false;
  return !progressed(s0, s1) && !progressed(s1, s2);
}

/** 预计每位参会者最多发言几次：提问 1 + 独立陈述 1 + 第 2 轮起每轮 1（执笔或审阅）。 */
export function estimateCalls(seatCount: number, maxRounds: number): { perSeat: number; total: number } {
  const perSeat = 2 + Math.max(0, maxRounds - 1);
  return { perSeat, total: perSeat * seatCount };
}
