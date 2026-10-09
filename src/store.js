import { randomInt } from 'node:crypto';
import { evaluateLine, analyze, totalWeight } from '../shared/paytable.js';
import { DEFAULT_MACHINES } from './defaults.js';
import { HttpError } from './validate.js';

const PLAYER_COLS = `id, code, name, balance, active, spins, wagered, won, biggest_win, jackpots,
  bj_hands, bj_net, adjustments, created_at, last_seen`;

const ACTIVITY_TYPES = {
  all: null,
  spins: ['spin', 'jackpot'],
  jackpot: ['jackpot'],
  blackjack: ['blackjack'],
  adjust: ['adjust', 'start', 'void'],
};

function pickSymbol(symbols, total) {
  let r = randomInt(total);
  for (const s of symbols) {
    if (r < s.weight) return s.s;
    r -= s.weight;
  }
  return symbols[symbols.length - 1].s;
}

// Each reel shows three cells; only the middle row is the payline.
export function resolveSpin(cfg, bet, jackpot) {
  const total = totalWeight(cfg);
  const grid = Array.from({ length: cfg.reels }, () => [0, 1, 2].map(() => pickSymbol(cfg.symbols, total)));
  const line = grid.map((col) => col[1]);
  const result = evaluateLine(line, cfg);

  let pot = jackpot + Math.floor((bet * cfg.jackpotContribution) / 100);
  let win = Math.floor(bet * result.mult);
  let jackpotWin = 0;
  if (result.jackpot) {
    jackpotWin = pot;
    win += pot;
    pot = cfg.jackpotSeed;
  }
  return { grid, line, win, jackpotWin, jackpot: pot, count: result.count, mult: result.mult };
}

export class Store {
  constructor(db) {
    this.db = db;
    this.settings = {};
    this.machines = new Map(); // id -> { config, jackpot, sort }
    this.queue = Promise.resolve();
  }

  async load() {
    const s = await this.db.execute('SELECT key, value FROM settings');
    this.settings = Object.fromEntries(s.rows.map((r) => [r.key, JSON.parse(r.value)]));
    const m = await this.db.execute('SELECT id, sort, config, jackpot FROM machines ORDER BY sort');
    this.machines = new Map(m.rows.map((r) => [r.id, { config: JSON.parse(r.config), jackpot: r.jackpot, sort: r.sort }]));
  }

