import { analyze } from '/shared/paytable.js';
import { api, esc, fmt, setCurrency, toast, timeAgo, toCents, storage } from '/ui.js';

const root = document.getElementById('app');
const S = { settings: null, timers: [], machines: null };

const NAV = [
  ['dashboard', '📈', 'Dashboard'],
  ['players', '👥', 'Players'],
  ['blackjack', '🃏', 'Blackjack'],
  ['machines', '🎰', 'Machines'],
  ['settings', '⚙️', 'Settings'],
  ['activity', '🧾', 'Activity'],
];

// ---------- helpers ----------

const units = (cents) => (Number(cents) / 100).toString();
const initials = (name) =>
  String(name)
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const oneIn = (p) => (p > 0 ? `1 in ${Math.round(1 / p).toLocaleString('en-US')}` : 'never');

async function call(path, opts) {
  try {
    return await api(path, opts);
  } catch (e) {
    if (e.status === 401) {
      renderLogin();
      toast('Your admin session expired. Log in again.', 'error');
    } else {
      toast(e.message, 'error');
    }
    throw e;
  }
}

function clearTimers() {
  S.timers.forEach(clearInterval);
  S.timers = [];
}

function openSheet(html, { wide = false } = {}) {
  const el = document.createElement('div');
  el.className = 'overlay';
  el.innerHTML = `<div class="sheet ${wide ? 'wide' : ''}" role="dialog"><div class="sheet-grip"></div><div class="sheet-body">${html}</div></div>`;
  const close = () => el.remove();
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-close]')) close();
  });
  document.body.append(el);
  return { el, body: el.querySelector('.sheet-body'), close };
}

function prow(p, { selected = false } = {}) {
  return `<button type="button" class="prow ${selected ? 'selected' : ''} ${p.active ? '' : 'inactive'}" data-pid="${p.id}">
    <span class="avatar">${esc(initials(p.name))}</span>
    <span class="pmain"><b>${esc(p.name)}</b><small><span class="code-tag">${esc(p.code)}</span> · ${p.active ? timeAgo(p.last_seen) : 'disabled'}</small></span>
    <span class="pright"><b class="num">${fmt(p.balance)}</b><small>${p.spins.toLocaleString('en-US')} spins</small></span>
  </button>`;
}

const TX_ICON = { spin: '🎰', jackpot: '🏆', blackjack: '🃏', adjust: '🛠️', start: '🎁', void: '↩️' };

function txLabel(t) {
  if (t.type === 'spin') return `${t.machine || t.machine_id} · bet ${fmt(t.bet)}${t.win ? ` · won ${fmt(t.win)}` : ''}`;
  if (t.type === 'jackpot') return `JACKPOT on ${t.machine || t.machine_id}`;
  return t.note || t.type;
}

function txRow(t, { who = false } = {}) {
  const undoable = ['blackjack', 'adjust'].includes(t.type) && !t.voided;
  return `<div class="tx ${t.voided ? 'voided' : ''}">
    <span class="ti">${TX_ICON[t.type] || '•'}</span>
    <div class="tmain"><b>${esc(txLabel(t))}</b>
      <small>${who ? `<span class="who">${esc(t.name || 'Deleted player')} <span class="code-tag">${esc(t.code || '-----')}</span></span> · ` : ''}${timeAgo(t.created_at)}${t.voided ? ' · undone' : ''}</small></div>
    <span class="tamt num ${t.amount > 0 ? 'pos' : t.amount < 0 ? 'neg' : 'muted'}">${fmt(t.amount, { sign: true })}</span>
    ${undoable ? `<button class="btn btn-sm btn-ghost" data-undo="${t.id}" title="Undo this entry">Undo</button>` : ''}
  </div>`;
}

function bindUndo(container, after) {
  container.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-undo]');
    if (!b) return;
    if (!confirm('Undo this entry? The money will be returned or taken back.')) return;
    b.disabled = true;
    try {
      await call(`/api/admin/transactions/${b.dataset.undo}/void`, { method: 'POST' });
      toast('Entry undone', 'success');
      after();
    } catch {
      b.disabled = false;
    }
  });
}

// ---------- login ----------

function renderLogin() {
  clearTimers();
  root.innerHTML = `
    <div class="login">
      <form class="login-card" id="form" autocomplete="on">
        <div class="login-logo">🔐</div>
        <h1>Admin</h1>
        <p>Sign in to manage the machines</p>
        <div style="display:grid;gap:12px;text-align:left">
          <label class="field"><span>Username</span><input class="input" name="username" autocomplete="username" required autofocus /></label>
          <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required /></label>
        </div>
        <div class="login-msg" id="msg" role="alert" style="margin-top:12px"></div>
        <button class="btn btn-primary btn-lg btn-block">Sign in</button>
      </form>
    </div>`;
  root.querySelector('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('.btn');
    btn.disabled = true;
    try {
      await api('/api/admin/login', { method: 'POST', body: { username: f.username.value, password: f.password.value } });
      await start();
    } catch (err) {
      root.querySelector('#msg').textContent = err.message;
      btn.disabled = false;
    }
  });
}

// ---------- layout ----------

