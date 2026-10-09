import { analyze, activeLines, LINE_COLORS } from '/shared/paytable.js';
import { api, esc, fmt, setCurrency, toast, timeAgo, countUp, storage, confetti } from '/ui.js';

const root = document.getElementById('app');

const state = {
  config: null,
  player: null,
  machines: new Map(),
  timers: [],
  cleanup: [],
};

// ---------- sound ----------

const sound = {
  ctx: null,
  on: storage.get('lm_sound', true),
  ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  },
  tone(freq, dur, type = 'sine', vol = 0.07, when = 0) {
    if (!this.on || !this.ensure()) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  },
  click() {
    this.tone(660, 0.05, 'triangle', 0.05);
  },
  stop() {
    this.tone(180, 0.09, 'square', 0.035);
  },
  win() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.2, 'triangle', 0.08, i * 0.09));
  },
  bigWin() {
    [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.25, 'triangle', 0.09, i * 0.1));
  },
  jackpot() {
    for (let r = 0; r < 3; r++) {
      [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => this.tone(f, 0.22, 'square', 0.05, r * 0.7 + i * 0.08));
    }
  },
  error() {
    this.tone(160, 0.22, 'sawtooth', 0.05);
  },
};

const vibrate = (p) => {
  try {
    navigator.vibrate?.(p);
  } catch {
    /* unsupported */
  }
};

// ---------- helpers ----------

function every(ms, fn) {
  state.timers.push(setInterval(fn, ms));
}

function teardown() {
  state.timers.forEach(clearInterval);
  state.timers = [];
  state.cleanup.forEach((fn) => fn());
  state.cleanup = [];
}

function setBalance(cents, { bump = false } = {}) {
  const prev = state.player.balance;
  state.player.balance = cents;
  document.querySelectorAll('[data-balance]').forEach((el) => {
    if (bump && cents > prev) countUp(el, prev, cents, 600);
    else el.textContent = fmt(cents);
    if (bump) {
      const pill = el.closest('.balance-pill');
      pill?.classList.remove('bump');
      void pill?.offsetWidth;
      pill?.classList.add('bump');
    }
  });
}

function balancePill() {
  return `<a class="balance-pill num" href="#/stats" aria-label="Your balance">
    <span class="coin">${esc(state.config.settings.currencySymbol.slice(0, 1))}</span>
    <span data-balance>${fmt(state.player.balance)}</span></a>`;
}

function shell(active, content) {
  const s = state.config.settings;
  const nav = [
    ['lobby', '#/', '🎰', 'Machines'],
    ...(s.blackjackTable ? [['table', '#/table', '🃏', 'Blackjack']] : []),
    ['stats', '#/stats', '📊', 'My stats'],
    ...(s.showLeaderboard ? [['leaders', '#/leaders', '🏆', 'Leaders']] : []),
  ];
  return `<div class="app">
    <header class="topbar">
      <div class="container topbar-inner">
        <a class="brand" href="#/"><span class="brand-logo">🎰</span><span class="brand-name">${esc(s.siteName)}</span></a>
        <nav class="topnav">${nav.map(([k, href, , label]) => `<a href="${href}" class="${k === active ? 'active' : ''}">${label}</a>`).join('')}
          <a href="#" data-logout>Log out</a></nav>
        <span class="spacer"></span>
        ${balancePill()}
      </div>
    </header>
    <main class="container">${content}</main>
    <nav class="tabbar">
      ${nav.map(([k, href, icon, label]) => `<a href="${href}" class="${k === active ? 'active' : ''}"><span class="ti">${icon}</span>${label}</a>`).join('')}
      <button type="button" data-logout><span class="ti">🚪</span>Log out</button>
    </nav></div>`;
}

function bindLogout() {
  root.querySelectorAll('[data-logout]').forEach((el) =>
    el.addEventListener('click', async (e) => {
      e.preventDefault();
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      state.player = null;
      location.hash = '#/';
      render();
    })
  );
}

function symbolPicker(m) {
  const total = m.symbols.reduce((t, s) => t + s.weight, 0);
  return () => {
    let r = Math.random() * total;
    for (const s of m.symbols) {
      if (r < s.weight) return s.s;
      r -= s.weight;
    }
    return m.symbols[0].s;
  };
}

function themeVars(m) {
  return `--from:${m.theme.from};--to:${m.theme.to};--accent:${m.theme.accent}`;
}

// ---------- login ----------

