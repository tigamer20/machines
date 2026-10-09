// Database access. In production this talks to Turso through its HTTP API
// (Hrana over HTTP, https://docs.turso.tech/sdk/http/reference) using plain
// fetch, so the app needs no third-party packages. Without TURSO_DATABASE_URL
// it falls back to a local SQLite file via Node's built-in node:sqlite.
//
// Both backends expose the same interface:
//   execute(sql, args)  -> { rows: [{col: value}], rowsAffected, lastInsertRowid }
//   batch([{sql, args}]) -> runs all statements in one transaction (all or nothing)

import fs from 'node:fs';
import path from 'node:path';

function encodeArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  }
  return { type: 'text', value: String(v) };
}

function decodeValue(c) {
  switch (c.type) {
    case 'null':
      return null;
    case 'integer':
      return Number(c.value);
    case 'blob':
      return Buffer.from(c.base64, 'base64');
    default:
      return c.value;
  }
}

function decodeResult(r) {
  const cols = r.cols.map((c) => c.name);
  return {
    rows: r.rows.map((row) => Object.fromEntries(row.map((v, i) => [cols[i], decodeValue(v)]))),
    rowsAffected: r.affected_row_count,
    lastInsertRowid: r.last_insert_rowid == null ? null : Number(r.last_insert_rowid),
  };
}

class TursoDb {
  constructor(url, token) {
    this.kind = 'turso';
    this.base = url.trim().replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
    this.token = token?.trim();
  }

  async pipeline(requests) {
    const res = await fetch(`${this.base}/v2/pipeline`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ requests: [...requests, { type: 'close' }] }),
    });
    if (!res.ok) {
      throw new Error(`Turso HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json();
    return body.results;
  }

  async execute(sql, args = []) {
    const [r] = await this.pipeline([{ type: 'execute', stmt: { sql, args: args.map(encodeArg) } }]);
    if (r.type === 'error') throw new Error(r.error.message);
    return decodeResult(r.response.result);
  }

  async batch(stmts) {
    // BEGIN, each statement only if the previous step succeeded, COMMIT if the
    // last one succeeded, otherwise ROLLBACK.
    const steps = [{ stmt: { sql: 'BEGIN' } }];
    stmts.forEach((s, i) => {
      steps.push({
        stmt: { sql: s.sql, args: (s.args || []).map(encodeArg) },
        condition: { type: 'ok', step: i },
      });
    });
    const last = steps.length - 1;
    steps.push({ stmt: { sql: 'COMMIT' }, condition: { type: 'ok', step: last } });
    steps.push({
      stmt: { sql: 'ROLLBACK' },
      condition: { type: 'not', cond: { type: 'ok', step: last + 1 } },
    });

    const [r] = await this.pipeline([{ type: 'batch', batch: { steps } }]);
    if (r.type === 'error') throw new Error(r.error.message);
    const { step_results: results, step_errors: errors } = r.response.result;
    const err = errors.find(Boolean);
    if (err) throw new Error(err.message);
    if (!results[last + 1]) throw new Error('Transaction was not committed');
    return results.slice(1, last + 1).map(decodeResult);
  }
}

const READS_ROWS = /^\s*(SELECT|WITH|PRAGMA)\b|\bRETURNING\b/i;

class LocalDb {
  constructor(DatabaseSync, file) {
    this.kind = 'local';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
  }

  run(sql, args = []) {
    const stmt = this.db.prepare(sql);
    const params = args.map((v) => (typeof v === 'boolean' ? Number(v) : v === undefined ? null : v));
    if (READS_ROWS.test(sql)) {
      return { rows: stmt.all(...params), rowsAffected: 0, lastInsertRowid: null };
    }
    const info = stmt.run(...params);
    return { rows: [], rowsAffected: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
  }

  async execute(sql, args) {
    return this.run(sql, args);
  }

  async batch(stmts) {
    this.db.exec('BEGIN');
    try {
      const out = stmts.map((s) => this.run(s.sql, s.args));
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

// Catches the most common setup mistakes before the first query.
function checkTursoEnv(url, token) {
  const u = url.trim();
  if (!/^(libsql|https?):\/\//.test(u)) {
    throw new Error('TURSO_DATABASE_URL must start with libsql:// (copy the URL from the Turso dashboard)');
  }
  const t = (token || '').trim().replace(/^Bearer\s+/i, '');
  if (!t) throw new Error('TURSO_AUTH_TOKEN is empty. Create a token in the Turso dashboard and set it.');
  if (t.includes('://') || t.startsWith('libsql')) {
    throw new Error('TURSO_AUTH_TOKEN contains a URL. Put the database URL in TURSO_DATABASE_URL and the token (starts with "eyJ") in TURSO_AUTH_TOKEN.');
  }
  if (t.split('.').length !== 3) {
    throw new Error('TURSO_AUTH_TOKEN does not look like a Turso token (it should start with "eyJ" and contain two dots). Copy it again without spaces or quotes.');
  }
  return t;
}

export async function openDb() {
  const url = process.env.TURSO_DATABASE_URL;
  if (url) return new TursoDb(url, checkTursoEnv(url, process.env.TURSO_AUTH_TOKEN));
  const { DatabaseSync } = await import('node:sqlite');
  const file = process.env.LOCAL_DB_FILE || path.resolve('data', 'local.db');
  console.warn(`[db] TURSO_DATABASE_URL is not set, using local SQLite file ${file}`);
  return new LocalDb(DatabaseSync, file);
}
