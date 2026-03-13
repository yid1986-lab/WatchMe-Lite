const Database = require("better-sqlite3");

const db = new Database("database.db");

try {
  db.pragma("journal_mode = WAL");
} catch (err) {
  console.warn("WAL mode not enabled:", err?.message || err);
}

/* -------------------------
   TABLES
-------------------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  announce_channel_id TEXT NOT NULL,
  fb_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('twitch')),
  url TEXT NOT NULL,
  external_id TEXT,
  added_at INTEGER NOT NULL,
  UNIQUE(guild_id, platform, url)
);

CREATE TABLE IF NOT EXISTS last_announced (
  guild_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, platform, key)
);
`);

/* -------------------------
   MIGRATIONS
-------------------------- */

const guildConfigColumns = db.prepare(`PRAGMA table_info(guild_config)`).all();
const hasFbEnabled = guildConfigColumns.some((col) => col.name === "fb_enabled");

if (!hasFbEnabled) {
  db.exec(`
    ALTER TABLE guild_config
    ADD COLUMN fb_enabled INTEGER NOT NULL DEFAULT 0
  `);
}

/* -------------------------
   INDEXES
-------------------------- */

db.exec(`
CREATE INDEX IF NOT EXISTS idx_members_lookup
ON members (guild_id, platform, url);

CREATE INDEX IF NOT EXISTS idx_members_external
ON members (external_id);
`);

module.exports = db;