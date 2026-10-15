/** SQLite（better-sqlite3）：一个文件 DATA_DIR/relay.sqlite，启动时建表。 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(join(DATA_DIR, "relay.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** 测试用：换成内存数据库。 */
export function useMemoryDb(): void {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ua TEXT
    );
    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, content TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      topic TEXT NOT NULL,
      prompt_id INTEGER,
      prompt_name TEXT,
      prompt_content TEXT NOT NULL DEFAULT '',
      pen_mode TEXT NOT NULL,            -- fixed 固定执笔 / rotate 轮流执笔
      pen_seat TEXT NOT NULL,
      next_writer TEXT,
      max_rounds INTEGER NOT NULL,
      wait_seconds INTEGER NOT NULL,
      status TEXT NOT NULL,
      pause_reason TEXT,
      pause_detail TEXT,
      current_round INTEGER NOT NULL DEFAULT 0,
      deadline_at INTEGER,
      finalize_stage TEXT,
      finalize_reason TEXT,
      pause_after INTEGER NOT NULL DEFAULT 0,
      final_draft TEXT,
      end_note TEXT,
      error TEXT,
      retry_at INTEGER,
      elapsed_ms INTEGER NOT NULL DEFAULT 0,
      active_since INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meeting_participants (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      seat TEXT NOT NULL,
      site TEXT NOT NULL,
      chat_id TEXT,
      chat_url TEXT,
      seen_upto INTEGER NOT NULL DEFAULT 0,
      joined_round INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (meeting_id, seat)
    );
    CREATE TABLE IF NOT EXISTS meeting_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      seat TEXT NOT NULL,              -- A B C D / host / system
      kind TEXT NOT NULL,
      site TEXT,
      text TEXT NOT NULL,
      status_json TEXT,
      draft_version INTEGER,
      duration_ms INTEGER,
      thinking_len INTEGER,
      attach_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turns_meeting ON meeting_turns(meeting_id, id);
    CREATE TABLE IF NOT EXISTS meeting_drafts (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      seat TEXT NOT NULL,
      turn_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (meeting_id, version)
    );
    -- 会议在各网站上用过的对话（会话管理用；换 AI 后旧的也留着）
    CREATE TABLE IF NOT EXISTS meeting_chats (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      site TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      url TEXT,
      seat TEXT,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      PRIMARY KEY (site, chat_id)
    );
  `);
  // 后加的列（旧数据库补上）
  const cols = (d.prepare(`PRAGMA table_info(meeting_turns)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("meta_json")) d.exec(`ALTER TABLE meeting_turns ADD COLUMN meta_json TEXT`);
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? row.value : null;
}
export function setSetting(key: string, value: string): void {
  getDb().prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
