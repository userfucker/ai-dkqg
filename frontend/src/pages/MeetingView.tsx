/**
 * 会议页：照 webui 的 AI 会议页面（frontend/src/components/meeting/MeetingView.tsx）。
 *  - 顶部：标题、会议计时、四个网站的状态；参会者、轮数、执笔方式、状态
 *  - 中间（3/5）：结束提示、版本按钮（提问 / v1…vN）、合并稿、复制；提问环节时在这里逐题回答
 *  - 右边（2/5）：讨论过程（发言卡片，从上到下按时间）、正在发言的实时文字
 *  - 底部：状态、继续 / 合并定稿 / 暂停 / 终止 / 更多，主持人输入框
 *  - 手机：底部切换“会议列表 / 合并稿 / 过程”
 */
import { useEffect, useRef, useState } from "react";
import { usePasteFold } from "../pasteFold.ts";
import { useNavigate } from "react-router-dom";
import { api, command as sendCommand } from "../api.ts";
import { Markdown } from "../components/ui.tsx";
import {
  copyText, draftSection, formatDuration, formatElapsed, formatFinishedAt, isEmptySection, KIND_TEXT, markdownToPlainText,
  ACTIVE_SITES, SEAT_LABEL, siteCls, siteName, statusInfo,
} from "../util.ts";
import type { BridgeStatus, Draft, MeetingDetail, Question, Seat, Turn } from "../types.ts";
import type { Notify } from "../App.tsx";

const KIND_LABEL: Record<string, string> = { ...KIND_TEXT, ask: "提问", answer: "回答提问", final_write: "执笔定稿" };
const STATUS_TEXT_CLS: Record<string, string> = {
  running: "text-blue-600", waiting: "text-blue-600", paused: "text-gray-600 dark:text-gray-400", interrupted: "text-orange-600", error: "text-red-600",
  consensus: "text-green-600", finalized: "text-gray-700 dark:text-gray-300", divergent: "text-indigo-600", insufficient: "text-amber-700", max_rounds: "text-gray-600", stopped: "text-gray-500",
};

function lineDiff(a: string, b: string): { type: "same" | "add" | "del"; text: string }[] {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { type: "same" | "add" | "del"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ type: "same", text: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: "del", text: x[i++] });
    else out.push({ type: "add", text: y[j++] });
  }
  while (i < n) out.push({ type: "del", text: x[i++] });
  while (j < m) out.push({ type: "add", text: y[j++] });
  return out;
}