function layout(active) {
  root.innerHTML = `
    <div class="admin">
      <aside class="side">
        <a class="brand" href="#/dashboard"><span class="brand-logo">🎰</span><span class="brand-name">${esc(S.settings.siteName)} · Admin</span></a>
        <nav class="side-nav">
          ${NAV.map(([k, icon, label]) => `<a href="#/${k}" class="${k === active ? 'active' : ''}"><span class="ni">${icon}</span><span class="nl">${label}</span></a>`).join('')}
          <a href="#" class="mobile-only" data-logout><span class="ni">🚪</span></a>
        </nav>
        <div class="side-foot">
          <a class="btn btn-sm" href="/" target="_blank" rel="noopener">Open player site ↗</a>
          <button class="btn btn-sm btn-ghost" data-logout>Log out</button>
        </div>
      </aside>
      <main class="admin-main" id="main"><div class="loading"><div class="spinner"></div></div></main>
    </div>`;
  root.querySelectorAll('[data-logout]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
      renderLogin();
    })
  );
  return root.querySelector('#main');
}

// ---------- dashboard ----------

async function renderDashboard() {
  const main = layout('dashboard');
  const load = async () => {
    const d = await call('/api/admin/dashboard');
    const t = d.totals;
    const slotsHouse = t.wagered - t.won;
    if (!main.isConnected) return;
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Dashboard</h1><p>Live overview of the floor.</p></div>
        <div class="form-actions" style="margin:0">
          <a class="btn" href="#/players?new=1">＋ New player</a>
          <a class="btn btn-primary" href="#/blackjack">🃏 Record blackjack</a>
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat"><small>Players</small><strong class="num">${t.players}</strong><span class="muted" style="font-size:13px">${t.activeToday} active today</span></div>
        <div class="stat"><small>Money in play</small><strong class="num">${fmt(t.balance)}</strong></div>
        <div class="stat"><small>Slots house result</small><strong class="num ${slotsHouse >= 0 ? 'pos' : 'neg'}">${fmt(slotsHouse, { sign: true })}</strong></div>
        <div class="stat"><small>Spins</small><strong class="num">${t.spins.toLocaleString('en-US')}</strong></div>
        <div class="stat"><small>Jackpots hit</small><strong class="num">${t.jackpots}</strong></div>
        <div class="stat"><small>Blackjack house result</small><strong class="num ${-t.bj_net >= 0 ? 'pos' : 'neg'}">${fmt(-t.bj_net, { sign: true })}</strong><span class="muted" style="font-size:13px">${t.bj_hands} hands</span></div>
      </div>
      <h2 class="section-title">Machines</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Machine</th><th>Status</th><th class="r">Jackpot</th><th class="r">Spins</th><th class="r">Bet</th><th class="r">Paid</th><th class="r">Real RTP</th><th class="r">Jackpots</th></tr></thead>
        <tbody>${d.machines
          .map(
            (m) => `<tr>
          <td><a href="#/machines/${esc(m.id)}">${esc(m.name)}</a></td>
          <td><span class="badge ${m.enabled ? 'on' : 'off'}">${m.enabled ? 'Open' : 'Off'}</span></td>
          <td class="r num">${fmt(m.jackpot)}</td><td class="r num">${m.spins.toLocaleString('en-US')}</td>
          <td class="r num">${fmt(m.wagered)}</td><td class="r num">${fmt(m.won)}</td>
          <td class="r num">${m.wagered ? pct(m.won / m.wagered) : '–'}</td><td class="r num">${m.jackpots}</td></tr>`
          )
          .join('')}</tbody></table></div>
      <h2 class="section-title">Recent jackpots</h2>
      <div class="feed">${
        d.recentJackpots
          .map(
            (j) => `<div class="feed-item"><span class="fi">🏆</span><div><b>${esc(j.name)}</b>
              <span class="muted">on ${esc(j.machine)} · ${timeAgo(j.created_at)}</span></div><span class="amt num">${fmt(j.amount)}</span></div>`
          )
          .join('') || '<div class="empty">No jackpot has been hit yet.</div>'
      }</div>`;
  };
  await load();
  S.timers.push(setInterval(() => load().catch(() => {}), 15000));
}

// ---------- players ----------

async function renderPlayers(params) {
  const main = layout('players');
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Players</h1><p>Each player signs in with their 5-digit code.</p></div>
      <button class="btn btn-primary" id="new">＋ New player</button>
    </div>
    <input class="input" id="q" type="search" placeholder="Search by name or code" style="margin-bottom:14px" />
    <div class="player-list" id="list"><div class="loading"><div class="spinner"></div></div></div>`;

  const list = main.querySelector('#list');
  const q = main.querySelector('#q');
  const load = async () => {
    const { players } = await call(`/api/admin/players?q=${encodeURIComponent(q.value)}`);
    list.innerHTML = players.map((p) => prow(p)).join('') || '<div class="empty">No player found.</div>';
  };
  let t;
  q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(load, 200);
  });
  list.addEventListener('click', (e) => {
    const r = e.target.closest('[data-pid]');
    if (r) openPlayer(Number(r.dataset.pid), load);
  });
  main.querySelector('#new').addEventListener('click', () => newPlayer(load));
  await load();
  if (params.get('new')) newPlayer(load);
}