function renderLogin() {
  const s = state.config.settings;
  let code = '';
  let busy = false;

  root.innerHTML = `
    <div class="login">
      <div class="login-card">
        <div class="login-logo">🎰</div>
        <h1>${esc(s.siteName)}</h1>
        <p>Enter your 5-digit code to play</p>
        <div class="code-boxes" id="boxes" role="group" aria-label="Your code">
          ${'<div class="code-box num"></div>'.repeat(5)}
        </div>
        <div class="login-msg" id="msg" role="alert"></div>
        <div class="keypad" id="keypad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button class="key" data-k="${n}">${n}</button>`).join('')}
          <button class="key fn" data-k="back" aria-label="Delete">⌫</button>
          <button class="key" data-k="0">0</button>
          <button class="key go" data-k="go" aria-label="Enter">→</button>
        </div>
        ${s.allowSignup ? '<button class="link-btn" id="signup">New here? Get a code</button>' : ''}
        <p class="muted" style="margin-top:22px;font-size:13px">Play money only. No real money is involved.</p>
      </div>
    </div>`;

  const boxes = root.querySelector('#boxes');
  const msg = root.querySelector('#msg');

  const paint = () => {
    [...boxes.children].forEach((b, i) => {
      b.textContent = code[i] ? '•' : '';
      b.classList.toggle('filled', i < code.length);
      b.classList.toggle('current', i === code.length);
    });
  };

  const submit = async () => {
    if (busy || code.length !== 5) return;
    busy = true;
    try {
      const { player } = await api('/api/login', { method: 'POST', body: { code } });
      boxes.classList.add('ok');
      state.player = player;
      setTimeout(render, 250);
    } catch (e) {
      msg.textContent = e.message;
      boxes.classList.remove('shake');
      void boxes.offsetWidth;
      boxes.classList.add('shake');
      vibrate(120);
      code = '';
      paint();
    } finally {
      busy = false;
    }
  };

  const press = (k) => {
    if (busy) return;
    msg.textContent = '';
    if (k === 'back') code = code.slice(0, -1);
    else if (k === 'go') return submit();
    else if (/^\d$/.test(k) && code.length < 5) code += k;
    paint();
    if (code.length === 5) submit();
  };

  root.querySelector('#keypad').addEventListener('click', (e) => {
    const key = e.target.closest('[data-k]');
    if (key) press(key.dataset.k);
  });
  const onKey = (e) => {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('back');
    else if (e.key === 'Enter') press('go');
  };
  document.addEventListener('keydown', onKey);
  state.cleanup.push(() => document.removeEventListener('keydown', onKey));
  root.querySelector('#signup')?.addEventListener('click', renderSignup);
  paint();
}

function renderSignup() {
  teardown();
  root.innerHTML = `
    <div class="login">
      <form class="login-card" id="form">
        <div class="login-logo">✨</div>
        <h1>Get your code</h1>
        <p>You will start with ${fmt(state.config.settings.startingBalance)} in play money.</p>
        <label class="field" style="text-align:left">
          <span>Your name</span>
          <input class="input" name="name" maxlength="40" autocomplete="nickname" required autofocus />
        </label>
        <div class="login-msg" id="msg" role="alert"></div>
        <button class="btn btn-primary btn-lg btn-block">Create my code</button>
        <button type="button" class="link-btn" id="back">I already have a code</button>
      </form>
    </div>`;
  root.querySelector('#back').addEventListener('click', render);
  root.querySelector('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('.btn');
    btn.disabled = true;
    try {
      const { player } = await api('/api/signup', { method: 'POST', body: { name: e.target.name.value } });
      state.player = player;
      root.innerHTML = `
        <div class="login"><div class="login-card">
          <div class="login-logo">🔑</div>
          <h1>Welcome, ${esc(player.name)}!</h1>
          <p>This is your personal code. Write it down: you need it to come back.</p>
          <div class="new-code num">${esc(player.code)}</div>
          <button class="btn btn-primary btn-lg btn-block" id="go">Start playing</button>
        </div></div>`;
      root.querySelector('#go').addEventListener('click', () => {
        location.hash = '#/';
        render();
      });
    } catch (err) {
      root.querySelector('#msg').textContent = err.message;
      btn.disabled = false;
    }
  });
}

// ---------- lobby ----------

function renderLobby() {
  const s = state.config.settings;
  const machines = state.config.machines;

  root.innerHTML = shell(
    'lobby',
    `
    <h1 class="page-title">Hi ${esc(state.player.name)} 👋</h1>
    <p class="page-sub">Pick a machine. Every machine has its own progressive jackpot.</p>
    ${s.announcement ? `<div class="notice"><span class="ni">📣</span><div>${esc(s.announcement)}</div></div>` : ''}
    ${!s.slotsOpen ? `<div class="notice warn"><span class="ni">⛔</span><div>${esc(s.closedMessage)}</div></div>` : ''}
    ${
      s.blackjackTable
        ? `<a class="table-card" href="#/table">
        <span class="tc-icon">🃏</span>
        <span class="tc-main"><b>Playing at the blackjack table?</b><small>Open your table screen: your balance updates live as the dealer records each hand.</small></span>
        <span class="btn btn-primary">Join table</span>
      </a>`
        : ''
    }
    <div class="machine-grid">
      ${
        machines.length
          ? machines
              .map(
                (m) => `
        <a class="machine-card" href="#/play/${encodeURIComponent(m.id)}" style="${themeVars(m)}">
          <div class="mc-symbols">${m.symbols.slice(-4).map((x) => esc(x.s)).join('')}</div>
          <div>
            <h2 class="mc-name">${esc(m.name)}</h2>
            <p class="mc-tag">${esc(m.tagline)}</p>
          </div>
          <div class="mc-jackpot">
            <small>JACKPOT</small>
            <strong class="num" data-jackpot="${esc(m.id)}">${fmt(m.jackpot)}</strong>
          </div>
          <div class="mc-meta"><span>${m.reels} reels · ${m.lines} line${m.lines > 1 ? 's' : ''} · ${fmt(m.bets[0])}–${fmt(m.bets[m.bets.length - 1])}</span><span class="mc-play">Play ▸</span></div>
        </a>`
              )
              .join('')
          : '<div class="empty">No machines are open right now.</div>'
      }
    </div>
    <h2 class="section-title">Recent jackpots</h2>
    <div class="feed" id="feed"><div class="empty">Loading…</div></div>`
  );
  bindLogout();

  const refresh = async () => {
    try {
      const { jackpots, recent } = await api('/api/lobby');
      updateJackpots(jackpots);
      const feed = root.querySelector('#feed');
      if (!feed) return;
      feed.innerHTML = recent.length
        ? recent
            .map(
              (j) => `<div class="feed-item"><span class="fi">🏆</span>
                <div><b>${esc(j.name)}</b> <span class="muted">hit the jackpot on ${esc(j.machine)} · ${timeAgo(j.created_at)}</span></div>
                <span class="amt num">${fmt(j.amount)}</span></div>`
            )
            .join('')
        : '<div class="empty">No jackpot yet. Will you be the first?</div>';
    } catch {
      /* keep the last values */
    }
  };
  refresh();
  every(5000, refresh);
}

function updateJackpots(jackpots) {
  for (const [id, amount] of Object.entries(jackpots)) {
    const m = state.machines.get(id);
    if (!m) continue;
    const prev = m.jackpot;
    m.jackpot = amount;
    document.querySelectorAll(`[data-jackpot="${CSS.escape(id)}"]`).forEach((el) => {
      if (prev !== amount) countUp(el, prev, amount, 900);
    });
  }
}

// ---------- slot machine ----------

function renderMachine(id) {
  const m = state.machines.get(id);
  if (!m) {
    toast('This machine is not available');
    location.hash = '#/';
    return;
  }
  const s = state.config.settings;
  const pick = symbolPicker(m);
  const saved = storage.get(`lm_bet_${m.id}`, m.bets[0]);
  let bet = m.bets.includes(saved) ? saved : m.bets[0];
  let spinning = false;
  let autoLeft = 0;

  root.innerHTML = `
    <div class="app">
      <div class="play" style="${themeVars(m)}">
        <div class="play-head">
          <a class="icon-btn" href="#/" aria-label="Back to machines">←</a>
          <h1>${esc(m.name)}</h1>
          <span class="spacer"></span>
          ${balancePill()}
        </div>
        ${!s.slotsOpen ? `<div class="notice warn"><span class="ni">⛔</span><div>${esc(s.closedMessage)}</div></div>` : ''}
        <div class="cabinet">
          <div class="jackpot-display">
            <small>JACKPOT</small>
            <strong class="num" data-jackpot="${esc(m.id)}">${fmt(m.jackpot)}</strong>
          </div>
          <div class="reels" id="reels">
            ${Array.from({ length: m.reels }, () => `<div class="reel"><div class="strip">${[pick(), pick(), pick()].map(cell).join('')}</div></div>`).join('')}
            <svg class="lines-svg" id="linesSvg" aria-hidden="true"></svg>
          </div>
          <div class="machine-tags">
            <span class="mtag">${m.lines} line${m.lines > 1 ? 's' : ''}</span>
            ${m.wildSymbol ? `<span class="mtag">${esc(m.wildSymbol)} wild</span>` : ''}
            ${m.scatterSymbol ? `<span class="mtag">${esc(m.scatterSymbol)} scatter</span>` : ''}
            <span class="mtag gold">${esc(m.jackpotSymbol).repeat(m.reels)} jackpot</span>
          </div>
          <div class="result-line" id="result"><span class="msg">Tap ℹ️ to see every way to win</span></div>
        </div>
        <div class="controls">
          <div class="bet-row">
            <span class="bet-label">BET</span>
            <div class="chips" id="chips">
              ${m.bets.map((b) => `<button class="chip num" data-bet="${b}">${fmt(b)}</button>`).join('')}
            </div>
          </div>
          <div class="action-row">
            <div class="side">
              <button class="icon-btn" id="info" aria-label="Paytable">ℹ️</button>
              <button class="icon-btn" id="sound" aria-label="Toggle sound">${sound.on ? '🔊' : '🔇'}</button>
            </div>
            <button class="spin-btn" id="spin" ${!s.slotsOpen ? 'disabled' : ''}>SPIN</button>
            <div class="side right">
              ${s.maxAutoSpins > 0 ? `<button class="btn toggle-btn" id="auto">AUTO <span class="auto-count" id="autoCount"></span></button>` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const reelsEl = root.querySelector('#reels');
  const resultEl = root.querySelector('#result');
  const spinBtn = root.querySelector('#spin');
  const autoBtn = root.querySelector('#auto');
  const linesSvg = root.querySelector('#linesSvg');
  const patterns = activeLines(m);

  // Draws the given line indexes over the reels (cell centers + edge stubs).
  const drawLines = (indexes, { win = false } = {}) => {
    const cellPx = parseFloat(reelsEl.style.getPropertyValue('--cell')) || 96;
    const w = reelsEl.clientWidth;
    const h = reelsEl.clientHeight;
    const x = (reel) => 10 + reel * (cellPx + 8) + cellPx / 2;
    const y = (row) => 10 + row * cellPx + cellPx / 2;
    linesSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    linesSvg.innerHTML = indexes
      .map((i) => {
        const p = patterns[i];
        const pts = [[2, y(p[0])], ...p.map((row, reel) => [x(reel), y(row)]), [w - 2, y(p[p.length - 1])]];
        const color = LINE_COLORS[i % LINE_COLORS.length];
        return `<polyline class="${win ? 'win' : ''}" points="${pts.map((q) => q.join(',')).join(' ')}" stroke="${color}" />`;
      })
      .join('');
  };
  const showAllLines = () => {
    drawLines(patterns.map((_, i) => i));
    linesSvg.classList.add('preview');
    setTimeout(() => {
      if (!spinning) linesSvg.innerHTML = '';
      linesSvg.classList.remove('preview');
    }, 1400);
  };

  const sizeReels = () => {
    const avail = Math.min(reelsEl.parentElement.clientWidth - 32, 688) - 20 - 8 * (m.reels - 1);
    const byWidth = Math.floor(avail / m.reels);
    const byHeight = Math.floor((window.innerHeight * 0.5) / 3);
    const cellPx = Math.max(48, Math.min(byWidth, byHeight, m.reels === 3 ? 124 : 104));
    reelsEl.style.setProperty('--cell', `${cellPx}px`);
    return cellPx;
  };
  sizeReels();
  window.addEventListener('resize', sizeReels);
  state.cleanup.push(() => window.removeEventListener('resize', sizeReels));

  const paintChips = () => {
    root.querySelectorAll('[data-bet]').forEach((c) => {
      const v = Number(c.dataset.bet);
      c.classList.toggle('active', v === bet);
      c.disabled = spinning;
    });
  };
  paintChips();

  root.querySelector('#chips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-bet]');
    if (!c || spinning) return;
    bet = Number(c.dataset.bet);
    storage.set(`lm_bet_${m.id}`, bet);
    sound.click();
    paintChips();
  });

  root.querySelector('#sound').addEventListener('click', (e) => {
    sound.on = !sound.on;
    storage.set('lm_sound', sound.on);
    e.currentTarget.textContent = sound.on ? '🔊' : '🔇';
    if (sound.on) sound.click();
  });

  root.querySelector('#info').addEventListener('click', () => showPaytable(m, bet));
  setTimeout(showAllLines, 350);

  const setAuto = (n) => {
    autoLeft = n;
    if (!autoBtn) return;
    autoBtn.classList.toggle('on', n > 0);
    root.querySelector('#autoCount').textContent = n > 0 ? n : '';
  };

  autoBtn?.addEventListener('click', () => {
    if (autoLeft > 0) return setAuto(0);
    setAuto(s.maxAutoSpins);
    if (!spinning) doSpin();
  });

  const clearHits = () => {
    reelsEl.querySelectorAll('.hit').forEach((c) => c.classList.remove('hit'));
    linesSvg.innerHTML = '';
  };

  async function doSpin() {
    if (spinning) return;
    if (state.player.balance < bet) {
      setAuto(0);
      sound.error();
      toast(state.player.balance > 0 ? 'Not enough money for this bet. Try a smaller one.' : 'You are out of money. Talk to the host!', 'error');
      return;
    }
    spinning = true;
    spinBtn.disabled = true;
    spinBtn.classList.add('spinning');
    paintChips();
    clearHits();
    resultEl.innerHTML = '<span class="msg">Good luck…</span>';
    sound.click();

    let r;
    try {
      r = await api('/api/spin', { method: 'POST', body: { machineId: m.id, bet } });
    } catch (e) {
      spinning = false;
      spinBtn.disabled = false;
      spinBtn.classList.remove('spinning');
      setAuto(0);
      paintChips();
      resultEl.innerHTML = '<span class="msg">Spin cancelled</span>';
      sound.error();
      toast(e.message, 'error');
      if (e.status === 401) render();
      return;
    }

    setBalance(state.player.balance - bet);
    const cellPx = sizeReels();
    const duration = s.spinDuration;
    const reels = [...reelsEl.querySelectorAll('.reel')];
    await Promise.all(
      reels.map((reel, i) => spinReel(reel, r.grid[i], i, cellPx, duration * (0.55 + (0.45 * i) / Math.max(1, m.reels - 1)), pick))
    );

    setBalance(r.balance, { bump: r.win > 0 });
    updateJackpots({ [m.id]: r.jackpot });

    if (r.win > 0) {
      for (const w of r.wins) {
        for (const [reel, row] of w.cells) reels[reel]?.querySelector('.strip').children[row]?.classList.add('hit');
      }
      drawLines(
        r.wins.filter((w) => w.line !== null).map((w) => w.line),
        { win: true }
      );
      const describe = (w) =>
        w.type === 'jackpot'
          ? `JACKPOT on line ${w.line + 1}!`
          : w.type === 'scatter'
            ? `${w.count} × ${esc(w.symbol)} scatter · ${fmt(w.amount)}`
            : `Line ${w.line + 1}: ${w.count} × ${esc(w.symbol)} · ${fmt(w.amount)}`;
      const shown = [...r.wins].sort((a, b) => b.amount - a.amount);
      resultEl.innerHTML = `<div><div class="win-amt num">WIN ${fmt(r.win)}</div><div class="msg win-list">${shown
        .slice(0, 2)
        .map(describe)
        .join('<br>')}${shown.length > 2 ? `<br>+ ${shown.length - 2} more` : ''}</div></div>`;
      if (r.jackpotWin > 0) {
        setAuto(0);
        sound.jackpot();
        vibrate([200, 100, 200, 100, 400]);
        await celebrate('JACKPOT', r.jackpotWin, true);
      } else if (r.win >= bet * 15) {
        sound.bigWin();
        vibrate([120, 60, 220]);
        await celebrate('BIG WIN', r.win, false);
      } else {
        sound.win();
        vibrate(60);
      }
    } else {
      const lines = ['So close!', 'Not this time', 'Spin again?', 'The next one could be it', 'Keep going'];
      resultEl.innerHTML = `<span class="msg">${lines[(Math.random() * lines.length) | 0]}</span>`;
    }

    spinning = false;
    spinBtn.disabled = false;
    spinBtn.classList.remove('spinning');
    paintChips();

    if (autoLeft > 0 && root.contains(spinBtn)) {
      setAuto(autoLeft - 1);
      if (autoLeft > 0) setTimeout(() => root.contains(spinBtn) && doSpin(), r.win > 0 ? 900 : 350);
    }
  }

  spinBtn.addEventListener('click', () => {
    if (autoLeft > 0) setAuto(0);
    doSpin();
  });

  const onKey = (e) => {
    if (e.code === 'Space' && !e.repeat && !document.querySelector('.overlay, .celebrate')) {
      e.preventDefault();
      doSpin();
    }
  };
  document.addEventListener('keydown', onKey);
  state.cleanup.push(() => {
    document.removeEventListener('keydown', onKey);
    autoLeft = 0;
  });

  every(5000, async () => {
    try {
      const { jackpots } = await api('/api/lobby');
      if (!spinning) updateJackpots(jackpots);
    } catch {
      /* ignore */
    }
  });
}

