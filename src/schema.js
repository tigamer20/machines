import { DEFAULT_MACHINES, DEFAULT_SETTINGS } from './defaults.js';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS players (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     code        TEXT NOT NULL UNIQUE,
     name        TEXT NOT NULL,
     balance     INTEGER NOT NULL DEFAULT 0,
     active      INTEGER NOT NULL DEFAULT 1,
     spins       INTEGER NOT NULL DEFAULT 0,
     wagered     INTEGER NOT NULL DEFAULT 0,
     won         INTEGER NOT NULL DEFAULT 0,
     biggest_win INTEGER NOT NULL DEFAULT 0,
     jackpots    INTEGER NOT NULL DEFAULT 0,
     bj_hands    INTEGER NOT NULL DEFAULT 0,
     bj_net      INTEGER NOT NULL DEFAULT 0,
     adjustments INTEGER NOT NULL DEFAULT 0,
     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
     last_seen   TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS machines (
     id      TEXT PRIMARY KEY,
     sort    INTEGER NOT NULL DEFAULT 0,
     config  TEXT NOT NULL,
     jackpot INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS machine_stats (
     player_id  INTEGER NOT NULL,
     machine_id TEXT NOT NULL,
     spins      INTEGER NOT NULL DEFAULT 0,
     wagered    INTEGER NOT NULL DEFAULT 0,
     won        INTEGER NOT NULL DEFAULT 0,
     jackpots   INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (player_id, machine_id)
   )`,
  `CREATE TABLE IF NOT EXISTS transactions (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     player_id     INTEGER NOT NULL,
     type          TEXT NOT NULL,
     machine_id    TEXT,
     amount        INTEGER NOT NULL,
     bet           INTEGER NOT NULL DEFAULT 0,
     win           INTEGER NOT NULL DEFAULT 0,
     balance_after INTEGER NOT NULL,
     note          TEXT,
     voided        INTEGER NOT NULL DEFAULT 0,
     created_at    TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tx_player ON transactions (player_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions (type, id DESC)`,
  `CREATE TABLE IF NOT EXISTS jackpot_wins (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     player_id  INTEGER NOT NULL,
     machine_id TEXT NOT NULL,
     amount     INTEGER NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
];

export async function migrate(db) {
  for (const sql of STATEMENTS) await db.execute(sql);

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
  }

  for (const [i, m] of DEFAULT_MACHINES.entries()) {
    await db.execute('INSERT OR IGNORE INTO machines (id, sort, config, jackpot) VALUES (?, ?, ?, ?)', [
      m.id,
      i,
      JSON.stringify(m),
      m.jackpotSeed,
    ]);
  }
}
