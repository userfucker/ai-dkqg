import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.ts";
import { Button, Card, SiteDot, StatusBadge } from "../components/ui.tsx";
import { bj, SEAT_LABEL, SITES } from "../util.ts";
import type { BridgeStatus, Seat, SiteId } from "../types.ts";
import type { Notify } from "../App.tsx";

interface MChat { meetingId: string; meetingTitle: string; meetingStatus: string; site: SiteId; siteName: string; chatId: string; url: string | null; seat: Seat | null; createdAt: number; deletedAt: number | null }
interface SChat { id: string; title: string; updatedAt: number; pinned: boolean; url: string; meetingId: string | null; meetingTitle: string | null }

/** 会话管理：会议在各网站上用过的对话（按会议）；也可以看某个网站上的全部对话。都能打开、批量删除。 */
export default function Chats({ notify, bridge }: { notify: Notify; bridge: BridgeStatus | null }) {
  const [tab, setTab] = useState<"meeting" | SiteId>("meeting");
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-3 p-4 pb-16">
        <h1 className="text-lg font-semibold">会话管理</h1>
        <div className="flex flex-wrap gap-1.5">
          <Button kind={tab === "meeting" ? "primary" : "default"} onClick={() => setTab("meeting")}>会议用过的对话</Button>
          {SITES.map((s) => <Button key={s.id} kind={tab === s.id ? "primary" : "default"} onClick={() => setTab(s.id)}><SiteDot site={s.id} />{s.name} 全部</Button>)}
        </div>
        {!bridge?.connected && <p className="text-sm text-red-600">插件没连上：可以看记录，但打开、删除和查看网站上的对话要等插件连上。</p>}
        {tab === "meeting" ? <MeetingChats notify={notify} /> : <SiteChats key={tab} site={tab} notify={notify} />}
      </div>
    </div>
  );
}