const cell = (s) => `<div class="cell">${esc(s)}</div>`;

function spinReel(reel, finalCol, index, cellPx, duration, pick) {
  const strip = reel.querySelector('.strip');
  const current = [...strip.children].slice(0, 3).map((c) => c.textContent);
  const filler = Array.from({ length: 14 + index * 5 }, pick);
  const symbols = [...current, ...filler, ...finalCol];
  strip.innerHTML = symbols.map(cell).join('');
  strip.style.transition = 'none';
  strip.style.transform = 'translateY(0)';
  void strip.offsetHeight;
  strip.classList.add('blur');
  strip.style.transition = `transform ${duration}ms cubic-bezier(.16,.84,.24,1.03)`;
  strip.style.transform = `translateY(-${(symbols.length - 3) * cellPx}px)`;
  setTimeout(() => strip.classList.remove('blur'), duration * 0.75);
  return new Promise((resolve) =>
    setTimeout(() => {
      strip.style.transition = 'none';
      strip.innerHTML = finalCol.map(cell).join('');
      strip.style.transform = 'translateY(0)';
      sound.stop();
      resolve();
    }, duration + 20)
  );
}

function celebrate(label, amount, wait) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'celebrate';
    el.innerHTML = `<canvas></canvas><div class="celebrate-box">
      <div class="label">${label}</div>
      <div class="big num">${fmt(0)}</div>
      ${wait ? '<button class="btn btn-primary btn-lg">Collect</button>' : ''}</div>`;
    document.body.append(el);
    confetti(el.querySelector('canvas'), wait ? 5000 : 2500);
    countUp(el.querySelector('.big'), 0, amount, wait ? 2200 : 1200);
    const close = () => {
      el.remove();
      resolve();
    };
    if (wait) el.querySelector('.btn').addEventListener('click', close);
    else {
      el.addEventListener('click', close);
      setTimeout(close, 2600);
    }
  });
}

