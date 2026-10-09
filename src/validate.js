import { DEFAULT_SETTINGS } from './defaults.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => {
  throw new HttpError(400, msg);
};

const MAX_MONEY = 1_000_000_000_00; // 1 billion, in cents
const HEX = /^#[0-9a-f]{6}$/i;

export function money(v, label, { min = 0, allowNegative = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) bad(`${label} must be a number`);
  const cents = Math.round(n);
  if (!allowNegative && cents < min) bad(`${label} must be at least ${min / 100}`);
  if (Math.abs(cents) > MAX_MONEY) bad(`${label} is too large`);
  return cents;
}

function text(v, label, max, { required = true } = {}) {
  const s = String(v ?? '').trim();
  if (required && !s) bad(`${label} is required`);
  if (s.length > max) bad(`${label} must be ${max} characters or fewer`);
  return s;
}

export function playerName(v) {
  return text(v, 'Name', 40);
}

export function validateMachine(input, id) {
  if (!input || typeof input !== 'object') bad('Invalid machine');
  const reels = Number(input.reels);
  if (![3, 4, 5].includes(reels)) bad('Reels must be 3, 4 or 5');

  const theme = input.theme || {};
  for (const k of ['from', 'to', 'accent']) {
    if (!HEX.test(theme[k] || '')) bad(`Theme color "${k}" must look like #12ab34`);
  }

  if (!Array.isArray(input.bets) || input.bets.length < 1 || input.bets.length > 8) {
    bad('Provide between 1 and 8 bet sizes');
  }
  const bets = [...new Set(input.bets.map((b) => money(b, 'Bet', { min: 1 })))].sort((a, b) => a - b);

  if (!Array.isArray(input.symbols) || input.symbols.length < 3 || input.symbols.length > 10) {
    bad('A machine needs between 3 and 10 symbols');
  }
  const seen = new Set();
  const symbols = input.symbols.map((sym, i) => {
    const s = text(sym.s, `Symbol #${i + 1}`, 16);
    if (seen.has(s)) bad(`Symbol ${s} is used twice`);
    seen.add(s);
    const weight = Number(sym.weight);
    if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
      bad(`Weight of ${s} must be a whole number between 1 and 1000`);
    }
    const pays = {};
    for (const [k, v] of Object.entries(sym.pays || {})) {
      const count = Number(k);
      const mult = Number(v);
      if (!Number.isInteger(count) || count < 1 || count > reels) continue;
      if (!Number.isFinite(mult) || mult < 0 || mult > 1_000_000) bad(`Payout for ${s} x${count} is invalid`);
      if (mult > 0) pays[count] = Math.round(mult * 100) / 100;
    }
    return { s, name: text(sym.name, `Name of ${s}`, 24, { required: false }) || s, weight, pays };
  });

  const jackpotSymbol = String(input.jackpotSymbol || '');
  if (!seen.has(jackpotSymbol)) bad('The jackpot symbol must be one of the symbols');

  const contribution = Number(input.jackpotContribution);
  if (!Number.isFinite(contribution) || contribution < 0 || contribution > 50) {
    bad('Jackpot contribution must be between 0 and 50 %');
  }

  return {
    id,
    name: text(input.name, 'Name', 40),
    tagline: text(input.tagline, 'Tagline', 80, { required: false }),
    enabled: Boolean(input.enabled),
    reels,
    theme: { from: theme.from, to: theme.to, accent: theme.accent },
    bets,
    jackpotSymbol,
    jackpotSeed: money(input.jackpotSeed, 'Jackpot seed'),
    jackpotContribution: Math.round(contribution * 100) / 100,
    symbols,
  };
}

export function validateSettings(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    switch (key) {
      case 'siteName':
        out[key] = text(value, 'Site name', 40);
        break;
      case 'currencySymbol':
        out[key] = text(value, 'Currency symbol', 4);
        break;
      case 'closedMessage':
        out[key] = text(value, 'Closed message', 200, { required: false });
        break;
      case 'announcement':
        out[key] = text(value, 'Announcement', 200, { required: false });
        break;
      case 'startingBalance':
        out[key] = money(value, 'Starting balance');
        break;
      case 'spinDuration': {
        const n = Math.round(Number(value));
        if (!(n >= 400 && n <= 6000)) bad('Spin duration must be between 400 and 6000 ms');
        out[key] = n;
        break;
      }
      case 'maxAutoSpins': {
        const n = Math.round(Number(value));
        if (!(n >= 0 && n <= 500)) bad('Max auto-spins must be between 0 and 500');
        out[key] = n;
        break;
      }
      default:
        out[key] = Boolean(value);
    }
  }
  return out;
}
