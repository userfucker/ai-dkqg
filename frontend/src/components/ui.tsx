import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import { SEAT_LABEL, SITE_COLOR, siteName, statusInfo } from "../util.ts";
import type { Seat } from "../types.ts";

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`prose prose-sm prose-zinc max-w-none break-words dark:prose-invert prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-h1:text-lg prose-h1:mb-2 prose-h2:text-base prose-h2:mt-4 prose-h2:mb-1.5 prose-h3:text-sm ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

export function SiteDot({ site, size = 8 }: { site: string; size?: number }) {
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: SITE_COLOR[site] ?? "#999" }} />;
}

export function SeatChip({ seat, site, active }: { seat: Seat; site: string; active?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${active ? "border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-950" : "border-zinc-200 dark:border-zinc-700"}`}>
      <SiteDot site={site} />
      <b className="font-semibold">{SEAT_LABEL[seat]}</b>
      <span className="text-zinc-500 dark:text-zinc-400">{siteName(site)}</span>
    </span>
  );
}

export function StatusBadge({ status, pauseReason }: { status: string; pauseReason?: string | null }) {
  const s = statusInfo(status, pauseReason);
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.text}</span>;
}

export function Button({ children, onClick, kind = "default", disabled, className = "", type = "button", title }: { children: ReactNode; onClick?: () => void; kind?: "default" | "primary" | "danger" | "ghost"; disabled?: boolean; className?: string; type?: "button" | "submit"; title?: string }) {
  const k = {
    default: "border border-zinc-300 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800",
    primary: "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300",
    danger: "border border-red-300 bg-white text-red-600 hover:bg-red-50 dark:border-red-900 dark:bg-zinc-900 dark:text-red-400",
    ghost: "hover:bg-zinc-100 dark:hover:bg-zinc-800",
  }[kind];
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} className={`inline-flex min-h-9 items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-sm transition disabled:opacity-40 ${k} ${className}`}>
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 ${className}`}>{children}</div>;
}

export const inputCls = "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-400";

export function Toast({ msg, onClose }: { msg: { text: string; bad?: boolean } | null; onClose: () => void }) {
  if (!msg) return null;
  return (
    <div className="fixed inset-x-0 top-3 z-50 flex justify-center px-4" onClick={onClose}>
      <div className={`max-w-md rounded-lg px-4 py-2 text-sm shadow-lg ${msg.bad ? "bg-red-600 text-white" : "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"}`}>{msg.text}</div>
    </div>
  );
}
