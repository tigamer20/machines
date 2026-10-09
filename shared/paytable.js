// Pure paytable logic shared by the server (spin resolution) and the browser
// (paytable display, live odds in the admin editor). No Node or DOM imports.

export function totalWeight(cfg) {
  return cfg.symbols.reduce((t, s) => t + s.weight, 0);
}

// Pays are keyed by the number of identical symbols in a row on the payline,
// starting from the leftmost reel. Only the exact count is paid.
export function evaluateLine(line, cfg) {
  const n = cfg.reels;
  if (line.every((s) => s === cfg.jackpotSymbol)) {
    return { jackpot: true, mult: 0, count: n, symbol: cfg.jackpotSymbol };
  }
  const first = line[0];
  let count = 1;
  while (count < n && line[count] === first) count++;
  const sym = cfg.symbols.find((s) => s.s === first);
  const mult = Number(sym?.pays?.[count]) || 0;
  return { jackpot: false, mult, count, symbol: first };
}

// Exact probabilities, given every reel uses the same weighted strip.
export function analyze(cfg) {
  const total = totalWeight(cfg);
  const n = cfg.reels;
  let rtp = 0;
  let hit = 0;
  let jackpotProb = 0;
  const rows = [];
  for (const sym of cfg.symbols) {
    const p = total > 0 ? sym.weight / total : 0;
    for (let k = 1; k <= n; k++) {
      const prob = k < n ? p ** k * (1 - p) : p ** n;
      if (sym.s === cfg.jackpotSymbol && k === n) {
        jackpotProb = prob;
        continue;
      }
      const mult = Number(sym.pays?.[k]) || 0;
      if (mult > 0) {
        hit += prob;
        rtp += prob * mult;
        rows.push({ symbol: sym.s, count: k, mult, prob });
      }
    }
  }
  return {
    rtp,
    hitRate: hit + jackpotProb,
    jackpotProb,
    jackpotOdds: jackpotProb > 0 ? Math.round(1 / jackpotProb) : Infinity,
    rows,
  };
}
