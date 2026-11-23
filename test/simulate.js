'use strict';
// Headless smoke test: starts the server, connects 4 bots, plays a full game under the guide's rules.
process.env.PORT = process.env.PORT || '3999';
const { rooms } = require('../server/index.js');
const { io } = require('socket.io-client');

const URL = `http://localhost:${process.env.PORT}`;
const NAMES = ['Alice', 'Bob', 'Cara', 'Dev'];
let finished = false;
const checks = { kingTurnFirst: true, kingPlaysOk: true, handTopUp: true, goldBounds: true };

function makeBot(name) {
  const s = io(URL, { forceNew: true });
  const bot = { name, s, state: null, busy: false, answered: new Set() };
  const act = (type, payload) => new Promise((res) => s.emit('action', { type, payload }, res));
  s.on('state', async (st) => {
    bot.state = st;
    for (const p of st.players) if (p.gold < 0 || p.gold > st.settings.maxGold) checks.goldBounds = false;
    if (st.phase === 'gameOver' && !finished) {
      finished = true;
      console.log('\n=== GAME OVER ===');
      console.log(st.ranking.map((r) => `${r.rank}. ${r.name} ${r.gold}${r.winner ? ' (KING — winner)' : ''}`).join('\n'));
      const log = st.log.map((l) => l.text);
      const errs = st.log.filter((l) => l.kind === 'error');
      if (process.env.VERBOSE) log.forEach((l) => console.log('   ', l));
      console.log('crown changes:', log.filter((l) => l.includes('takes the crown')).length,
        '| trades:', log.filter((l) => l.includes('exchanged cards')).length,
        '| face-down:', log.filter((l) => l.includes('face down')).length,
        '| knight checks:', log.filter((l) => l.includes('real Knight') || l.includes('bluff')).length);
      console.log('checks:', JSON.stringify(checks));
      console.log(`log entries: ${log.length}, engine errors: ${errs.length}`);
      errs.forEach((e) => console.log('  ERR', e.text));
      const ok = !errs.length && Object.values(checks).every(Boolean);
      setTimeout(() => process.exit(ok ? 0 : 1), 200);
    }
    if (bot.busy) { bot.pending = true; return; }
    bot.busy = true;
    try {
      for (const pr of st.prompts) {
        if (bot.answered.has(pr.id)) continue;
        bot.answered.add(pr.id);
        const value = pr.type === 'number' ? pr.min : Math.floor(Math.random() * Math.max(1, pr.options.length));
        await new Promise((r) => setTimeout(r, 20));
        await act('respond', { promptId: pr.id, value });
      }
      const meP = st.players.find((p) => p.id === st.you);
      if (st.phase === 'negotiation' && !st.ready.includes(st.you) && !bot.negotiated) {
        bot.negotiated = true;
        const other = st.players.find((p) => p.id !== st.you && p.role === meP.role);
        if (Math.random() < 0.5) await act('giveGold', { to: st.players.find((p) => p.id !== st.you).id, amount: 100 });
        if (other && st.hand.length && Math.random() < 0.6) act('proposeTrade', { to: other.id, uid: st.hand[0].uid });
        await new Promise((r) => setTimeout(r, 300));
        await act('ready');
      }
      if (st.phase !== 'negotiation') bot.negotiated = false;
      if (st.phase === 'turns' && st.currentPlayerId === st.you && !st.resolving && !st.prompts.length) {
        if (!bot.turnSeen || bot.turnSeen !== `${st.round}`) {
          bot.turnSeen = `${st.round}`;
          // first turn-state of the round for this bot
          if (meP.role === 'king') {
            const expected = st.players.length - 1 <= 3 ? st.settings.kingPlaysFewNobles : st.settings.kingPlays;
            if (st.playsRemaining !== expected) checks.kingPlaysOk = false;
          }
          if (st.hand.length < st.settings.handSize) checks.handTopUp = false;
        }
        await new Promise((r) => setTimeout(r, 30));
        const card = st.hand.find((c) => c.playable);
        if (st.playsRemaining > 0 && st.hand.length && Math.random() < 0.15) await act('placeFaceDown', { uid: (st.hand.find((c) => c.knight) || st.hand[0]).uid, target: meP.role === 'king' ? st.players.find((p) => p.id !== st.you).id : undefined });
        else if (card && st.playsRemaining > 0) await act('playCard', { uid: card.uid });
        else if (st.canEndTurn) await act('endTurn');
      }
    } finally {
      bot.busy = false;
      if (bot.pending) { bot.pending = false; setImmediate(() => s.listeners('state')[0](bot.state)); }
    }
  });
  return { bot, act };
}

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const host = makeBot(NAMES[0]);
  const res = await new Promise((r) => host.bot.s.emit('createRoom', { name: NAMES[0] }, r));
  console.log('room', res.code);
  const bots = [];
  for (const n of NAMES.slice(1)) {
    const b = makeBot(n);
    const j = await new Promise((r) => b.bot.s.emit('joinRoom', { code: res.code, name: n }, r));
    if (!j.ok) throw new Error(j.error);
    bots.push(b);
  }
  const notHost = await bots[0].act('start');
  console.log('non-host start rejected:', !notHost.ok);

  // watch turn order: first turn line of every round must be the King
  host.bot.s.on('state', (st) => {
    const idx = st.log.findIndex((l, i) => l.kind === 'round' && l.text.startsWith('Round') && !host.seen?.has(i));
    if (idx >= 0) {
      const next = st.log.slice(idx + 1).find((l) => l.kind === 'turn');
      if (next) {
        host.seen = host.seen || new Set();
        host.seen.add(idx);
        if (!next.text.includes('(King')) checks.kingTurnFirst = false;
      }
    }
  });

  await host.act('updateSettings', { negotiationTime: 4, turnTime: 15, promptTime: 5, reactionTime: 2 });
  const st = await host.act('start');
  console.log('start ok:', st.ok);
  setTimeout(() => { const room = [...rooms.values()][0]; const T = room.timer; console.log('SERVER: phase', room.phase, 'current', room.currentPlayerId, 'turnOpen', room.turnOpen, 'plays', room.playsRemaining, 'resolving', !!room.resolving, 'timerActive', T.active, 'paused', T.paused, 'msLeft', T.endsAt - Date.now(), 'prompts', [...room.prompts.values()].map((p) => p.playerId + ':' + p.spec.title + ':' + (p.endsAt - Date.now()))); const s = host.bot.state; console.log('TIMEOUT — phase', s.phase, 'current', s.currentPlayerId, 'timer', JSON.stringify(s.timer), 'resolving', JSON.stringify(s.resolving), 'canEnd', s.canEndTurn); console.log(s.log.slice(-8).map((l) => l.text)); process.exit(1); }, 180000);
})();
