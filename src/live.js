// Server-Sent Events hub. Players at the blackjack table keep a stream open;
// balance changes are pushed to them instantly and the admin can see who is
// seated. Everything is in memory, which works because the app runs as a
// single instance.

const clients = new Map(); // playerId -> Set<{ res, table }>

function write(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function connect(req, res, player, { table = false } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  write(res, 'balance', { balance: player.balance });

  const client = { res, table, since: Date.now() };
  if (!clients.has(player.id)) clients.set(player.id, new Set());
  clients.get(player.id).add(client);

  // Comments keep proxies (Render) from closing an idle stream.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    const set = clients.get(player.id);
    set?.delete(client);
    if (set && !set.size) clients.delete(player.id);
  });
}

export function publish(playerId, data) {
  for (const c of clients.get(playerId) || []) write(c.res, 'balance', data);
}

// Tells a player's open streams to stop (account disabled, code changed, deleted).
export function kick(playerId) {
  for (const c of clients.get(playerId) || []) {
    write(c.res, 'kicked', {});
    c.res.end();
  }
  clients.delete(playerId);
}

// Player ids currently seated at the blackjack table, longest seated first.
export function seated() {
  const out = [];
  for (const [id, set] of clients) {
    const since = Math.min(...[...set].filter((c) => c.table).map((c) => c.since));
    if (Number.isFinite(since)) out.push({ id, since });
  }
  return out.sort((a, b) => a.since - b.since).map((x) => x.id);
}
