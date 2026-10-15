import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation, useMatch, useNavigate } from "react-router-dom";
import { api } from "./api.ts";
import { useEvents, useTitleFlash } from "./events.ts";
import { Button, Card, inputCls, SiteDot, StatusBadge, Toast } from "./components/ui.tsx";
import { needsHost, SEAT_LABEL, bj } from "./util.ts";
import NewMeeting from "./pages/NewMeeting.tsx";
import MeetingView from "./pages/MeetingView.tsx";
import Chats from "./pages/Chats.tsx";
import Settings from "./pages/Settings.tsx";
import type { BridgeStatus, MeetingSummary } from "./types.ts";

export type Notify = (text: string, bad?: boolean) => void;

export default function App() {
  const [auth, setAuth] = useState<{ setup: boolean; loggedIn: boolean } | null>(null);
  const check = useCallback(() => api("/api/auth/state").then(setAuth).catch(() => setAuth({ setup: false, loggedIn: false })), []);
  useEffect(() => {
    check();
    const off = () => setAuth((a) => (a ? { ...a, loggedIn: false } : a));
    window.addEventListener("aid-logout", off);
    return () => window.removeEventListener("aid-logout", off);
  }, [check]);
  if (!auth) return null;
  if (!auth.loggedIn) return <Login setup={auth.setup} onDone={check} />;
  return <Shell onLogout={check} />;
}