function newPlayer(onDone) {
  const sheet = openSheet(`
    <div class="sheet-head"><h2>New player</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <form id="f" style="display:grid;gap:14px">
      <label class="field"><span>Name</span><input class="input" name="name" maxlength="40" required autofocus /></label>
      <label class="field"><span>Starting balance (${esc(S.settings.currencySymbol)})</span>
        <input class="input num" name="balance" inputmode="decimal" value="${units(S.settings.startingBalance)}" required /></label>
      <button class="btn btn-primary btn-lg">Create player</button>
    </form>`);
  sheet.body.querySelector('[name=name]').focus();
  sheet.body.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    f.querySelector('.btn').disabled = true;
    try {
      const { player } = await call('/api/admin/players', {
        method: 'POST',
        body: { name: f.name.value, balance: toCents(f.balance.value) },
      });
      sheet.body.innerHTML = `
        <div class="sheet-head"><h2>${esc(player.name)} is ready</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
        <p class="muted">Give this code to the player. They type it on the home page to play.</p>
        <div class="big-code"><b>${esc(player.code)}</b><span class="num">${fmt(player.balance)}</span></div>
        <div class="form-actions"><button class="btn btn-primary" data-close>Done</button>
        <button class="btn" id="another">Create another</button></div>`;
      sheet.body.querySelector('#another').addEventListener('click', () => {
        sheet.close();
        newPlayer(onDone);
      });
      onDone?.();
    } catch {
      f.querySelector('.btn').disabled = false;
    }
  });
}

async function openPlayer(id, onChange) {
  const sheet = openSheet('<div class="loading" style="min-height:200px"><div class="spinner"></div></div>', { wide: true });

  const load = async () => {
    let d;
    try {
      d = await call(`/api/admin/players/${id}`);
    } catch {
      return sheet.close();
    }
    const p = d.player;
    sheet.body.innerHTML = `
      <div class="sheet-head"><h2>${esc(p.name)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="drawer-section">
        <div class="big-code"><b>${esc(p.code)}</b><button class="btn btn-sm" id="regen">New code</button></div>
      </div>
      <div class="drawer-section">
        <h3>Balance · <span class="num" style="color:var(--text)">${fmt(p.balance)}</span></h3>
        <form id="adj" class="inline-form">
          <input class="input num" name="amount" inputmode="decimal" placeholder="Amount (${esc(S.settings.currencySymbol)})" required />
          <button class="btn btn-success" name="op" value="add">Add</button>
          <button class="btn btn-danger" name="op" value="remove">Remove</button>
          <button class="btn" name="op" value="set">Set to</button>
          <input class="input" name="note" placeholder="Reason (optional)" maxlength="120" style="flex-basis:100%" />
        </form>
      </div>
      <div class="drawer-section">
        <h3>Profile</h3>
        <form id="prof" class="inline-form">
          <input class="input" name="name" value="${esc(p.name)}" maxlength="40" required />
          <button class="btn">Rename</button>
        </form>
        <label class="switch" style="margin-top:10px"><span>Account active<small>Disabled players cannot sign in or play.</small></span>
          <input type="checkbox" id="active" ${p.active ? 'checked' : ''} /></label>
      </div>
      <div class="drawer-section">
        <h3>Stats</h3>
        <div class="stat-grid">
          <div class="stat"><small>Spins</small><strong class="num">${p.spins.toLocaleString('en-US')}</strong></div>
          <div class="stat"><small>Total bet</small><strong class="num">${fmt(p.wagered)}</strong></div>
          <div class="stat"><small>Total won</small><strong class="num">${fmt(p.won)}</strong></div>
          <div class="stat"><small>Slots result</small><strong class="num ${p.won - p.wagered >= 0 ? 'pos' : 'neg'}">${fmt(p.won - p.wagered, { sign: true })}</strong></div>
          <div class="stat"><small>Biggest win</small><strong class="num">${fmt(p.biggest_win)}</strong></div>
          <div class="stat"><small>Jackpots</small><strong class="num">${p.jackpots}</strong></div>
          <div class="stat"><small>Blackjack</small><strong class="num ${p.bj_net >= 0 ? 'pos' : 'neg'}">${fmt(p.bj_net, { sign: true })}</strong><span class="muted" style="font-size:13px">${p.bj_hands} hands</span></div>
          <div class="stat"><small>Adjustments</small><strong class="num">${fmt(p.adjustments, { sign: true })}</strong></div>
        </div>
        ${
          d.machines.length
            ? `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Machine</th><th class="r">Spins</th><th class="r">Bet</th><th class="r">Won</th><th class="r">Jackpots</th></tr></thead>
          <tbody>${d.machines.map((m) => `<tr><td>${esc(m.name)}</td><td class="r num">${m.spins}</td><td class="r num">${fmt(m.wagered)}</td><td class="r num">${fmt(m.won)}</td><td class="r num">${m.jackpots}</td></tr>`).join('')}</tbody></table></div>`
            : ''
        }
      </div>
      <div class="drawer-section">
        <h3>Recent activity</h3>
        <div class="tx-list" id="tx">${d.transactions.map((t) => txRow(t)).join('') || '<div class="empty">Nothing yet.</div>'}</div>
      </div>
      <div class="drawer-section">
        <button class="btn btn-danger btn-block" id="del">Delete player</button>
      </div>`;

    const after = () => {
      load();
      onChange?.();
    };

    sheet.body.querySelector('#regen').addEventListener('click', async () => {
      if (!confirm(`Give ${p.name} a new code? The old code ${p.code} will stop working.`)) return;
      await call(`/api/admin/players/${id}/regenerate-code`, { method: 'POST' }).catch(() => null);
      after();
    });

    sheet.body.querySelector('#adj').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const op = e.submitter?.value || 'add';
      const cents = toCents(f.amount.value);
      if (!Number.isFinite(cents) || cents < 0) return toast('Enter a positive amount', 'error');
      const body = op === 'set' ? { setBalance: cents } : { amount: op === 'remove' ? -cents : cents };
      body.note = f.note.value;
      try {
        await call(`/api/admin/players/${id}/adjust`, { method: 'POST', body });
        toast('Balance updated', 'success');
        after();
      } catch {
        /* toast shown */
      }
    });

    sheet.body.querySelector('#prof').addEventListener('submit', async (e) => {
      e.preventDefault();
      await call(`/api/admin/players/${id}`, { method: 'PATCH', body: { name: e.target.name.value } }).catch(() => null);
      toast('Renamed', 'success');
      after();
    });

    sheet.body.querySelector('#active').addEventListener('change', async (e) => {
      await call(`/api/admin/players/${id}`, { method: 'PATCH', body: { active: e.target.checked } }).catch(() => null);
      after();
    });

    sheet.body.querySelector('#del').addEventListener('click', async () => {
      if (!confirm(`Delete ${p.name} and all of their history? This cannot be undone.`)) return;
      await call(`/api/admin/players/${id}`, { method: 'DELETE' }).catch(() => null);
      toast('Player deleted', 'success');
      sheet.close();
      onChange?.();
    });

    bindUndo(sheet.body.querySelector('#tx'), after);
  };
  await load();
}

