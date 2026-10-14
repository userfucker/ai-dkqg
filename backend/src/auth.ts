/**
 * 登录：只有一个管理密码（scrypt 哈希存在 settings 里）。登录后发一个随机令牌，放在 cookie 里，30 天有效。
 * 插件连中转站用另一个“插件口令”（settings.ext_token，第一次启动随机生成，在设置页可以看、可以换）。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { getDb, getSetting, setSetting } from "./db.ts";

const COOKIE = "aid_token";
const TTL = 30 * 24 * 3600 * 1000;

export function hasPassword(): boolean {
  return !!getSetting("admin_password");
}
export function setPassword(pw: string): void {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 32).toString("hex");
  setSetting("admin_password", `${salt}:${hash}`);
  getDb().prepare(`DELETE FROM auth_sessions`).run(); // 改密码后所有设备重新登录
}
export function checkPassword(pw: string): boolean {
  const v = getSetting("admin_password");
  if (!v) return false;
  const [salt, hash] = v.split(":");
  const got = scryptSync(pw, salt, 32);
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}
export function extToken(): string {
  let t = getSetting("ext_token");
  if (!t) { t = randomBytes(9).toString("base64url"); setSetting("ext_token", t); }
  return t;
}
export function regenerateExtToken(): string {
  const t = randomBytes(9).toString("base64url");
  setSetting("ext_token", t);
  return t;
}

export function login(c: Context): void {
  const token = randomBytes(24).toString("base64url");
  const now = Date.now();
  getDb().prepare(`INSERT INTO auth_sessions (token, created_at, expires_at, ua) VALUES (?, ?, ?, ?)`).run(token, now, now + TTL, c.req.header("user-agent") ?? null);
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: TTL / 1000 });
}
export function logout(c: Context): void {
  const t = getCookie(c, COOKIE);
  if (t) getDb().prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(t);
  deleteCookie(c, COOKIE, { path: "/" });
}
export function isLoggedIn(c: Context): boolean {
  const t = getCookie(c, COOKIE);
  if (!t) return false;
  const row = getDb().prepare(`SELECT expires_at FROM auth_sessions WHERE token = ?`).get(t) as { expires_at: number } | undefined;
  return !!row && row.expires_at > Date.now();
}
export async function requireAuth(c: Context, next: Next) {
  if (!isLoggedIn(c)) return c.json({ error: "请先登录", code: "unauthorized" }, 401);
  await next();
}

/** 登录失败太多次：同一个 IP 10 分钟内最多错 10 次。 */
const fails = new Map<string, { n: number; at: number }>();
export function tooManyFails(ip: string): boolean {
  const f = fails.get(ip);
  return !!f && Date.now() - f.at < 600_000 && f.n >= 10;
}
export function noteFail(ip: string): void {
  const f = fails.get(ip);
  if (!f || Date.now() - f.at > 600_000) fails.set(ip, { n: 1, at: Date.now() });
  else f.n++;
}
