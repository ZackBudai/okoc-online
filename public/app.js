'use strict';

const socket = io();
let state = null;
let theme = {};
let schema = [];
let selectedUid = null;
let renderedPromptKey = '';
let lastRollId = null;
let lastChatCount = 0;
let activeTab = 'log';
let settingsBuilt = false;

const $ = (s) => document.querySelector(s);

// Small DOM builder — always uses text nodes, so player names can't inject HTML.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const show = (el, on) => el.classList.toggle('hidden', !on);
const me = () => state.players.find((p) => p.id === state.you);
const pname = (id) => state.players.find((p) => p.id === id)?.name ?? '?';
const isHost = () => state && state.hostId === state.you;
const cur = () => theme.currency || 'gold';
// A hooded Noble or crowned King silhouette with two eyes, drawn entirely in CSS.
const figure = (role, extra = '') => h('div', { class: `figure ${role === 'king' ? 'king' : 'noble'} ${extra}`.trim(), 'aria-hidden': 'true' },
  h('i', { class: 'eye' }), h('i', { class: 'eye' }));
// A card back (artwork in public/art/back-noble.png / back-king.png, styled in CSS).
const cardBack = (deck, extra = '') => h('div', { class: `card-back deck-${deck === 'king' ? 'king' : 'noble'} ${extra}`.trim(), title: `${deck === 'king' ? (theme.leaderTitle || 'King') : (theme.playerTitle || 'Noble')} card` });

function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3800);
}