// ---------- blackjack ----------

async function renderBlackjack() {
  const main = layout('blackjack');
  const st = { players: [], selected: null, result: 'win', amount: '', note: '', search: '' };
  const recentIds = () => storage.get('lm_bj_recent', []);

  main.innerHTML = `
    <div class="page-head"><div><h1>Blackjack table</h1><p>Record each hand. The player's balance updates instantly.</p></div></div>
    <div class="grid-2">
      <div class="card card-pad" id="form"></div>
      <div class="card card-pad"><h2>Recent hands</h2><div class="tx-list" id="recent"><div class="loading" style="min-height:120px"><div class="spinner"></div></div></div></div>
    </div>`;

  const formEl = main.querySelector('#form');
  const recentEl = main.querySelector('#recent');

  const loadPlayers = async () => {
    st.players = (await call('/api/admin/players')).players;
    if (st.selected) st.selected = st.players.find((p) => p.id === st.selected.id) || null;
  };
  const loadRecent = async () => {
    const { entries } = await call('/api/admin/activity?type=blackjack&limit=25');
    recentEl.innerHTML = entries.map((t) => txRow(t, { who: true })).join('') || '<div class="empty">No hand recorded yet.</div>';
  };

  const summary = () => {
    const cents = toCents(st.amount || 0);
    if (!st.selected) return 'Pick a player';
    const name = esc(st.selected.name);
    if (st.result === 'push') return `Record a push for ${name}`;
    if (!(cents > 0)) return 'Enter an amount';
    return st.result === 'win' ? `${name} wins ${fmt(cents)}` : `${name} loses ${fmt(cents)}`;
  };

  const paint = () => {
    const recent = recentIds()
      .map((id) => st.players.find((p) => p.id === id))
      .filter(Boolean);
    const term = st.search.trim().toLowerCase();
    const matches = term
      ? st.players.filter((p) => p.name.toLowerCase().includes(term) || p.code.startsWith(term)).slice(0, 8)
      : recent.length
        ? recent
        : st.players.slice(0, 6);

    formEl.innerHTML = `
      <div class="bj-block">
        <div class="step"><i>1</i> Player</div>
        ${
          st.selected
            ? `<div class="selected-player"><span class="avatar">${esc(initials(st.selected.name))}</span>
                <div class="pmain"><b>${esc(st.selected.name)}</b><div class="muted"><span class="code-tag">${esc(st.selected.code)}</span> · balance <span class="num">${fmt(st.selected.balance)}</span></div></div>
                <button class="btn btn-sm" id="change">Change</button></div>`
            : `<input class="input" id="search" type="search" placeholder="Name or code" value="${esc(st.search)}" autocomplete="off" />
               <div class="muted" style="font-size:12px;margin-top:10px">${term ? 'Matches' : recent.length ? 'At the table recently' : 'Players'}</div>
               <div class="suggestions">${matches.map((p) => prow(p)).join('') || '<div class="empty">No player found.</div>'}</div>`
        }
      </div>
      <div class="bj-block">
        <div class="step"><i>2</i> Result</div>
        <div class="segmented">
          <button class="seg win ${st.result === 'win' ? 'active' : ''}" data-r="win">Won</button>
          <button class="seg loss ${st.result === 'loss' ? 'active' : ''}" data-r="loss">Lost</button>
          <button class="seg push ${st.result === 'push' ? 'active' : ''}" data-r="push">Push</button>
        </div>
      </div>
      <div class="bj-block">
        <div class="step"><i>3</i> Amount</div>
        <input class="amount-input num" id="amount" inputmode="decimal" placeholder="${esc(S.settings.currencySymbol)}0" value="${esc(st.amount)}" ${st.result === 'push' ? 'disabled' : ''} />
        <div class="quick">
          ${[5, 10, 25, 50, 100].map((v) => `<button class="chip num" data-add="${v}" ${st.result === 'push' ? 'disabled' : ''}>+${v}</button>`).join('')}
          <button class="chip" data-add="clear" ${st.result === 'push' ? 'disabled' : ''}>Clear</button>
        </div>
        <input class="input" id="note" placeholder="Note (optional, e.g. blackjack 3:2)" maxlength="120" value="${esc(st.note)}" style="margin-top:12px" />
      </div>
      <div class="bj-block">
        <button class="btn btn-primary btn-lg btn-block" id="record">${summary()}</button>
      </div>`;

    const search = formEl.querySelector('#search');
    if (search) {
      search.addEventListener('input', () => {
        st.search = search.value;
        const pos = search.selectionStart;
        paint();
        const s2 = formEl.querySelector('#search');
        s2.focus();
        s2.setSelectionRange(pos, pos);
      });
    }
    const amount = formEl.querySelector('#amount');
    amount.addEventListener('input', () => {
      st.amount = amount.value;
      formEl.querySelector('#record').innerHTML = summary();
    });
    amount.addEventListener('keydown', (e) => e.key === 'Enter' && record());
    formEl.querySelector('#note').addEventListener('input', (e) => (st.note = e.target.value));
    formEl.querySelector('#record').addEventListener('click', record);
  };

  formEl.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pid]');
    if (pick) {
      st.selected = st.players.find((p) => p.id === Number(pick.dataset.pid));
      st.search = '';
      paint();
      if (st.result !== 'push') formEl.querySelector('#amount')?.focus();
      return;
    }
    if (e.target.closest('#change')) {
      st.selected = null;
      paint();
      formEl.querySelector('#search')?.focus();
      return;
    }
    const seg = e.target.closest('[data-r]');
    if (seg) {
      st.result = seg.dataset.r;
      paint();
      return;
    }
    const add = e.target.closest('[data-add]');
    if (add) {
      if (add.dataset.add === 'clear') st.amount = '';
      else st.amount = String((Number(st.amount) || 0) + Number(add.dataset.add));
      paint();
    }
  });

  let busy = false;
  async function record() {
    if (busy) return;
    if (!st.selected) return toast('Pick a player first', 'error');
    const cents = st.result === 'push' ? 0 : toCents(st.amount || 0);
    if (st.result !== 'push' && !(cents > 0)) return toast('Enter an amount', 'error');
    busy = true;
    try {
      const signed = st.result === 'loss' ? -cents : cents;
      const r = await call('/api/admin/blackjack', {
        method: 'POST',
        body: { playerId: st.selected.id, amount: signed, note: st.note, push: st.result === 'push' },
      });
      toast(`${st.selected.name}: ${st.result === 'push' ? 'push recorded' : fmt(signed, { sign: true })} · balance ${fmt(r.player.balance)}`, 'success');
      storage.set('lm_bj_recent', [st.selected.id, ...recentIds().filter((x) => x !== st.selected.id)].slice(0, 8));
      st.amount = '';
      st.note = '';
      await Promise.all([loadPlayers(), loadRecent()]);
      paint();
    } catch {
      /* toast shown */
    } finally {
      busy = false;
    }
  }

  bindUndo(recentEl, async () => {
    await Promise.all([loadPlayers(), loadRecent()]);
    paint();
  });

  await Promise.all([loadPlayers(), loadRecent()]);
  paint();
}