function showPaytable(m, bet) {
  const a = analyze(m);
  const patterns = activeLines(m);
  const lineBet = bet / patterns.length;
  const symRow = (sym, k, amount, mult) =>
    `<div class="pt-row"><span class="pt-syms">${Array.from({ length: m.reels }, (_, i) =>
      i < k ? esc(sym.s) : `<span class="dim">${esc(sym.s)}</span>`
    ).join('')}</span><span class="pt-pay num">${fmt(amount)}<small>${mult}×</small></span></div>`;

  const lineRows = [];
  const scatterRows = [];
  for (const sym of [...m.symbols].reverse()) {
    for (let k = m.reels; k >= 1; k--) {
      const mult = Number(sym.pays?.[k]);
      if (!mult) continue;
      if (sym.s === m.scatterSymbol) scatterRows.push(symRow(sym, k, Math.floor(mult * bet), mult));
      else lineRows.push(symRow(sym, k, Math.floor(mult * lineBet), mult));
    }
  }

  const mini = (p, i) => `<div class="mini-line" title="Line ${i + 1}">
      <div class="mini-grid" style="--n:${m.reels}">${[0, 1, 2]
        .map((row) => p.map((r) => `<i class="${r === row ? 'on' : ''}" style="${r === row ? `background:${LINE_COLORS[i % LINE_COLORS.length]}` : ''}"></i>`).join(''))
        .join('')}</div><small>${i + 1}</small></div>`;

  const el = document.createElement('div');
  el.className = 'overlay';
  el.innerHTML = `<div class="sheet" role="dialog" aria-label="Paytable">
    <div class="sheet-grip"></div>
    <div class="sheet-head"><h2>Ways to win</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <p class="muted" style="margin-top:0">Amounts shown for a <b>${fmt(bet)}</b> bet.</p>

    <h3 class="pt-title">🏆 Jackpot</h3>
    <div class="paytable">
      <div class="pt-row jp"><span class="pt-syms">${esc(m.jackpotSymbol).repeat(m.reels)}</span><span class="pt-pay num">${fmt(m.jackpot)}</span></div>
    </div>
    <p class="pt-note">Fill any active line with ${esc(m.jackpotSymbol)} to win the whole jackpot. About 1 in ${a.jackpotOdds.toLocaleString('en-US')} spins.</p>

    <h3 class="pt-title">📏 ${patterns.length} pay line${patterns.length > 1 ? 's' : ''}</h3>
    <div class="mini-lines">${patterns.map(mini).join('')}</div>
    <p class="pt-note">Your bet is split across every line (${fmt(Math.floor(lineBet))} per line). Each line pays on its own when it starts
      with identical symbols from the left reel. Faded symbols mean "anything else".</p>

    ${
      m.wildSymbol
        ? `<h3 class="pt-title">${esc(m.wildSymbol)} Wild</h3>
           <p class="pt-note">The wild replaces any symbol on a line to complete a win, except ${esc(m.jackpotSymbol)}${
             m.scatterSymbol ? ` and ${esc(m.scatterSymbol)}` : ''
           }. A line of wilds pays the most.</p>`
        : ''
    }
    ${
      m.scatterSymbol && scatterRows.length
        ? `<h3 class="pt-title">${esc(m.scatterSymbol)} Scatter</h3>
           <p class="pt-note">Pays anywhere on the screen, no line needed: count the reels showing ${esc(m.scatterSymbol)}.</p>
           <div class="paytable">${scatterRows.join('')}</div>`
        : ''
    }

    <h3 class="pt-title">💰 Line wins</h3>
    <div class="paytable">${lineRows.join('')}</div>
    <p class="pt-note" style="margin-bottom:0">About 1 spin in ${(1 / a.hitRate).toFixed(1)} wins something.</p>
  </div>`;
  const close = () => el.remove();
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-close]')) close();
  });
  document.body.append(el);
}

