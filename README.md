# 🎰 Lucky Machines

A play-money slot machine website for parties, events and game nights.

- **5 slot machines**, each with its own progressive jackpot that can actually be won, and several ways to win: up to 9 **pay lines**, **wild** symbols and **scatter** symbols that pay anywhere.
- **Live blackjack table screen**: a player sitting at the real table taps **🃏 Blackjack** and gets a full-screen view of their balance. When the dealer records a hand in the admin panel, it updates instantly with a win/loss animation. **Leave table** is always one tap away.
- **Players sign in with a 5-digit code.** The code keeps their balance and stats: spins, total bet, total won, biggest win, jackpots, per-machine results and blackjack results.
- **Hidden admin panel** protected by a username and password. From it you can:
  - create players and hand out codes, edit balances, rename, disable, reset codes or delete players
  - **record the physical blackjack table**: players with the table screen open appear at the top as "Seated at the table now". Pick one, choose Won / Lost / Push, enter the amount, and their balance updates instantly on their phone (with Undo).
  - edit every machine: name, colors, bet sizes, number of pay lines, wild and scatter symbols, symbols, symbol weights, payouts, jackpot symbol, current jackpot, jackpot reset value and the % of each bet that feeds it. Live odds (return to player, hit rate, jackpot odds) update as you type.
  - edit global settings: site name, currency symbol, starting balance, self sign-up, leaderboard, blackjack table screen, announcement banner, open/close all machines, spin speed, auto-spin
  - see a live dashboard and a full activity log
- **Mobile-first UI.** Works on phones, tablets and desktops.

> ⚠️ **Play money only.** No real money is involved. Do not use this to take real bets.