// ---------- machines ----------

async function loadMachines() {
  S.machines = (await call('/api/admin/machines')).machines;
  return S.machines;
}

async function renderMachines() {
  const main = layout('machines');
  const machines = await loadMachines();
  main.innerHTML = `
    <div class="page-head"><div><h1>Machines</h1><p>Edit names, looks, bets, symbols, payouts and jackpots.</p></div></div>
    <div class="machine-admin-grid">
      ${machines
        .map(({ config: c, jackpot, analysis: a }) => {
          const total = a.rtp + c.jackpotContribution / 100;
          return `<div class="ma-card" style="--to:${c.theme.to}">
            <div class="ma-top"><h3>${esc(c.name)}</h3><span class="badge ${c.enabled ? 'on' : 'off'}">${c.enabled ? 'Open' : 'Off'}</span></div>
            <div class="ma-syms">${c.symbols.map((s) => esc(s.s)).join(' ')}</div>
            <div class="ma-stats">
              <div><small>Jackpot</small><b>${fmt(jackpot)}</b></div>
              <div><small>RTP</small><b class="${total > 1 ? 'neg' : ''}">${pct(total)}</b></div>
              <div><small>Jackpot odds</small><b>${oneIn(a.jackpotProb).replace('1 in ', '1/')}</b></div>
            </div>
            <a class="btn btn-primary" href="#/machines/${esc(c.id)}">Edit machine</a>
          </div>`;
        })
        .join('')}
    </div>`;
}

