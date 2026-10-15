/** 粘贴大段文字自动折叠（照搬 webui）：超过 500 字或 50 行的粘贴，输入框里只放一行占位
 *  ［附件：粘贴内容 #1 · 1284 字符 · 62 行］，发送 / 创建时再还原成原文。原文只在这个页面的内存里。 */
import { useRef, useState } from "react";
import type React from "react";

export const PASTE_FOLD_CHARS = 500;
export const PASTE_FOLD_LINES = 50;
const PLACEHOLDER_RE = /［附件：粘贴内容 #(\d+) · \d+ 字符 · \d+ 行］/g;

export function usePasteFold(value: string, setValue: (v: string) => void) {
  const [blocks, setBlocks] = useState<Record<string, string>>({});
  const nextId = useRef(0);

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    const lines = text.split("\n").length;
    if (text.length < PASTE_FOLD_CHARS && lines < PASTE_FOLD_LINES) return;
    e.preventDefault();
    const id = String(++nextId.current);
    setBlocks((b) => ({ ...b, [id]: text }));
    const el = e.currentTarget;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const ph = `［附件：粘贴内容 #${id} · ${text.length} 字符 · ${lines} 行］`;
    setValue(value.slice(0, start) + ph + value.slice(end));
    requestAnimationFrame(() => { try { el.selectionStart = el.selectionEnd = start + ph.length; } catch { /* 输入框已经不在了 */ } });
  };

  /** 把占位行还原成原文（占位行被改坏的就原样保留）。 */
  const resolve = (text: string) => text.replace(PLACEHOLDER_RE, (m, id: string) => blocks[id] ?? m);
  const folded = (value.match(PLACEHOLDER_RE) ?? []).filter((m) => blocks[/#(\d+)/.exec(m)?.[1] ?? ""] !== undefined).length;
  const reset = () => setBlocks({});
  return { onPaste, resolve, folded, reset };
}