export default function MeetingView({ detail: meeting, serverNow, notify, bridge }: { detail: MeetingDetail | null; serverNow: () => number; notify: Notify; bridge: BridgeStatus | null }) {
  const nav = useNavigate();
  const [selected, setSelected] = useState<number | "qa" | "topic" | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [input, setInput] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<"draft" | "flow">("draft");
  const [copied, setCopied] = useState<"md" | "plain" | null>(null);
  const [, setTick] = useState(0);
  const holdingRef = useRef(false);
  const timelineRef = useRef<HTMLElement>(null);
  const stickRef = useRef(true);

  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { setSelected(null); setShowDiff(false); setExpanded({}); setInput(""); holdingRef.current = false; }, [meeting?.id]);
  const liveLen = meeting?.live.reduce((n, l) => n + l.text.length, 0) ?? 0;
  useEffect(() => { const el = timelineRef.current; if (el && stickRef.current) el.scrollTop = el.scrollHeight; }, [meeting?.turns.length, liveLen, mobileTab]);
  // 换了一版（或提问页 / 新稿出来）时中间回到顶部
  const middleRef = useRef<HTMLElement>(null);
  useEffect(() => { if (middleRef.current) middleRef.current.scrollTop = 0; }, [meeting?.id, selected, meeting?.drafts.length, meeting?.pauseReason]);

  const inputChangeRef = useRef<(v: string) => void>(setInput);
  const hostFold = usePasteFold(input, (v) => inputChangeRef.current(v));

  if (!meeting) return <div className="p-6 text-sm text-gray-500">加载中……</div>;

  const now = serverNow();
  const ended = statusInfo(meeting.status).ended;
  const participant = (seat: Seat) => meeting.participants.find((p) => p.seat === seat);
  const seatName = (seat: Seat) => `${SEAT_LABEL[seat]}（${siteName(participant(seat)?.site)}）`;
  const seatColor = (seat: Seat) => siteCls(participant(seat)?.site);
  const drafts = meeting.drafts;
  const latest: Draft | null = drafts.at(-1) ?? null;
  const askTurns = meeting.turns.filter((t) => t.kind === "ask");
  const answerTurn = meeting.turns.find((t) => t.kind === "answer") ?? null;
  const questionsStage = meeting.status === "paused" && meeting.pauseReason === "questions";
  const hasQa = askTurns.some((t) => t.hasQuestions) && !!answerTurn;
  const shownDraft = typeof selected === "number" ? drafts.find((d) => d.version === selected) ?? latest : selected === "qa" || selected === "topic" ? null : latest;
  const showQa = selected === "qa" || (!latest && hasQa && selected === null);
  const showTopic = !showQa && !shownDraft;
  const previousDraft = shownDraft ? drafts.find((d) => d.version === shownDraft.version - 1) ?? null : null;
  const diff = showDiff && !showQa && previousDraft && shownDraft ? lineDiff(previousDraft.content, shownDraft.content) : null;
  const isConclusion = ended && shownDraft === latest && !!meeting.finalDraft;
  const shownContent = showTopic ? meeting.topic : isConclusion ? (meeting.finalDraft as string) : shownDraft?.content ?? "";
  const countdown = meeting.status === "waiting" && meeting.deadlineAt ? Math.max(0, Math.ceil((meeting.deadlineAt - now) / 1000)) : null;
  const timerRunning = meeting.status === "running" || meeting.status === "waiting";
  const elapsed = meeting.elapsedMs + (meeting.activeSince ? Math.max(0, now - meeting.activeSince) : 0);
  const canControl = !ended;
  const runningSeats = meeting.live.map((l) => l.seat);

  const command = async (action: string, payload: Record<string, unknown> = {}) => {
    try { await sendCommand(meeting.id, action, payload); return true; } catch (e) { notify((e as Error).message, true); return false; }
  };
  const onInputChange = (value: string) => {
    setInput(value);
    if (ended) return;
    if (value.trim() && !holdingRef.current) { holdingRef.current = true; if (meeting.status === "waiting") void command("hold"); }
    else if (!value.trim() && holdingRef.current) { holdingRef.current = false; if (meeting.status === "paused" && meeting.pauseReason === "typing") void command("release"); }
  };
  inputChangeRef.current = onInputChange;
  const sendHostInput = async () => {
    const text = hostFold.resolve(input).trim();
    if (!text) return;
    if (await command("message", { text })) { setInput(""); hostFold.reset(); holdingRef.current = false; }
  };

  // 结论里“需要主持人测试或确认的事”：结束后提醒一句
  const conclusion = meeting.finalDraft ?? latest?.content ?? "";
  const testSection = conclusion ? draftSection(conclusion, "需要主持人测试或确认的事") : null;
  const testHint = ended && !isEmptySection(testSection) ? <span className="mt-1 block text-sm font-normal">结论里有“需要主持人测试或确认的事”。测完后可以在“更多”里增加轮数，把测试结果发给大家，接着开会。</span> : null;
  // 讨论中途 AI 需要你回答的问题（它们先按假设继续）
  const hostQuestions = !ended && latest ? draftSection(latest.content, "需主持人回答") : null;

  const banner = (() => {
    const box = "rounded border px-4 py-2";
    if (meeting.status === "consensus") return <div className={`${box} border-green-300 bg-green-50 font-semibold text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300`}>✔ 已达成一致（第 {meeting.currentRound} 轮）{testHint}</div>;
    if (meeting.status === "finalized") return <div className={`${box} border-gray-300 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300`}>主持人要求定稿，会议结束。{meeting.endNote}{testHint}</div>;
    if (meeting.status === "divergent") return <div className={`${box} border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300`}>求同存异：最近两轮都没有实际进展，大家已确认各自的立场。共识在正文里，剩下的分歧在待议清单里（每条写了各方的理由和建议你怎么选）。{testHint}</div>;
    if (meeting.status === "insufficient") return <div className={`${box} border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300`}>条件不足：{meeting.endNote ?? "大家都认为在现有条件下无法继续"}。可以补充信息或缩小范围后，在“更多”里增加轮数接着开。</div>;
    if (meeting.status === "max_rounds") return <div className={`${box} border-gray-300 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400`}>已达到最大轮数（{meeting.maxRounds}），没有达成一致{meeting.endNote ? `（${meeting.endNote}）` : ""}。可以在“更多”里增加轮数接着开。{testHint}</div>;
    if (meeting.status === "stopped") return <div className={`${box} border-gray-300 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400`}>{meeting.endNote ?? "会议已终止"}</div>;
    return null;
  })();

  const turnItem = (t: Turn) => {
    if (t.seat === "system") return <div key={t.id} className="py-1 text-center text-sm text-gray-400">—— {t.text} ——</div>;
    if (t.seat === "host") {
      return (
        <div key={t.id} className="rounded border border-purple-200 bg-purple-50 px-3 py-2 dark:border-purple-900 dark:bg-purple-950">
          <p className="text-sm font-semibold text-purple-700 dark:text-purple-300">{t.kind === "answer" ? "主持人 · 回答提问" : "主持人"}</p>
          <p className="whitespace-pre-wrap text-base text-gray-900 dark:text-gray-100">{t.text}</p>
        </div>
      );
    }
    const seat = t.seat as Seat;
    const color = siteCls(t.site ?? participant(seat)?.site);
    const long = t.text.length > 400;
    const open = expanded[t.id] ?? !long;
    const st = t.status;
    return (
      <div key={t.id} className={`rounded border bg-white px-3 py-2 dark:bg-gray-900 ${color.border}`}>
        <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
          <span className={`font-semibold ${color.text}`}>{SEAT_LABEL[seat]}（{siteName(t.site ?? participant(seat)?.site)}）</span>
          <span className="text-gray-500">{t.kind === "ask" ? "提问环节" : `第 ${t.round} 轮`} · {KIND_LABEL[t.kind] ?? t.kind}{t.draftVersion ? ` · 写出 v${t.draftVersion}` : ""}</span>
          {st?.agree === true && <span className="rounded bg-green-100 px-1.5 text-green-700 dark:bg-green-950 dark:text-green-300">同意定稿</span>}
          {st && st.agree !== true && st.keyIssues !== null && <span className={st.keyIssues > 0 ? "rounded bg-orange-100 px-1.5 text-orange-700 dark:bg-orange-950 dark:text-orange-300" : "rounded bg-gray-100 px-1.5 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}>关键 {st.keyIssues}</span>}
          {st?.newPoints === false && <span className="rounded bg-gray-100 px-1.5 text-gray-600 dark:bg-gray-800 dark:text-gray-400">无新论点</span>}
          {st?.cannotContinue === true && <span className="rounded bg-amber-100 px-1.5 text-amber-800" title={st.cannotContinueReason ?? undefined}>认为无法继续</span>}
          {t.kind === "ask" && t.hasQuestions === false && <span className="rounded bg-gray-100 px-1.5 text-gray-600 dark:bg-gray-800 dark:text-gray-400">没有问题</span>}
          {t.attach && <span className="rounded bg-gray-100 px-1.5 text-gray-600 dark:bg-gray-800 dark:text-gray-400" title={`这一轮的材料用附件《${t.attach.name}》发送`}>附件 {t.attach.lines} 行</span>}
        </div>
        {t.durationMs !== null && <div className="mb-1 text-sm text-gray-400">{formatDuration(t.durationMs)} · {formatFinishedAt(t.createdAt)}{t.thinkingLen ? ` · 思考 ${t.thinkingLen} 字（已去掉）` : ""}</div>}
        <div className={open ? "" : "max-h-32 overflow-hidden"}>
          {t.kind === "ask" && t.questions && t.questions.length > 0 ? (
            <ol className="list-decimal space-y-1 pl-5 text-base text-gray-900 dark:text-gray-100">
              {t.questions.map((q) => (
                <li key={q.n}>{q.text}
                  {q.options.length > 0 && <span className="block text-sm text-gray-500">选项：{q.options.join(" ｜ ")}</span>}
                  {q.assumption && <span className="block text-sm text-gray-500">默认假设：{q.assumption}</span>}
                </li>
              ))}
            </ol>
          ) : <Markdown text={t.kind === "ask" ? t.text.replace(/<\/?提问>/g, "").trim() || "（没有问题）" : t.text} />}
        </div>
        {long && <button type="button" className="mt-1 text-sm text-blue-600 hover:underline" onClick={() => setExpanded((p) => ({ ...p, [t.id]: !open }))}>{open ? "收起" : "展开全文"}</button>}
      </div>
    );
  };

  // 正在进行的这一轮（current_round 要等这一轮有人发完言才更新）
  const shownRound = Math.max(meeting.currentRound, ...meeting.live.filter((l) => l.kind !== "ask").map((l) => l.round));
  const draftTitle = showQa ? "提问环节" : showTopic ? "议题" : !shownDraft ? "合并稿" : `${isConclusion ? "会议结论 · " : ""}合并稿 v${shownDraft.version}（${SEAT_LABEL[shownDraft.seat]}执笔）`;
  const btn = (on: boolean) => `rounded border px-2 text-sm ${on ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300" : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-gray-200 bg-white px-4 py-2 lg:px-6 lg:py-3 dark:border-gray-800 dark:bg-gray-900">
        <div className="grid grid-cols-[1fr_auto] items-start gap-3 lg:grid-cols-[1fr_auto_1fr] lg:gap-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">meeting</span>
            <h1 className="truncate text-base font-semibold text-gray-900 lg:text-lg dark:text-gray-100" title={meeting.title}>AI 会议：{meeting.title}</h1>
          </div>
          <div className="text-center" title="会议已进行的时间（暂停期间不计时）">
            <div className={`font-mono text-xl font-semibold tabular-nums lg:text-2xl ${timerRunning ? "text-blue-700 dark:text-blue-400" : ended ? "text-gray-500" : "text-gray-400"}`}>{formatElapsed(elapsed)}</div>
            <div className="text-xs text-gray-400">{timerRunning ? "会议计时" : ended ? "会议已结束" : "计时已暂停"}</div>
          </div>
          <div className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs lg:col-span-1 lg:justify-end">
            {!bridge?.connected ? <span className="text-red-600">插件未连接</span> : bridge.sites.map((s) => (
              <span key={s.site} className="flex items-center gap-1 text-gray-500" title={!s.open ? "没打开" : s.ready ? "就绪" : "加载中"}>
                <span className={`h-2 w-2 rounded-full ${!s.open ? "bg-gray-300 dark:bg-gray-600" : s.ready ? "bg-green-500" : "bg-yellow-400"}`} />{s.name}
              </span>
            ))}
          </div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {meeting.participants.map((p) => <span key={p.seat} className={`${seatColor(p.seat).text} ${p.dropped ? "line-through opacity-60" : ""}`} title={p.dropped ? "连续两次发言失败，已跳过" : ""}>{seatName(p.seat)}{p.dropped ? "（已跳过）" : ""}</span>)}
          <span className="text-gray-500">{shownRound === 0 ? `提问环节（共 ${meeting.maxRounds} 轮）` : `第 ${shownRound}/${meeting.maxRounds} 轮`} · {meeting.penMode === "rotate" ? "轮流执笔" : `固定执笔（${SEAT_LABEL[meeting.penSeat]}）`}</span>
          <span className={`font-semibold ${STATUS_TEXT_CLS[meeting.status] ?? ""}`}>{statusInfo(meeting.status, meeting.pauseReason).text}</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-3 lg:p-4">
        {/* 合并稿 */}
        <section ref={middleRef} className={`${mobileTab === "draft" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto lg:flex lg:flex-[3]`}>
          {banner}
          {questionsStage ? (
            <>
              <details className="rounded border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
                <summary className="cursor-pointer font-medium text-gray-700 dark:text-gray-300">议题（点击展开全文，共 {meeting.topic.length} 字）</summary>
                <p className="mt-2 whitespace-pre-wrap break-words text-gray-800 dark:text-gray-200">{meeting.topic}</p>
              </details>
              <QuestionsPanel asks={askTurns} seatName={seatName} onSubmit={(body) => command("answer", body)} />
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className={`font-semibold ${meeting.status === "consensus" && shownDraft === latest && !showQa ? "text-green-700 dark:text-green-400" : "text-gray-900 dark:text-gray-100"}`}>{draftTitle}</h2>
                <button type="button" className={btn(showTopic)} onClick={() => { setSelected("topic"); setShowDiff(false); }}>议题</button>
                {hasQa && <button type="button" className={btn(showQa)} onClick={() => { setSelected("qa"); setShowDiff(false); }}>提问</button>}
                {drafts.map((d) => <button key={d.version} type="button" className={btn(!showQa && shownDraft?.version === d.version)} onClick={() => setSelected(d === latest ? null : d.version)}>v{d.version}</button>)}
                {previousDraft && !showQa && (
                  <label className="ml-auto flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400"><input type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} />对比上一版</label>
                )}
              </div>
              <div className="rounded border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
                {showQa ? <QaPage asks={askTurns} answer={answerTurn} seatName={seatName} />
                  : showTopic ? (
                    <div>
                      <div className="mb-3 text-sm text-gray-500">会议风格：{meeting.promptName ?? "不用风格提示词"} · 共 {meeting.topic.length} 字 / {meeting.topic.split("\n").length} 行</div>
                      <p className="whitespace-pre-wrap break-words text-gray-800 dark:text-gray-200">{meeting.topic}</p>
                      {!latest && <p className="mt-4 text-sm text-gray-500">开始前各位 AI 会先向你提问（有问题时会议停下来等你回答）；第 1 轮各自独立陈述观点，第 2 轮起执笔人把大家的观点合并成合并稿，显示在这里。</p>}
                    </div>
                  ) : diff ? (
                    <pre className="whitespace-pre-wrap font-sans text-sm">
                      {diff.map((l, i) => <div key={i} className={l.type === "add" ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300" : l.type === "del" ? "bg-red-50 text-red-700 line-through dark:bg-red-950 dark:text-red-400" : "text-gray-700 dark:text-gray-300"}>{l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}{l.text}</div>)}
                    </pre>
                  ) : <Markdown text={shownContent} />}
              </div>
              {(shownDraft || showTopic) && (
                <div className="flex items-center gap-3 text-sm text-gray-400">
                  <button type="button" className="hover:text-gray-600 hover:underline" onClick={async () => { await copyText(shownContent); setCopied("md"); setTimeout(() => setCopied(null), 1500); }}>{copied === "md" ? "已复制 ✓" : "📋 复制"}</button>
                  <button type="button" className="hover:text-gray-600 hover:underline" title="复制去掉 Markdown 语法符号后的纯文字（所见即所得）" onClick={async () => { await copyText(markdownToPlainText(shownContent)); setCopied("plain"); setTimeout(() => setCopied(null), 1500); }}>{copied === "plain" ? "已复制 ✓" : "复制明文"}</button>
                  <a className="hover:text-gray-600 hover:underline" href={`/api/meetings/${meeting.id}/minutes`}>导出纪要</a>
                </div>
              )}
            </>
          )}
        </section>

        {/* 讨论过程 */}
        <section ref={timelineRef} onScroll={() => { const el = timelineRef.current; if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150; }}
          className={`${mobileTab === "flow" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto lg:flex lg:flex-[2]`}>
          {meeting.turns.map(turnItem)}
          {runningSeats.map((seat) => {
            const info = meeting.live.find((l) => l.seat === seat)!;
            const color = siteCls(info.site);
            const seconds = Math.max(0, Math.round((now - info.startedAt) / 1000));
            return (
              <div key={`live-${seat}`} className={`rounded border border-dashed bg-white px-3 py-2 dark:bg-gray-900 ${color.border}`}>
                <p className={`mb-1 text-sm font-semibold ${color.text}`}>
                  <span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
                  {seatName(seat)}正在{KIND_LABEL[info.kind] ?? "发言"}……（{seconds} 秒）{info.thinkingLen > 0 ? `　思考 ${info.thinkingLen} 字` : ""}{info.attach ? `　附件 ${info.attach.lines} 行` : ""}
                </p>
                {info.busy && <p className="mb-1 text-sm text-amber-600 dark:text-amber-400">网站显示服务火爆，正在排队，轮到后会自动回复（最多再等 30 分钟）</p>}
                <p className="max-h-60 overflow-y-auto whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{info.text.replace(/<会议状态>[\s\S]*$/, "") || "思考中……"}</p>
              </div>
            );
          })}
        </section>
      </div>

      {/* 主持人控制栏 */}
      <footer className="border-t border-gray-200 bg-white px-3 py-2 lg:px-6 lg:py-3 dark:border-gray-800 dark:bg-gray-900">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
          {meeting.status === "running" && (
            <span className="text-blue-600">
              {runningSeats.length > 1 ? `${runningSeats.map((s) => SEAT_LABEL[s]).join("、")}正在${KIND_LABEL[meeting.live[0]?.kind] ?? "发言"}……` : runningSeats[0] ? `${seatName(runningSeats[0])}正在发言……` : "正在进行……"}
              {meeting.pauseAfter && "（这一轮结束后暂停）"}
            </span>
          )}
          {countdown !== null && <span className="font-semibold text-blue-700 dark:text-blue-400">⏱ 等待主持人 {countdown} 秒（可以输入想法或指令）</span>}
          {meeting.status === "paused" && (
            <span className="text-gray-600 dark:text-gray-400">
              {meeting.pauseReason === "questions" ? "开会前 AI 有问题想问你。在上面回答（可以只答一部分），没回答的按 AI 写的默认假设处理。"
                : meeting.pauseReason === "typing" ? "倒计时已停住，写完点“发送”，或者清空输入框继续倒计时。"
                : meeting.pauseReason === "no_ext" ? `插件没连上中转站，连上后自动继续。${meeting.pauseDetail?.message ?? ""}`
                : meeting.pauseReason === "retry" ? `${meeting.pauseDetail?.message ?? "网站限流"}——${meeting.retryAt ? `${formatFinishedAt(meeting.retryAt).replace(/^.*日/, "").replace("完成", "")}自动重试` : "稍后自动重试"}，也可以点“继续”马上重试。`
                : meeting.pauseReason === "restart" ? "服务重启过，会议暂停了。点“继续”接着开。"
                : "会议已暂停，点“继续”接着开。"}
            </span>
          )}
          {meeting.status === "interrupted" && <span className="text-orange-600">服务重启中断了这一轮，点“继续”重新进行这一轮。</span>}
          {meeting.status === "error" && <span className="text-red-600">{meeting.error ?? "发言失败"}——可以“继续”重试，或者在“更多”里换个 AI。</span>}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {canControl && meeting.status !== "running" && !questionsStage && <button type="button" className="rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700" onClick={() => command("continue")}>继续</button>}
            {canControl && !questionsStage && (
              <button type="button" className="rounded border border-green-500 px-3 py-1.5 text-green-700 hover:bg-green-50 disabled:opacity-50 dark:text-green-400 dark:hover:bg-green-950" disabled={!!meeting.finalizeStage}
                onClick={() => { if (window.confirm("要求执笔人现在写出最终稿，其他人确认后会议结束。确定吗？")) void command("finalize"); }}>合并定稿</button>
            )}
            {canControl && meeting.status !== "paused" && <button type="button" className="rounded border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800" onClick={() => command("pause")}>暂停</button>}
            {canControl && <button type="button" className="rounded border border-red-300 px-3 py-1.5 text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950" onClick={() => { if (window.confirm("确定要终止这场会议吗？")) void command("stop"); }}>终止</button>}
            <div className="relative">
              <button type="button" className="rounded border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800" onClick={() => setMenuOpen((v) => !v)}>更多 ▾</button>
              {menuOpen && <MoreMenu meeting={meeting} ended={ended} seatName={seatName} command={command} notify={notify} onClose={() => setMenuOpen(false)} />}
            </div>
          </div>
        </div>
        {canControl && !questionsStage && !isEmptySection(hostQuestions) && (
          <details className="mb-2 rounded border border-purple-200 bg-purple-50 px-3 py-1.5 text-sm text-purple-800 dark:border-purple-900 dark:bg-purple-950 dark:text-purple-300">
            <summary className="cursor-pointer">AI 有问题想问你（它们先按自己的假设继续；你可以在下面回答）</summary>
            <div className="mt-1 text-gray-800 dark:text-gray-200"><Markdown text={hostQuestions ?? ""} /></div>
          </details>
        )}
        {canControl && !questionsStage && (
          <div className="flex gap-2">
            <textarea className="min-h-[44px] flex-1 rounded border border-gray-300 bg-white px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-950" rows={2} value={input}
              placeholder="输入你的想法或指令，所有 AI 都会看到，并在合并稿里逐条回应（Ctrl+Enter 发送）"
              onChange={(e) => onInputChange(e.target.value)} onPaste={hostFold.onPaste}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void sendHostInput(); } }} />
            <button type="button" className="self-end rounded bg-purple-600 px-4 py-2 text-white hover:bg-purple-700 disabled:opacity-50" onClick={sendHostInput} disabled={!input.trim()}>发送</button>
          </div>
        )}
        {canControl && !questionsStage && hostFold.folded > 0 && (
          <p className="mt-1 text-xs text-gray-500">已折叠 {hostFold.folded} 段粘贴内容，发送时会还原成原文。<button type="button" className="text-blue-600 hover:underline" onClick={() => onInputChange(hostFold.resolve(input))}>展开</button></p>
        )}
      </footer>

      {/* 手机：底部切换 */}
      <nav className="flex border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] text-sm lg:hidden dark:border-gray-800 dark:bg-gray-900">
        <button className="flex-1 py-2.5 text-gray-500" onClick={() => nav("/")}>会议列表</button>
        <button className={`flex-1 py-2.5 ${mobileTab === "draft" ? "font-semibold text-blue-600" : "text-gray-500"}`} onClick={() => setMobileTab("draft")}>{questionsStage ? "回答提问" : `合并稿${latest ? ` v${latest.version}` : ""}`}</button>
        <button className={`flex-1 py-2.5 ${mobileTab === "flow" ? "font-semibold text-blue-600" : "text-gray-500"}`} onClick={() => { stickRef.current = true; setMobileTab("flow"); }}>过程{runningSeats.length ? " ●" : ""}</button>
      </nav>
    </div>
  );
}

/** 提问环节：所有 AI 的问题逐条显示，选项点一下就填进答案，也可以自己写；最后可以补充一段说明。 */
function QuestionsPanel({ asks, seatName, onSubmit }: { asks: Turn[]; seatName: (s: Seat) => string; onSubmit: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [free, setFree] = useState("");
  const [busy, setBusy] = useState(false);
  const freeFold = usePasteFold(free, setFree);
  const extra = freeFold.resolve(free).trim();
  const withQuestions = asks.filter((t) => t.hasQuestions !== false);
  const set = (key: string, value: string) => setAnswers((p) => ({ ...p, [key]: value }));
  const composed = (() => {
    const lines: string[] = [];
    for (const t of withQuestions) for (const q of t.questions ?? []) { const v = answers[`${t.seat}-${q.n}`]?.trim(); if (v) lines.push(`${seatName(t.seat as Seat)}的问题 ${q.n}（${q.text}）：${v}`); }
    if (extra) lines.push(`补充说明：${extra}`);
    return lines.join("\n");
  })();
  const submit = async (body: Record<string, unknown>) => { setBusy(true); await onSubmit(body); setBusy(false); };
  const question = (seat: Seat, q: Question) => {
    const key = `${seat}-${q.n}`;
    return (
      <div key={key} className="rounded border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900">
        <p className="font-medium text-gray-900 dark:text-gray-100">{q.n}. {q.text}</p>
        {q.why && <p className="text-sm text-gray-500">为什么问：{q.why}</p>}
        {q.options.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {q.options.map((o) => <button key={o} type="button" className={`rounded border px-2 py-0.5 text-sm ${answers[key] === o ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300" : "border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"}`} onClick={() => set(key, answers[key] === o ? "" : o)}>{o}</button>)}
          </div>
        )}
        <input className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-950" value={answers[key] ?? ""} placeholder={q.assumption ? `不回答就按：${q.assumption}` : "你的回答（可以不填）"} onChange={(e) => set(key, e.target.value)} />
      </div>
    );
  };
  return (
    <div className="space-y-3 rounded border border-purple-200 bg-purple-50/50 p-3 dark:border-purple-900 dark:bg-purple-950/30">
      <h2 className="font-semibold text-purple-700 dark:text-purple-300">开会前 AI 有问题想问你</h2>
      {withQuestions.map((t) => (
        <div key={t.id}>
          <p className={`mb-1 text-sm font-semibold ${siteCls(t.site).text}`}>{seatName(t.seat as Seat)}的提问</p>
          {t.questions && t.questions.length > 0 ? <div className="space-y-1">{t.questions.map((q) => question(t.seat as Seat, q))}</div>
            : <div className="rounded border border-gray-200 bg-white p-2 text-sm dark:border-gray-700 dark:bg-gray-900"><Markdown text={t.text.replace(/<\/?提问>/g, "")} /></div>}
        </div>
      ))}
      {asks.filter((t) => t.hasQuestions === false).length > 0 && <p className="text-sm text-gray-500">{asks.filter((t) => t.hasQuestions === false).map((t) => seatName(t.seat as Seat)).join("、")}没有问题。</p>}
      <textarea className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-base dark:border-gray-600 dark:bg-gray-950" rows={2} value={free} placeholder="补充说明（可选）：其他背景、要求，或者回答上面没拆开的问题" onChange={(e) => setFree(e.target.value)} onPaste={freeFold.onPaste} />
      {freeFold.folded > 0 && <p className="-mt-2 text-xs text-gray-500">已折叠 {freeFold.folded} 段粘贴内容，提交时会还原成原文。<button type="button" className="text-blue-600 hover:underline" onClick={() => setFree(extra)}>展开</button></p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="rounded border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300" disabled={busy} onClick={() => submit({ text: "" })}>跳过提问，按默认假设开始</button>
        <button type="button" className="rounded bg-purple-600 px-4 py-1.5 text-white hover:bg-purple-700 disabled:opacity-50" disabled={busy || !composed.trim()} onClick={() => submit({ text: composed, answers, extra })}>提交回答，开始讨论</button>
      </div>
    </div>
  );
}

/** “提问”那一页（排在 v1 前面）：每个 AI 问了什么、你选了什么 / 写了什么。只能看。 */
function QaPage({ asks, answer, seatName }: { asks: Turn[]; answer: Turn | null; seatName: (s: Seat) => string }) {
  const meta = answer?.meta ?? null;
  const answers = meta?.answers ?? {};
  if (meta?.skipped || (answer && !meta && /跳过了提问/.test(answer.text))) {
    return <div className="space-y-3"><p className="text-gray-600 dark:text-gray-400">你跳过了提问，各位 AI 按自己写的默认假设进行。</p><AskList asks={asks} answers={{}} seatName={seatName} /></div>;
  }
  if (answer && !meta) return <div className="space-y-3"><AskList asks={asks} answers={{}} seatName={seatName} /><p className="font-medium">你的回答</p><p className="whitespace-pre-wrap">{answer.text}</p></div>;
  return (
    <div className="space-y-4">
      <AskList asks={asks} answers={answers} seatName={seatName} />
      {meta?.extra && <div><p className="mb-1 font-medium text-purple-700 dark:text-purple-300">补充说明</p><p className="whitespace-pre-wrap text-gray-800 dark:text-gray-200">{meta.extra}</p></div>}
    </div>
  );
}

function AskList({ asks, answers, seatName }: { asks: Turn[]; answers: Record<string, string>; seatName: (s: Seat) => string }) {
  return (
    <>
      {asks.map((t) => (
        <div key={t.id}>
          <p className={`mb-1 font-semibold ${siteCls(t.site).text}`}>{seatName(t.seat as Seat)}的提问{t.hasQuestions === false ? "：没有问题" : ""}</p>
          {t.questions && t.questions.length > 0 ? (
            <ol className="space-y-2">
              {t.questions.map((q) => {
                const a = answers[`${t.seat}-${q.n}`];
                return (
                  <li key={q.n} className="rounded border border-gray-200 p-2 dark:border-gray-700">
                    <p className="font-medium">{q.n}. {q.text}</p>
                    {q.why && <p className="text-sm text-gray-500">为什么问：{q.why}</p>}
                    {q.options.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{q.options.map((o) => <span key={o} className={`rounded border px-2 py-0.5 text-sm ${a === o ? "border-blue-500 bg-blue-50 font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300" : "border-gray-200 text-gray-400 dark:border-gray-700"}`}>{a === o ? "✓ " : ""}{o}</span>)}</div>}
                    <p className="mt-1 text-sm">{a ? (q.options.includes(a) ? null : <span>你的回答：<b>{a}</b></span>) : <span className="text-gray-500">没回答，按默认假设：{q.assumption || "（没写）"}</span>}</p>
                  </li>
                );
              })}
            </ol>
          ) : t.hasQuestions ? <Markdown text={t.text.replace(/<\/?提问>/g, "")} /> : null}
        </div>
      ))}
    </>
  );
}

/** “更多”菜单：执笔、轮数、等待时间、换 AI、打开某个 AI 的对话、导出纪要。（删除会议：在左边会议列表上右键 / 手机长按） */
function MoreMenu({ meeting, ended, seatName, command, notify, onClose }: {
  meeting: MeetingDetail; ended: boolean; seatName: (s: Seat) => string; command: (a: string, p?: Record<string, unknown>) => Promise<boolean>; notify: Notify; onClose: () => void;
}) {
  const seats = meeting.participants.filter((p) => !p.dropped).map((p) => p.seat);
  const dropped = meeting.participants.filter((p) => p.dropped);
  const free = ACTIVE_SITES.filter((s) => !meeting.participants.some((p) => p.site === s.id));
  const [rounds, setRounds] = useState(ended ? meeting.maxRounds + 2 : meeting.maxRounds);
  const [swapSeat, setSwapSeat] = useState<Seat>(dropped[0]?.seat ?? seats[0]);
  const [swapSite, setSwapSite] = useState<string>(free[0]?.id ?? "");
  const item = "block w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800";
  const small = (on: boolean) => `rounded border px-2 py-0.5 text-xs ${on ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300" : "border-gray-300 dark:border-gray-600"}`;
  const openChat = async (site: string, chatId: string) => { try { await api("/api/chats/open", { body: { site, chatId } }); notify("已在电脑的浏览器里打开"); } catch (e) { notify((e as Error).message, true); } };
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute bottom-full right-0 z-20 mb-1 max-h-[70vh] w-80 overflow-y-auto rounded border border-gray-200 bg-white py-1 text-left shadow-lg dark:border-gray-700 dark:bg-gray-900">
        {!ended && (
          <>
            <div className="px-3 py-1.5 text-sm">
              <p className="mb-1 text-gray-500">{meeting.penMode === "fixed" ? "执笔人" : "指定下一位执笔人"}</p>
              <div className="flex flex-wrap gap-1">{seats.map((s) => <button key={s} className={small((meeting.penMode === "fixed" ? meeting.penSeat : meeting.nextWriter) === s)} onClick={() => command("set_pen", { seat: s })}>{seatName(s)}</button>)}</div>
            </div>
            <div className="px-3 py-1.5 text-sm">
              <p className="mb-1 text-gray-500">执笔方式</p>
              <div className="flex gap-1">
                <button className={small(meeting.penMode === "rotate")} onClick={() => command("set_pen_mode", { penMode: "rotate", penSeat: meeting.nextWriter ?? meeting.penSeat })}>轮流执笔</button>
                <button className={small(meeting.penMode === "fixed")} onClick={() => command("set_pen_mode", { penMode: "fixed", penSeat: meeting.penSeat })}>固定执笔</button>
              </div>
            </div>
            <div className="px-3 py-1.5 text-sm">
              <p className="mb-1 text-gray-500">每轮结束后等主持人</p>
              <div className="flex gap-1">{([[0, "不等"], [30, "30 秒"], [60, "60 秒"], [-1, "一直等"]] as [number, string][]).map(([v, l]) => <button key={v} className={small(meeting.waitSeconds === v)} onClick={() => command("set_wait", { waitSeconds: v })}>{l}</button>)}</div>
            </div>
          </>
        )}
        <div className="px-3 py-1.5 text-sm">
          <p className="mb-1 text-gray-500">{ended ? "增加轮数接着开" : "调整最大轮数"}（现在 {meeting.maxRounds}）</p>
          <div className="flex gap-1">
            <input type="number" min={2} max={30} className="w-16 rounded border border-gray-300 bg-white px-2 py-0.5 dark:border-gray-600 dark:bg-gray-950" value={rounds} onChange={(e) => setRounds(Number(e.target.value))} />
            <button className={small(false)} onClick={async () => { if (await command("set_max_rounds", { maxRounds: rounds })) onClose(); }}>{ended ? "重新开启" : "改"}</button>
          </div>
        </div>
        {!ended && dropped.length > 0 && (
          <div className="px-3 py-1.5 text-sm">
            <p className="mb-1 text-gray-500">被跳过的 AI（连续两次发言失败）</p>
            <div className="flex flex-wrap gap-1">{dropped.map((p) => <button key={p.seat} className={small(false)} onClick={async () => { if (await command("set_site", { seat: p.seat, site: p.site })) onClose(); }}>让{seatName(p.seat)}重新参会</button>)}</div>
          </div>
        )}
        {!ended && free.length > 0 && (
          <div className="px-3 py-1.5 text-sm">
            <p className="mb-1 text-gray-500">给某个席位换 AI（新对话，会把之前的记录发给它）</p>
            <div className="flex flex-wrap items-center gap-1">
              <select className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-950" value={swapSeat} onChange={(e) => setSwapSeat(e.target.value as Seat)}>{meeting.participants.map((p) => p.seat).map((s) => <option key={s} value={s}>{seatName(s)}</option>)}</select>
              换成
              <select className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-950" value={swapSite} onChange={(e) => setSwapSite(e.target.value)}>{free.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              <button className={small(false)} onClick={() => command("set_site", { seat: swapSeat, site: swapSite })}>换</button>
            </div>
          </div>
        )}
        <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
        {meeting.participants.filter((p) => p.chatId).map((p) => <button key={p.seat} className={item} onClick={() => openChat(p.site, p.chatId as string)}>在浏览器里打开{seatName(p.seat)}的对话</button>)}
        <a className={item} href={`/api/meetings/${meeting.id}/minutes`}>导出会议纪要（Markdown）</a>
      </div>
    </>
  );
}
