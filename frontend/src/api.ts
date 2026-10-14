/** 接口请求：cookie 登录；401 时跳登录页。 */
export class ApiError extends Error { constructor(msg: string, public status: number) { super(msg); } }

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.code === "unauthorized") { window.dispatchEvent(new Event("aid-logout")); }
  if (!res.ok) throw new ApiError(data.error || `请求失败（${res.status}）`, res.status);
  return data as T;
}
export const command = (id: string, action: string, payload: Record<string, unknown> = {}) => api(`/api/meetings/${id}/command`, { body: { action, ...payload } });