async function renderMachineEditor(id) {
  const main = layout('machines');
  const machines = S.machines || (await loadMachines());
  const found = machines.find((m) => m.config.id === id);
  if (!found) {
    location.hash = '#/machines';
    return;
  }
  let draft = structuredClone(found.config);
  let jackpot = found.jackpot;

  const render = () => {
    main.innerHTML = `
      <div class="page-head">
        <div><a href="#/machines" class="muted" style="text-decoration:none">← Machines</a><h1>${esc(draft.name)}</h1></div>
        <div class="form-actions" style="margin:0">
          <button class="btn" id="reset">Reset to default</button>
          <button class="btn btn-primary" id="save">Save changes</button>
        </div>
      </div>
      <div class="grid-2 grid-editor">
        <div class="stack">
          <section class="card card-pad">
            <h2>General</h2>
            <div class="form-grid">
              <label class="field"><span>Name</span><input class="input" data-k="name" value="${esc(draft.name)}" maxlength="40" /></label>
              <label class="field"><span>Tagline</span><input class="input" data-k="tagline" value="${esc(draft.tagline)}" maxlength="80" /></label>
              <label class="field"><span>Reels</span><select class="input" data-k="reels">${[3, 4, 5].map((n) => `<option ${draft.reels === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
              <label class="switch"><span>Machine open<small>Players can see and play it</small></span><input type="checkbox" data-k="enabled" ${draft.enabled ? 'checked' : ''} /></label>
              <label class="field wide"><span>Bet sizes (${esc(S.settings.currencySymbol)}, separated by commas)</span>
                <input class="input num" data-k="bets" value="${draft.bets.map(units).join(', ')}" /></label>
              <div class="color-row wide">
                <label class="field"><span>Color 1</span><input type="color" class="input" data-k="theme.from" value="${draft.theme.from}" /></label>
                <label class="field"><span>Color 2</span><input type="color" class="input" data-k="theme.to" value="${draft.theme.to}" /></label>
                <label class="field"><span>Accent</span><input type="color" class="input" data-k="theme.accent" value="${draft.theme.accent}" /></label>
              </div>
            </div>
          </section>
          <section class="card card-pad">
            <h2>Jackpot</h2>
            <div class="form-grid">
              <label class="field"><span>Current jackpot (${esc(S.settings.currencySymbol)})</span>
                <div class="inline-form"><input class="input num" id="jpNow" inputmode="decimal" value="${units(jackpot)}" /><button class="btn" id="jpSet">Set now</button></div></label>
              <label class="field"><span>Reset value after a win (${esc(S.settings.currencySymbol)})</span><input class="input num" data-k="jackpotSeed" inputmode="decimal" value="${units(draft.jackpotSeed)}" /></label>
              <label class="field"><span>% of each bet added to jackpot</span><input class="input num" data-k="jackpotContribution" inputmode="decimal" value="${draft.jackpotContribution}" /></label>
              <label class="field"><span>Jackpot symbol</span><select class="input" data-k="jackpotSymbol" id="jpSym">${jpOptions()}</select></label>
            </div>
            <p class="hint">The jackpot is won when every reel shows the jackpot symbol on the middle line. Raise that symbol's weight to make it more frequent.</p>
          </section>
          <section class="card" style="overflow:hidden">
            <div class="card-pad" style="padding-bottom:6px"><h2>Symbols & payouts</h2>
              <p class="hint" style="margin-top:-6px">Weight = how often the symbol lands. Payouts are multipliers of the bet for N identical symbols in a row from the left.</p></div>
            <div style="overflow-x:auto" id="symWrap">${symTable()}</div>
            <div class="card-pad" style="padding-top:10px"><button class="btn btn-sm" id="addSym" ${draft.symbols.length >= 10 ? 'disabled' : ''}>＋ Add symbol</button></div>
          </section>
        </div>
        <aside class="card card-pad analysis" id="analysis"></aside>
      </div>`;
    paintAnalysis();
    bind();
  };

  function jpOptions() {
    return draft.symbols.map((s) => `<option value="${esc(s.s)}" ${s.s === draft.jackpotSymbol ? 'selected' : ''}>${esc(s.s)} ${esc(s.name)}</option>`).join('');
  }

  function symTable() {
    const total = draft.symbols.reduce((t, s) => t + (Number(s.weight) || 0), 0) || 1;
    const counts = Array.from({ length: draft.reels }, (_, i) => i + 1);
    return `<table class="sym-table">
      <thead><tr><th>Symbol</th><th>Name</th><th>Weight</th><th class="r">Chance</th>${counts.map((k) => `<th>×${k}</th>`).join('')}<th></th></tr></thead>
      <tbody>${draft.symbols
        .map(
          (s, i) => `<tr>
        <td><input class="input sym-input" data-sym="${i}" data-f="s" value="${esc(s.s)}" maxlength="16" /></td>
        <td><input class="input name-input" data-sym="${i}" data-f="name" value="${esc(s.name)}" maxlength="24" /></td>
        <td><input class="input num-input num" data-sym="${i}" data-f="weight" inputmode="numeric" value="${s.weight}" /></td>
        <td class="r num muted">${pct((Number(s.weight) || 0) / total)}</td>
        ${counts
          .map((k) =>
            s.s === draft.jackpotSymbol && k === draft.reels
              ? `<td><span class="badge warn">JACKPOT</span></td>`
              : `<td><input class="input num-input num" data-sym="${i}" data-f="pay" data-count="${k}" inputmode="decimal" placeholder="–" value="${s.pays?.[k] ?? ''}" /></td>`
          )
          .join('')}
        <td><button class="icon-btn" data-remove="${i}" aria-label="Remove symbol" ${draft.symbols.length <= 3 ? 'disabled' : ''} style="width:36px;height:36px;font-size:14px">✕</button></td>
      </tr>`
        )
        .join('')}</tbody></table>`;
  }

  function paintAnalysis() {
    const el = main.querySelector('#analysis');
    let a;
    try {
      a = analyze({ ...draft, symbols: draft.symbols.map((s) => ({ ...s, weight: Number(s.weight) || 0 })) });
    } catch {
      el.innerHTML = '<p class="muted">Fix the fields to see the odds.</p>';
      return;
    }
    const contrib = (Number(draft.jackpotContribution) || 0) / 100;
    const total = a.rtp + contrib;
    let verdict = '<span class="badge on">Balanced</span>';
    if (total > 1) verdict = '<span class="badge off">Players win money over time</span>';
    else if (total < 0.8) verdict = '<span class="badge warn">Very tight</span>';
    el.innerHTML = `
      <h2>Odds</h2>
      <div class="row"><span>Return to player</span><b class="${total > 1 ? 'neg' : ''}">${pct(total)}</b></div>
      <div class="row"><span class="muted">· from paytable</span><b>${pct(a.rtp)}</b></div>
      <div class="row"><span class="muted">· fed to jackpot</span><b>${pct(contrib)}</b></div>
      <div class="row"><span>Winning spins</span><b>${oneIn(a.hitRate)}</b></div>
      <div class="row"><span>Jackpot</span><b>${oneIn(a.jackpotProb)}</b></div>
      <div style="margin-top:12px">${verdict}</div>
      <p class="hint">Return to player is the share of all bets paid back on average. Below 100% the house keeps the difference; 88–96% feels fair.</p>`;
  }

  function refreshSymbols() {
    main.querySelector('#symWrap').innerHTML = symTable();
    main.querySelector('#jpSym').innerHTML = jpOptions();
    main.querySelector('#addSym').disabled = draft.symbols.length >= 10;
    paintAnalysis();
  }

  function bind() {
    main.addEventListener('input', onInput);
    main.addEventListener('change', onInput);
    main.querySelector('#addSym').addEventListener('click', () => {
      draft.symbols.push({ s: '⭐', name: 'New', weight: 5, pays: {} });
      refreshSymbols();
    });
    main.querySelector('#symWrap').addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove]');
      if (!b) return;
      const [removed] = draft.symbols.splice(Number(b.dataset.remove), 1);
      if (removed.s === draft.jackpotSymbol) draft.jackpotSymbol = draft.symbols[draft.symbols.length - 1].s;
      refreshSymbols();
    });
    main.querySelector('#save').addEventListener('click', save);
    main.querySelector('#reset').addEventListener('click', async () => {
      if (!confirm('Reset this machine to its factory settings? The current jackpot is kept.')) return;
      const r = await call(`/api/admin/machines/${id}/reset`, { method: 'POST' }).catch(() => null);
      if (!r) return;
      draft = structuredClone(r.config);
      await loadMachines();
      toast('Machine reset', 'success');
      main.removeEventListener('input', onInput);
      main.removeEventListener('change', onInput);
      render();
    });
    main.querySelector('#jpSet').addEventListener('click', async () => {
      const cents = toCents(main.querySelector('#jpNow').value);
      if (!Number.isFinite(cents) || cents < 0) return toast('Enter a valid amount', 'error');
      const r = await call(`/api/admin/machines/${id}/jackpot`, { method: 'POST', body: { amount: cents } }).catch(() => null);
      if (!r) return;
      jackpot = r.jackpot;
      await loadMachines();
      toast(`Jackpot set to ${fmt(jackpot)}`, 'success');
    });
  }

  function onInput(e) {
    const t = e.target;
    if (t.dataset.sym !== undefined) {
      const s = draft.symbols[Number(t.dataset.sym)];
      const f = t.dataset.f;
      if (f === 'pay') {
        s.pays = { ...s.pays };
        if (t.value === '') delete s.pays[t.dataset.count];
        else s.pays[t.dataset.count] = Number(t.value);
      } else if (f === 'weight') {
        s.weight = Number(t.value);
      } else if (f === 's') {
        const wasJackpot = s.s === draft.jackpotSymbol;
        s.s = t.value;
        if (wasJackpot) draft.jackpotSymbol = t.value;
        if (e.type === 'change') return refreshSymbols();
        main.querySelector('#jpSym').innerHTML = jpOptions();
      } else {
        s[f] = t.value;
        if (e.type === 'change') main.querySelector('#jpSym').innerHTML = jpOptions();
      }
      if (f === 'weight' && e.type === 'change') return refreshSymbols();
      return paintAnalysis();
    }
    const k = t.dataset.k;
    if (!k) return;
    if (k === 'enabled') draft.enabled = t.checked;
    else if (k === 'reels') {
      draft.reels = Number(t.value);
      return refreshSymbols();
    } else if (k.startsWith('theme.')) draft.theme[k.slice(6)] = t.value;
    else if (k === 'bets') draft.betsText = t.value;
    else if (k === 'jackpotSeed') draft.jackpotSeedText = t.value;
    else if (k === 'jackpotContribution') draft.jackpotContribution = t.value;
    else if (k === 'jackpotSymbol') {
      draft.jackpotSymbol = t.value;
      return refreshSymbols();
    } else draft[k] = t.value;
    paintAnalysis();
  }

  async function save() {
    const bets = (draft.betsText ?? draft.bets.map(units).join(','))
      .split(/[,;\s]+/)
      .filter(Boolean)
      .map(toCents);
    if (bets.some((b) => !Number.isFinite(b) || b <= 0)) return toast('Bet sizes must be positive numbers', 'error');
    const seed = draft.jackpotSeedText !== undefined ? toCents(draft.jackpotSeedText) : draft.jackpotSeed;
    const { betsText, jackpotSeedText, ...rest } = draft;
    const body = { ...rest, bets, jackpotSeed: seed, jackpotContribution: Number(draft.jackpotContribution) };
    const btn = main.querySelector('#save');
    btn.disabled = true;
    try {
      const r = await call(`/api/admin/machines/${id}`, { method: 'PUT', body });
      draft = structuredClone(r.config);
      await loadMachines();
      toast('Machine saved. Players see the change on their next visit.', 'success');
      main.querySelector('h1').textContent = draft.name;
    } catch {
      /* toast shown */
    } finally {
      btn.disabled = false;
    }
  }

  render();
}

// ---------- settings ----------

async function renderSettings() {
  const main = layout('settings');
  const { settings: s } = await call('/api/admin/settings');
  S.settings = s;
  const sw = (k, label, hint) =>
    `<label class="switch"><span>${label}<small>${hint}</small></span><input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''} /></label>`;
  main.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>Global options for the whole site.</p></div></div>
    <form id="f" class="stack">
      <section class="card card-pad">
        <h2>Site</h2>
        <div class="form-grid">
          <label class="field"><span>Site name</span><input class="input" name="siteName" value="${esc(s.siteName)}" maxlength="40" required /></label>
          <label class="field"><span>Currency symbol</span><input class="input" name="currencySymbol" value="${esc(s.currencySymbol)}" maxlength="4" required /></label>
          <label class="field wide"><span>Announcement banner (empty to hide)</span><input class="input" name="announcement" value="${esc(s.announcement)}" maxlength="200" /></label>
        </div>
      </section>
      <section class="card card-pad">
        <h2>Players</h2>
        <div class="form-grid">
          <label class="field"><span>Starting balance (${esc(s.currencySymbol)})</span><input class="input num" name="startingBalance" inputmode="decimal" value="${units(s.startingBalance)}" /></label>
          ${sw('allowSignup', 'Self sign-up', 'Players can create their own code from the home page')}
          ${sw('showLeaderboard', 'Leaderboard', 'Show the top 10 balances to players')}
        </div>
      </section>
      <section class="card card-pad">
        <h2>Machines</h2>
        <div class="form-grid">
          ${sw('slotsOpen', 'Machines open', 'Turn off to pause every machine at once')}
          <label class="field wide"><span>Message when closed</span><input class="input" name="closedMessage" value="${esc(s.closedMessage)}" maxlength="200" /></label>
          <label class="field"><span>Spin animation (ms)</span><input class="input num" name="spinDuration" inputmode="numeric" value="${s.spinDuration}" /></label>
          <label class="field"><span>Max auto-spins (0 hides the button)</span><input class="input num" name="maxAutoSpins" inputmode="numeric" value="${s.maxAutoSpins}" /></label>
        </div>
      </section>
      <div class="form-actions"><button class="btn btn-primary btn-lg">Save settings</button></div>
    </form>`;
  main.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      siteName: f.siteName.value,
      currencySymbol: f.currencySymbol.value,
      announcement: f.announcement.value,
      startingBalance: toCents(f.startingBalance.value),
      allowSignup: f.allowSignup.checked,
      showLeaderboard: f.showLeaderboard.checked,
      slotsOpen: f.slotsOpen.checked,
      closedMessage: f.closedMessage.value,
      spinDuration: Number(f.spinDuration.value),
      maxAutoSpins: Number(f.maxAutoSpins.value),
    };
    try {
      const r = await call('/api/admin/settings', { method: 'PUT', body });
      S.settings = r.settings;
      setCurrency(r.settings.currencySymbol);
      toast('Settings saved', 'success');
    } catch {
      /* toast shown */
    }
  });
}

