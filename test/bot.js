'use strict';
// Usage: node test/bot.js ROOMCODE [name] [port]  — joins a room and plays automatically (for testing).
const { io } = require('socket.io-client');
const [code, name = 'Bot', port = 3000] = process.argv.slice(2);
const s = io(`http://localhost:${port}`);
const act = (type, payload) => new Promise((r) => s.emit('action', { type, payload }, r));
const answered = new Set();
let busy = false;
let latest = null;
let pending = false;
s.emit('joinRoom', { code, name }, (r) => console.log('join', r.ok ? 'ok' : r.error));

async function handle(st) {
  for (const pr of st.prompts) {
    // Prompt ids restart in every game, so key on id + deadline to stay unique across games in one room.
    const key = `${pr.id}:${pr.endsAt}`;
    if (answered.has(key)) continue; answered.add(key);
    await new Promise((r) => setTimeout(r, 1200));
    // Typed lines: say the suggested line (or a generic thank-you) most of the time, refuse sometimes.
    const value = pr.type === 'text' ? (Math.random() < 0.85 ? (pr.suggestion || 'Thank you, my king!') : null)
      : pr.type === 'number' ? pr.min : Math.floor(Math.random() * Math.max(1, pr.options.length));
    await act('respond', { promptId: pr.id, value });
  }
  if (st.phase === 'negotiation' && !st.ready.includes(st.you)) await act('ready');
  if (st.phase === 'turns' && st.currentPlayerId === st.you && !st.resolving && !st.prompts.length) {
    await new Promise((r) => setTimeout(r, 1500));
    const c = st.hand.find((x) => x.playable);
    if (c && st.playsRemaining > 0) await act('playCard', { uid: c.uid }); else await act('endTurn');
  }
}

// Updates that arrive while the bot is busy aren't dropped: the latest one is handled afterwards.
s.on('state', async (st) => {
  latest = st;
  if (busy) { pending = true; return; }
  busy = true;
  try {
    do { pending = false; await handle(latest); } while (pending);
  } finally { busy = false; }
});
