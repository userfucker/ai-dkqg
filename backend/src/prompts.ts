/** 会议风格提示词（主持人在设置页增删改，新建会议时选一份）。 */
import { getDb } from "./db.ts";

export interface PromptRow { id: number; name: string; content: string; is_default: number; created_at: number; updated_at: number }

export function listPrompts(): PromptRow[] {
  return getDb().prepare(`SELECT * FROM prompts ORDER BY is_default DESC, updated_at DESC`).all() as PromptRow[];
}
export function getPrompt(id: number): PromptRow | undefined {
  return getDb().prepare(`SELECT * FROM prompts WHERE id = ?`).get(id) as PromptRow | undefined;
}
export function savePrompt(p: { id?: number; name: string; content: string; isDefault: boolean }): number {
  const db = getDb();
  const now = Date.now();
  return db.transaction(() => {
    if (p.isDefault) db.prepare(`UPDATE prompts SET is_default = 0`).run();
    if (p.id) {
      db.prepare(`UPDATE prompts SET name = ?, content = ?, is_default = ?, updated_at = ? WHERE id = ?`).run(p.name, p.content, p.isDefault ? 1 : 0, now, p.id);
      return p.id;
    }
    return Number(db.prepare(`INSERT INTO prompts (name, content, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(p.name, p.content, p.isDefault ? 1 : 0, now, now).lastInsertRowid);
  })();
}
export function deletePrompt(id: number): void {
  getDb().prepare(`DELETE FROM prompts WHERE id = ?`).run(id);
}