  // Serializes every operation that moves money. The app runs as a single
  // instance, so this is enough to make read-modify-write sequences safe.
  exclusive(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  money(cents) {
    const units = (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
    return (this.settings.currencySymbol || '$') + units;
  }

  // ---------- public data ----------

  publicConfig() {
    const { siteName, currencySymbol, allowSignup, slotsOpen, closedMessage, announcement, showLeaderboard, spinDuration, maxAutoSpins } =
      this.settings;
    const machines = [...this.machines.values()]
      .filter((m) => m.config.enabled)
      .map(({ config: c, jackpot }) => ({
        id: c.id,
        name: c.name,
        tagline: c.tagline,
        reels: c.reels,
        theme: c.theme,
        bets: c.bets,
        jackpotSymbol: c.jackpotSymbol,
        symbols: c.symbols.map(({ s, name, weight, pays }) => ({ s, name, weight, pays })),
        jackpot,
      }));
    return {
      settings: { siteName, currencySymbol, allowSignup, slotsOpen, closedMessage, announcement, showLeaderboard, spinDuration, maxAutoSpins },
      machines,
    };
  }

  jackpots() {
    return Object.fromEntries([...this.machines].map(([id, m]) => [id, m.jackpot]));
  }

  async recentJackpots(limit = 8) {
    const r = await this.db.execute(
      `SELECT j.id, j.machine_id, j.amount, j.created_at, COALESCE(p.name, 'Someone') AS name
         FROM jackpot_wins j LEFT JOIN players p ON p.id = j.player_id
        ORDER BY j.id DESC LIMIT ?`,
      [limit]
    );
    return r.rows.map((row) => ({ ...row, machine: this.machines.get(row.machine_id)?.config.name || row.machine_id }));
  }

  async leaderboard() {
    const r = await this.db.execute(
      `SELECT id, name, balance, jackpots FROM players WHERE active = 1 ORDER BY balance DESC, id LIMIT 10`
    );
    return r.rows;
  }

  // ---------- players ----------

  async getPlayer(id) {
    const r = await this.db.execute(`SELECT ${PLAYER_COLS} FROM players WHERE id = ?`, [id]);
    return r.rows[0] || null;
  }

  async getPlayerByCode(code) {
    const r = await this.db.execute(`SELECT ${PLAYER_COLS} FROM players WHERE code = ?`, [code]);
    return r.rows[0] || null;
  }

  async touch(id) {
    await this.db.execute(`UPDATE players SET last_seen = datetime('now') WHERE id = ?`, [id]);
  }

  async uniqueCode() {
    for (let i = 0; i < 50; i++) {
      const code = String(randomInt(0, 100000)).padStart(5, '0');
      if (!(await this.getPlayerByCode(code))) return code;
    }
    throw new HttpError(500, 'Could not generate a free code, try again');
  }

  async createPlayer(name, balance) {
    return this.exclusive(async () => {
      const code = await this.uniqueCode();
      const [ins] = await this.db.batch([
        { sql: 'INSERT INTO players (code, name, balance) VALUES (?, ?, ?)', args: [code, name, balance] },
        {
          sql: `INSERT INTO transactions (player_id, type, amount, balance_after, note)
                VALUES (last_insert_rowid(), 'start', ?, ?, 'Starting balance')`,
          args: [balance, balance],
        },
      ]);
      return this.getPlayer(ins.lastInsertRowid);
    });
  }

  async playerDetails(id, txLimit = 30) {
    const player = await this.getPlayer(id);
    if (!player) throw new HttpError(404, 'Player not found');
    const [ms, tx] = await Promise.all([
      this.db.execute(
        'SELECT machine_id, spins, wagered, won, jackpots FROM machine_stats WHERE player_id = ? ORDER BY spins DESC',
        [id]
      ),
      this.db.execute(
        `SELECT id, type, machine_id, amount, bet, win, balance_after, note, voided, created_at
           FROM transactions WHERE player_id = ? ORDER BY id DESC LIMIT ?`,
        [id, txLimit]
      ),
    ]);
    const name = (mid) => this.machines.get(mid)?.config.name || mid;
    return {
      player,
      machines: ms.rows.map((r) => ({ ...r, name: name(r.machine_id) })),
      transactions: tx.rows.map((r) => ({ ...r, machine: r.machine_id ? name(r.machine_id) : null })),
    };
  }

  async listPlayers(q) {
    const term = String(q || '').trim();
    const r = await this.db.execute(
      `SELECT ${PLAYER_COLS} FROM players
        WHERE ? = '' OR name LIKE ? OR code LIKE ?
        ORDER BY last_seen IS NULL, last_seen DESC, id DESC LIMIT 300`,
      [term, `%${term}%`, `${term}%`]
    );
    return r.rows;
  }

  async updatePlayer(id, { name, active }) {
    const p = await this.getPlayer(id);
    if (!p) throw new HttpError(404, 'Player not found');
    await this.db.execute('UPDATE players SET name = ?, active = ? WHERE id = ?', [
      name ?? p.name,
      active === undefined ? p.active : active ? 1 : 0,
      id,
    ]);
    return this.getPlayer(id);
  }

  async regenerateCode(id) {
    return this.exclusive(async () => {
      if (!(await this.getPlayer(id))) throw new HttpError(404, 'Player not found');
      const code = await this.uniqueCode();
      await this.db.execute('UPDATE players SET code = ? WHERE id = ?', [code, id]);
      return this.getPlayer(id);
    });
  }

  async deletePlayer(id) {
    return this.exclusive(() =>
      this.db.batch([
        { sql: 'DELETE FROM transactions WHERE player_id = ?', args: [id] },
        { sql: 'DELETE FROM machine_stats WHERE player_id = ?', args: [id] },
        { sql: 'DELETE FROM players WHERE id = ?', args: [id] },
      ])
    );
  }

  // ---------- money ----------

  async spin(playerId, machineId, bet) {
    return this.exclusive(async () => {
      if (!this.settings.slotsOpen) throw new HttpError(403, this.settings.closedMessage || 'The machines are closed');
      const machine = this.machines.get(machineId);
      if (!machine || !machine.config.enabled) throw new HttpError(404, 'This machine is not available');
      const cfg = machine.config;
      if (!cfg.bets.includes(bet)) throw new HttpError(400, 'Invalid bet for this machine');

      const player = await this.getPlayer(playerId);
      if (!player || !player.active) throw new HttpError(401, 'Your account is not active');
      if (player.balance < bet) throw new HttpError(400, 'Not enough money for this bet');

      const r = resolveSpin(cfg, bet, machine.jackpot);
      const balance = player.balance - bet + r.win;
      const isJackpot = r.jackpotWin > 0 ? 1 : 0;

      const stmts = [
        {
          sql: `UPDATE players SET balance = ?, spins = spins + 1, wagered = wagered + ?, won = won + ?,
                  biggest_win = MAX(biggest_win, ?), jackpots = jackpots + ?, last_seen = datetime('now')
                WHERE id = ?`,
          args: [balance, bet, r.win, r.win, isJackpot, player.id],
        },
        {
          sql: `INSERT INTO machine_stats (player_id, machine_id, spins, wagered, won, jackpots)
                VALUES (?, ?, 1, ?, ?, ?)
                ON CONFLICT (player_id, machine_id) DO UPDATE SET
                  spins = spins + 1, wagered = wagered + excluded.wagered,
                  won = won + excluded.won, jackpots = jackpots + excluded.jackpots`,
          args: [player.id, cfg.id, bet, r.win, isJackpot],
        },
        { sql: 'UPDATE machines SET jackpot = ? WHERE id = ?', args: [r.jackpot, cfg.id] },
        {
          sql: `INSERT INTO transactions (player_id, type, machine_id, amount, bet, win, balance_after)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [player.id, isJackpot ? 'jackpot' : 'spin', cfg.id, r.win - bet, bet, r.win, balance],
        },
      ];
      if (isJackpot) {
        stmts.push({
          sql: 'INSERT INTO jackpot_wins (player_id, machine_id, amount) VALUES (?, ?, ?)',
          args: [player.id, cfg.id, r.jackpotWin],
        });
      }
      await this.db.batch(stmts);
      machine.jackpot = r.jackpot;

      return {
        grid: r.grid,
        win: r.win,
        jackpotWin: r.jackpotWin,
        count: r.count,
        mult: r.mult,
        balance,
        jackpot: r.jackpot,
      };
    });
  }

  // Credits (positive) or debits (negative) a player. type is 'blackjack' or 'adjust'.
  async adjust(playerId, amount, type, note) {
    return this.exclusive(async () => {
      const player = await this.getPlayer(playerId);
      if (!player) throw new HttpError(404, 'Player not found');
      const balance = player.balance + amount;
      if (balance < 0) throw new HttpError(400, `${player.name} only has ${this.money(player.balance)}`);

      const statCol = type === 'blackjack' ? 'bj_hands = bj_hands + 1, bj_net = bj_net + ?' : 'adjustments = adjustments + ?';
      const [, tx] = await this.db.batch([
        { sql: `UPDATE players SET balance = ?, ${statCol} WHERE id = ?`, args: [balance, amount, player.id] },
        {
          sql: `INSERT INTO transactions (player_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)`,
          args: [player.id, type, amount, balance, note || null],
        },
      ]);
      return { player: { ...player, balance }, transactionId: tx.lastInsertRowid };
    });
  }

  async voidTransaction(txId) {
    return this.exclusive(async () => {
      const r = await this.db.execute('SELECT * FROM transactions WHERE id = ?', [txId]);
      const tx = r.rows[0];
      if (!tx) throw new HttpError(404, 'Entry not found');
      if (!['blackjack', 'adjust'].includes(tx.type)) throw new HttpError(400, 'Only blackjack results and adjustments can be undone');
      if (tx.voided) throw new HttpError(400, 'This entry was already undone');

      const player = await this.getPlayer(tx.player_id);
      if (!player) throw new HttpError(404, 'Player not found');
      const balance = player.balance - tx.amount;
      if (balance < 0) throw new HttpError(400, `Undoing this would put ${player.name} below zero`);

      const statCol = tx.type === 'blackjack' ? 'bj_hands = bj_hands - 1, bj_net = bj_net - ?' : 'adjustments = adjustments - ?';
      await this.db.batch([
        { sql: `UPDATE players SET balance = ?, ${statCol} WHERE id = ?`, args: [balance, tx.amount, player.id] },
        { sql: 'UPDATE transactions SET voided = 1 WHERE id = ?', args: [tx.id] },
        {
          sql: `INSERT INTO transactions (player_id, type, amount, balance_after, note) VALUES (?, 'void', ?, ?, ?)`,
          args: [player.id, -tx.amount, balance, `Undo of ${tx.type} entry #${tx.id}`],
        },
      ]);
      return { balance };
    });
  }

  // ---------- admin views ----------

  async activity(filter = 'all', limit = 50, before = null) {
    const types = ACTIVITY_TYPES[filter] ?? null;
    const where = [];
    const args = [];
    if (types) {
      where.push(`t.type IN (${types.map(() => '?').join(',')})`);
      args.push(...types);
    }
    if (before) {
      where.push('t.id < ?');
      args.push(Number(before));
    }
    args.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
    const r = await this.db.execute(
      `SELECT t.*, p.name, p.code FROM transactions t LEFT JOIN players p ON p.id = t.player_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY t.id DESC LIMIT ?`,
      args
    );
    return r.rows.map((row) => ({ ...row, machine: row.machine_id ? this.machines.get(row.machine_id)?.config.name : null }));
  }

  async dashboard() {
    const [totals, perMachine, active] = await Promise.all([
      this.db.execute(
        `SELECT COUNT(*) AS players, COALESCE(SUM(balance), 0) AS balance, COALESCE(SUM(spins), 0) AS spins,
                COALESCE(SUM(wagered), 0) AS wagered, COALESCE(SUM(won), 0) AS won,
                COALESCE(SUM(jackpots), 0) AS jackpots, COALESCE(SUM(bj_hands), 0) AS bj_hands,
                COALESCE(SUM(bj_net), 0) AS bj_net
           FROM players`
      ),
      this.db.execute(
        `SELECT machine_id, SUM(spins) AS spins, SUM(wagered) AS wagered, SUM(won) AS won, SUM(jackpots) AS jackpots
           FROM machine_stats GROUP BY machine_id`
      ),
      this.db.execute(`SELECT COUNT(*) AS n FROM players WHERE last_seen > datetime('now', '-1 day')`),
    ]);
    const stats = Object.fromEntries(perMachine.rows.map((r) => [r.machine_id, r]));
    return {
      totals: { ...totals.rows[0], activeToday: active.rows[0].n },
      machines: [...this.machines.values()].map(({ config: c, jackpot }) => ({
        id: c.id,
        name: c.name,
        enabled: c.enabled,
        jackpot,
        spins: stats[c.id]?.spins || 0,
        wagered: stats[c.id]?.wagered || 0,
        won: stats[c.id]?.won || 0,
        jackpots: stats[c.id]?.jackpots || 0,
      })),
      recentJackpots: await this.recentJackpots(10),
    };
  }

  // ---------- configuration ----------

  adminMachines() {
    return [...this.machines.values()].map(({ config, jackpot }) => ({ config, jackpot, analysis: analyze(config) }));
  }

  async saveMachine(cfg) {
    return this.exclusive(async () => {
      const m = this.machines.get(cfg.id);
      if (!m) throw new HttpError(404, 'Machine not found');
      await this.db.execute('UPDATE machines SET config = ? WHERE id = ?', [JSON.stringify(cfg), cfg.id]);
      m.config = cfg;
      return { config: cfg, jackpot: m.jackpot, analysis: analyze(cfg) };
    });
  }

  async setJackpot(id, amount) {
    return this.exclusive(async () => {
      const m = this.machines.get(id);
      if (!m) throw new HttpError(404, 'Machine not found');
      await this.db.execute('UPDATE machines SET jackpot = ? WHERE id = ?', [amount, id]);
      m.jackpot = amount;
      return { config: m.config, jackpot: amount, analysis: analyze(m.config) };
    });
  }

  async resetMachine(id) {
    const def = DEFAULT_MACHINES.find((m) => m.id === id);
    if (!def) throw new HttpError(404, 'Machine not found');
    return this.saveMachine(structuredClone(def));
  }

  async saveSettings(partial) {
    return this.exclusive(async () => {
      const entries = Object.entries(partial);
      if (entries.length) {
        await this.db.batch(
          entries.map(([key, value]) => ({
            sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
            args: [key, JSON.stringify(value)],
          }))
        );
      }
      Object.assign(this.settings, partial);
      return this.settings;
    });
  }
}
