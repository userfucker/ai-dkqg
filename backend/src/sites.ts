/** 四个网页版 AI（和插件 ai-web 的网站 id 一致）。 */
export const SITES = {
  deepseek: { name: "DeepSeek" },
  glm: { name: "智谱清言" },
  kimi: { name: "Kimi" },
  qwen: { name: "千问" },
} as const;
export type SiteId = keyof typeof SITES;
export const SITE_IDS = Object.keys(SITES) as SiteId[];
/** 能参会的网站。千问去掉了（2026-10-15）：消息超过一万多字就用不了。旧会议里的千问照常显示。 */
export const ACTIVE_SITE_IDS: SiteId[] = ["deepseek", "glm", "kimi"];
export const isActiveSite = (s: unknown): s is SiteId => typeof s === "string" && (ACTIVE_SITE_IDS as string[]).includes(s);
export const isSite = (s: unknown): s is SiteId => typeof s === "string" && s in SITES;
export const siteName = (s: string) => (SITES as Record<string, { name: string }>)[s]?.name ?? s;
