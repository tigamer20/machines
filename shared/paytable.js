// Pure win logic shared by the server (spin resolution) and the browser
// (paytable display, live odds in the admin editor). No Node or DOM imports.
//
// A spin is a grid of `reels` columns x 3 rows (0 = top, 1 = middle, 2 = bottom).
// Ways to win:
//   - Paylines: identical symbols in a row from the left reel along each active
//     line. The bet is split evenly across the active lines.
//   - Wild: substitutes for any regular symbol on a line (not for the jackpot
//     or scatter symbol). A run of wilds also pays by itself.
//   - Scatter: pays by the number of reels showing it anywhere, times the bet.
//   - Jackpot: every cell of an active line shows the jackpot symbol.

export const LINE_PATTERNS = {
  3: [
    [1, 1, 1],
    [0, 0, 0],
    [2, 2, 2],
    [0, 1, 2],
    [2, 1, 0],
  ],
  4: [
    [1, 1, 1, 1],
    [0, 0, 0, 0],
    [2, 2, 2, 2],
    [0, 1, 1, 0],
    [2, 1, 1, 2],
    [0, 0, 1, 2],
    [2, 2, 1, 0],
  ],
  5: [
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0],
    [2, 2, 2, 2, 2],
    [0, 1, 2, 1, 0],
    [2, 1, 0, 1, 2],
    [0, 0, 1, 2, 2],
    [2, 2, 1, 0, 0],
    [1, 0, 0, 0, 1],
    [1, 2, 2, 2, 1],
  ],
};

export const LINE_COLORS = ['#fde047', '#38bdf8', '#f472b6', '#4ade80', '#fb923c', '#a78bfa', '#f87171', '#2dd4bf', '#facc15'];

export const maxLines = (reels) => LINE_PATTERNS[reels]?.length || 1;

export function activeLines(cfg) {
  const all = LINE_PATTERNS[cfg.reels] || [Array(cfg.reels).fill(1)];
  const n = Math.min(Math.max(Math.round(Number(cfg.lines) || 1), 1), all.length);
  return all.slice(0, n);
}

export function totalWeight(cfg) {
  return cfg.symbols.reduce((t, s) => t + (Number(s.weight) || 0), 0);
}

function payOf(cfg, symbol, count) {
  return Number(cfg.symbols.find((x) => x.s === symbol)?.pays?.[count]) || 0;
}

// Best win on one line: { jackpot, mult, count, symbol }.
export function evaluateLine(line, cfg) {
  const n = line.length;
  if (line.every((s) => s === cfg.jackpotSymbol)) {
    return { jackpot: true, mult: 0, count: n, symbol: cfg.jackpotSymbol };
  }
  const wild = cfg.wildSymbol || null;
  let best = { jackpot: false, mult: 0, count: 0, symbol: null };

  if (wild && line[0] === wild) {
    let k = 0;
    while (k < n && line[k] === wild) k++;
    const mult = payOf(cfg, wild, k);
    if (mult > best.mult) best = { jackpot: false, mult, count: k, symbol: wild };
  }

  const target = line.find((s) => s !== wild);
  if (target && target !== cfg.scatterSymbol) {
    const substitutes = wild && target !== cfg.jackpotSymbol;
    let k = 0;
    while (k < n && (line[k] === target || (substitutes && line[k] === wild))) k++;
    const mult = k ? payOf(cfg, target, k) : 0;
    if (mult > best.mult) best = { jackpot: false, mult, count: k, symbol: target };
  }
  return best;
}

// Evaluates a full grid. Amounts are in the same unit as bet (cents).
export function evaluateSpin(grid, cfg, bet) {
  const lines = activeLines(cfg);
  const lineBet = bet / lines.length;
  const wins = [];
  let jackpot = false;

  lines.forEach((pattern, index) => {
    const line = pattern.map((row, reel) => grid[reel][row]);
    const r = evaluateLine(line, cfg);
    if (r.jackpot) {
      jackpot = true;
      wins.push({ type: 'jackpot', line: index, cells: pattern.map((row, reel) => [reel, row]), symbol: r.symbol, count: r.count, amount: 0 });
    } else if (r.mult > 0) {
      wins.push({
        type: 'line',
        line: index,
        cells: pattern.slice(0, r.count).map((row, reel) => [reel, row]),
        symbol: r.symbol,
        count: r.count,
        mult: r.mult,
        amount: Math.floor(r.mult * lineBet),
      });
    }
  });

  if (cfg.scatterSymbol) {
    const reelsHit = grid.filter((col) => col.includes(cfg.scatterSymbol)).length;
    const mult = payOf(cfg, cfg.scatterSymbol, reelsHit);
    if (mult > 0) {
      const cells = [];
      grid.forEach((col, reel) => col.forEach((s, row) => s === cfg.scatterSymbol && cells.push([reel, row])));
      wins.push({ type: 'scatter', line: null, cells, symbol: cfg.scatterSymbol, count: reelsHit, mult, amount: Math.floor(mult * bet) });
    }
  }

  return { wins, jackpot, total: wins.reduce((t, w) => t + w.amount, 0) };
}

// Exact odds for one line (enumerating every combination) and for the
// scatter. Whole-spin hit rate and jackpot odds treat lines as independent,
// which is a close approximation.
export function analyze(cfg) {
  const total = totalWeight(cfg);
  const n = cfg.reels;
  const L = activeLines(cfg).length;
  const symbols = cfg.symbols.filter((s) => Number(s.weight) > 0);
  const probs = symbols.map((s) => (total > 0 ? Number(s.weight) / total : 0));

  let lineRtp = 0;
  let lineHit = 0;
  let lineJackpot = 0;
  const combo = new Array(n);
  const idx = new Array(n).fill(0);
  const S = symbols.length;
  if (S > 0 && S ** n <= 2_000_000) {
    for (;;) {
      let p = 1;
      for (let i = 0; i < n; i++) {
        combo[i] = symbols[idx[i]].s;
        p *= probs[idx[i]];
      }
      if (p > 0) {
        const r = evaluateLine(combo, cfg);
        if (r.jackpot) lineJackpot += p;
        else if (r.mult > 0) {
          lineHit += p;
          lineRtp += p * r.mult;
        }
      }
      let k = n - 1;
      while (k >= 0 && ++idx[k] === S) idx[k--] = 0;
      if (k < 0) break;
    }
  }

  let scatterRtp = 0;
  let scatterHit = 0;
  if (cfg.scatterSymbol) {
    const q = (Number(symbols.find((s) => s.s === cfg.scatterSymbol)?.weight) || 0) / (total || 1);
    const onReel = 1 - (1 - q) ** 3;
    for (let k = 1; k <= n; k++) {
      const mult = payOf(cfg, cfg.scatterSymbol, k);
      if (!mult) continue;
      const p = binom(n, k) * onReel ** k * (1 - onReel) ** (n - k);
      scatterRtp += p * mult;
      scatterHit += p;
    }
  }

  const jackpotProb = 1 - (1 - lineJackpot) ** L;
  const hitRate = 1 - (1 - lineHit - lineJackpot) ** L * (1 - scatterHit);
  return {
    rtp: lineRtp + scatterRtp,
    lineRtp,
    scatterRtp,
    lines: L,
    hitRate,
    jackpotProb,
    jackpotOdds: jackpotProb > 0 ? Math.round(1 / jackpotProb) : Infinity,
  };
}

function binom(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}