function Login({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (setup && pw !== pw2) return setErr("两次输入的密码不一样");
    try { await api(setup ? "/api/auth/setup" : "/api/auth/login", { body: { password: pw } }); onDone(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold">AI 多方会议</h1>
        <p className="mb-4 mt-1 text-sm text-zinc-500">{setup ? "第一次使用，请设置管理密码（至少 6 位）" : "请输入管理密码"}</p>
        <form onSubmit={submit} className="space-y-3">
          <input type="password" autoFocus className={inputCls} placeholder="管理密码" value={pw} onChange={(e) => setPw(e.target.value)} />
          {setup && <input type="password" className={inputCls} placeholder="再输一次" value={pw2} onChange={(e) => setPw2(e.target.value)} />}
          {err && <p className="text-sm text-red-600">{err}</p>}
          <Button kind="primary" type="submit" className="w-full">{setup ? "设置并进入" : "登录"}</Button>
        </form>
      </Card>
    </div>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const m = useMatch("/m/:id");
  const meetingId = m?.params.id ?? null;
  const ev = useEvents(meetingId);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const notify: Notify = useCallback((text, bad) => { setToast({ text, bad }); setTimeout(() => setToast(null), bad ? 5000 : 2500); }, []);
  const loc = useLocation();
  const meetingPage = loc.pathname === "/" || loc.pathname.startsWith("/m/") || loc.pathname === "/new";
  const attention = (ev.meetings ?? []).find((x) => needsHost(x.status, x.pauseReason));
  useTitleFlash(!!attention, attention ? (attention.pauseReason === "questions" ? "AI 在等你回答" : "会议需要你处理") : "");
  return (
    <div className="flex h-full flex-col">
      <Toast msg={toast} onClose={() => setToast(null)} />
      <TopBar bridge={ev.bridge} online={ev.online} onLogout={onLogout} />
      <div className="flex min-h-0 flex-1">
        {meetingPage && (
          <aside className={`${loc.pathname === "/" ? "flex" : "hidden"} w-full flex-col border-zinc-200 md:flex md:w-72 md:shrink-0 md:border-r dark:border-zinc-800`}>
            <MeetingList meetings={ev.meetings} currentId={meetingId} notify={notify} />
          </aside>
        )}
        <main className={`min-w-0 flex-1 ${loc.pathname === "/" ? "hidden md:block" : ""}`}>
          <Routes>
            <Route path="/" element={<Empty />} />
            <Route path="/new" element={<NewMeeting key={loc.search} notify={notify} bridge={ev.bridge} />} />
            <Route path="/m/:id" element={<MeetingView detail={ev.detail} serverNow={ev.serverNow} notify={notify} bridge={ev.bridge} />} />
            <Route path="/chats" element={<Chats notify={notify} bridge={ev.bridge} />} />
            <Route path="/settings" element={<Settings notify={notify} bridge={ev.bridge} onLogout={onLogout} />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function TopBar({ bridge, online, onLogout: _ }: { bridge: BridgeStatus | null; online: boolean; onLogout: () => void }) {
  const nav = ({ isActive }: { isActive: boolean }) => `rounded-lg px-2.5 py-1.5 text-sm ${isActive ? "bg-zinc-200 font-medium dark:bg-zinc-800" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"}`;
  const ready = bridge?.sites.filter((s) => s.ready).length ?? 0;
  return (
    <header className="flex items-center gap-1 border-b border-zinc-200 bg-white px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] dark:border-zinc-800 dark:bg-zinc-900">
      <Link to="/" className="mr-2 font-semibold">AI 会议</Link>
      <NavLink to="/" end className={({ isActive }) => nav({ isActive: isActive || location.pathname.startsWith("/m/") })}>会议</NavLink>
      <NavLink to="/chats" className={nav}>会话</NavLink>
      <NavLink to="/settings" className={nav}>设置</NavLink>
      <Link to="/settings" className="ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" title="插件连接状态">
        <span className={`h-2 w-2 rounded-full ${!online ? "bg-zinc-400" : bridge?.connected ? "bg-green-500" : "bg-red-500"}`} />
        <span className="hidden sm:inline">{!online ? "和中转站断开" : bridge?.connected ? `插件已连接 · ${ready}/${bridge.sites.length} 就绪` : "插件未连接"}</span>
        <span className="sm:hidden">{bridge?.connected ? `${ready}/${bridge.sites.length}` : "插件"}</span>
      </Link>
    </header>
  );
}

function MeetingList({ meetings, currentId, notify }: { meetings: MeetingSummary[] | null; currentId: string | null; notify: Notify }) {
  const nav = useNavigate();
  // 右键（手机长按）弹出菜单：重新讨论 / 删除会议。删除只删中转站里的记录，不删 AI 网站上的对话。
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const openMenu = (id: string, x: number, y: number) => setMenu({ id, x: Math.min(x, window.innerWidth - 200), y: Math.min(y, window.innerHeight - 100) });
  const del = async (id: string) => {
    setMenu(null);
    const m = meetings?.find((x) => x.id === id);
    if (!window.confirm(`删除会议“${m?.title ?? ""}”的记录？\n（AI 网站上的对话不会删）`)) return;
    try { await api(`/api/meetings/${id}`, { method: "DELETE" }); if (id === currentId) nav("/"); notify("已删除"); } catch (e) { notify((e as Error).message, true); }
  };
  const active = meetings?.find((m) => !["consensus", "finalized", "divergent", "insufficient", "max_rounds", "stopped"].includes(m.status));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="p-3">
        <Button kind="primary" className="w-full" onClick={() => nav("/new")} disabled={!!active} title={active ? "一次只能开一场会议" : ""}>＋ 新建会议</Button>
        {active && <p className="mt-1.5 text-center text-xs text-zinc-500">“{active.title}”还没结束，一次只能开一场</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {meetings === null && <p className="p-3 text-sm text-zinc-500">加载中…</p>}
        {meetings?.length === 0 && <p className="p-3 text-sm text-zinc-500">还没有会议</p>}
        {meetings?.map((m) => (
          <Link key={m.id} to={`/m/${m.id}`}
            onContextMenu={(e) => { e.preventDefault(); openMenu(m.id, e.clientX, e.clientY); }}
            onTouchStart={(e) => { const t = e.touches[0]; longPressed.current = false; press.current = setTimeout(() => { longPressed.current = true; openMenu(m.id, t.clientX, t.clientY); }, 550); }}
            onClick={(e) => { if (longPressed.current) { e.preventDefault(); longPressed.current = false; } }}
            onTouchEnd={() => { if (press.current) clearTimeout(press.current); }} onTouchMove={() => { if (press.current) clearTimeout(press.current); }}
            style={{ WebkitTouchCallout: "none" }}
            className={`mb-1 block rounded-lg px-3 py-2.5 ${m.id === currentId ? "bg-zinc-200 dark:bg-zinc-800" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.title}</span>
              <StatusBadge status={m.status} pauseReason={m.pauseReason} />
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
              {m.participants.map((p) => <span key={p.seat} className="flex items-center gap-0.5"><SiteDot site={p.site} size={7} />{SEAT_LABEL[p.seat]}</span>)}
              <span className="ml-auto">{m.currentRound > 0 ? `第 ${m.currentRound}/${m.maxRounds} 轮 · ` : ""}{bj(m.createdAt)}</span>
            </div>
          </Link>
        ))}
      </div>
      {menu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="fixed z-40 w-48 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900" style={{ left: menu.x, top: menu.y }}>
            <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 disabled:text-zinc-400 dark:hover:bg-zinc-800" disabled={!!active} title={active ? "一次只能开一场，先结束正在进行的会议" : "用这场会议的议题和设置新开一场，只需要重新选 AI"}
              onClick={() => { setMenu(null); nav(`/new?from=${menu.id}`); }}>重新讨论{active ? "（有会议没结束）" : ""}</button>
            <button type="button" className="block w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => del(menu.id)}>删除会议</button>
          </div>
        </>
      )}
    </div>
  );
}

function Empty() {
  return <div className="flex h-full items-center justify-center p-6 text-sm text-zinc-500">选择左边的会议，或者新建一场</div>;
}