// ---------- stats ----------

const TX_ICON = { spin: '🎰', jackpot: '🏆', blackjack: '🃏', adjust: '🛠️', start: '🎁', void: '↩️' };

function txLabel(t) {
  switch (t.type) {
    case 'spin':
      return `${t.machine || 'Slot'} · bet ${fmt(t.bet)}`;
    case 'jackpot':
      return `JACKPOT on ${t.machine || 'slot'}`;
    case 'blackjack':
      return t.note || 'Blackjack';
    case 'start':
      return 'Starting balance';
    default:
      return t.note || 'Adjustment by the host';
  }
}

function txRow(t) {
  return `<div class="tx ${t.voided ? 'voided' : ''}">
    <span class="ti">${TX_ICON[t.type] || '•'}</span>
    <div class="tmain"><b>${esc(txLabel(t))}</b><small>${timeAgo(t.created_at)}</small></div>
    <span class="tamt num ${t.amount > 0 ? 'pos' : t.amount < 0 ? 'neg' : 'muted'}">${fmt(t.amount, { sign: true })}</span>
  </div>`;
}

async function renderStats() {
  root.innerHTML = shell('stats', '<div class="loading"><div class="spinner"></div></div>');
  bindLogout();
  let d;
  try {
    d = await api('/api/me');
  } catch (e) {
    if (e.status === 401) return render();
    toast(e.message, 'error');
    return;
  }
  const p = d.player;
  setBalance(p.balance);
  const slotsNet = p.won - p.wagered;
  const main = root.querySelector('main');
  main.innerHTML = `
    <h1 class="page-title">My stats</h1>
    <p class="page-sub">Your code is <b class="num">${esc(p.code)}</b>. Keep it secret.</p>
    <div class="stat-grid">
      <div class="stat hero"><small>Balance</small><strong class="num">${fmt(p.balance)}</strong></div>
      <div class="stat"><small>Slots result</small><strong class="num ${slotsNet >= 0 ? 'pos' : 'neg'}">${fmt(slotsNet, { sign: true })}</strong></div>
      <div class="stat"><small>Spins</small><strong class="num">${p.spins.toLocaleString('en-US')}</strong></div>
      <div class="stat"><small>Total bet</small><strong class="num">${fmt(p.wagered)}</strong></div>
      <div class="stat"><small>Total won</small><strong class="num">${fmt(p.won)}</strong></div>
      <div class="stat"><small>Biggest win</small><strong class="num">${fmt(p.biggest_win)}</strong></div>
      <div class="stat"><small>Jackpots</small><strong class="num">${p.jackpots}</strong></div>
      <div class="stat"><small>Blackjack hands</small><strong class="num">${p.bj_hands}</strong></div>
      <div class="stat"><small>Blackjack result</small><strong class="num ${p.bj_net >= 0 ? 'pos' : 'neg'}">${fmt(p.bj_net, { sign: true })}</strong></div>
    </div>
    <h2 class="section-title">By machine</h2>
    ${
      d.machines.length
        ? `<div class="table-wrap"><table>
        <thead><tr><th>Machine</th><th class="r">Spins</th><th class="r">Bet</th><th class="r">Won</th><th class="r">Result</th><th class="r">Jackpots</th></tr></thead>
        <tbody>${d.machines
          .map(
            (x) => `<tr><td>${esc(x.name)}</td><td class="r num">${x.spins}</td><td class="r num">${fmt(x.wagered)}</td>
            <td class="r num">${fmt(x.won)}</td><td class="r num ${x.won - x.wagered >= 0 ? 'pos' : 'neg'}">${fmt(x.won - x.wagered, { sign: true })}</td>
            <td class="r num">${x.jackpots}</td></tr>`
          )
          .join('')}</tbody></table></div>`
        : '<div class="empty">You have not played any machine yet.</div>'
    }
    <h2 class="section-title">Recent activity</h2>
    <div class="tx-list">${d.transactions.map(txRow).join('') || '<div class="empty">Nothing yet.</div>'}</div>`;
}