**Tech:** Node.js (no npm dependencies at all), [Turso](https://turso.tech) (hosted SQLite) for storage and [Render](https://render.com) free tier for hosting. Because there are no third-party packages there is nothing to `npm install`, and no supply-chain risk.

---

## Table of contents

1. [Set up the Turso database](#1-set-up-the-turso-database)
2. [Deploy on Render](#2-deploy-on-render)
3. [First steps after deploying](#3-first-steps-after-deploying)
4. [How the games work](#4-how-the-games-work)
5. [Run it on your computer](#5-run-it-on-your-computer)
6. [Environment variables](#6-environment-variables)
7. [Troubleshooting](#7-troubleshooting)
8. [Project structure](#8-project-structure)

---

## 1. Set up the Turso database

Turso hosts the database for free. The app creates all of its tables by itself on first start, so you only need an empty database, its URL and a token.

### Option A: with the Turso website (no installation)

1. Go to <https://app.turso.tech> and sign up (GitHub sign-in works).
2. Click **Create Database**.
   - **Name:** e.g. `lucky-machines`
   - **Location:** pick the region closest to the Render region you will choose in step 2 (for example *AWS us-east-1 (Virginia)* if you will use Render *Virginia* / *Ohio*, or *AWS eu-west-1* for Render *Frankfurt*). Being close keeps the spins fast.
3. Open the database page:
   - Copy the **URL**. It looks like `libsql://lucky-machines-yourname.aws-us-east-1.turso.io`. This is your `TURSO_DATABASE_URL`.
   - Click **Create Token** (sometimes under the **⋯** menu or a **Generate token** button), choose **Read & Write** and **no expiration**, then copy the token. This is your `TURSO_AUTH_TOKEN`.
4. Keep both values somewhere safe. You will paste them into Render.

### Option B: with the Turso CLI

```bash
# macOS / Linux / WSL
curl -sSfL https://get.tur.so/install.sh | bash
# Windows (PowerShell): install WSL, or use Option A

turso auth signup                      # or: turso auth login
turso db create lucky-machines         # add --location <code> to choose a region (turso db locations)
turso db show lucky-machines --url     # -> TURSO_DATABASE_URL
turso db tokens create lucky-machines  # -> TURSO_AUTH_TOKEN
```

**Free plan limits:** the Turso free plan is far more than a party needs. Every spin writes about 4 small rows.

---

## 2. Deploy on Render

### Step 1: Put the code on GitHub

This repository (`https://github.com/tigamer20/machines`) is ready to deploy as is.

### Step 2: Create the web service

You can use either the Blueprint (fastest) or manual setup.

#### Option A: Blueprint (uses `render.yaml`)

1. Go to <https://dashboard.render.com> → **New +** → **Blueprint**.
2. Connect your GitHub account and pick the `machines` repository.
3. Render reads `render.yaml` and asks for the values marked `sync: false`. Fill them in:

   | Variable | What to put |
   | --- | --- |
   | `TURSO_DATABASE_URL` | the `libsql://...` URL from Turso |
   | `TURSO_AUTH_TOKEN` | the token from Turso |
   | `ADMIN_USERNAME` | your admin username |
   | `ADMIN_PASSWORD` | a strong password (12+ characters) |
   | `ADMIN_PATH` | the secret address of the admin panel, e.g. `/backstage-7f3k9` |

   `SESSION_SECRET` is generated automatically.
4. Click **Apply**. The first deploy takes 1–3 minutes.

#### Option B: Manual setup

1. Go to <https://dashboard.render.com> → **New +** → **Web Service**.
2. Connect GitHub and choose the `machines` repository.
3. Fill in:
   - **Name:** `lucky-machines` (this becomes `https://lucky-machines.onrender.com`; pick another name if it is taken)
   - **Region:** the closest one to your Turso database
   - **Branch:** `main`
   - **Runtime / Language:** `Node`
   - **Build Command:** `true` (there is nothing to build or install; `npm install` also works)
   - **Start Command:** `node server.js`
   - **Instance Type:** **Free**
4. Under **Environment Variables** add:

   | Key | Value |
   | --- | --- |
   | `NODE_VERSION` | `22.14.0` |
   | `NODE_ENV` | `production` |
   | `TURSO_DATABASE_URL` | the `libsql://...` URL |
   | `TURSO_AUTH_TOKEN` | the Turso token |
   | `ADMIN_USERNAME` | your admin username |
   | `ADMIN_PASSWORD` | a strong password |
   | `ADMIN_PATH` | e.g. `/backstage-7f3k9` |
   | `SESSION_SECRET` | a long random string (click **Generate**) |

5. Under **Advanced**, set **Health Check Path** to `/healthz`.
6. Click **Create Web Service**.

### Step 3: Check it works

- Open the **Logs** tab. You should see:
  ```
  Lucky Machines listening on http://localhost:10000 (database: turso)
  Admin panel: /backstage-7f3k9/
  ```
  If it says `database: local`, the `TURSO_DATABASE_URL` variable is missing (and your data would be lost on every restart).
- Visit `https://<your-service>.onrender.com` → you should see the code keypad.
- Visit `https://<your-service>.onrender.com/backstage-7f3k9/` (your `ADMIN_PATH`) → admin sign-in.

### About the Render free plan

- **It sleeps after 15 minutes without visitors.** The next visit wakes it up, which takes about 30–60 seconds. Open the site a minute before your event starts. (Optional: a free uptime monitor such as UptimeRobot pinging `/healthz` every 10 minutes keeps it awake, within the free-hours limit.)
- **The disk is temporary**, which is why all data lives in Turso. Restarts and redeploys never lose players or balances.
- **Updating the site:** push to `main` and Render redeploys automatically.

---

## 3. First steps after deploying

1. Open your admin panel (`https://<your-service>.onrender.com<ADMIN_PATH>/`) and sign in.
2. **Settings:** set the site name, currency symbol and the starting balance for new players.
3. **Players → New player:** enter a name. The app shows a **5-digit code**. Give it to the player.
4. The player opens the site on their phone, types the code and plays.
5. **Blackjack:**
   - Each player at the real table opens the site on their phone and taps **🃏 Blackjack** (in the menu or on the home screen). Their phone shows their balance in big numbers and stays awake. They can tap **Leave table** at any time.
   - The dealer opens **Blackjack** in the admin panel (works well on a phone). Seated players are listed at the top with a green dot. For each hand: tap the player → **Won**, **Lost** or **Push** → amount (quick buttons +5, +10, +25…) → **Record**.
   - The player's screen updates instantly (green flash for a win, red for a loss) and keeps a running total for the session. If you make a mistake, press **Undo** next to the entry; the player's screen shows the correction.
   - You can turn the table screen off in **Settings → Blackjack table**.
6. **Machines:** adjust anything you like. The **Odds** panel shows you the effect before you save.

Tip: bookmark the admin URL. It is never linked from the player site and is marked `noindex`. The real protection is still your username and password: login attempts are rate-limited and sessions expire after 12 hours.

---

## 4. How the games work

Each spin shows 3 rows on every reel. Every reel uses the same **weighted** list of symbols: a symbol with weight 10 lands twice as often as one with weight 5. There are four ways to win, and all of them add up on the same spin:

1. **Pay lines.** Each machine has up to 5 lines (3 reels) or 9 lines (5 reels): the 3 rows, diagonals, V shapes and zigzags. The bet is split evenly across the active lines. A line pays when it starts with identical symbols from the left reel, and the payout multiplies the line bet. Example: on *Lucky Sevens* with a $5 bet on 5 lines ($1 per line), `7️⃣ 7️⃣ 7️⃣` on any line pays 50 × $1 = $50.
2. **Wild.** The wild symbol replaces any regular symbol to complete a line (`🃏 7️⃣ 7️⃣` counts as three sevens). A line made only of wilds has its own, bigger payout. Wilds never replace the jackpot or scatter symbol.
3. **Scatter.** The scatter pays anywhere on the screen, no line needed: count the reels that show it. Its payout multiplies the whole bet.
4. **Jackpot.** Fill any active line with the machine's jackpot symbol to win the whole jackpot, which then resets to its "reset value". A percentage of every bet on that machine is added to the jackpot, so it grows while people play (players see it climb live).

Winning lines are drawn over the reels, and the **ℹ️** button on each machine lists every way to win, with the real amounts for the selected bet.

All randomness happens on the server with a cryptographically secure generator. The browser only animates the result, so players cannot cheat.

The defaults pay back about **91–92%** of bets on average (93–96% counting what feeds the jackpot), verified with 200,000 simulated spins per machine:

| Machine | Reels / lines | Wild · Scatter | Bets | Jackpot starts at | Jackpot odds |
| --- | --- | --- | --- | --- | --- |
| Lucky Sevens | 3 / 5 | 🃏 · 🔥 | $1–$25 | $1,000 | 1 in ~10,000 |
| Fruit Fiesta | 3 / 5 | 🌈 · 🧺 | $0.50–$10 | $500 | 1 in ~14,000 |
| Neon Nights | 5 / 9 | 🌀 · 🎤 | $1–$20 | $2,500 | 1 in ~21,000 |
| Pharaoh's Gold | 5 / 9 | 🌞 · 📜 | $2–$50 | $5,000 | 1 in ~21,000 |
| Galaxy Jackpot | 3 / 5 | 🕳️ · 🛸 | $5–$100 | $10,000 | 1 in ~9,000 |

Want jackpots more often during a short event? In **Machines**, raise the weight of the jackpot symbol (for example from 1 to 2) and watch the **Jackpot** odds in the side panel. **Reset to default** restores the original paytable at any time.

> Upgrading from the first version: on startup, machines saved by the old single-line version are replaced by these new defaults automatically. Current jackpot amounts are kept.

Run `npm run check` to print the odds of the default machines.

---

## 5. Run it on your computer

Requirements: **Node.js 22.13 or newer** (<https://nodejs.org>). Nothing else to install.

```bash
git clone https://github.com/tigamer20/machines.git
cd machines
cp .env.example .env      # then edit .env: set ADMIN_USERNAME / ADMIN_PASSWORD
npm run dev
```

Open <http://localhost:3000> for the player site and <http://localhost:3000/admin/> (or your `ADMIN_PATH`) for the admin panel.

If `TURSO_DATABASE_URL` is empty, the app stores everything in `data/local.db` using Node's built-in SQLite. That's handy for testing. Put your Turso URL and token in `.env` to use the real database instead.

---

## 6. Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `TURSO_DATABASE_URL` | yes, in production | `libsql://...` URL of the Turso database. Without it, a local SQLite file is used. |
| `TURSO_AUTH_TOKEN` | yes, with Turso | Turso database token (read & write). |
| `ADMIN_USERNAME` | yes | Admin username. The admin panel is disabled until both admin variables are set. |
| `ADMIN_PASSWORD` | yes | Admin password. Changing it signs every admin out. |
| `ADMIN_PATH` | recommended | Secret path of the admin panel. Default `/admin`. Use something hard to guess. |
| `SESSION_SECRET` | yes, in production | Long random string used to sign login cookies. If missing, a random one is generated at start, and everybody must sign in again after each restart. |
| `NODE_ENV` | recommended | `production` on Render (enables secure cookies). |
| `PORT` | no | Set automatically by Render. Default `3000`. |
| `LOCAL_DB_FILE` | no | Path of the local SQLite file when Turso is not configured. |

---

## 7. Troubleshooting

| Problem | Fix |
| --- | --- |
| Render log shows `Turso HTTP 401` | The token is wrong or expired. Create a new token in Turso and update `TURSO_AUTH_TOKEN`. |
| Render log shows `Turso HTTP 404` or `fetch failed` | Check `TURSO_DATABASE_URL` (it must start with `libsql://` or `https://`, no spaces). |
| Log says `database: local` on Render | `TURSO_DATABASE_URL` is not set. Data would be wiped on restart. Add it and redeploy. |
| Admin page says "Admin is not configured" | Set both `ADMIN_USERNAME` and `ADMIN_PASSWORD`. |
| Admin page shows `Not found` | You are not using the exact `ADMIN_PATH`. It needs the trailing part exactly as set, e.g. `/backstage-7f3k9/`. |
| "Too many attempts" | Login is rate-limited per device (15 tries per 5 min for players, 8 per 15 min for admin). Wait and retry. |
| The site takes ~1 minute to open | Normal on the free plan after 15 minutes idle (see above). |
| The table screen says "Reconnecting…" | The phone lost its connection or the server restarted. It reconnects by itself within a few seconds. |
| A player forgot their code | Admin → Players → search their name. The code is shown in the list. |
| A code was leaked | Admin → Players → open the player → **New code**. The old code stops working immediately. |

---

## 8. Project structure

```
server.js            HTTP server, routes, static files, hidden admin path
src/db.js            Turso HTTP client (no SDK) + local SQLite fallback
src/schema.js        Tables, created automatically on start
src/store.js         Spins, jackpots, players, blackjack, settings (all money moves are serialized)
src/defaults.js      Default settings and the 5 default machines
src/validate.js      Input validation for admin edits
src/auth.js          Signed cookies, admin credentials, rate limiting
src/live.js          Live balance stream (Server-Sent Events) for the blackjack table screen
shared/paytable.js   Pay lines, wilds, scatters, jackpot and exact odds (used by server and browser)
public/              Player site (index.html, app.js, app.css, ui.js)
admin/               Admin panel (only served under ADMIN_PATH)
render.yaml          Render Blueprint
scripts/odds.js      Prints the odds of the default machines (npm run check)
```

The app runs as a single instance (the Render free plan has one), and every money operation goes through one in-process queue, so two spins can never use the same balance twice.
