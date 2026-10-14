import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { Button, Card, inputCls, Markdown, SiteDot } from "../components/ui.tsx";
import { bj } from "../util.ts";
import type { BridgeStatus, Prompt } from "../types.ts";
import type { Notify } from "../App.tsx";

export default function Settings({ notify, bridge, onLogout }: { notify: Notify; bridge: BridgeStatus | null; onLogout: () => void }) {
  const [s, setS] = useState<{ attachLines: number; extToken: string; version: string } | null>(null);
  const [lines, setLines] = useState(100);
  useEffect(() => { api("/api/settings").then((r) => { setS(r); setLines(r.attachLines); }).catch((e) => notify(e.message, true)); }, [notify]);
  const site = async (id: string, action: string) => { try { await api(`/api/sites/${id}/${action}`, { body: {} }); notify("好了"); } catch (e) { notify((e as Error).message, true); } };
  const port = location.port || (location.protocol === "https:" ? "443" : "80");
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-4 pb-16">
        <h1 className="text-lg font-semibold">设置</h1>

        <Card className="space-y-3 p-4">
          <h2 className="font-medium">浏览器插件</h2>
          <p className="text-sm">
            <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${bridge?.connected ? "bg-green-500" : "bg-red-500"}`} />
            {bridge?.connected ? `已连接：${bridge.name}（插件 ${bridge.version}），${bj(bridge.since ?? 0)} 连上` : "没连上"}
          </p>
          <div className="rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-800/50">
            在插件的“设置”里填：<br />
            中转站 IP <b className="font-mono">{location.hostname}</b>　端口 <b className="font-mono">{port}</b>　口令 <b className="font-mono">{s?.extToken ?? "…"}</b>
            <div className="mt-2 flex gap-2">
              <Button className="min-h-8" onClick={() => { void navigator.clipboard?.writeText(s?.extToken ?? ""); notify("口令已复制"); }}>复制口令</Button>
              <Button className="min-h-8" onClick={async () => { if (!confirm("换一个新口令？插件要重新填。")) return; const r = await api("/api/settings/ext-token", { body: {} }); setS((x) => (x ? { ...x, extToken: r.extToken } : x)); }}>换新口令</Button>
            </div>
            <p className="mt-2 text-xs text-zinc-500">中转站跑在 Docker 里时，IP 填宿主机（OpenWrt）的局域网 IP，端口填映射出来的端口。</p>
          </div>
          {bridge?.connected && (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {bridge.sites.map((x) => (
                <div key={x.site} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <SiteDot site={x.site} /><span className="w-20">{x.name}</span>
                  <span className="flex-1 text-xs text-zinc-500">{!x.open ? "没打开" : x.ready ? "就绪" : "加载中…"}</span>
                  <Button className="min-h-7 px-2 text-xs" onClick={() => site(x.site, "open")}>{x.open ? "确认就绪" : "打开"}</Button>
                  {x.open && <Button className="min-h-7 px-2 text-xs" onClick={() => site(x.site, "focus")}>切到窗口</Button>}
                  {x.open && <Button className="min-h-7 px-2 text-xs" onClick={() => site(x.site, "reload")}>刷新</Button>}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="space-y-2 p-4">
          <h2 className="font-medium">长消息</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            发给 AI 的消息超过
            <input type="number" className={`${inputCls} w-24 py-1`} min={10} value={lines} onChange={(e) => setLines(Number(e.target.value))} />
            行，就把材料放进 txt 附件上传
            <Button className="min-h-8" onClick={async () => { try { await api("/api/settings", { method: "PUT", body: { attachLines: lines } }); notify("已保存"); } catch (e) { notify((e as Error).message, true); } }}>保存</Button>
          </div>
        </Card>

        <Prompts notify={notify} />
        <Rules />
        <Password notify={notify} onLogout={onLogout} />
        <p className="text-center text-xs text-zinc-400">中转站 {s?.version}</p>
      </div>
    </div>
  );
}

function Prompts({ notify }: { notify: Notify }) {
  const [list, setList] = useState<Prompt[]>([]);
  const [edit, setEdit] = useState<{ id?: number; name: string; content: string; isDefault: boolean } | null>(null);
  const load = () => api("/api/prompts").then((r) => setList(r.prompts)).catch(() => {});
  useEffect(() => { load(); }, []);
  const save = async () => {
    if (!edit) return;
    try { await api(edit.id ? `/api/prompts/${edit.id}` : "/api/prompts", { method: edit.id ? "PUT" : "POST", body: edit }); setEdit(null); load(); notify("已保存"); } catch (e) { notify((e as Error).message, true); }
  };
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center"><h2 className="flex-1 font-medium">会议风格提示词</h2><Button className="min-h-8" onClick={() => setEdit({ name: "", content: "", isDefault: false })}>＋ 新建</Button></div>
      <p className="text-xs text-zinc-500">新建会议时选一份，原样插在会议规则后面，用来规定讨论的风格和要求。</p>
      {edit && (
        <div className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
          <input className={inputCls} placeholder="名字，例如：技术评审" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          <textarea className={`${inputCls} min-h-40`} placeholder="提示词内容" value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} />
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={edit.isDefault} onChange={(e) => setEdit({ ...edit, isDefault: e.target.checked })} />新建会议时默认选它</label>
          <div className="flex gap-2"><Button kind="primary" onClick={save}>保存</Button><Button onClick={() => setEdit(null)}>取消</Button></div>
        </div>
      )}
      {list.length === 0 && !edit && <p className="text-sm text-zinc-500">还没有。</p>}
      {list.map((p) => (
        <div key={p.id} className="flex items-start gap-2 border-t border-zinc-100 pt-2 text-sm dark:border-zinc-800">
          <div className="min-w-0 flex-1"><b>{p.name}</b>{p.is_default ? <span className="ml-1 text-xs text-green-600">默认</span> : null}<p className="line-clamp-2 text-xs text-zinc-500">{p.content}</p></div>
          <Button className="min-h-7 px-2 text-xs" onClick={() => setEdit({ id: p.id, name: p.name, content: p.content, isDefault: !!p.is_default })}>编辑</Button>
          <Button kind="danger" className="min-h-7 px-2 text-xs" onClick={async () => { if (confirm(`删除“${p.name}”？`)) { await api(`/api/prompts/${p.id}`, { method: "DELETE" }); load(); } }}>删除</Button>
        </div>
      ))}
    </Card>
  );
}

function Rules() {
  const [rules, setRules] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open && !rules) api("/api/meeting-rules").then((r) => setRules(r.rules)).catch(() => {}); }, [open, rules]);
  return (
    <Card className="p-4">
      <button className="flex w-full items-center text-left" onClick={() => setOpen(!open)}><h2 className="flex-1 font-medium">会议规则（只读）</h2><span className="text-sm text-zinc-500">{open ? "收起" : "展开"}</span></button>
      <p className="mt-1 text-xs text-zinc-500">程序靠规则里的固定格式（合并稿、状态块、提问）判断会议进度，所以不能改。</p>
      {open && <Markdown className="mt-3" text={"```\n" + rules + "\n```"} />}
    </Card>
  );
}

function Password({ notify, onLogout }: { notify: Notify; onLogout: () => void }) {
  const [old, setOld] = useState("");
  const [pw, setPw] = useState("");
  return (
    <Card className="space-y-2 p-4">
      <h2 className="font-medium">管理密码</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        <input type="password" className={inputCls} placeholder="原密码" value={old} onChange={(e) => setOld(e.target.value)} />
        <input type="password" className={inputCls} placeholder="新密码（至少 6 位）" value={pw} onChange={(e) => setPw(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button onClick={async () => { try { await api("/api/settings/password", { body: { old, password: pw } }); setOld(""); setPw(""); notify("密码已修改，其他设备需要重新登录"); } catch (e) { notify((e as Error).message, true); } }}>修改密码</Button>
        <Button kind="ghost" className="ml-auto" onClick={async () => { await api("/api/auth/logout", { body: {} }); onLogout(); }}>退出登录</Button>
      </div>
    </Card>
  );
}
