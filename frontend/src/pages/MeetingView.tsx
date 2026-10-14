import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, command } from "../api.ts";
import { Button, Card, inputCls, Markdown, SeatChip, SiteDot, StatusBadge } from "../components/ui.tsx";
import { bj, KIND_TEXT, SEAT_LABEL, secs, siteName, SITES, statusInfo } from "../util.ts";
import type { BridgeStatus, Draft, MeetingDetail, Question, Seat, Turn } from "../types.ts";
import type { Notify } from "../App.tsx";

type Tab = "flow" | "draft" | "topic";

export default function MeetingView({ detail: d, serverNow, notify, bridge }: { detail: MeetingDetail | null; serverNow: () => number; notify: Notify; bridge: BridgeStatus | null }) {
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>("flow");
  if (!d) return <div className="p-6 text-sm text-zinc-500">加载中…</div>;
  const st = statusInfo(d.status, d.pauseReason);
  const run = async (action: string, payload: Record<string, unknown> = {}) => {
    try { await command(d.id, action, payload); return true; } catch (e) { notify((e as Error).message, true); return false; }
  };
  const nextWriter = d.nextWriter ?? (d.penMode === "fixed" ? d.penSeat : null);
  return (
    <div className="flex h-full flex-col">
      {/* 头部 */}
      <div className="border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2">
          <Button kind="ghost" className="-ml-1 px-2 md:hidden" onClick={() => nav("/")}>‹</Button>
          <h1 className="min-w-0 flex-1 truncate font-semibold" title={d.title}>{d.title}</h1>
          <StatusBadge status={d.status} pauseReason={d.pauseReason} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {d.participants.map((p) => <SeatChip key={p.seat} seat={p.seat} site={p.site} active={d.live.some((l) => l.seat === p.seat)} />)}
          <span className="text-xs text-zinc-500">
            {d.currentRound > 0 ? `第 ${d.currentRound}/${d.maxRounds} 轮` : "提问环节"} · {d.penMode === "fixed" ? `固定执笔（${SEAT_LABEL[d.penSeat]}）` : "轮流执笔"}
            {nextWriter && d.penMode === "rotate" ? ` · 下一轮由${SEAT_LABEL[nextWriter]}执笔` : ""}
          </span>
        </div>
      </div>
      {st.ended && (
        <div className={`px-4 py-2 text-sm ${d.status === "consensus" ? "bg-green-600 text-white" : d.status === "finalized" ? "bg-emerald-600 text-white" : d.status === "divergent" || d.status === "insufficient" ? "bg-orange-500 text-white" : "bg-zinc-600 text-white"}`}>
          <b>{d.status === "consensus" ? "✔ 达成一致" : st.text}</b>{d.endNote ? `：${d.endNote}` : ""}{d.finalDraft ? "　结论见“合并稿”" : ""}
        </div>
      )}
      {/* 手机：分页 */}
      <div className="flex border-b border-zinc-200 text-sm lg:hidden dark:border-zinc-800">
        {(["flow", "draft", "topic"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 py-2 ${tab === t ? "border-b-2 border-zinc-900 font-medium dark:border-zinc-100" : "text-zinc-500"}`}>
            {t === "flow" ? "过程" : t === "draft" ? `合并稿${d.drafts.length ? ` v${d.drafts.length}` : ""}` : "议题"}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className={`${tab === "flow" ? "flex" : "hidden"} min-w-0 flex-1 flex-col lg:flex`}>
          <Timeline d={d} />
        </div>
        <div className={`${tab === "flow" ? "hidden" : "flex"} min-w-0 flex-1 flex-col border-zinc-200 lg:flex lg:max-w-[46%] lg:border-l dark:border-zinc-800`}>
          <div className="hidden border-b border-zinc-200 text-sm lg:flex dark:border-zinc-800">
            {(["draft", "topic"] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`flex-1 py-2 ${(tab === t || (tab === "flow" && t === "draft")) ? "border-b-2 border-zinc-900 font-medium dark:border-zinc-100" : "text-zinc-500"}`}>{t === "draft" ? "合并稿" : "议题"}</button>
            ))}
          </div>
          {tab === "topic" ? <TopicPanel d={d} /> : <DraftPanel d={d} />}
        </div>
      </div>
      <ControlBar d={d} run={run} serverNow={serverNow} notify={notify} bridge={bridge} />
    </div>
  );
}

// ---- 过程（时间线）

function Timeline({ d }: { d: MeetingDetail }) {
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const liveLen = d.live.reduce((n, l) => n + l.text.length, 0);
  useEffect(() => { if (stick.current) end.current?.scrollIntoView({ block: "end" }); }, [d.turns.length, liveLen, d.status]);
  const onScroll = () => { const el = box.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; };
  const askTurns = d.turns.filter((t) => t.kind === "ask");
  let lastRound = -1;
  return (
    <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      {d.turns.map((t) => {
        const head = t.round !== lastRound && t.seat !== "system" ? (lastRound = t.round, <RoundHead key={`r${t.id}`} round={t.round} max={d.maxRounds} />) : null;
        return <div key={t.id}>{head}<TurnCard t={t} d={d} /></div>;
      })}
      {d.pauseReason === "questions" && d.status === "paused" && <QuestionsPanel d={d} asks={askTurns} />}
      {d.live.map((l) => (
        <Card key={l.seat} className="border-blue-300 p-3 dark:border-blue-800">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <SeatChip seat={l.seat} site={l.site} active />
            <span>{l.round === 0 ? "提问环节" : `第 ${l.round} 轮`} · {KIND_TEXT[l.kind]}</span>
            <span className="animate-pulse text-blue-600">● 正在发言</span>
            {l.thinkingLen > 0 && <span>思考 {l.thinkingLen} 字</span>}
            {l.attach && <span>📎 {l.attach.name}</span>}
          </div>
          {l.text ? <Markdown text={l.text.replace(/<会议状态>[\s\S]*$/, "")} /> : <p className="text-sm text-zinc-400">等待回复…</p>}
        </Card>
      ))}
      <div ref={end} className="h-2" />
    </div>
  );
}

function RoundHead({ round, max }: { round: number; max: number }) {
  return <div className="my-2 flex items-center gap-2 text-xs text-zinc-400"><div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />{round === 0 ? "提问环节" : `第 ${round}/${max} 轮`}<div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" /></div>;
}

function Tags({ t }: { t: Turn }) {
  const s = t.status;
  const tags: [string, string][] = [];
  if (s?.agree === true) tags.push(["同意定稿", "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"]);
  if (s?.agree === false && t.kind !== "opening") tags.push(["不同意定稿", "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"]);
  if (s?.keyIssues) tags.push([`关键 ${s.keyIssues}`, "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300"]);
  if (s?.minorIssues) tags.push([`次要 ${s.minorIssues}`, "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"]);
  if (s?.cannotContinue) tags.push(["无法继续", "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"]);
  if (t.draftVersion) tags.push([`合并稿 v${t.draftVersion}`, "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"]);
  if (t.kind === "ask") tags.push(t.hasQuestions ? [`提了 ${t.questions?.length || ""} 个问题`, "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"] : ["没有问题", "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"]);
  return <>{tags.map(([x, c]) => <span key={x} className={`rounded px-1.5 py-0.5 text-[11px] ${c}`}>{x}</span>)}</>;
}

function TurnCard({ t, d }: { t: Turn; d: MeetingDetail }) {
  const [open, setOpen] = useState(false);
  if (t.seat === "system") return <p className="text-center text-xs text-zinc-500">— {t.text} —</p>;
  if (t.seat === "host") {
    return (
      <div className="ml-auto max-w-[90%] rounded-xl bg-blue-600 px-3 py-2 text-sm text-white">
        <div className="mb-0.5 text-[11px] opacity-80">{t.kind === "answer" ? "主持人回答提问" : "主持人"} · {bj(t.createdAt)}</div>
        <div className="whitespace-pre-wrap break-words">{t.text}</div>
      </div>
    );
  }
  const p = d.participants.find((x) => x.seat === t.seat);
  const long = t.text.split("\n").length > 14 || t.text.length > 900;
  const shown = !long || open ? t.text : t.text.split("\n").slice(0, 10).join("\n").slice(0, 700) + "\n\n…";
  return (
    <Card className="p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
        <SeatChip seat={t.seat as Seat} site={t.site ?? p?.site ?? ""} />
        <span>{KIND_TEXT[t.kind] ?? t.kind}</span>
        <Tags t={t} />
        <span className="ml-auto">{secs(t.durationMs)}{t.thinkingLen ? ` · 思考 ${t.thinkingLen} 字` : ""}</span>
      </div>
      {t.attach && <p className="mb-1 text-xs text-zinc-500">📎 这一轮的材料用附件《{t.attach.name}》发送（{t.attach.lines} 行）</p>}
      {t.kind === "ask" && t.questions?.length ? (
        <ol className="space-y-1.5 text-sm">{t.questions.map((q) => <li key={q.n}><b>问题 {q.n}：</b>{q.text}{q.options.length > 0 && <div className="text-xs text-zinc-500">选项：{q.options.join("｜")}</div>}{q.assumption && <div className="text-xs text-zinc-500">默认假设：{q.assumption}</div>}</li>)}</ol>
      ) : <Markdown text={shown} />}
      {long && t.kind !== "ask" && <button onClick={() => setOpen(!open)} className="mt-1 text-xs text-blue-600">{open ? "收起" : "展开全文"}</button>}
      {t.status?.cannotContinueReason && <p className="mt-1 text-xs text-red-600">无法继续的原因：{t.status.cannotContinueReason}</p>}
    </Card>
  );
}

// ---- 提问环节：逐题回答

function QuestionsPanel({ d, asks }: { d: MeetingDetail; asks: Turn[] }) {
  const [ans, setAns] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const withQ = asks.filter((t) => t.hasQuestions);
  const key = (t: Turn, q: Question) => `${t.seat}-${q.n}`;
  const submit = async (skip: boolean) => {
    setBusy(true);
    let text = "";
    if (!skip) {
      const parts: string[] = [];
      for (const t of withQ) {
        const label = `${SEAT_LABEL[t.seat as Seat]}（${siteName(t.site)}）`;
        if (t.questions?.length) {
          for (const q of t.questions) { const a = ans[key(t, q)]?.trim(); if (a) parts.push(`${label}的问题 ${q.n}（${q.text}）：${a}`); }
        } else if (ans[`${t.seat}-all`]?.trim()) parts.push(`回答${label}：${ans[`${t.seat}-all`].trim()}`);
      }
      if (extra.trim()) parts.push(`补充说明：${extra.trim()}`);
      text = parts.join("\n");
    }
    try { await command(d.id, "answer", { text }); } catch (e) { alert((e as Error).message); }
    setBusy(false);
  };
  return (
    <Card className="border-violet-300 p-3 dark:border-violet-800">
      <h3 className="mb-2 font-semibold text-violet-700 dark:text-violet-300">AI 有问题要问你</h3>
      <p className="mb-3 text-xs text-zinc-500">逐题回答（可以点选项），没回答的按 AI 写的默认假设处理。也可以直接跳过。</p>
      <div className="space-y-4">
        {withQ.map((t) => (
          <div key={t.id}>
            <div className="mb-1.5"><SeatChip seat={t.seat as Seat} site={t.site ?? ""} /></div>
            {t.questions?.length ? t.questions.map((q) => (
              <div key={q.n} className="mb-3 rounded-lg bg-zinc-50 p-2.5 text-sm dark:bg-zinc-800/50">
                <div className="font-medium">问题 {q.n}：{q.text}</div>
                {q.why && <div className="text-xs text-zinc-500">为什么问：{q.why}</div>}
                {q.options.length > 0 && <div className="my-1.5 flex flex-wrap gap-1.5">{q.options.map((o) => <button key={o} onClick={() => setAns((a) => ({ ...a, [key(t, q)]: o }))} className={`rounded-full border px-2.5 py-1 text-xs ${ans[key(t, q)] === o ? "border-violet-600 bg-violet-600 text-white" : "border-zinc-300 dark:border-zinc-600"}`}>{o}</button>)}</div>}
                <input className={inputCls} placeholder={q.assumption ? `不填就按默认假设：${q.assumption}` : "你的回答"} value={ans[key(t, q)] ?? ""} onChange={(e) => setAns((a) => ({ ...a, [key(t, q)]: e.target.value }))} />
              </div>
            )) : (
              <>
                <Markdown text={t.text} className="mb-2" />
                <textarea className={inputCls} placeholder="你的回答" value={ans[`${t.seat}-all`] ?? ""} onChange={(e) => setAns((a) => ({ ...a, [`${t.seat}-all`]: e.target.value }))} />
              </>
            )}
          </div>
        ))}
        <textarea className={inputCls} placeholder="补充说明（可选，所有 AI 都会看到）" value={extra} onChange={(e) => setExtra(e.target.value)} />
        <div className="flex gap-2">
          <Button kind="primary" className="flex-1" disabled={busy} onClick={() => submit(false)}>提交回答，开始第 1 轮</Button>
          <Button disabled={busy} onClick={() => submit(true)}>跳过</Button>
        </div>
      </div>
    </Card>
  );
}

// ---- 合并稿

function lineDiff(a: string, b: string): { t: "same" | "add" | "del"; s: string }[] {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: "same" | "add" | "del"; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ t: "same", s: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "del", s: x[i++] });
    else out.push({ t: "add", s: y[j++] });
  }
  while (i < n) out.push({ t: "del", s: x[i++] });
  while (j < m) out.push({ t: "add", s: y[j++] });
  return out;
}

function DraftPanel({ d }: { d: MeetingDetail }) {
  const [ver, setVer] = useState<number | "final" | null>(null);
  const [diff, setDiff] = useState(false);
  const ended = statusInfo(d.status).ended;
  const cur = ver ?? (ended && d.finalDraft ? "final" : d.drafts.length || null);
  const draft: Draft | undefined = typeof cur === "number" ? d.drafts.find((x) => x.version === cur) : undefined;
  const prev = draft ? d.drafts.find((x) => x.version === draft.version - 1) : undefined;
  const rows = useMemo(() => (diff && draft && prev ? lineDiff(prev.content, draft.content) : null), [diff, draft, prev]);
  if (!d.drafts.length && !d.finalDraft) return <div className="p-6 text-sm text-zinc-500">还没有合并稿。第 2 轮由执笔人把大家的观点合并成合并稿 v1。</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 p-2 dark:border-zinc-800">
        {d.finalDraft && ended && <Button kind={cur === "final" ? "primary" : "ghost"} className="min-h-7 px-2 text-xs" onClick={() => setVer("final")}>会议结论</Button>}
        {d.drafts.map((x) => <Button key={x.version} kind={cur === x.version ? "primary" : "ghost"} className="min-h-7 px-2 text-xs" onClick={() => setVer(x.version)}>v{x.version}</Button>)}
        {draft && prev && <label className="ml-auto flex items-center gap-1 text-xs text-zinc-500"><input type="checkbox" checked={diff} onChange={(e) => setDiff(e.target.checked)} />和 v{prev.version} 对比</label>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {draft && <p className="mb-2 text-xs text-zinc-500">合并稿 v{draft.version} · {SEAT_LABEL[draft.seat]}（{siteName(d.participants.find((p) => p.seat === draft.seat)?.site)}）执笔</p>}
        {cur === "final" && d.finalDraft ? <Markdown text={d.finalDraft} />
          : rows ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm">{rows.map((r, i) => <div key={i} className={r.t === "add" ? "bg-green-100 dark:bg-green-950" : r.t === "del" ? "bg-red-100 text-zinc-500 line-through dark:bg-red-950" : ""}>{r.s || " "}</div>)}</pre>
          ) : draft ? <Markdown text={draft.content} /> : null}
      </div>
    </div>
  );
}

function TopicPanel({ d }: { d: MeetingDetail }) {
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
      <Markdown text={d.topic} />
      <div className="space-y-1 border-t border-zinc-200 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
        <p>创建：{bj(d.createdAt)}　已进行：{secs(d.elapsedMs + (d.activeSince ? Date.now() - d.activeSince : 0))}</p>
        {d.promptName && <p>会议风格：{d.promptName}</p>}
        <p>每轮等待：{d.waitSeconds < 0 ? "一直等我" : d.waitSeconds === 0 ? "不等" : `${d.waitSeconds} 秒`}　预计每个 AI 最多发言 {d.estimate.perSeat} 次</p>
        {d.participants.map((p) => <p key={p.seat} className="flex items-center gap-1"><SiteDot site={p.site} />{SEAT_LABEL[p.seat]}（{p.name}）：{p.chatId ? <a className="text-blue-600 underline" href={p.chatUrl ?? "#"} target="_blank" rel="noreferrer">对话 {p.chatId.slice(0, 10)}…</a> : "还没开始"}</p>)}
      </div>
    </div>
  );
}

// ---- 控制栏

function ControlBar({ d, run, serverNow, notify, bridge }: { d: MeetingDetail; run: (a: string, p?: Record<string, unknown>) => Promise<boolean>; serverNow: () => number; notify: Notify; bridge: BridgeStatus | null }) {
  const nav = useNavigate();
  const [text, setText] = useState("");
  const [more, setMore] = useState(false);
  const [, tick] = useState(0);
  const held = useRef(false);
  const ended = statusInfo(d.status).ended;
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  // 一打字倒计时就停住；清空了接着倒计时
  useEffect(() => {
    if (text.trim() && !held.current && d.status === "waiting") { held.current = true; void run("hold"); }
    if (!text.trim() && held.current) { held.current = false; void run("release"); }
  }, [text, d.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (!text.trim()) return;
    if (await run("message", { text })) { held.current = false; setText(""); notify(d.running ? "已记下，下一位发言时一起转达" : "已发送，所有 AI 都会看到"); }
  };
  const left = d.deadlineAt ? Math.max(0, Math.ceil((d.deadlineAt - serverNow()) / 1000)) : null;
  const speaking = d.live.map((l) => `${SEAT_LABEL[l.seat]}${KIND_TEXT[l.kind] === "执笔" ? "正在执笔" : `正在${KIND_TEXT[l.kind]}`}`).join("、");
  let line = "";
  if (d.status === "running") line = speaking ? `${speaking}…` : "准备中…";
  else if (d.status === "waiting") line = left !== null && left > 0 ? `⏱ 等你 ${left} 秒，可以输入意见，或者点“继续”` : "马上开始下一步…";
  else if (d.status === "paused") line = d.pauseReason === "questions" ? "AI 在等你回答上面的问题" : d.pauseReason === "no_ext" ? `插件没连上，连上后自动继续${d.pauseDetail?.message ? `（${d.pauseDetail.message}）` : ""}` : d.pauseReason === "retry" ? `${d.pauseDetail?.message ?? "网站限流"}；${d.retryAt ? bj(d.retryAt, false).slice(0, 5) : ""} 自动重试` : d.pauseReason === "typing" ? "你在输入，倒计时停住了" : "已暂停，点“继续”接着开";
  else if (d.status === "error") line = `出错：${d.error ?? ""}　可以点“继续”重试，或在“更多”里给这个席位换 AI`;
  else if (d.status === "interrupted") line = "服务重启时会议正在进行，点“继续”从上一次完整的发言接着开";
  if (d.pauseAfter && d.status === "running") line += "（这一轮结束后暂停）";

  const exportMd = () => { window.location.href = `/api/meetings/${d.id}/minutes`; };
  const del = async () => {
    if (!confirm("删除这场会议的记录？")) return;
    const chats = d.participants.some((p) => p.chatId) && confirm("要不要同时删除这场会议在各网站上用过的对话？\n确定 = 一起删；取消 = 只删记录");
    try { await api(`/api/meetings/${d.id}${chats ? "?deleteChats=1" : ""}`, { method: "DELETE" }); nav("/"); } catch (e) { notify((e as Error).message, true); }
  };
  if (ended) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 bg-white p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] dark:border-zinc-800 dark:bg-zinc-900">
        <Button onClick={exportMd}>导出纪要</Button>
        <MaxRounds d={d} run={run} label="加轮数接着开" />
        <Button kind="danger" className="ml-auto" onClick={del}>删除</Button>
      </div>
    );
  }
  return (
    <div className="border-t border-zinc-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-zinc-800 dark:bg-zinc-900">
      <div className={`px-3 pt-2 text-xs ${d.status === "error" ? "text-red-600" : "text-zinc-500"}`}>{line}{!bridge?.connected && d.status !== "paused" ? "　⚠ 插件没连上" : ""}</div>
      <div className="flex items-end gap-2 p-2">
        <textarea className={`${inputCls} max-h-40 min-h-10 flex-1 resize-none`} rows={1} placeholder={d.pauseReason === "questions" ? "也可以在这里直接写回答" : "你的意见或指令（所有 AI 都会看到，必须逐条回应）"} value={text}
          onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(160, e.target.scrollHeight) + "px"; }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send(); }} />
        <Button kind="primary" onClick={send} disabled={!text.trim()}>发送</Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2">
        <Button onClick={() => run("continue")} disabled={d.status === "running"}>继续</Button>
        <Button onClick={() => run("finalize")} disabled={!!d.finalizeStage || d.currentRound < 1} title="执笔人马上写最终稿，其他人确认后结束">定稿</Button>
        <Button onClick={() => run("pause")} disabled={d.status === "paused" || d.pauseAfter}>暂停</Button>
        <Button kind="danger" onClick={() => { if (confirm("终止会议？当前的合并稿会作为结论保存。")) void run("stop"); }}>终止</Button>
        <Button kind="ghost" className="ml-auto" onClick={() => setMore(!more)}>{more ? "收起" : "更多…"}</Button>
      </div>
      {more && <MorePanel d={d} run={run} exportMd={exportMd} del={del} />}
    </div>
  );
}

function MaxRounds({ d, run, label }: { d: MeetingDetail; run: (a: string, p?: Record<string, unknown>) => Promise<boolean>; label: string }) {
  const [n, setN] = useState(d.maxRounds + 2);
  return (
    <span className="flex items-center gap-1">
      <input type="number" min={2} max={30} className="w-16 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900" value={n} onChange={(e) => setN(Number(e.target.value))} />
      <Button className="whitespace-nowrap" onClick={() => run("set_max_rounds", { maxRounds: n })}>{label}</Button>
    </span>
  );
}

function MorePanel({ d, run, exportMd, del }: { d: MeetingDetail; run: (a: string, p?: Record<string, unknown>) => Promise<boolean>; exportMd: () => void; del: () => void }) {
  const seats = d.participants.map((p) => p.seat);
  const [swapSeat, setSwapSeat] = useState<Seat>(seats[0]);
  const free = SITES.filter((s) => !d.participants.some((p) => p.site === s.id));
  const [swapSite, setSwapSite] = useState<string>(free[0]?.id ?? "");
  const row = "flex flex-wrap items-center gap-1.5 text-sm";
  return (
    <div className="space-y-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
      <div className={row}>
        <span className="w-20 text-zinc-500">执笔</span>
        <Button kind={d.penMode === "rotate" ? "primary" : "default"} className="min-h-8" onClick={() => run("set_pen_mode", { penMode: "rotate", penSeat: d.nextWriter ?? d.penSeat })}>轮流</Button>
        <Button kind={d.penMode === "fixed" ? "primary" : "default"} className="min-h-8" onClick={() => run("set_pen_mode", { penMode: "fixed", penSeat: d.penSeat })}>固定</Button>
        <span className="text-zinc-500">{d.penMode === "fixed" ? "执笔人" : "下一轮"}：</span>
        {seats.map((s) => <Button key={s} className="min-h-8 px-2" kind={(d.penMode === "fixed" ? d.penSeat : d.nextWriter) === s ? "primary" : "default"} onClick={() => run("set_pen", { seat: s })}>{SEAT_LABEL[s]}</Button>)}
      </div>
      <div className={row}><span className="w-20 text-zinc-500">最大轮数</span><MaxRounds d={d} run={run} label="改" /></div>
      <div className={row}>
        <span className="w-20 text-zinc-500">每轮等我</span>
        {[[0, "不等"], [30, "30 秒"], [60, "60 秒"], [-1, "一直等"]].map(([v, l]) => <Button key={v} className="min-h-8" kind={d.waitSeconds === v ? "primary" : "default"} onClick={() => run("set_wait", { waitSeconds: v })}>{l}</Button>)}
      </div>
      {free.length > 0 && (
        <div className={row}>
          <span className="w-20 text-zinc-500">换 AI</span>
          <select className={`${inputCls} w-auto py-1`} value={swapSeat} onChange={(e) => setSwapSeat(e.target.value as Seat)}>{seats.map((s) => <option key={s} value={s}>{SEAT_LABEL[s]}（{siteName(d.participants.find((p) => p.seat === s)?.site)}）</option>)}</select>
          <span>换成</span>
          <select className={`${inputCls} w-auto py-1`} value={swapSite} onChange={(e) => setSwapSite(e.target.value)}>{free.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <Button className="min-h-8" onClick={() => run("set_site", { seat: swapSeat, site: swapSite })}>换</Button>
        </div>
      )}
      <div className={row}><Button onClick={exportMd}>导出纪要</Button><Button kind="danger" onClick={del}>删除会议</Button></div>
    </div>
  );
}