async function renderLeaders() {
  root.innerHTML = shell('leaders', '<div class="loading"><div class="spinner"></div></div>');
  bindLogout();
  try {
    const { players } = await api('/api/leaderboard');
    const medals = ['🥇', '🥈', '🥉'];
    root.querySelector('main').innerHTML = `
      <h1 class="page-title">Leaderboard</h1>
      <p class="page-sub">Top 10 balances right now.</p>
      <div class="feed">${
        players
          .map(
            (p, i) => `<div class="leader ${p.id === state.player.id ? 'me' : ''}">
          <span class="rank">${medals[i] || i + 1}</span>
          <span class="lname">${esc(p.name)}${p.jackpots ? ` <span title="Jackpots">🏆×${p.jackpots}</span>` : ''}</span>
          <b class="num">${fmt(p.balance)}</b></div>`
          )
          .join('') || '<div class="empty">No players yet.</div>'
      }</div>`;
  } catch (e) {
    if (e.status === 401) return render();
    location.hash = '#/';
  }
}

// ---------- blackjack table ----------

function renderTable() {
  const s = state.config.settings;
  if (!s.blackjackTable) {
    location.hash = '#/';
    return;
  }
  const session = { net: 0, hands: 0, list: [] };

  root.innerHTML = `
    <div class="table-view">
      <div class="tv-top">
        <button class="btn btn-lg tv-leave" id="leave">← Leave table</button>
        <span class="live-badge" id="live"><i></i><span>Connecting…</span></span>
      </div>
      <div class="tv-center">
        <div class="tv-label">🃏 Blackjack table</div>
        <div class="tv-name">${esc(state.player.name)}</div>
        <div class="tv-caption">Your balance</div>
        <div class="tv-balance num" id="tvBal">${fmt(state.player.balance)}</div>
        <div class="tv-flash" id="flash" aria-live="assertive"></div>
        <div class="tv-session num" id="session">No hand recorded yet</div>
      </div>
      <div class="tv-hands" id="hands"></div>
      <p class="tv-hint">Play at the real table. The dealer records each hand and your balance updates here instantly.</p>
    </div>`;

  const balEl = root.querySelector('#tvBal');
  const flashEl = root.querySelector('#flash');
  const liveEl = root.querySelector('#live');
  const setLive = (mode, text) => {
    liveEl.className = `live-badge ${mode}`;
    liveEl.querySelector('span').textContent = text;
  };

  const paintSession = () => {
    root.querySelector('#session').innerHTML = session.hands
      ? `This session: <b class="${session.net > 0 ? 'pos' : session.net < 0 ? 'neg' : ''}">${fmt(session.net, { sign: true })}</b> · ${session.hands} hand${session.hands > 1 ? 's' : ''}`
      : 'No hand recorded yet';
    root.querySelector('#hands').innerHTML = session.list
      .slice(0, 8)
      .map(
        (h) => `<div class="tv-hand ${h.kind}"><span>${h.label}</span><b class="num">${h.kind === 'push' ? 'Push' : fmt(h.amount, { sign: true })}</b></div>`
      )
      .join('');
  };

  let flashTimer;
  const flash = (kind, text) => {
    clearTimeout(flashTimer);
    flashEl.className = 'tv-flash';
    void flashEl.offsetWidth;
    flashEl.className = `tv-flash show ${kind}`;
    flashEl.textContent = text;
    root.querySelector('.table-view').dataset.result = kind;
    flashTimer = setTimeout(() => {
      flashEl.classList.remove('show');
      delete root.querySelector('.table-view')?.dataset.result;
    }, 4000);
  };

  const onBalance = (data) => {
    const prev = state.player.balance;
    if (data.balance !== prev) countUp(balEl, prev, data.balance, 900);
    else balEl.textContent = fmt(data.balance);
    state.player.balance = data.balance;
    const c = data.change;
    if (!c) return;
    if (c.type === 'blackjack') {
      const kind = c.amount > 0 ? 'win' : c.amount < 0 ? 'loss' : 'push';
      session.hands++;
      session.net += c.amount;
      session.list.unshift({ kind, amount: c.amount, label: c.note || 'Hand' });
      if (kind === 'win') {
        flash('win', `WIN ${fmt(c.amount, { sign: true })}`);
        sound.win();
        vibrate([80, 60, 160]);
      } else if (kind === 'loss') {
        flash('loss', `LOSS ${fmt(c.amount)}`);
        sound.error();
        vibrate(200);
      } else {
        flash('push', 'PUSH');
        sound.click();
      }
    } else {
      session.net += c.type === 'void' ? c.amount : 0;
      if (c.type === 'void') {
        session.hands = Math.max(0, session.hands - 1);
        session.list.unshift({ kind: 'push', amount: c.amount, label: 'Correction by the dealer' });
      } else {
        session.list.unshift({ kind: c.amount >= 0 ? 'win' : 'loss', amount: c.amount, label: c.note || 'Adjustment' });
      }
      flash(c.amount >= 0 ? 'win' : 'loss', `${c.type === 'void' ? 'CORRECTION' : 'ADJUSTED'} ${fmt(c.amount, { sign: true })}`);
    }
    paintSession();
  };

  const es = new EventSource('/api/live?table=1');
  es.addEventListener('open', () => setLive('on', 'Live'));
  es.addEventListener('balance', (e) => onBalance(JSON.parse(e.data)));
  es.addEventListener('kicked', async () => {
    es.close();
    state.player = null;
    toast('You were signed out by the host', 'error');
    location.hash = '#/';
    render();
  });
  es.addEventListener('error', async () => {
    setLive('off', 'Reconnecting…');
    if (es.readyState === EventSource.CLOSED) {
      try {
        await api('/api/me');
        setTimeout(() => location.hash === '#/table' && render(), 2000);
      } catch (e) {
        if (e.status === 401) {
          state.player = null;
          render();
        }
      }
    }
  });

  // Keep the phone screen on while seated.
  let wakeLock = null;
  const lock = async () => {
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      /* not supported or not allowed */
    }
  };
  const onVisible = () => document.visibilityState === 'visible' && lock();
  lock();
  document.addEventListener('visibilitychange', onVisible);

  state.cleanup.push(() => {
    es.close();
    clearTimeout(flashTimer);
    document.removeEventListener('visibilitychange', onVisible);
    wakeLock?.release?.().catch(() => {});
  });

  root.querySelector('#leave').addEventListener('click', () => {
    location.hash = '#/';
  });
}