// ---------- activity ----------

async function renderActivity() {
  const main = layout('activity');
  const filters = [
    ['all', 'All'],
    ['spins', 'Spins'],
    ['jackpot', 'Jackpots'],
    ['blackjack', 'Blackjack'],
    ['adjust', 'Adjustments'],
  ];
  let type = 'all';
  let lastId = null;
  main.innerHTML = `
    <div class="page-head"><div><h1>Activity</h1><p>Every spin, hand and adjustment, newest first.</p></div></div>
    <div class="filters">${filters.map(([k, l]) => `<button class="chip ${k === type ? 'active' : ''}" data-type="${k}">${l}</button>`).join('')}</div>
    <div class="tx-list" id="list"></div>
    <div class="form-actions"><button class="btn" id="more">Load more</button></div>`;
  const list = main.querySelector('#list');
  const more = main.querySelector('#more');

  const load = async (reset) => {
    if (reset) {
      lastId = null;
      list.innerHTML = '<div class="loading" style="min-height:120px"><div class="spinner"></div></div>';
    }
    const { entries } = await call(`/api/admin/activity?type=${type}&limit=50${lastId ? `&before=${lastId}` : ''}`);
    if (reset) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', entries.map((t) => txRow(t, { who: true })).join(''));
    if (reset && !entries.length) list.innerHTML = '<div class="empty">Nothing here yet.</div>';
    lastId = entries.length ? entries[entries.length - 1].id : lastId;
    more.classList.toggle('hidden', entries.length < 50);
  };

  main.querySelector('.filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    type = b.dataset.type;
    main.querySelectorAll('[data-type]').forEach((x) => x.classList.toggle('active', x === b));
    load(true);
  });
  more.addEventListener('click', () => load(false));
  bindUndo(list, () => load(true));
  await load(true);
}

// ---------- router ----------

async function route() {
  clearTimers();
  document.querySelectorAll('.overlay').forEach((o) => o.remove());
  const [pathPart, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [view, arg] = pathPart.split('/');
  const params = new URLSearchParams(query);
  window.scrollTo(0, 0);
  try {
    if (view === 'players') return await renderPlayers(params);
    if (view === 'blackjack') return await renderBlackjack();
    if (view === 'machines' && arg) return await renderMachineEditor(decodeURIComponent(arg));
    if (view === 'machines') return await renderMachines();
    if (view === 'settings') return await renderSettings();
    if (view === 'activity') return await renderActivity();
    return await renderDashboard();
  } catch {
    /* errors are already shown as toasts */
  }
}

async function start() {
  const { settings } = await call('/api/admin/settings');
  S.settings = settings;
  setCurrency(settings.currencySymbol);
  document.title = `${settings.siteName} · Admin`;
  if (!location.hash) location.hash = '#/dashboard';
  window.onhashchange = route;
  route();
}

(async () => {
  const { admin } = await api('/api/admin/session').catch(() => ({ admin: false }));
  if (admin) start();
  else renderLogin();
})();