function action(type, payload) {
  return new Promise((resolve) => {
    socket.emit('action', { type, payload }, (res) => {
      if (res && !res.ok) toast(res.error, 'error');
      resolve(res);
    });
  });
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
const session = {
  get() { try { return JSON.parse(localStorage.getItem('session') || 'null'); } catch { return null; } },
  set(v) { localStorage.setItem('session', JSON.stringify(v)); },
  clear() { localStorage.removeItem('session'); },
};

socket.on('connect', () => {
  const s = session.get();
  if (s) {
    socket.emit('rejoin', s, (res) => {
      if (!res.ok) { session.clear(); showScreen('home'); }
    });
  }
});
socket.on('disconnect', () => toast('Connection lost — reconnecting…', 'error'));
socket.on('kicked', (msg) => { toast(msg, 'error'); });
socket.on('toast', (msg) => toast(msg));
socket.on('state', (s) => { state = s; render(); });

function enter(event) {
  const name = $('#name').value.trim();
  if (!name) return ($('#home-error').textContent = 'Enter your name first');
  localStorage.setItem('name', name);
  const payload = { name, code: $('#join-code').value.trim().toUpperCase() };
  socket.emit(event, payload, (res) => {
    if (!res.ok) return ($('#home-error').textContent = res.error);
    session.set({ code: res.code, token: res.token });
    history.replaceState(null, '', `?room=${res.code}`);
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function showScreen(name) {
  for (const s of ['home', 'lobby', 'game']) show($(`#screen-${s}`), s === name);
  show($('#sidebar'), name !== 'home');
  document.body.dataset.screen = name;
}

function render() {
  if (!state) return;
  if (state.phase === 'lobby') { showScreen('lobby'); renderLobby(); }
  else { showScreen('game'); settingsBuilt = false; renderGame(); }
  renderFeeds();
  // Toasts float just above the hand bar, whatever its height on this screen.
  document.documentElement.style.setProperty('--hand-h', `${$('#hand-area').offsetHeight}px`);
  renderPrompt();
  renderDice();
}

function renderLobby() {
  $('#lobby-code').textContent = state.code;
  $('#lobby-players').replaceChildren(...state.players.map((p) => h('li', { class: p.connected ? '' : 'dim' },
    figure('noble', 'tiny'),
    h('span', { class: 'lp-name' }, p.name),
    p.id === state.hostId ? h('span', { class: 'tag' }, 'host') : null,
    p.id === state.you ? h('span', { class: 'tag you' }, 'you') : null)));
  show($('#btn-start'), isHost());
  const enough = state.players.filter((p) => p.connected).length >= state.settings.minPlayers; // offline players are dropped at start
  $('#btn-start').disabled = !enough;
  $('#lobby-note').textContent = isHost()
    ? (enough ? 'Start when everyone is in.' : `Waiting for at least ${state.settings.minPlayers} players…`)
    : 'Waiting for the host to start…';
  renderSettings();
}

function renderSettings() {
  const form = $('#settings-form');
  if (!settingsBuilt && schema.length) {
    form.replaceChildren(...schema.map((f) => {
      let input;
      if (f.type === 'bool') input = h('input', { type: 'checkbox', name: f.key });
      else if (f.type === 'select') input = h('select', { name: f.key }, f.options.map(([v, l]) => h('option', { value: v }, l)));
      else input = h('input', { type: 'number', name: f.key, min: f.min, max: f.max, step: f.step });
      input.addEventListener('change', () => {
        const v = f.type === 'bool' ? input.checked : f.type === 'number' ? Number(input.value) : input.value;
        action('updateSettings', { [f.key]: v });
      });
      return h('label', { class: f.type === 'bool' ? 'check' : '' }, h('span', null, f.label), input);
    }));
    settingsBuilt = true;
  }
  for (const f of schema) {
    const el = form.elements[f.key];
    if (!el) continue;
    el.disabled = !isHost();
    if (document.activeElement === el) continue;
    if (f.type === 'bool') el.checked = !!state.settings[f.key];
    else el.value = state.settings[f.key];
  }
}

// During the playing phase: whose turn it is out of how many this round, counted from the King.
function phaseLabel(s) {
  if (s.phase === 'turns' && s.currentPlayerId) {
    const n = s.players.length;
    const king = s.players.findIndex((p) => p.id === s.leaderId);
    const cur = s.players.findIndex((p) => p.id === s.currentPlayerId);
    if (king >= 0 && cur >= 0) {
      const step = s.direction === 'cw' ? 1 : -1;
      const pos = ((((cur - king) * step) % n) + n) % n + 1;
      return `Playing · turn ${pos}/${n}`;
    }
  }
  return PHASE_LABEL[s.phase] || s.phase;
}

const PHASE_LABEL = {
  leaderSelect: 'Choosing the Leader', roundStart: 'Round starting', negotiation: 'Negotiation',
  turns: 'Playing phase', roundEnd: 'Round ending', gameOver: 'Game over',
};

function renderGame() {
  const s = state;
  const leaderT = theme.leaderTitle || 'King';
  const nobleT = theme.playerTitle || 'Noble';
  $('#tb-round').textContent = s.round ? `Round ${s.round}/${s.settings.rounds}` : 'Setup';
  $('#tb-dir').textContent = s.direction === 'cw' ? '↻ Clockwise' : '↺ Counter-clockwise';
  show($('#tb-dir'), !!s.round);
  $('#tb-phase').textContent = phaseLabel(s);
  $('#tb-deck').replaceChildren(
    h('span', { class: 'pile' }, cardBack('king', 'pile-back'), `${leaderT} deck ${s.deckCounts.king}`),
    h('span', { class: 'pile' }, cardBack('noble', 'pile-back'), `${nobleT} deck ${s.deckCounts.noble}`));
  show($('#btn-end-game'), isHost() && s.phase !== 'gameOver');

  // players, seated around the table: clockwise means down the right side, then back up the left
  const seatEl = (p) => h('div', { class: ['seat', p.id === s.currentPlayerId && 'active'].filter(Boolean).join(' ') },
    h('div', {
      class: ['player', p.id === s.currentPlayerId && 'active', p.id === s.you && 'self', !p.connected && 'dim'].filter(Boolean).join(' '),
    },
    figure(p.role, p.id === s.currentPlayerId ? 'small awake' : 'small'),
    h('div', { class: 'p-head' },
      h('span', { class: 'p-name' }, p.name),
      p.role === 'king' ? h('span', { class: 'tag leader' }, leaderT) : p.role ? h('span', { class: 'tag' }, nobleT) : null,
      p.id === s.you ? h('span', { class: 'tag you' }, 'you') : null,
      !p.connected ? h('span', { class: 'tag' }, 'offline') : null,
      s.phase === 'negotiation' && s.ready.includes(p.id) ? h('span', { class: 'tag ok' }, 'ready') : null,
      s.phase === 'negotiation' && s.skipVotes.includes(p.id) ? h('span', { class: 'tag' }, 'skip') : null),
    h('div', { class: 'p-gold' }, `${p.gold} ${cur()}`),
    h('div', { class: 'p-meta muted' },
      p.role ? h('span', { class: 'fan' }, Array.from({ length: Math.min(p.handCount, 8) }, () => cardBack(p.role, 'fan-back'))) : null,
      `${p.handCount} card${p.handCount === 1 ? '' : 's'}`),
    p.statuses.length ? h('div', { class: 'p-status' }, p.statuses.map((st) => h('span', { class: 'tag status', title: st.description }, st.label || st.key))) : null),
    h('div', { class: 'p-front', title: `In front of ${p.name}` }, p.tableau.map(tabledCard)));
  const n = s.players.length;
  const rightCount = Math.ceil(n / 2);
  $('#side-right').replaceChildren(...s.players.slice(0, rightCount).map(seatEl));
  $('#side-left').replaceChildren(...s.players.slice(rightCount).reverse().map(seatEl));
  $('#table-dir').replaceChildren(...(s.round ? [
    h('div', { class: 'dir-arrow' }, s.direction === 'cw' ? '↻' : '↺'),
    h('div', { class: 'dir-label' }, `Round ${s.round}/${s.settings.rounds}`),
  ] : []));

  // status line
  let status = '';
  if (s.phase === 'leaderSelect') status = `Dealing roles — who will be ${leaderT}?`;
  else if (s.phase === 'negotiation') status = 'Negotiation phase — talk, trade, then press Ready.';
  else if (s.phase === 'turns' && s.currentPlayerId) status = s.currentPlayerId === s.you ? 'Your turn!' : `${pname(s.currentPlayerId)}'s turn`;
  else if (s.phase === 'gameOver') status = 'Game over';
  if (s.resolving) status += ` — resolving ${s.resolving.cardName}`;
  if (s.reactionOpen) status += ' (reaction window open)';
  $('#status-line').textContent = status;
  $('#waiting').textContent = s.waitingOn.length ? `Waiting on: ${s.waitingOn.map((w) => `${w.name} (${w.title})`).join(', ')}` : '';

  // negotiation
  show($('#negotiation'), s.phase === 'negotiation');
  if (s.phase === 'negotiation') {
    const sel = $('#gift-to');
    const keep = sel.value;
    const others = s.players.filter((p) => p.id !== s.you);
    const sig = others.map((p) => p.id + p.name).join();
    if (sel.dataset.sig !== sig) {
      sel.replaceChildren(...others.map((p) => h('option', { value: p.id }, p.name)));
      sel.dataset.sig = sig;
      if (keep) sel.value = keep;
    }
    const cap = s.settings.negotiationReceiveCap;
    const got = s.received[sel.value] || 0;
    $('#gift-cap').textContent = cap ? `${pname(sel.value)} can receive ${Math.max(0, cap - got)} more this phase` : '';
    const r = s.ready.includes(s.you);
    $('#btn-ready').textContent = r ? 'Not ready' : 'Ready';
    $('#ready-count').textContent = `${s.ready.length}/${s.players.filter((p) => p.connected).length} ready`;
    show($('#btn-skip'), !!s.skipNeeded);
    show($('#skip-count'), !!s.skipNeeded);
    if (s.skipNeeded) {
      $('#btn-skip').textContent = s.skipVotes.includes(s.you) ? 'Withdraw skip vote' : 'Vote to skip';
      $('#skip-count').textContent = `${s.skipVotes.length}/${s.skipNeeded} votes to skip`;
    }
  }

  // turn controls
  const myTurn = s.phase === 'turns' && s.currentPlayerId === s.you;
  show($('#turn-controls'), myTurn);
  $('#btn-end-turn').disabled = !s.canEndTurn;
  $('#plays-left').textContent = myTurn
    ? `${s.playsRemaining} play${s.playsRemaining === 1 ? '' : 's'} left${s.playsRemaining > 0 && !s.canEndTurn ? ' — you must use them' : ''}`
    : '';

  // effects
  $('#effects').replaceChildren(...(s.effects.length ? [h('h4', null, 'Ongoing effects'), h('ul', { class: 'plain' }, s.effects.map((e) => h('li', null, e.label)))] : []));

  // game over
  show($('#gameover'), s.phase === 'gameOver');
  if (s.phase === 'gameOver' && s.ranking) {
    $('#gameover').replaceChildren(
      h('h2', null, `👑 ${s.ranking.find((r) => r.winner)?.name ?? '?'} ends the game as ${leaderT} and wins!`),
      h('ol', { class: 'ranking' }, s.ranking.map((r) => h('li', { class: r.winner ? 'winner' : '' },
        h('span', null, `${r.rank}. ${r.name}`), h('span', null, `${r.gold} ${cur()}`), r.winner ? h('span', { class: 'tag leader' }, leaderT) : null))),
      isHost() ? h('button', { class: 'primary', onclick: () => action('backToLobby') }, 'Back to lobby') : h('p', { class: 'muted' }, 'Waiting for the host…'),
    );
  }

  renderHand();
}

function cardEl(c, opts = {}) {
  return h('div', {
    class: ['card', `deck-${c.deck || 'noble'}`, opts.selected && 'selected', c.playable && 'playable', `timing-${c.timing}`].filter(Boolean).join(' '),
    onclick: opts.onclick,
  },
  c.art ? h('img', { class: 'card-art', src: c.art, alt: '' }) : h('div', { class: 'card-art placeholder' }, figure(c.knight ? 'noble' : c.deck, c.knight ? 'helm' : '')),
  h('div', { class: 'card-name' }, c.name),
  h('div', { class: 'card-text' }, c.text),
  c.knight ? h('div', { class: 'card-timing' }, 'knight') : c.timing !== 'turn' ? h('div', { class: 'card-timing' }, c.timing) : null,
  c.deck === 'king' ? h('div', { class: 'card-deck' }, theme.leaderTitle || 'King') : null);
}

// A card on the table in front of a player.
function tabledCard(t) {
  if (t.faceDown && !t.name) return h('div', { class: 'tabled' }, cardBack(t.deck, 'table-back'));
  if (t.faceDown) {
    // you placed it, so you know what it is; everyone else sees only the back
    return h('div', { class: 'tabled', title: `${t.name} (face down): ${t.text}` },
      cardBack(t.deck, 'table-back'),
      h('div', { class: 'tabled-note' }, t.knight ? 'Knight' : `bluff: ${t.name}`));
  }
  return h('div', { class: 'tabled', title: t.text },
    h('div', { class: `table-front deck-${t.deck || 'noble'}` },
      h('div', { class: 'tf-art' }, figure(t.deck)),
      h('div', { class: 'tf-name' }, t.name)),
    t.note ? h('div', { class: 'tabled-note' }, t.note) : null);
}

function renderHand() {
  const hand = state.hand;
  if (selectedUid && !hand.some((c) => c.uid === selectedUid)) selectedUid = null;
  $('#hand').replaceChildren(...(hand.length ? hand.map((c) => cardEl(c, {
    selected: c.uid === selectedUid,
    onclick: () => { selectedUid = selectedUid === c.uid ? null : c.uid; renderHand(); },
  })) : [h('p', { class: 'muted' }, 'No cards in hand.')]));
  const sel = hand.find((c) => c.uid === selectedUid);
  const s = state;
  const myTurn = s.phase === 'turns' && s.currentPlayerId === s.you;
  const amKing = s.leaderId === s.you;
  $('#btn-play').disabled = !sel || !sel.playable;

  // Face-down placement (real Knight or bluff) — my turn only; the King may place it in front of anyone.
  show($('#facedown-group'), myTurn);
  if (myTurn) {
    fillPlayerSelect($('#facedown-target'), s.players.filter((p) => (amKing ? p.id !== s.you : p.id === s.you)), (p) => (p.id === s.you ? 'in front of me' : `in front of ${p.name}`));
    show($('#facedown-target'), amKing);
    $('#btn-facedown').disabled = !sel || s.playsRemaining <= 0 || !!s.resolving;
  }

  // Negotiation: one-for-one exchanges with players of the same role, and deal discards.
  const negotiating = s.phase === 'negotiation';
  show($('#trade-group'), negotiating);
  if (negotiating) {
    const myRole = me()?.role;
    fillPlayerSelect($('#trade-to'), s.players.filter((p) => p.id !== s.you && p.role === myRole), (p) => `with ${p.name}`);
    $('#btn-trade').disabled = !sel || !$('#trade-to').value;
    const canTrade = !!$('#trade-to').options.length;
    show($('#trade-to'), canTrade);
    show($('#btn-trade'), canTrade);
    // Deal discards: name the other side of the deal; they must agree. Limited per phase.
    fillPlayerSelect($('#discard-with'), s.players.filter((p) => p.id !== s.you), (p) => `deal with ${p.name}`);
    const left = s.dealDiscardsLeft ?? 0;
    $('#btn-deal-discard').textContent = `Discard (deal) · ${left} left`;
    $('#btn-deal-discard').disabled = !sel || !left || !$('#discard-with').value;
    show($('#discard-with'), left > 0);
  }

  let reason = '';
  if (sel && !sel.playable) {
    if (sel.knight) reason = 'Knights are placed face down.';
    else if (sel.timing === 'reaction') reason = 'Reaction cards are offered automatically when they can be used.';
    else if (!myTurn && !negotiating) reason = 'Wait for your turn.';
    else if (myTurn) reason = 'Cannot play this right now.';
  }
  $('#card-reason').textContent = reason;
}

function fillPlayerSelect(sel, players, label) {
  const keep = sel.value;
  const sig = players.map((p) => p.id + label(p)).join('|');
  if (sel.dataset.sig !== sig) {
    sel.replaceChildren(...players.map((p) => h('option', { value: p.id }, label(p))));
    sel.dataset.sig = sig;
    if (players.some((p) => p.id === keep)) sel.value = keep;
  }
}

function renderPrompt() {
  const pr = state.prompts[0];
  const key = pr ? `${pr.id}` : '';
  if (key === renderedPromptKey) return;
  renderedPromptKey = key;
  const box = $('#modal-box');
  if (!pr) { show($('#modal'), false); box.replaceChildren(); return; }

  const respond = (value) => action('respond', { promptId: pr.id, value });
  const kids = [h('h3', null, pr.title)];
  if (pr.message) kids.push(h('p', null, pr.message));
  if (pr.cards) kids.push(h('div', { class: 'modal-cards' }, pr.cards.map((c) => cardEl(c))));

  if (pr.type === 'number') {
    const input = h('input', { type: 'number', min: pr.min, max: pr.max, step: pr.step, value: pr.min });
    kids.push(h('div', { class: 'row' }, input, h('button', { class: 'primary', onclick: () => respond(input.value) }, 'Confirm')));
  } else if (pr.type === 'text') {
    // A spoken card part: type the line; the server checks it.
    const input = h('input', { type: 'text', maxlength: 200, placeholder: pr.placeholder || 'Type it here…', class: 'speak-input', autocomplete: 'off' });
    const send = () => { if (input.value.trim()) respond(input.value); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    kids.push(h('div', { class: 'speak-row' }, input, h('button', { class: 'primary', onclick: send }, 'Say it')));
    const extra = [];
    if (pr.suggestion) extra.push(h('button', { class: 'ghost', onclick: () => { input.value = pr.suggestion; input.focus(); } }, 'Use suggested line'));
    if (pr.refuseLabel) extra.push(h('button', { class: 'ghost', onclick: () => respond(null) }, pr.refuseLabel));
    if (extra.length) kids.push(h('div', { class: 'row speak-extra' }, ...extra));
    setTimeout(() => input.focus(), 0);
  } else if (pr.type === 'roll') {
    kids.push(h('button', { class: 'primary big', onclick: () => respond(0) }, '🎲 Roll!'));
  } else {
    const withCards = pr.options.some((o) => o.card || o.back);
    kids.push(h('div', { class: withCards ? 'modal-cards' : 'options' }, pr.options.map((o, i) => (o.card
      ? h('div', { class: 'pick' }, cardEl(o.card, { onclick: () => respond(i) }), h('button', { onclick: () => respond(i) }, o.label))
      : o.back
      ? h('div', { class: 'pick' }, h('div', { class: 'pick-back', onclick: () => respond(i) }, cardBack(o.back, 'big-back')), h('button', { onclick: () => respond(i) }, o.label))
      : h('button', { class: pr.type === 'info' ? 'primary' : '', onclick: () => respond(i) }, o.label)))));
  }
  kids.push(h('div', { class: 'prompt-timer' }, h('div', { class: 'fill', 'data-ends': pr.endsAt, 'data-start': Date.now() })));
  box.replaceChildren(...kids);
  show($('#modal'), true);
}

function renderDice() {
  const r = state.lastRoll;
  if (!r || r.id === lastRollId) return;
  lastRollId = r.id;
  const d = $('#dice');
  $('#die-face').textContent = r.value;
  $('#dice-caption').textContent = `${r.name} rolled ${r.value}${r.label ? ` — ${r.label}` : ''}`;
  d.classList.remove('faded');
  d.classList.remove('roll'); void d.offsetWidth; d.classList.add('roll');
  clearTimeout(renderDice.t);
  renderDice.t = setTimeout(() => d.classList.add('faded'), 6000);
}

function renderFeeds() {
  const log = $('#log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.replaceChildren(...state.log.map((l) => h('div', { class: `entry k-${l.kind}` }, l.text)));
  if (atBottom) log.scrollTop = log.scrollHeight;

  const chat = $('#chat');
  chat.replaceChildren(...state.chat.map((c) => h('div', { class: `entry${c.style ? ` said ${c.style}` : ''}` },
    h('strong', null, c.name + (c.style ? ' says: ' : ': ')), c.style ? `“${c.text}”` : c.text)));
  chat.scrollTop = chat.scrollHeight;
  if (state.chat.length > lastChatCount && activeTab !== 'chat') $('#chat-badge').textContent = '●';
  lastChatCount = state.chat.length;
}

// timers: animate bars without re-rendering everything
setInterval(() => {
  if (!state) return;
  const t = state.timer;
  const fill = $('#timer-fill'), text = $('#timer-text');
  if (!t) { fill.style.width = '0'; text.textContent = ''; }
  else {
    const left = t.paused ? t.remaining : Math.max(0, t.endsAt - Date.now());
    fill.style.width = `${Math.min(100, (left / t.total) * 100)}%`;
    fill.classList.toggle('low', left < 10000);
    text.textContent = `${t.label} · ${Math.ceil(left / 1000)}s${t.paused ? ' (paused)' : ''}`;
  }
  const pf = document.querySelector('.prompt-timer .fill');
  if (pf) {
    const ends = Number(pf.dataset.ends), start = Number(pf.dataset.start);
    pf.style.width = `${Math.max(0, ((ends - Date.now()) / Math.max(1, ends - start)) * 100)}%`;
  }
}, 200);

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$('#btn-create').onclick = () => enter('createRoom');
$('#btn-join').onclick = () => enter('joinRoom');
$('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter('joinRoom'); });
// ---- rules summary (uses this room's settings where they're known)
function openRules() {
  const st = (state && state.settings) || {};
  const v = (k, d) => (st[k] ?? d);
  const K = theme.leaderTitle || 'King', N = theme.playerTitle || 'Noble', G = cur();
  const sec = (title, ...items) => h('section', null, h('h4', null, title), h('ul', null, items.map((t) => h('li', null, t))));
  $('#rules-box').replaceChildren(
    h('div', { class: 'rules-head' }, h('h3', null, 'How to play'), h('button', { class: 'ghost', onclick: closeRules }, 'Close')),
    h('p', { class: 'rules-goal' }, `Be the ${K} when the last card of round ${v('rounds', 4)} is played.`),
    sec('Setup',
      `One player is dealt the ${K}; everyone else is a ${N}.`,
      `The ${K} starts with ${v('kingStartingGold', 1000)} ${G}, each ${N} with ${v('nobleStartingGold', 600)}. ${G[0].toUpperCase() + G.slice(1)} stays between 0 and ${v('maxGold', 2000)}: you can't go past either limit, and at 0 you keep playing.`,
      `Everyone is dealt ${v('handSize', 8)} cards. The ${K} draws from the ${K} deck, ${N}s from the ${N} deck.`),
    sec('Each round: 1. Playing phase',
      `The ${K} always goes first and plays ${v('kingPlays', 3)} cards (${v('kingPlaysFewNobles', 2)} with 3 or fewer ${N}s).`,
      `Then each ${N} plays ${v('noblePlays', 2)}, going round the table. Direction alternates each round (see the arrow).`,
      'Use all your plays if you have a playable card.',
      `At the end of your turn, draw as many cards as you played. You can hold more than ${v('handSize', 8)} cards but never fewer: if you lose a card, draw a replacement straight away.`,
      'Cards with a dotted line: pick ONE of the two effects.'),
    sec('Each round: 2. Negotiation (none after the final round)',
      (() => {
        const t = v('negotiationTime', 120);
        if (!t) return 'Negotiation is turned off in this room.';
        const len = t < 60 ? `${t} seconds` : `${Math.round((t / 60) * 10) / 10} minute${t === 60 ? '' : 's'}`;
        return `Up to ${len} to make deals. Nothing is binding.`;
      })(),
      `Trade ${G}: a player can receive at most ${v('negotiationReceiveCap', 400)} per phase.`,
      `Swap cards one-for-one with a player of the same role (${N} with ${N}).`,
      `Discard a card only as part of a deal: name the other player, who must agree. You get ${v('negotiationDiscards', 1)} per negotiation, and you draw a replacement.`,
      'Ends when everyone is Ready, the timer runs out, or enough players vote to skip.'),
    sec(`Becoming the ${K}`,
      `The moment a ${N} has more ${G} than the ${K}, they take the crown: they swap seats and hands with the old ${K}, who becomes a ${N}.`,
      'Face-down cards stay in front of the seat, so whoever moves into it inherits them without seeing them.',
      `If it happens during a turn, play passes to the next player. If two ${N}s qualify at once, they roll; the lower roll loses 100.`),
    sec('Knights and bluffs',
      `Place any card face down and claim it is a Knight. It counts as a play. ${N}s place them in front of themselves.`,
      'A real Knight blocks one Betrayal and is then discarded. A bluff is revealed and gives no protection.',
      `The ${K} can't use a Knight on themselves: the ${K}'s Knight goes face down in front of a ${N}, who can't look at it.`,
      `Nothing protects the ${K} from "Betray the ${K}".`),
    v('spokenParts', 'typed') === 'honour'
      ? sec('Spoken card parts (honour system)',
        'Cards that make someone speak (Loyal Dog, Bend the Knee, Royal Parrot, Loyalty, Council Meeting, Actors) just announce what must be said. Keep each other honest.')
      : sec('Spoken card parts (typed and checked)',
        'When a card makes you speak, type the line. The game checks it and posts it in chat as your speech.',
        "Fixed lines must match (capitals and punctuation don't matter). Thanks and praise must name the King; a laugh must be a laugh.",
        'Not saying it in time counts as refusing: Loyal Dog gives no gold, Council Meeting draws nothing, Bend the Knee and Royal Parrot cost 300. For Actors and Loyalty, refusals are named publicly.'),
    sec('Card rulings (official FAQ)',
      'Betrayal: someone must speak up in support after it is played, or it has no effect.',
      "Isolation (gold): other players' cards can't take or cost you gold until it ends, except Royal Bomb and Betrayal. Your own cards still cost you.",
      'Helping Hand: draw 2 and play one extra card; Helping Hand itself does not use up a play.',
      `Bad Blood: stops the moment its owner becomes the ${K}.`,
      "Sub Rosa: if you looked at a face-down Knight and roll 4+, you take a random card from that player's hand without seeing it.",
      `Anchor: the ${K} picks two players; the first chooses to lose 200, or for the second to lose 100 to the ${K}.`,
      `Debt Collector: the chosen player must pick another ${N}, never the ${K}.`,
      `People's Champion: you may nominate yourself. If the challenger wins, they swap ${G} with the ${K}.`),
    sec('Good to know',
      `"The bank" has unlimited ${G}; it never runs out.`,
      `${N}s can't hold ${K} cards and vice versa.`));
  show($('#rules'), true);
}
function closeRules() { show($('#rules'), false); }
$('#btn-rules').onclick = openRules;
$('#btn-rules-lobby').onclick = openRules;
$('#rules').addEventListener('click', (e) => { if (e.target.id === 'rules') closeRules(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRules(); });

$('#btn-leave').onclick = async () => {
  const res = await action('leave');
  if (!res || !res.ok) return;
  session.clear();
  state = null;
  settingsBuilt = false;
  history.replaceState(null, '', '/');
  $('#join-code').value = '';
  showScreen('home');
};
$('#btn-copy').onclick = async () => {
  const url = `${location.origin}/?room=${state.code}`;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); } catch { toast(url); }
};
$('#btn-start').onclick = () => action('start');
$('#btn-end-game').onclick = () => { if (confirmInline('#btn-end-game')) action('endGame'); };
$('#btn-end-turn').onclick = () => action('endTurn');
$('#btn-ready').onclick = () => action('ready');
$('#btn-skip').onclick = () => action('voteSkip');
$('#btn-gift').onclick = () => action('giveGold', { to: $('#gift-to').value, amount: Number($('#gift-amount').value) });
$('#btn-play').onclick = () => { if (selectedUid) { const uid = selectedUid; selectedUid = null; action('playCard', { uid }); } };
const withSelected = (fn) => () => { if (!selectedUid) return; const uid = selectedUid; selectedUid = null; fn(uid); renderHand(); };
$('#btn-facedown').onclick = withSelected((uid) => action('placeFaceDown', { uid, target: $('#facedown-target').value || undefined }));
$('#btn-trade').onclick = withSelected((uid) => { action('proposeTrade', { uid, to: $('#trade-to').value }); toast('Exchange offered — waiting for an answer'); });
$('#btn-deal-discard').onclick = withSelected((uid) => { action('discardForDeal', { uid, with: $('#discard-with').value }); toast('Waiting for them to agree to the deal'); });
$('#gift-to').onchange = () => render();
$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chat-input').value.trim();
  if (text) action('chat', { text });
  $('#chat-input').value = '';
};
for (const b of document.querySelectorAll('.tabs button')) {
  b.onclick = () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    show($('#log'), activeTab === 'log');
    show($('#chat'), activeTab === 'chat');
    show($('#chat-form'), activeTab === 'chat');
    if (activeTab === 'chat') { $('#chat-badge').textContent = ''; $('#chat').scrollTop = $('#chat').scrollHeight; }
  };
}

// two-click confirm (avoids browser confirm() dialogs)
function confirmInline(sel) {
  const b = $(sel);
  if (b.dataset.armed) { delete b.dataset.armed; b.textContent = b.dataset.label; return true; }
  b.dataset.label = b.textContent;
  b.dataset.armed = '1';
  b.textContent = 'Click again to confirm';
  setTimeout(() => { if (b.dataset.armed) { delete b.dataset.armed; b.textContent = b.dataset.label; } }, 3000);
  return false;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('#join-code').value = params.get('room').toUpperCase();
  $('#name').value = localStorage.getItem('name') || '';
  [theme, schema] = await Promise.all([fetch('/theme.json').then((r) => r.json()), fetch('/api/schema').then((r) => r.json())]);
  document.title = theme.gameTitle || document.title;
  for (const el of document.querySelectorAll('[data-theme]')) el.textContent = theme[el.dataset.theme] || '';
  if (!session.get()) showScreen('home');
  if (state) render();
})();