// ---------- router ----------

async function render() {
  teardown();
  if (!state.player) return renderLogin();
  const hash = location.hash.replace(/^#\/?/, '');
  const [view, arg] = hash.split('/');
  window.scrollTo(0, 0);
  if (view === 'play' && arg) return renderMachine(decodeURIComponent(arg));
  if (view === 'table') return renderTable();
  if (view === 'stats') return renderStats();
  if (view === 'leaders' && state.config.settings.showLeaderboard) return renderLeaders();
  root.innerHTML = '';
  return renderLobby();
}

async function boot() {
  try {
    state.config = await api('/api/config');
  } catch (e) {
    root.innerHTML = `<div class="login"><div class="login-card"><div class="login-logo">😵</div>
      <h1>Can't connect</h1><p>${esc(e.message)}</p><button class="btn btn-primary" id="retry">Retry</button></div></div>`;
    root.querySelector('#retry').addEventListener('click', () => location.reload());
    return;
  }
  setCurrency(state.config.settings.currencySymbol);
  document.title = state.config.settings.siteName;
  state.machines = new Map(state.config.machines.map((m) => [m.id, m]));
  try {
    state.player = (await api('/api/me')).player;
  } catch {
    state.player = null;
  }
  render();
}

window.addEventListener('hashchange', render);
document.addEventListener('visibilitychange', async () => {
  // Pick up admin changes (settings, balance) when the player comes back to the tab.
  if (document.visibilityState !== 'visible' || !state.player) return;
  try {
    const [config, me] = await Promise.all([api('/api/config'), api('/api/me')]);
    const changed = JSON.stringify(config) !== JSON.stringify(state.config);
    state.config = config;
    setCurrency(config.settings.currencySymbol);
    state.machines = new Map(config.machines.map((m) => [m.id, m]));
    setBalance(me.player.balance);
    if (changed && !/^#\/(play|table)/.test(location.hash)) render();
  } catch (e) {
    if (e.status === 401) {
      state.player = null;
      render();
    }
  }
});

boot();
