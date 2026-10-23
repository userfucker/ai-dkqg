/**
 * 议题里上传的文件（Lee 2026-10-23）：开会前在“新建会议”页面上传，存在 DATA_DIR/uploads/<草稿编号>/<文件名>，
 * 议题里加一行“查看 uploads/<草稿编号>/<文件名> 文件”（和 webui 一样）。
 * 开会时每个 AI 第一次发言（新对话）把这些文件原格式作为附件发过去；议题里那一行换成“附件《文件名》已随消息上传”。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { DATA_DIR } from "./config.ts";
import { getSetting } from "./db.ts";

export const UPLOAD_ROOT = join(DATA_DIR, "uploads");
/** 议题里引用文件的那一行 */
export const FILE_LINE_RE = /^查看 (uploads\/[^\n]+?) 文件$/gm;

export const uploadMaxMb = (): number => { const n = Number(getSetting("upload_max_mb") ?? 2); return Number.isFinite(n) && n > 0 ? n : 2; };

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".json": "application/json",
  ".pdf": "application/pdf", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};
export const mimeOf = (name: string): string => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";

/** 相对路径 uploads/... → 绝对路径；跑出 uploads 目录的返回 null */
export function uploadPath(rel: string): string | null {
  if (!/^uploads\//.test(rel)) return null;
  const abs = resolve(DATA_DIR, rel);
  return abs.startsWith(UPLOAD_ROOT + sep) ? abs : null;
}
const safeName = (s: string) => basename(String(s || "文件")).replace(/[\\/:*?"<>|\r\n\t]+/g, "_").trim().slice(0, 120) || "文件";
const safeDraft = (s: string) => (/^[\w-]{4,40}$/.test(s) ? s : "");

/** 存一个文件，重名就加 (2)、(3)。返回相对路径 */
export function saveUpload(draft: string, name: string, buf: Buffer): { ok: true; path: string; name: string; size: number } | { ok: false; error: string } {
  const d = safeDraft(draft);
  if (!d) return { ok: false, error: "草稿编号不对" };
  const max = uploadMaxMb();
  if (buf.length > max * 1024 * 1024) return { ok: false, error: `文件太大：${(buf.length / 1024 / 1024).toFixed(1)} MB，上限 ${max} MB（可以在“设置”里改）` };
  if (!buf.length) return { ok: false, error: "文件是空的" };
  const dir = join(UPLOAD_ROOT, d);
  mkdirSync(dir, { recursive: true });
  let n = safeName(name);
  const ext = extname(n), stem = n.slice(0, n.length - ext.length);
  for (let i = 2; existsSync(join(dir, n)); i++) n = `${stem}(${i})${ext}`;
  writeFileSync(join(dir, n), buf);
  return { ok: true, path: `uploads/${d}/${n}`, name: n, size: buf.length };
}
export function deleteUpload(rel: string): boolean {
  const abs = uploadPath(rel);
  if (!abs || !existsSync(abs)) return false;
  rmSync(abs, { force: true });
  try { const dir = dirname(abs); if (dir !== UPLOAD_ROOT && !readdirSync(dir).length) rmSync(dir, { recursive: true, force: true }); } catch { /* 目录不空就算了 */ }
  return true;
}

/** 议题里引用的文件（还存在的） */
export function topicFiles(topic: string): { rel: string; name: string; abs: string; size: number; mime: string }[] {
  const out: { rel: string; name: string; abs: string; size: number; mime: string }[] = [];
  for (const m of String(topic || "").matchAll(FILE_LINE_RE)) {
    const abs = uploadPath(m[1]);
    if (!abs || !existsSync(abs) || out.some((x) => x.rel === m[1])) continue;
    out.push({ rel: m[1], name: basename(abs), abs, size: statSync(abs).size, mime: mimeOf(abs) });
  }
  return out;
}
/** 发给 AI 的议题：文件那一行换成“附件《文件名》已随消息上传” */
export const topicForAI = (topic: string): string => String(topic || "").replace(FILE_LINE_RE, (_l, rel: string) => `【附件《${basename(rel)}》已经随这条消息上传，请打开阅读】`);
/** 第一次发言要带的附件（原格式） */
export const topicAttachments = (topic: string): { name: string; b64: string; mime: string }[] =>
  topicFiles(topic).map((f) => ({ name: f.name, b64: readFileSync(f.abs).toString("base64"), mime: f.mime.split(";")[0] }));
/** 删除会议时：删掉议题里引用的文件所在的草稿目录 */
export function deleteTopicUploads(topic: string): void {
  const dirs = new Set(topicFiles(topic).map((f) => dirname(f.abs)));
  for (const d of dirs) if (d.startsWith(UPLOAD_ROOT + sep)) rmSync(d, { recursive: true, force: true });
}
