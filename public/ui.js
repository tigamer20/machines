// Small helpers shared by the player app and the admin panel.

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error('Network error. Check your connection.'), { status: 0 });
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

let symbol = '$';
export const setCurrency = (s) => (symbol = s || '$');

// Amounts are cents. Whole amounts drop the decimals.
export function fmt(cents, { sign = false } = {}) {
  const n = Number(cents) || 0;
  const abs = Math.abs(n) / 100;
  const str = abs.toLocaleString('en-US', {
    minimumFractionDigits: abs % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  });
  const prefix = n < 0 ? '−' : sign && n > 0 ? '+' : '';
  return `${prefix}${symbol}${str}`;
}

export const toCents = (v) => Math.round(Number(String(v).replace(/[^0-9.\-]/g, '')) * 100);

export function toast(message, type = '') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

export function parseDate(s) {
  return s ? new Date(s.replace(' ', 'T') + 'Z') : null;
}

export function timeAgo(s) {
  const d = parseDate(s);
  if (!d) return 'never';
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days} d ago`;
  return d.toLocaleDateString();
}

// Animates the text of el from one amount (cents) to another.
export function countUp(el, from, to, duration = 700) {
  if (!el) return;
  if (el._raf) cancelAnimationFrame(el._raf);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = fmt(Math.round(from + (to - from) * eased));
    if (t < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

export const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
};

export function confetti(canvas, duration = 4000) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
  };
  resize();
  const colors = ['#fbbf24', '#f59e0b', '#8b5cf6', '#22c55e', '#f43f5e', '#38bdf8', '#ffffff'];
  const parts = Array.from({ length: 160 }, () => ({
    x: canvas.width / 2,
    y: canvas.height * 0.45,
    vx: (Math.random() - 0.5) * 22 * dpr,
    vy: (Math.random() * -18 - 6) * dpr,
    s: (Math.random() * 6 + 4) * dpr,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const start = performance.now();
  const frame = (now) => {
    if (!canvas.isConnected) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.vy += 0.45 * dpr;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    if (now - start < duration) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
  requestAnimationFrame(frame);
}
