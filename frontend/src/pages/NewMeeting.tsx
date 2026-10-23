import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api.ts";
import { usePasteFold } from "../pasteFold.ts";
import { Button, Card, inputCls, SiteDot } from "../components/ui.tsx";
import { ACTIVE_SITES, SEAT_LABEL, siteName } from "../util.ts";
import type { BridgeStatus, MeetingDetail, Prompt, Seat, SiteId } from "../types.ts";
import type { Notify } from "../App.tsx";

const SEATS: Seat[] = ["A", "B", "C", "D"];

export default function NewMeeting({ notify, bridge }: { notify: Notify; bridge: BridgeStatus | null }) {
  const nav = useNavigate();
  const [topic, setTopic] = useState("");
  const [title, setTitle] = useState("");
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [promptId, setPromptId] = useState<number | "">("");
  const [order, setOrder] = useState<SiteId[]>(["deepseek", "kimi"]);
  const [penMode, setPenMode] = useState<"rotate" | "fixed">("rotate");
  const [penSeat, setPenSeat] = useState<Seat>("A");
  const [maxRounds, setMaxRounds] = useState(10);
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);
  const fold = usePasteFold(topic, setTopic);
  // 议题里上传文件（和 webui 一样：上传后在议题里加一行“查看 uploads/… 文件”；开会时第一轮原格式发给每个 AI）
  const draft = useRef(Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [maxMb, setMaxMb] = useState(2);
  useEffect(() => { api<{ uploadMaxMb: number }>("/api/settings").then((r) => setMaxMb(r.uploadMaxMb || 2)).catch(() => {}); }, []);
  const files = [...topic.matchAll(/^查看 (uploads\/[^\n]+?) 文件$/gm)].map((m) => m[1]);
  const uploadOne = async (f: File) => {
    if (f.size > maxMb * 1024 * 1024) return notify(`${f.name} 太大：${(f.size / 1024 / 1024).toFixed(1)} MB，上限 ${maxMb} MB（可以在“设置”里改）`, true);
    setUploading((n) => n + 1);
    try {
      const res = await fetch(`/api/uploads?draft=${draft.current}&name=${encodeURIComponent(f.name || "文件")}`, { method: "POST", body: f, credentials: "same-origin" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `上传失败（${res.status}）`);
      const line = `查看 ${d.path} 文件`;
      setTopic((t) => (t ? `${t.replace(/\n+$/, "")}\n${line}` : line));
    } catch (e) { notify(`${f.name}：${(e as Error).message}`, true); }
    finally { setUploading((n) => n - 1); }
  };
  const uploadAll = async (list: FileList | File[]) => { for (const f of [...list]) await uploadOne(f); };
  const removeFile = async (rel: string) => {
    try { await api(`/api/${rel.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" }); } catch { /* 已经没了也从议题里去掉 */ }
    setTopic((t) => t.split("\n").filter((l) => l !== `查看 ${rel} 文件`).join("\n"));
  };
  const onPasteTopic = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pics = [...(e.clipboardData?.files ?? [])];
    if (pics.length) { e.preventDefault(); void uploadAll(pics.map((f, i) => (/^image\.(png|jpe?g|gif|webp)$/i.test(f.name) || !f.name ? new File([f], `粘贴的图片-${Date.now()}-${i + 1}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type }) : f))); return; }
    fold.onPaste(e);
  };

  // 重新讨论（会议列表右键）：/new?from=<会议 id>，把那场会议的议题和设置带过来，只需要重新选 AI
  const [params] = useSearchParams();
  const fromId = params.get("from");
  const [from, setFrom] = useState<MeetingDetail | null>(null);
  const [withConclusion, setWithConclusion] = useState(false);
  useEffect(() => {
    (async () => {
      let list: Prompt[] = [];
      try { list = (await api<{ prompts: Prompt[] }>("/api/prompts")).prompts; setPrompts(list); } catch { /* 没有风格也能开 */ }
      if (fromId) {
        try {
          const { meeting: m } = await api<{ meeting: MeetingDetail }>(`/api/meetings/${fromId}`);
          setFrom(m);
          setTopic(m.topic); setTitle(m.title);
          setPromptId(m.promptId && list.some((p) => p.id === m.promptId) ? m.promptId : "");
          setPenMode(m.penMode); setMaxRounds(m.maxRounds); setWait(m.waitSeconds);
          setOrder([]);
          return;
        } catch (e) { notify("读取原会议失败：" + (e as Error).message, true); }
      }
      const d = list.find((p) => p.is_default);
      if (d) setPromptId(d.id);
    })();
  }, [fromId]); // eslint-disable-line react-hooks/exhaustive-deps
  const conclusion = from ? from.finalDraft ?? from.drafts.at(-1)?.content ?? "" : "";

  const toggle = (s: SiteId) => setOrder((o) => (o.includes(s) ? o.filter((x) => x !== s) : o.length >= 4 ? o : [...o, s]));
  const move = (i: number, d: -1 | 1) => setOrder((o) => { const n = [...o]; const j = i + d; if (j < 0 || j >= n.length) return o; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const seats = SEATS.slice(0, order.length);
  useEffect(() => { if (!seats.includes(penSeat)) setPenSeat("A"); }, [order.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const perSeat = 2 + Math.max(0, maxRounds - 1);

  const submit = async () => {
    if (!topic.trim()) return notify("请填写议题", true);
    if (order.length < 2) return notify("至少选 2 个 AI", true);
    setBusy(true);
    try {
      const r = await api<{ id: string }>("/api/meetings", { body: { topic: fold.resolve(topic) + (withConclusion && conclusion ? `\n\n【上次讨论的结论（供参考）】\n${conclusion}` : ""), title: title || undefined, promptId: promptId || null, participants: order, penMode, penSeat, maxRounds, waitSeconds: wait } });
      nav(`/m/${r.id}`);
    } catch (e) { notify((e as Error).message, true); } finally { setBusy(false); }
  };

  const site = (s: SiteId) => bridge?.sites.find((x) => x.site === s);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24">
        <div className="flex items-center gap-2">
          <Button kind="ghost" className="md:hidden" onClick={() => nav("/")}>‹ 返回</Button>
          <h1 className="text-lg font-semibold">{from ? "重新讨论" : "新建 AI 会议"}</h1>
        </div>

        {from && (
          <Card className="space-y-1 border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300">
            <p>已载入“{from.title}”的议题和设置，选好参会的 AI 就可以开始。</p>
            {from.promptName && promptId === "" && <p>原来的会议风格“{from.promptName}”已经删除，这次不用风格提示词（可以重新选）。</p>}
            {conclusion && <label className="flex items-center gap-1.5"><input type="checkbox" checked={withConclusion} onChange={(e) => setWithConclusion(e.target.checked)} />把上次讨论的结论附在议题后面（供参考）</label>}
          </Card>
        )}
        <Card className="space-y-3 p-4">
          <label className="block text-sm font-medium">议题</label>
          <textarea className={`${inputCls} min-h-36`} placeholder="要讨论的问题、背景、要求……很长也没关系（大段粘贴会自动折叠；超过设置的行数会用 txt 附件发给 AI）" value={topic} onChange={(e) => setTopic(e.target.value)} onPaste={onPasteTopic}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); void uploadAll(e.dataTransfer.files); } }} />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Button className="min-h-8" onClick={() => fileInput.current?.click()} disabled={uploading > 0}>{uploading ? `上传中（${uploading}）…` : "上传文件"}</Button>
            <span className="text-xs text-zinc-500">图片、txt、PDF、Word、Excel 等都可以（也可以拖进议题框、粘贴截图），每个不超过 {maxMb} MB；开会时第一轮原格式发给每个 AI</span>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) void uploadAll(e.target.files); e.target.value = ""; }} />
          </div>
          {files.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-zinc-200 p-2 text-sm dark:border-zinc-800">
              {files.map((rel) => (
                <li key={rel} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" title={rel}>📎 {rel.split("/").pop()}</span>
                  <a className="text-blue-600 hover:underline" href={`/api/${rel.split("/").map(encodeURIComponent).join("/")}`} target="_blank" rel="noreferrer">预览</a>
                  <button type="button" className="text-red-600 hover:underline" onClick={() => void removeFile(rel)}>删除</button>
                </li>
              ))}
            </ul>
          )}
          {fold.folded > 0 && (
            <p className="-mt-1 text-xs text-zinc-500">已折叠 {fold.folded} 段粘贴内容，开会时会还原成原文。<button type="button" className="text-blue-600 hover:underline" onClick={() => setTopic(fold.resolve(topic))}>展开</button></p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">标题<span className="font-normal text-zinc-500">（可不填，默认取议题第一行）</span></label>
              <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">会议风格</label>
              <select className={inputCls} value={promptId} onChange={(e) => setPromptId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">不用风格提示词</option>
                {prompts.map((p) => <option key={p.id} value={p.id}>{p.name}{p.is_default ? "（默认）" : ""}</option>)}
              </select>
            </div>
          </div>
        </Card>

        <Card className="space-y-3 p-4">
          <div className="text-sm font-medium">参会的 AI <span className="font-normal text-zinc-500">（2～4 个，按点选顺序排成甲乙丙丁）</span></div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {ACTIVE_SITES.map((s) => {
              const i = order.indexOf(s.id);
              const st = site(s.id);
              return (
                <button key={s.id} onClick={() => toggle(s.id)} className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm ${i >= 0 ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900" : "border-zinc-300 dark:border-zinc-700"}`}>
                  <SiteDot site={s.id} />
                  <span className="flex-1">{s.name}</span>
                  {i >= 0 ? <b>{SEAT_LABEL[SEATS[i]]}</b> : <span className="text-xs text-zinc-400">{st?.ready ? "就绪" : st?.open ? "加载中" : "未打开"}</span>}
                </button>
              );
            })}
          </div>
          {order.length > 1 && (
            <div className="space-y-1">
              {order.map((s, i) => (
                <div key={s} className="flex items-center gap-2 text-sm">
                  <b className="w-5">{SEAT_LABEL[SEATS[i]]}</b><SiteDot site={s} /><span className="flex-1">{siteName(s)}</span>
                  <Button kind="ghost" className="min-h-7 px-2" disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
                  <Button kind="ghost" className="min-h-7 px-2" disabled={i === order.length - 1} onClick={() => move(i, 1)}>↓</Button>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-zinc-500">没打开的网站，插件会自动打开（单独一个窗口）。网站上的模式（深度思考、联网搜索、模型）以网页当前的设置为准。</p>
        </Card>

        <Card className="grid gap-3 p-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">执笔方式</label>
            <div className="flex gap-2">
              <Button kind={penMode === "rotate" ? "primary" : "default"} onClick={() => setPenMode("rotate")} className="flex-1">轮流执笔</Button>
              <Button kind={penMode === "fixed" ? "primary" : "default"} onClick={() => setPenMode("fixed")} className="flex-1">固定执笔</Button>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">{penMode === "fixed" ? "执笔人" : "第一位执笔人"}</label>
            <select className={inputCls} value={penSeat} onChange={(e) => setPenSeat(e.target.value as Seat)}>
              {seats.map((s, i) => <option key={s} value={s}>{SEAT_LABEL[s]}（{siteName(order[i])}）</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">最大轮数</label>
            <input type="number" min={2} max={30} className={inputCls} value={maxRounds} onChange={(e) => setMaxRounds(Math.max(2, Math.min(30, Number(e.target.value) || 2)))} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">每轮结束后等我</label>
            <select className={inputCls} value={wait} onChange={(e) => setWait(Number(e.target.value))}>
              <option value={0}>不等</option><option value={30}>30 秒</option><option value={60}>60 秒</option><option value={-1}>一直等我</option>
            </select>
          </div>
          <p className="text-xs text-zinc-500 sm:col-span-2">
            流程：提问环节（AI 先问你问题）→ 第 1 轮各自独立陈述 → 第 2 轮起{penMode === "rotate" ? "轮流" : "由同一位"}执笔写合并稿、其他人同时审阅 → 除执笔人外都同意就达成一致。
            预计每个 AI 最多发言 {perSeat} 次，一共最多 {perSeat * order.length} 次。
          </p>
        </Card>

        <div className="flex gap-2">
          <Button kind="primary" className="flex-1" onClick={submit} disabled={busy || order.length < 2 || !topic.trim()}>{busy ? "创建中…" : "开始会议"}</Button>
          <Button onClick={() => nav("/")}>取消</Button>
        </div>
        {!bridge?.connected && <p className="text-center text-sm text-red-600">插件还没连上中转站：会议会先暂停，插件连上后自动开始。</p>}
      </div>
    </div>
  );
}
