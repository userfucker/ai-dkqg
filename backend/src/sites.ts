/** 四个网页版 AI（和插件 ai-web 的网站 id 一致）。 */
export const SITES = {
  deepseek: { name: "DeepSeek" },
  glm: { name: "智谱清言" },
  kimi: { name: "Kimi" },
  qwen: { name: "千问" },
} as const;
export type SiteId = keyof typeof SITES;
export const SITE_IDS = Object.keys(SITES) as SiteId[];
export const isSite = (s: unknown): s is SiteId => typeof s === "string" && s in SITES;
export const siteName = (s: string) => (SITES as Record<string, { name: string }>)[s]?.name ?? s;