function MeetingChats({ notify }: { notify: Notify }) {
  const [chats, setChats] = useState<MChat[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [showDeleted, setShowDeleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ chats: MChat[] }>("/api/chats").then((r) => setChats(r.chats)).catch((e) => notify(e.message, true)), [notify]);
  useEffect(() => { load(); }, [load]);
  const k = (c: MChat) => `${c.site}|${c.chatId}`;
  const groups = useMemo(() => {
    const m = new Map<string, MChat[]>();
    for (const c of chats ?? []) if (showDeleted || !c.deletedAt) m.set(c.meetingId, [...(m.get(c.meetingId) || []), c]);
    return [...m.values()];
  }, [chats, showDeleted]);
  const del = async () => {
    const items = (chats ?? []).filter((c) => sel.has(k(c)) && !c.deletedAt).map((c) => ({ site: c.site, chatId: c.chatId }));
    if (!items.length) return;
    if (!confirm(`在网站上删除这 ${items.length} 个对话？删除后找不回来。`)) return;
    setBusy(true);
    try {
      const r = await api<{ deleted: number; failed: number; results: { ok: boolean; error?: string }[] }>("/api/chats/delete", { body: { items } });
      notify(`删除：成功 ${r.deleted}，失败 ${r.failed}${r.failed ? "：" + r.results.filter((x) => !x.ok).map((x) => x.error).join("；") : ""}`, r.failed > 0);
      setSel(new Set());
      load();
    } catch (e) { notify((e as Error).message, true); } finally { setBusy(false); }
  };
  if (!chats) return <p className="text-sm text-zinc-500">加载中…</p>;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button kind="danger" disabled={!sel.size || busy} onClick={del}>{busy ? "删除中…" : `删除选中（${sel.size}）`}</Button>
        <label className="ml-auto flex items-center gap-1 text-sm text-zinc-500"><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />显示已删除的</label>
      </div>
      {groups.length === 0 && <p className="text-sm text-zinc-500">还没有会议用过的对话。</p>}
      {groups.map((g) => {
        const live = g.filter((c) => !c.deletedAt);
        const all = live.length > 0 && live.every((c) => sel.has(k(c)));
        return (
          <Card key={g[0].meetingId} className="p-3">
            <div className="mb-2 flex items-center gap-2">
              <input type="checkbox" checked={all} disabled={!live.length} onChange={() => setSel((s) => { const n = new Set(s); live.forEach((c) => (all ? n.delete(k(c)) : n.add(k(c)))); return n; })} />
              <Link to={`/m/${g[0].meetingId}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{g[0].meetingTitle || "（会议已删除）"}</Link>
              {g[0].meetingStatus && <StatusBadge status={g[0].meetingStatus} />}
            </div>
            {g.map((c) => (
              <div key={k(c)} className={`flex items-center gap-2 py-1 text-sm ${c.deletedAt ? "text-zinc-400 line-through" : ""}`}>
                <input type="checkbox" disabled={!!c.deletedAt} checked={sel.has(k(c))} onChange={() => setSel((s) => { const n = new Set(s); n.has(k(c)) ? n.delete(k(c)) : n.add(k(c)); return n; })} />
                <SiteDot site={c.site} /><span className="w-16">{c.siteName}</span>
                <span className="text-zinc-500">{c.seat ? SEAT_LABEL[c.seat] : ""}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{c.chatId}</span>
                <span className="hidden text-xs text-zinc-500 sm:inline">{bj(c.createdAt)}</span>
                {!c.deletedAt && <OpenBtn site={c.site} chatId={c.chatId} notify={notify} />}
              </div>
            ))}
          </Card>
        );
      })}
    </>
  );
}

function OpenBtn({ site, chatId, notify }: { site: string; chatId: string; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  return <Button kind="ghost" className="min-h-7 px-2 text-xs" disabled={busy} onClick={async () => { setBusy(true); try { await api("/api/chats/open", { body: { site, chatId } }); notify("已在电脑的浏览器里打开"); } catch (e) { notify((e as Error).message, true); } setBusy(false); }}>{busy ? "…" : "打开"}</Button>;
}

function SiteChats({ site, notify }: { site: SiteId; notify: Notify }) {
  const [list, setList] = useState<SChat[] | null>(null);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setErr(""); setList(null); api<{ list: SChat[] }>(`/api/chats/site/${site}`).then((r) => setList(r.list)).catch((e) => setErr(e.message)); }, [site]);
  useEffect(() => { load(); }, [load]);
  const del = async () => {
    if (!sel.size || !confirm(`在网站上删除这 ${sel.size} 个对话？删除后找不回来。`)) return;
    setBusy(true);
    try {
      const r = await api<{ deleted: number; failed: number; results: { ok: boolean; error?: string }[] }>("/api/chats/delete", { body: { items: [...sel].map((chatId) => ({ site, chatId })) } });
      notify(`删除：成功 ${r.deleted}，失败 ${r.failed}${r.failed ? "：" + r.results.filter((x) => !x.ok).map((x) => x.error).join("；") : ""}`, r.failed > 0);
      setSel(new Set());
      load();
    } catch (e) { notify((e as Error).message, true); } finally { setBusy(false); }
  };
  if (err) return <p className="text-sm text-red-600">{err} <Button onClick={load}>重试</Button></p>;
  if (!list) return <p className="text-sm text-zinc-500">正在从网站获取对话列表…</p>;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button kind="danger" disabled={!sel.size || busy} onClick={del}>{busy ? "删除中…" : `删除选中（${sel.size}）`}</Button>
        <Button onClick={() => setSel(new Set(list.map((x) => x.id)))}>全选</Button>
        <Button onClick={() => setSel(new Set(list.filter((x) => x.meetingId).map((x) => x.id)))}>选会议用过的</Button>
        <Button kind="ghost" onClick={load}>刷新</Button>
        <span className="ml-auto text-sm text-zinc-500">共 {list.length} 个</span>
      </div>
      <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {list.map((c) => (
          <label key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <input type="checkbox" checked={sel.has(c.id)} onChange={() => setSel((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })} />
            <span className="min-w-0 flex-1 truncate">{c.pinned ? "📌 " : ""}{c.title || "（无标题）"}</span>
            {c.meetingTitle && <span className="hidden max-w-40 truncate rounded bg-blue-100 px-1.5 text-xs text-blue-700 sm:inline dark:bg-blue-950 dark:text-blue-300">会议：{c.meetingTitle}</span>}
            <span className="text-xs text-zinc-500">{c.updatedAt ? bj(c.updatedAt) : ""}</span>
            <OpenBtn site={site} chatId={c.id} notify={notify} />
          </label>
        ))}
      </Card>
    </>
  );
}
