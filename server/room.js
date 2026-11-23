'use strict';

const crypto = require('crypto');
const { defaults, sanitizeSettings } = require('./config');
const CARD_DEFS = require('./cards');
const { scoreGame } = require('./rules');

class Abort extends Error {}
class GameError extends Error {}

const DECKS = ['king', 'noble'];
const randInt = (min, max) => crypto.randomInt(min, max + 1);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20);

// ---- validate card definitions once at startup ----
const DEF_BY_ID = new Map();
for (const d of CARD_DEFS) {
  if (!d.id || DEF_BY_ID.has(d.id)) throw new Error(`Card id missing or duplicated: ${d.id}`);
  d.timing = d.timing || 'turn';
  d.deck = d.deck || 'noble';
  if (!DECKS.includes(d.deck)) throw new Error(`Card ${d.id}: deck must be 'king' or 'noble'`);
  if (d.choices) {
    if (!Array.isArray(d.choices) || d.choices.length < 2 || d.choices.some((c) => typeof c.play !== 'function')) {
      throw new Error(`Card ${d.id}: choices must be an array of { label, text, play }`);
    }
    if (!d.text) d.text = d.choices.map((c) => c.text || c.label).join('\n— or —\n');
  } else if (d.timing === 'reaction') {
    if (typeof d.react !== 'function') throw new Error(`Reaction card ${d.id} needs react()`);
  } else if (typeof d.play !== 'function' && !d.knight) {
    throw new Error(`Card ${d.id} needs play() (or knight: true)`);
  }
  DEF_BY_ID.set(d.id, d);
}

/* A pausable countdown that drives each phase. start() resolves on timeout or finish(). */
class PhaseTimer {
  constructor(room) { this.room = room; this.resolve = null; }
  start(seconds, label) {
    this.finish('replaced');
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.label = label;
      this.total = seconds * 1000;
      this.remaining = seconds * 1000;
      this.arm();
    });
  }
  arm() {
    clearTimeout(this.handle);
    this.paused = false;
    this.endsAt = Date.now() + this.remaining;
    this.handle = setTimeout(() => this.finish('timeout'), this.remaining);
    this.room.sync();
  }
  pause() {
    if (!this.resolve || this.paused) return;
    clearTimeout(this.handle);
    this.remaining = Math.max(0, this.endsAt - Date.now());
    this.paused = true;
  }
  resume() { if (this.resolve && this.paused) this.arm(); }
  finish(reason) {
    clearTimeout(this.handle);
    const r = this.resolve;
    this.resolve = null;
    if (r) r(reason);
  }
  get active() { return !!this.resolve; }
  view() {
    if (!this.resolve) return null;
    return { label: this.label, endsAt: this.endsAt, total: this.total, paused: this.paused, remaining: this.paused ? this.remaining : null };
  }
}

class Room {
  constructor(code, io, onEmpty) {
    this.code = code;
    this.io = io;
    this.onEmpty = onEmpty;
    this.settings = { ...defaults };
    this.players = [];          // array order == seating order around the table
    this.hostId = null;
    this.seq = 0;
    this.timer = new PhaseTimer(this);
    this.chat = [];
    this.resetGameState();
  }

  resetGameState() {
    this.phase = 'lobby';
    this.round = 0;
    this.direction = 'cw';
    this.leaderId = null;       // the King
    this.currentPlayerId = null;
    this.turnOpen = false;
    this.interruptTurn = false;
    this.playsRemaining = 0;
    this.decks = { king: [], noble: [] };
    this.discards = { king: [], noble: [] };
    this.log = [];
    this.effects = [];
    this.prompts = new Map();
    this.promptSeq = 0;
    this.resolving = null;
    this.reactionOpen = false;
    this.ready = new Set();
    this.skipVotes = new Set(); // players voting to skip the rest of this negotiation phase
    this.received = new Map();  // gold received this negotiation phase
    this.dealDiscards = new Map(); // deal-discards made this negotiation phase
    this.pendingTrades = new Set();
    this.lastRoll = null;
    this.ranking = null;
    this.crownDirty = false;
    this.crownBusy = false;
    this.turnSerial = 0;        // increases every turn; used by 'ownerNextTurnEnd' expiries
    this.game = null;
    for (const p of this.players) Object.assign(p, { gold: 0, hand: [], tableau: [], statuses: [] });
  }

  // =====================================================================
  // Players & sockets
  // =====================================================================
  player(id) { return this.players.find((p) => p.id === id); }
  emitTo(p, ev, data) { if (p.socketId) this.io.to(p.socketId).emit(ev, data); }
  toastAll(text) { for (const p of this.players) this.emitTo(p, 'toast', text); }
  roleOf(id) { return id === this.leaderId ? 'king' : 'noble'; }
  nobleIds() { return this.players.filter((p) => p.id !== this.leaderId).map((p) => p.id); }

  addPlayer(rawName, socket) {
    if (this.phase !== 'lobby') throw new GameError('That game has already started');
    if (this.players.length >= this.settings.maxPlayers) throw new GameError('Room is full');
    const name = cleanName(rawName);
    if (!name) throw new GameError('Enter a name');
    if (this.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new GameError('That name is taken in this room');
    const p = {
      id: 'p' + (++this.seq), token: crypto.randomBytes(16).toString('hex'), name,
      gold: 0, hand: [], tableau: [], statuses: [], socketId: null, connected: false,
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.bindSocket(p, socket);
    this.addLog(`${name} joined.`);
    this.sync();
    return p;
  }

  bindSocket(p, socket) {
    if (p.socketId && p.socketId !== socket.id) {
      const old = this.io.sockets.sockets.get(p.socketId);
      if (old) { old.emit('kicked', 'You opened this game in another tab.'); old.disconnect(true); }
    }
    clearTimeout(p.removeHandle);
    clearTimeout(this.disposeHandle);
    p.socketId = socket.id;
    p.connected = true;
    socket.data.roomCode = this.code;
    socket.data.playerId = p.id;
  }

  rejoin(token, socket) {
    const p = this.players.find((x) => x.token === token);
    if (!p) throw new GameError('Session expired');
    const was = p.connected;
    this.bindSocket(p, socket);
    if (!was && this.phase !== 'lobby') this.addLog(`${p.name} reconnected.`);
    this.sync();
    return p;
  }

  handleDisconnect(socket) {
    const p = this.player(socket.data.playerId);
    if (!p || p.socketId !== socket.id) return;
    p.connected = false;
    p.socketId = null;
    if (this.phase === 'lobby') {
      p.removeHandle = setTimeout(() => this.removePlayer(p.id), 20000);
    } else {
      this.addLog(`${p.name} disconnected.`);
      if (this.settings.skipDisconnected) {
        if (this.currentPlayerId === p.id && !this.resolving && this.timer.active) this.timer.finish('disconnected');
        for (const pr of this.prompts.values()) if (pr.playerId === p.id) pr.shorten(1500);
      }
      this.maybeEndNegotiation(); // fewer connected players can tip a skip vote or all-ready
    }
    if (this.players.every((x) => !x.connected)) {
      this.disposeHandle = setTimeout(() => this.dispose(), 30 * 60 * 1000);
    }
    this.sync();
  }

  // Players who dropped during a game get the lobby's usual grace period once the room is back in the lobby.
  scheduleGhostRemoval() {
    for (const p of this.players) {
      if (p.connected) continue;
      clearTimeout(p.removeHandle);
      p.removeHandle = setTimeout(() => this.removePlayer(p.id), 20000);
    }
  }

  // Drop anyone still offline right away (used when a game starts, so nobody absent is dealt in).
  removeOfflinePlayers() {
    for (const p of this.players.filter((x) => !x.connected)) {
      clearTimeout(p.removeHandle);
      this.removePlayer(p.id);
    }
  }

  removePlayer(id) {
    const p = this.player(id);
    if (!p || p.connected || this.phase !== 'lobby') return;
    this.players = this.players.filter((x) => x.id !== id);
    this.addLog(`${p.name} left.`);
    if (this.hostId === id) this.hostId = this.players[0]?.id || null;
    if (!this.players.length) return this.dispose();
    this.sync();
  }

  dispose() {
    if (this.game) this.abortGame();
    this.timer.finish('dispose');
    this.onEmpty(this.code);
  }

  // =====================================================================
  // Logging / sync
  // =====================================================================
  addLog(text, kind = 'info') {
    this.log.push({ t: Date.now(), text, kind });
    if (this.log.length > 300) this.log.shift();
  }

  sync() {
    if (this.syncQueued) return;
    this.syncQueued = true;
    setImmediate(() => {
      this.syncQueued = false;
      for (const p of this.players) if (p.socketId) this.emitTo(p, 'state', this.viewFor(p.id));
    });
  }

  cardView(card, viewerId) {
    const d = DEF_BY_ID.get(card.defId);
    const v = { uid: card.uid, id: d.id, name: d.name, text: d.text, art: d.art || null, timing: d.timing, deck: d.deck, knight: !!d.knight };
    if (viewerId) v.playable = this.playableReason(viewerId, card) === true;
    return v;
  }

  viewFor(pid) {
    const me = this.player(pid);
    const prompts = [...this.prompts.values()];
    const myTurn = this.phase === 'turns' && this.currentPlayerId === pid && this.turnOpen;
    return {
      code: this.code,
      you: pid,
      hostId: this.hostId,
      phase: this.phase,
      settings: this.settings,
      round: this.round,
      direction: this.direction,
      leaderId: this.leaderId,
      currentPlayerId: this.currentPlayerId,
      playsRemaining: myTurn ? this.playsRemaining : 0,
      canEndTurn: myTurn && !this.resolving && this.canEndTurn(pid),
      resolving: this.resolving && { player: this.resolving.player, cardName: this.resolving.cardName },
      reactionOpen: this.reactionOpen,
      timer: this.timer.view(),
      deckCounts: { king: this.decks.king.length, noble: this.decks.noble.length },
      ready: [...this.ready],
      skipVotes: [...this.skipVotes],
      dealDiscardsLeft: Math.max(0, this.settings.negotiationDiscards - (this.dealDiscards.get(pid) || 0)),
      skipNeeded: this.skipVotesNeeded(),
      received: Object.fromEntries(this.received),
      lastRoll: this.lastRoll,
      ranking: this.ranking,
      effects: this.effects.filter((e) => e.label).map((e) => ({ key: e.key, label: e.label })),
      players: this.players.map((p) => ({
        id: p.id, name: p.name, gold: p.gold, handCount: p.hand.length, connected: p.connected,
        role: this.leaderId ? this.roleOf(p.id) : null,
        statuses: p.statuses.map((s) => ({ key: s.key, label: s.label, description: s.description || '' })),
        tableau: p.tableau.map((t) => (t.faceDown && t.placedBy !== pid
          ? { uid: t.uid, faceDown: true, deck: DEF_BY_ID.get(t.defId).deck } // the back shows which deck, as on a real table
          : { ...this.cardView(t), faceDown: !!t.faceDown, note: t.data && t.data.backed ? `backing ${this.player(t.data.backed)?.name ?? '?'}` : null })),
      })),
      hand: me ? me.hand.map((c) => this.cardView(c, pid)) : [],
      prompts: prompts.filter((p) => p.playerId === pid).map((p) => p.view()),
      waitingOn: prompts.filter((p) => p.playerId !== pid && !p.spec.secret).map((p) => ({ name: this.player(p.playerId)?.name, title: p.spec.publicTitle || p.spec.title })),
      log: this.log.slice(-150),
      chat: this.chat.slice(-80),
    };
  }

  // =====================================================================
  // Actions from clients
  // =====================================================================
  async handleAction(pid, type, payload = {}) {
    const p = this.player(pid);
    if (!p) throw new GameError('Not in this room');
    const isHost = pid === this.hostId;
    const myTurnCheck = () => {
      if (this.phase !== 'turns' || this.currentPlayerId !== pid || !this.turnOpen) throw new GameError('Not your turn');
      if (this.resolving) throw new GameError('Wait for the current card to resolve');
    };
    switch (type) {
      case 'chat': {
        const text = String(payload.text || '').trim().slice(0, 300);
        if (!text) return;
        this.chat.push({ t: Date.now(), name: p.name, text });
        if (this.chat.length > 200) this.chat.shift();
        return this.sync();
      }
      case 'leave': {
        // Leaving on purpose from the lobby: removed at once, no grace period.
        if (this.phase !== 'lobby') throw new GameError('You can only leave from the lobby');
        clearTimeout(p.removeHandle);
        const sock = p.socketId && this.io.sockets.sockets.get(p.socketId);
        if (sock) { sock.data.roomCode = null; sock.data.playerId = null; }
        this.players = this.players.filter((x) => x.id !== pid);
        this.addLog(`${p.name} left.`);
        if (this.hostId === pid) {
          this.hostId = (this.players.find((x) => x.connected) || this.players[0])?.id || null;
          if (this.hostId) this.addLog(`${this.player(this.hostId).name} is now the host.`);
        }
        if (!this.players.length) { this.dispose(); return; }
        return this.sync();
      }
      case 'updateSettings':
        if (!isHost || this.phase !== 'lobby') throw new GameError('Only the host can change settings in the lobby');
        this.settings = sanitizeSettings(this.settings, payload);
        return this.sync();
      case 'start':
        if (!isHost) throw new GameError('Only the host can start');
        if (this.phase !== 'lobby') throw new GameError('Already started');
        this.removeOfflinePlayers();
        if (this.players.length < this.settings.minPlayers) throw new GameError(`Need at least ${this.settings.minPlayers} players`);
        this.runGame();
        return;
      case 'endGame':
        if (!isHost) throw new GameError('Only the host can end the game');
        this.abortGame();
        this.resetGameState();
        this.addLog('The host ended the game.');
        this.scheduleGhostRemoval();
        return this.sync();
      case 'backToLobby':
        if (!isHost || this.phase !== 'gameOver') throw new GameError('Not available');
        this.resetGameState();
        this.scheduleGhostRemoval();
        return this.sync();
      case 'respond': {
        const pr = this.prompts.get(Number(payload.promptId));
        if (!pr || pr.playerId !== pid) throw new GameError('That choice has expired');
        pr.answer(payload.value);
        return;
      }
      case 'playCard':
        return this.playCard(pid, String(payload.uid));
      case 'placeFaceDown': {
        // Any card may be placed face down as a (possibly bluffed) Knight. Counts as a play.
        myTurnCheck();
        if (this.playsRemaining <= 0) throw new GameError('No plays left this turn');
        const i = p.hand.findIndex((c) => c.uid === String(payload.uid));
        if (i < 0) throw new GameError('Card not in hand');
        // Nobles place in front of themselves. The King's Knight "is meant to be given to a noble"
        // (rules guide), so the King places in front of a Noble, never in front of themselves.
        let target = pid;
        if (this.roleOf(pid) === 'king') {
          target = String(payload.target || '');
          if (!this.player(target) || target === pid) throw new GameError('The King places face-down cards in front of a Noble');
        } else if (payload.target && payload.target !== pid) {
          throw new GameError('Only the King may place a card in front of another player');
        }
        const [c] = p.hand.splice(i, 1);
        this.player(target).tableau.push({ ...c, faceDown: true, placedBy: pid });
        this.playsRemaining--;
        this.playsUsed++;
        this.addLog(target === pid ? `${p.name} placed a card face down (a Knight?).` : `${p.name} placed a card face down in front of ${this.player(target).name}.`, 'play');
        return this.sync();
      }
      case 'endTurn':
        myTurnCheck();
        if (!this.canEndTurn(pid)) throw new GameError('You still have plays left and a card you can play');
        this.timer.finish('ended');
        return;
      case 'giveGold': {
        if (this.phase !== 'negotiation') throw new GameError('Gold can only be traded during negotiation');
        const to = this.player(String(payload.to));
        const amount = Math.floor(Number(payload.amount));
        if (!to || to.id === pid) throw new GameError('Pick another player');
        if (!(amount > 0)) throw new GameError('Enter an amount');
        if (amount > p.gold) throw new GameError("You don't have that much");
        const cap = this.settings.negotiationReceiveCap;
        const already = this.received.get(to.id) || 0;
        if (cap && already + amount > cap) throw new GameError(`${to.name} can only receive ${Math.max(0, cap - already)} more gold this phase`);
        const moved = this.moveGold(p, to, amount);
        this.received.set(to.id, already + moved);
        this.addLog(`${p.name} gave ${moved} gold to ${to.name}.`, 'gold');
        this.sync();
        if (moved && this.game) await this.runHooks('onGift', { from: pid, to: to.id, amount: moved });
        return this.resolveCrown();
      }
      case 'proposeTrade':
        return this.proposeTrade(pid, String(payload.to), String(payload.uid));
      case 'discardForDeal':
        return this.proposeDealDiscard(pid, String(payload.with || ''), String(payload.uid));
      case 'ready': {
        if (this.phase !== 'negotiation') return;
        if (this.ready.has(pid)) this.ready.delete(pid); else this.ready.add(pid);
        this.maybeEndNegotiation();
        return this.sync();
      }
      case 'voteSkip': {
        if (this.phase !== 'negotiation') throw new GameError('You can only vote to skip during negotiation');
        if (!this.skipVotesNeeded()) throw new GameError('Skipping negotiation is turned off');
        if (this.skipVotes.has(pid)) {
          this.skipVotes.delete(pid);
          this.addLog(`${p.name} withdrew their vote to skip negotiation.`);
        } else {
          this.skipVotes.add(pid);
          this.addLog(`${p.name} voted to skip negotiation (${this.skipVotes.size}/${this.skipVotesNeeded()}).`);
        }
        this.maybeEndNegotiation();
        return this.sync();
      }
      default:
        throw new GameError('Unknown action');
    }
  }

  // Negotiation ends early once every connected player is Ready and no exchange offer is still open.
  maybeEndNegotiation() {
    if (this.phase !== 'negotiation') return;
    // A successful skip vote ends the phase at once, even with exchange offers still open.
    const needed = this.skipVotesNeeded();
    const votes = this.players.filter((x) => x.connected && this.skipVotes.has(x.id)).length;
    if (needed && votes >= needed) {
      this.addLog('The players voted to skip the rest of negotiation.', 'phase');
      this.timer.finish('skipped');
      return;
    }
    if (this.pendingTrades.size) return;
    const active = this.players.filter((x) => x.connected);
    if (active.length && active.every((x) => this.ready.has(x.id))) this.timer.finish('ready');
  }

  // Votes needed to skip negotiation (0 = skipping is off). Counts connected players only.
  skipVotesNeeded() {
    const active = this.players.filter((x) => x.connected).length;
    if (!active) return 0;
    if (this.settings.negotiationSkipVote === 'all') return active;
    if (this.settings.negotiationSkipVote === 'majority') return Math.floor(active / 2) + 1;
    return 0;
  }

  canEndTurn(pid) {
    if (!this.settings.mustPlayAll || this.playsRemaining <= 0) return true;
    const p = this.player(pid);
    return !p.hand.some((c) => DEF_BY_ID.get(c.defId).timing === 'turn' && this.playableReason(pid, c) === true);
  }

  // Rules guide: "You can discard cards but only as a deal with someone else. Never discard
  // just to get a replacement card." So the other side of the deal has to agree, and each
  // player gets a limited number of deal-discards per negotiation phase.
  async proposeDealDiscard(pid, withId, uid) {
    if (this.phase !== 'negotiation') throw new GameError('Only during negotiation');
    const a = this.player(pid), b = this.player(withId);
    if (!b || b.id === pid) throw new GameError('Pick the player you made the deal with');
    const used = this.dealDiscards.get(pid) || 0;
    if (used >= this.settings.negotiationDiscards) {
      throw new GameError(this.settings.negotiationDiscards ? 'No deal discards left this negotiation' : 'Deal discards are turned off');
    }
    if (this.pendingTrades.has(pid)) throw new GameError('You already have an offer waiting');
    if (!a.hand.some((c) => c.uid === uid)) throw new GameError('Card not in hand');
    this.pendingTrades.add(pid);
    this.addLog(`${a.name} asks ${b.name} to agree to a deal discard.`);
    try {
      const ok = await this.prompt(withId, {
        type: 'chooseOption', title: `${a.name} wants to discard a card as part of a deal with you. Do you agree?`,
        message: 'Only agree if you really made this deal. They draw a replacement card.',
        options: [{ value: true, label: 'Yes, we made a deal' }, { value: false, label: 'No' }],
        default: false, publicTitle: 'Considering a deal discard',
      });
      const i = a.hand.findIndex((c) => c.uid === uid);
      if (!ok) { this.addLog(`${b.name} did not agree, so no card was discarded.`); return this.sync(); }
      if (i < 0 || this.phase !== 'negotiation' || (this.dealDiscards.get(pid) || 0) >= this.settings.negotiationDiscards) {
        this.addLog('The deal discard fell through.'); return this.sync();
      }
      const [c] = a.hand.splice(i, 1);
      this.discardCard(c);
      this.drawCards(pid, 1);
      this.dealDiscards.set(pid, (this.dealDiscards.get(pid) || 0) + 1);
      this.addLog(`${a.name} discarded a card as part of a deal with ${b.name} and drew a replacement.`);
      this.sync();
    } finally {
      this.pendingTrades.delete(pid);
      this.maybeEndNegotiation();
    }
  }

  async proposeTrade(pid, toId, uid) {
    if (this.phase !== 'negotiation') throw new GameError('Cards can only be exchanged during negotiation');
    const a = this.player(pid), b = this.player(toId);
    if (!b || b.id === pid) throw new GameError('Pick another player');
    if (this.roleOf(pid) !== this.roleOf(toId)) throw new GameError("Nobles can't hold King cards and vice versa");
    if (this.pendingTrades.has(pid)) throw new GameError('You already have a trade offer waiting');
    const card = a.hand.find((c) => c.uid === uid);
    if (!card) throw new GameError('Card not in hand');
    if (!b.hand.length) throw new GameError(`${b.name} has no cards`);
    this.pendingTrades.add(pid);
    this.addLog(`${a.name} offers ${b.name} a card exchange.`);
    try {
      const options = b.hand.map((c) => ({ value: c.uid, label: `Give ${DEF_BY_ID.get(c.defId).name}`, card: this.cardView(c) }));
      options.push({ value: null, label: 'Decline' });
      const answer = await this.prompt(toId, {
        type: 'chooseOption', title: `${a.name} offers you this card in exchange for one of yours`,
        cards: [this.cardView(card)], options, default: null, publicTitle: 'Considering a card exchange',
      });
      if (!answer) { this.addLog(`${b.name} declined the exchange.`); return this.sync(); }
      const ia = a.hand.findIndex((c) => c.uid === uid), ib = b.hand.findIndex((c) => c.uid === answer);
      if (ia < 0 || ib < 0 || this.phase !== 'negotiation' || this.roleOf(pid) !== this.roleOf(toId)) { this.addLog('The exchange fell through.'); return this.sync(); }
      const [ca] = a.hand.splice(ia, 1);
      const [cb] = b.hand.splice(ib, 1);
      a.hand.push(cb);
      b.hand.push(ca);
      this.addLog(`${a.name} and ${b.name} exchanged cards.`);
      this.sync();
    } finally {
      this.pendingTrades.delete(pid);
      this.maybeEndNegotiation();
    }
  }

  // =====================================================================
  // Game loop
  // =====================================================================
  ensureActive(game = this.game) {
    if (!game || game.aborted) throw new Abort();
  }

  abortGame() {
    if (!this.game) return;
    this.game.aborted = true;
    for (const pr of [...this.prompts.values()]) pr.cancel();
    this.timer.finish('abort');
  }

  async runGame() {
    this.resetGameState();
    const game = { aborted: false };
    this.game = game;
    const step = async (promise) => { const r = await promise; this.ensureActive(game); return r; };
    try {
      this.setupDecks();
      this.addLog('The game begins!', 'round');
      this.phase = 'leaderSelect';
      this.sync();
      await step(this.selectLeader());

      for (const p of this.players) {
        p.gold = p.id === this.leaderId ? this.settings.kingStartingGold : this.settings.nobleStartingGold;
        this.drawCards(p.id, this.settings.handSize);
      }
      this.sync();

      for (let r = 1; r <= this.settings.rounds; r++) {
        this.round = r;
        this.direction = this.settings.alternateDirection && r % 2 === 0 ? 'ccw' : 'cw';
        this.phase = 'roundStart';
        this.addLog(`Round ${r} of ${this.settings.rounds} — turns go ${this.direction === 'cw' ? 'clockwise' : 'counter-clockwise'}, starting with the King.`, 'round');
        this.sync();
        await step(this.runHooks('onRoundStart', { round: r }));

        // ---- Playing phase: the King's seat first, then around the table ----
        this.phase = 'turns';
        const n = this.players.length;
        const kingSeat = Math.max(0, this.players.findIndex((p) => p.id === this.leaderId));
        const dir = this.direction === 'cw' ? 1 : -1;
        for (let i = 0; i < n; i++) {
          // Read the seat each time: if the crown changed hands, players swapped seats
          // and the turn continues with whoever now sits in the next seat.
          const seat = (((kingSeat + dir * i) % n) + n) % n;
          await step(this.takeTurn(this.players[seat].id, game));
        }
        this.currentPlayerId = null;
        while (this.resolving) await step(this.resolving.done);

        // ---- Negotiation phase ----
        // No negotiation after the final round: the game ends after its last card (Royal Advisor FAQ).
        if (this.settings.negotiationTime > 0 && r < this.settings.rounds) {
          this.phase = 'negotiation';
          this.ready.clear();
          this.skipVotes.clear();
          this.received.clear();
          this.dealDiscards.clear();
          this.addLog('Negotiation phase — trade gold, exchange cards, make deals. Nothing is binding.', 'phase');
          await step(this.timer.start(this.settings.negotiationTime, 'Negotiation'));
          while (this.resolving) await step(this.resolving.done);
          for (const pr of [...this.prompts.values()]) if (pr.spec.negotiation !== false) pr.cancel();
          this.ready.clear();
          this.skipVotes.clear();
          this.received.clear();
          this.dealDiscards.clear();
        }

        this.phase = 'roundEnd';
        await step(this.runHooks('onRoundEnd', { round: r }));
        this.expire('roundEnd');
        this.sync();
      }

      this.phase = 'gameOver';
      this.timer.finish('over');
      this.ranking = scoreGame(this.players.map((p) => ({ id: p.id, name: p.name, gold: p.gold })), this.leaderId);
      const winners = this.ranking.filter((x) => x.winner).map((x) => x.name);
      this.addLog(`Game over! ${winners.join(' & ')} ${winners.length > 1 ? 'win' : 'wins'}.`, 'round');
      this.game = null;
      this.sync();
    } catch (e) {
      if (!(e instanceof Abort)) {
        console.error(e);
        this.addLog(`Engine error: ${e.message}`, 'error');
        this.sync();
      }
    }
  }

  setupDecks() {
    let n = 0;
    this.decks = { king: [], noble: [] };
    this.discards = { king: [], noble: [] };
    for (const d of CARD_DEFS) for (let i = 0; i < (d.copies ?? 1); i++) this.decks[d.deck].push({ uid: 'c' + (++n), defId: d.id });
    shuffle(this.decks.king);
    shuffle(this.decks.noble);
  }

  discardCard(card) {
    this.discards[DEF_BY_ID.get(card.defId).deck].push(card);
  }

  drawCards(pid, n) {
    const p = this.player(pid);
    if (!p) return 0;
    const type = this.roleOf(pid);
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      if (!this.decks[type].length) {
        if (!this.discards[type].length) break;
        this.decks[type] = shuffle(this.discards[type]);
        this.discards[type] = [];
        this.addLog(`The ${type} discard pile was reshuffled.`);
      }
      p.hand.push(this.decks[type].pop());
      drawn++;
    }
    return drawn;
  }

  topUp(pid) {
    const p = this.player(pid);
    if (!p) return 0;
    const need = this.settings.handSize - p.hand.length;
    return need > 0 ? this.drawCards(pid, need) : 0;
  }

  async selectLeader() {
    let leader;
    if (this.settings.leaderSelection === 'host') {
      const ctx = this.makeContext(this.hostId, null);
      leader = await ctx.choosePlayer({ title: 'Choose who starts as King', allowSelf: true, kind: null, alwaysAsk: true });
    }
    if (!leader) {
      this.addLog('Character cards are dealt…', 'phase');
      leader = this.players[randInt(0, this.players.length - 1)].id;
    }
    this.leaderId = leader;
    this.addLog(`${this.player(leader).name} starts as the King. Everyone else is a Noble.`, 'leader');
    this.sync();
  }

  playsFor(pid) {
    if (this.roleOf(pid) !== 'king') return this.settings.noblePlays;
    return this.nobleIds().length <= 3 ? this.settings.kingPlaysFewNobles : this.settings.kingPlays;
  }

  async takeTurn(pid, game) {
    const p = this.player(pid);
    if (!p) return;
    this.currentPlayerId = pid;
    this.turnSerial++;
    this.turnOpen = true;
    this.interruptTurn = false;
    this.playsRemaining = this.playsFor(pid);
    this.playsUsed = 0;         // cards played or placed face down this turn
    this.addLog(`${p.name}'s turn (${this.roleOf(pid) === 'king' ? 'King' : 'Noble'} — ${this.playsRemaining} plays).`, 'turn');
    this.expire('turnStart', pid);
    await this.runHooks('onTurnStart', { player: pid });
    this.ensureActive(game);

    if (this.interruptTurn) {
      // crown changed hands during start-of-turn effects
    } else if (!p.connected && this.settings.skipDisconnected) {
      this.addLog(`${p.name} is disconnected — turn skipped.`);
    } else {
      await this.timer.start(this.settings.turnTime, `${p.name}'s turn`);
      this.ensureActive(game);
    }
    while (this.resolving) { await this.resolving.done; this.ensureActive(game); }
    this.turnOpen = false;
    this.playsRemaining = 0;

    await this.runHooks('onTurnEnd', { player: pid });
    this.ensureActive(game);
    this.expire('turnEnd', pid);
    // "Plays N cards, then draws N" — everyone is kept at the minimum hand size.
    // "Plays 2 cards, then draws 2" (rules guide). You draw as many as you played, up to your
    // normal number of plays, and never end below the hand size. So a card gained mid-turn
    // (e.g. with Sub Rosa) doesn't cost you a draw, and hands can grow past 8 (Royal Advisor FAQ).
    for (const q of this.players) {
      let d;
      if (q.id === pid) {
        const want = Math.max(Math.min(this.playsUsed || 0, this.playsFor(pid)), this.settings.handSize - q.hand.length);
        d = want > 0 ? this.drawCards(q.id, want) : 0;
        if (d) this.addLog(`${q.name} draws ${d} card${d > 1 ? 's' : ''}.`);
      } else d = this.topUp(q.id);
    }
    await this.resolveCrown();
    this.ensureActive(game);
    this.currentPlayerId = null;
    this.sync();
  }

  // =====================================================================
  // The crown
  // =====================================================================
  async resolveCrown() {
    if (!this.crownDirty || this.crownBusy || !this.leaderId || !this.settings.autoCrown) { this.crownDirty = false; return; }
    this.crownBusy = true;
    try {
      while (this.crownDirty) {
        this.crownDirty = false;
        const king = this.player(this.leaderId);
        const richer = this.players.filter((p) => p.id !== king.id && p.gold > king.gold);
        if (!richer.length) break;
        const top = Math.max(...richer.map((p) => p.gold));
        let contenders = richer.filter((p) => p.gold === top).map((p) => p.id);
        // Two players become King at the same time: they roll, the lowest roll loses 100.
        while (contenders.length > 1) {
          this.addLog(`${contenders.map((id) => this.player(id).name).join(' and ')} would both take the crown — roll off!`, 'leader');
          const rolls = await Promise.all(contenders.map((id) => this.makeContext(id, null).roll({ label: 'Crown roll-off' })));
          this.ensureActive();
          const low = Math.min(...rolls);
          const losers = contenders.filter((_, i) => rolls[i] === low);
          if (losers.length === contenders.length) continue;
          for (const id of losers) {
            const moved = this.moveGold(this.player(id), null, 100);
            this.addLog(`${this.player(id).name} rolled lowest and loses ${moved} gold.`, 'gold');
          }
          contenders = contenders.filter((id) => !losers.includes(id));
        }
        const winner = this.player(contenders[0]);
        if (winner.gold > king.gold) this.crown(winner.id, 'has more gold than the King');
        this.crownDirty = true; // re-check once more after the swap
        if (this.leaderId === king.id) break;
      }
    } finally {
      this.crownBusy = false;
      this.crownDirty = false;
    }
  }

  // Make `newId` King: swap seats and hands with the old King.
  crown(newId, reason = '') {
    const oldId = this.leaderId;
    if (!oldId || newId === oldId) return;
    const a = this.player(newId), b = this.player(oldId);
    if (!a || !b) return;
    const ia = this.players.indexOf(a), ib = this.players.indexOf(b);
    this.players[ia] = b;
    this.players[ib] = a;
    // Cards marked discardOnCrown (e.g. Royal Bomb) are discarded when their holder becomes King.
    const gone = a.hand.filter((c) => DEF_BY_ID.get(c.defId).discardOnCrown);
    if (gone.length) {
      a.hand = a.hand.filter((c) => !DEF_BY_ID.get(c.defId).discardOnCrown);
      for (const c of gone) this.discardCard(c);
      this.addLog(`${a.name}'s ${gone.map((c) => DEF_BY_ID.get(c.defId).name).join(', ')} is discarded.`);
    }
    [a.hand, b.hand] = [b.hand, a.hand];
    // Face-down cards (Knights or bluffs) stay in front of the seat, so the player who moves
    // into it inherits them without being able to check them (Royal Advisor FAQ). Face-up
    // cards like Hindsight or Scout are personal bets and stay with their owner.
    const fdA = a.tableau.filter((t) => t.faceDown), fdB = b.tableau.filter((t) => t.faceDown);
    a.tableau = [...a.tableau.filter((t) => !t.faceDown), ...fdB];
    b.tableau = [...b.tableau.filter((t) => !t.faceDown), ...fdA];
    this.leaderId = newId;
    // Synchronous notification for effects/statuses that care who becomes King.
    for (const src of [...this.effects, ...this.players.flatMap((p) => p.statuses)]) {
      if (typeof src.onCrown === 'function') {
        try { src.onCrown(newId, oldId); } catch (e) { console.error(e); }
      }
    }
    const msg = `👑 ${a.name} ${reason ? `${reason} and ` : ''}takes the crown! ${b.name} becomes a Noble. They swap seats and cards.`;
    this.addLog(msg, 'leader');
    this.toastAll(`${a.name} is the new King!`);
    if (this.currentPlayerId === newId || this.currentPlayerId === oldId) this.interruptTurn = true;
    this.sync();
  }

  // =====================================================================
  // Playing cards
  // =====================================================================
  playableReason(pid, card) {
    const d = DEF_BY_ID.get(card.defId);
    if (this.resolving) return 'Wait for the current card to resolve';
    if (d.timing === 'reaction') return 'Played only in response to another card';
    if (d.knight && !d.play) return 'Place this face down';
    if (d.timing === 'anytime') {
      if (!['turns', 'negotiation'].includes(this.phase)) return 'Not now';
    } else {
      if (this.phase !== 'turns' || this.currentPlayerId !== pid || !this.turnOpen) return 'Not your turn';
      if (this.playsRemaining <= 0) return 'No plays left this turn';
    }
    if (d.canPlay) {
      let r;
      try { r = d.canPlay(this.makeContext(pid, card)); } catch { r = false; }
      if (r !== true) return typeof r === 'string' ? r : 'Cannot play this right now';
    }
    return true;
  }

  async playCard(pid, uid) {
    const p = this.player(pid);
    const idx = p.hand.findIndex((c) => c.uid === uid);
    if (idx < 0) throw new GameError('Card not in hand');
    const card = p.hand[idx];
    const reason = this.playableReason(pid, card);
    if (reason !== true) throw new GameError(reason);
    const d = DEF_BY_ID.get(card.defId);
    const game = this.game;

    p.hand.splice(idx, 1);
    if (d.timing !== 'anytime') { this.playsRemaining--; if (this.currentPlayerId === pid) this.playsUsed++; }
    let done;
    this.resolving = { player: pid, cardName: d.name, done: new Promise((r) => { done = r; }) };
    this.timer.pause();
    this.addLog(`${p.name} played ${d.name}.`, 'play');
    this.sync();

    const ctx = this.makeContext(pid, card);
    const played = { player: pid, cardId: d.id, cardName: d.name, uid, targets: ctx.targets };
    try {
      const cancelled = await this.reactionWindow(played);
      this.ensureActive(game);
      if (cancelled) this.addLog(`${d.name} was cancelled.`);
      else if (d.choices) {
        const i = await ctx.chooseOption(`${d.name} — choose one`, d.choices.map((c, k) => ({ value: k, label: c.text || c.label })));
        this.addLog(`${p.name} chose: ${d.choices[i].label || d.choices[i].text}`);
        await d.choices[i].play(ctx);
      } else await d.play(ctx);
      this.ensureActive(game);
      if (!cancelled) await this.runHooks('onCardPlayed', { player: pid, cardId: d.id, cardName: d.name, uid });
      await this.resolveCrown();
    } catch (e) {
      if (!(e instanceof Abort)) { console.error(e); this.addLog(`Card error (${d.name}): ${e.message}`, 'error'); }
    } finally {
      const aborted = game && game.aborted;
      if (!ctx._keptInFront && !aborted) this.discardCard(card);
      this.resolving = null;
      done();
      if (!aborted) {
        if (this.interruptTurn && this.timer.active && this.phase === 'turns') {
          this.addLog('The turn passes after the change of crown.');
          this.timer.finish('crown');
        } else this.timer.resume();
      }
      this.sync();
    }
  }

  async reactionWindow(played) {
    if (!this.settings.reactionTime) return false;
    const holders = [];
    for (const q of this.players) {
      if (q.id === played.player) continue;
      const qctx = this.makeContext(q.id, null);
      const cards = q.hand.filter((c) => {
        const d = DEF_BY_ID.get(c.defId);
        if (d.timing !== 'reaction') return false;
        try { return !d.canReact || d.canReact(qctx, played); } catch { return false; }
      });
      if (cards.length) holders.push({ q, cards });
    }
    if (!holders.length) return false;

    this.reactionOpen = true;
    const answers = await Promise.all(holders.map(({ q, cards }) => this.prompt(q.id, {
      type: 'chooseOption',
      title: `${this.player(played.player).name} played ${played.cardName}. React?`,
      secret: true,
      options: [...cards.map((c) => ({ value: c.uid, label: `Play ${DEF_BY_ID.get(c.defId).name}`, card: this.cardView(c) })), { value: null, label: 'Pass' }],
      timeout: this.settings.reactionTime,
      default: null,
    })));
    this.reactionOpen = false;
    this.ensureActive();

    for (let i = 0; i < holders.length; i++) {
      const uid = answers[i];
      if (!uid) continue;
      const q = holders[i].q;
      const ci = q.hand.findIndex((c) => c.uid === uid);
      if (ci < 0) continue;
      const [c] = q.hand.splice(ci, 1);
      const d = DEF_BY_ID.get(c.defId);
      this.addLog(`${q.name} reacts with ${d.name}!`, 'play');
      const rctx = this.makeContext(q.id, c);
      let result;
      try { result = await d.react(rctx, played); } catch (e) { if (e instanceof Abort) throw e; console.error(e); }
      if (!rctx._keptInFront) this.discardCard(c);
      this.sync();
      if (result === 'cancel') return true;
    }
    return false;
  }

  // =====================================================================
  // Prompts (choices sent to a specific player)
  // =====================================================================
  prompt(playerId, spec) {
    const room = this;
    const p = this.player(playerId);
    const id = ++this.promptSeq;
    const seconds = spec.timeout ?? this.settings.promptTime;
    const options = spec.options || [];
    const fallback = () => {
      if (spec.default !== undefined) return typeof spec.default === 'function' ? spec.default() : spec.default;
      if (spec.type === 'number') return spec.min;
      if (options.length) return options[randInt(0, options.length - 1)].value;
      return null;
    };
    return new Promise((resolve) => {
      const entry = {
        id, playerId, spec,
        settle(value) {
          clearTimeout(entry.handle);
          if (!room.prompts.has(id)) return;
          room.prompts.delete(id);
          room.sync();
          resolve(value);
        },
        answer(raw) {
          if (spec.type === 'number') {
            let n = Math.round(Number(raw));
            if (!Number.isFinite(n)) throw new GameError('Enter a number');
            n = Math.min(spec.max, Math.max(spec.min, n));
            if (spec.step) n = spec.min + Math.round((n - spec.min) / spec.step) * spec.step;
            return entry.settle(n);
          }
          if (spec.type === 'info') return entry.settle(true);
          const i = Number(raw);
          if (!Number.isInteger(i) || i < 0 || i >= options.length) throw new GameError('Invalid choice');
          entry.settle(options[i].value);
        },
        cancel() { entry.settle(fallback()); },
        shorten(ms) {
          if (entry.endsAt - Date.now() <= ms) return;
          clearTimeout(entry.handle);
          entry.endsAt = Date.now() + ms;
          entry.handle = setTimeout(() => entry.settle(fallback()), ms);
        },
        view() {
          return {
            id, type: spec.type, title: spec.title, message: spec.message || '',
            options: options.map((o) => ({ label: o.label, card: o.card || null, back: o.back || null })),
            cards: spec.cards || null, min: spec.min, max: spec.max, step: spec.step,
            endsAt: entry.endsAt,
          };
        },
      };
      const disconnected = p && !p.connected && this.settings.skipDisconnected;
      const ms = disconnected ? 1500 : seconds * 1000;
      entry.endsAt = Date.now() + ms;
      entry.handle = setTimeout(() => entry.settle(fallback()), ms);
      this.prompts.set(id, entry);
      this.sync();
    });
  }

  // =====================================================================
  // Gold, statuses, effects, hooks
  // =====================================================================
  moveGold(fromP, toP, amount) {
    let amt = Math.max(0, Math.floor(amount));
    if (fromP) amt = Math.min(amt, fromP.gold);
    if (toP && this.settings.maxGold > 0) amt = Math.min(amt, Math.max(0, this.settings.maxGold - toP.gold));
    if (fromP) fromP.gold -= amt;
    if (toP) toP.gold += amt;
    if (amt) this.crownDirty = true;
    return amt;
  }

  isBlocked(pid, kind, byPid) {
    if (!kind || pid === byPid) return false;
    const p = this.player(pid);
    return !!p && p.statuses.some((s) => s.blocks && s.blocks.includes(kind));
  }

  normalizeExpiry(exp, ownerId, holderId) {
    if (!exp || exp === 'never') return { type: 'never' };
    if (exp === 'roundEnd') return { type: 'roundEnd' };
    if (exp === 'ownerNextTurn') return { type: 'turnStart', player: ownerId };
    if (exp === 'holderNextTurn') return { type: 'turnStart', player: holderId };
    // "until the end of your next turn": skips the turn in progress, if it is the owner's
    if (exp === 'ownerNextTurnEnd') return { type: 'turnEnd', player: ownerId, after: this.turnSerial };
    if (exp === 'holderNextTurnEnd') return { type: 'turnEnd', player: holderId, after: this.turnSerial };
    if (exp.turnStartOf) return { type: 'turnStart', player: exp.turnStartOf };
    return { type: 'never' };
  }

  expire(event, pid) {
    const hit = (x) => x.expires.type === event
      && (event === 'roundEnd' || x.expires.player === pid)
      && (x.expires.after === undefined || this.turnSerial > x.expires.after);
    for (const p of this.players) {
      const gone = p.statuses.filter(hit);
      if (gone.length) {
        p.statuses = p.statuses.filter((s) => !hit(s));
        for (const s of gone) if (s.label) this.addLog(`${p.name} is no longer ${s.label}.`);
      }
    }
    this.effects = this.effects.filter((e) => !hit(e));
  }

  async runHooks(name, payload) {
    const list = [
      ...this.effects.filter((e) => typeof e[name] === 'function').map((e) => ({ src: e, owner: e.owner })),
      ...this.players.flatMap((p) => p.statuses.filter((s) => typeof s[name] === 'function').map((s) => ({ src: s, owner: s.source, holder: p.id }))),
    ];
    for (const { src, owner, holder } of list) {
      const ctx = this.makeContext(owner, null);
      ctx.effect = src;
      try {
        await src[name](ctx, { ...payload, holder });
      } catch (e) {
        if (e instanceof Abort) throw e;
        console.error(e);
        this.addLog(`Effect error: ${e.message}`, 'error');
      }
      this.ensureActive();
    }
    await this.resolveCrown();
    this.sync();
  }

  // =====================================================================
  // The card API (`ctx`). Documented in CARD_API.md
  // =====================================================================
  makeContext(meId, card) {
    const room = this;
    const game = this.game;
    const active = () => room.ensureActive(game);
    const P = (id) => room.player(id);
    const nameOf = (id) => (id === 'bank' ? 'the bank' : P(id)?.name ?? '?');
    const loseCard = (p, i) => {
      // "If you discard/lose a card then draw a replacement instantly"
      const [c] = p.hand.splice(i, 1);
      room.drawCards(p.id, 1);
      return c;
    };

    const ctx = {
      me: meId,
      card: card ? DEF_BY_ID.get(card.defId) : null,
      cardInstance: card,
      targets: [],
      get round() { return room.round; },
      get totalRounds() { return room.settings.rounds; },
      get isFirstRound() { return room.round === 1; },
      get isLastRound() { return room.round === room.settings.rounds; },
      get direction() { return room.direction; },
      get king() { return room.leaderId; },
      get leader() { return room.leaderId; },
      get currentPlayer() { return room.currentPlayerId; },
      settings: room.settings,

      // ---- lookups ----
      players: () => room.players.map((p) => p.id),
      others: (id = meId) => room.players.filter((p) => p.id !== id).map((p) => p.id),
      nobles: () => room.nobleIds(),
      nonLeaders: () => room.nobleIds(),
      role: (id = meId) => room.roleOf(id),
      isKing: (id = meId) => id === room.leaderId,
      isLeader: (id) => id === room.leaderId,
      name: nameOf,
      gold: (id) => P(id)?.gold ?? 0,
      handSize: (id) => P(id)?.hand.length ?? 0,
      hand: (id) => (P(id)?.hand || []).map((c) => ({ uid: c.uid, id: c.defId, name: DEF_BY_ID.get(c.defId).name })),
      isTargetable: (id, kind = 'target') => !room.isBlocked(id, kind, meId),
      seatNeighbours(id = meId) {
        const n = room.players.length, i = room.players.findIndex((p) => p.id === id);
        return { left: room.players[(i + 1) % n].id, right: room.players[(i - 1 + n) % n].id };
      },

      // ---- output ----
      log: (text) => { room.addLog(text); room.sync(); },
      announce: (text) => { room.addLog(text, 'announce'); room.toastAll(text); room.sync(); },

      // ---- choices ----
      async choosePlayer(o = {}) {
        active();
        const chooser = o.chooser || meId;
        const kind = o.kind === undefined ? 'target' : o.kind;
        const ids = room.players.map((p) => p.id).filter((id) =>
          (o.allowSelf || id !== chooser)
          && (o.includeKing !== false && o.includeLeader !== false || id !== room.leaderId)
          && !(o.exclude || []).includes(id)
          && (!o.filter || o.filter(id))
          && !room.isBlocked(id, kind, meId));
        if (!ids.length) { room.addLog(`No valid player to choose for ${ctx.card?.name || 'this effect'}.`); return null; }
        const options = ids.map((id) => ({ value: id, label: room.phase === 'leaderSelect' ? P(id).name : `${P(id).name}${id === room.leaderId ? ' (King)' : ''} — ${P(id).gold} gold` }));
        if (o.optional) options.push({ value: null, label: o.cancelLabel || 'Cancel' });
        const v = ids.length === 1 && !o.optional && !o.alwaysAsk ? ids[0]
          : await room.prompt(chooser, { type: 'chooseOption', title: o.title || 'Choose a player', message: o.message, options, publicTitle: o.publicTitle, default: o.default });
        active();
        if (v) { ctx.targets.push(v); room.addLog(`${nameOf(chooser)} chose ${nameOf(v)}.`); }
        return v;
      },
      async choosePlayers(n, o = {}) {
        const chosen = [];
        for (let i = 0; i < n; i++) {
          const v = await ctx.choosePlayer({ ...o, exclude: [...(o.exclude || []), ...chosen], title: `${o.title || 'Choose players'} (${i + 1}/${n})` });
          if (!v) break;
          chosen.push(v);
        }
        return chosen;
      },
      async chooseOption(title, opts, o = {}) {
        active();
        const options = opts.map((x) => (typeof x === 'object' ? x : { value: x, label: String(x) }));
        const v = await room.prompt(o.chooser || meId, { type: 'chooseOption', title, message: o.message, options, default: o.default, timeout: o.timeout, publicTitle: o.publicTitle });
        active();
        return v;
      },
      async confirm(title, o = {}) {
        return ctx.chooseOption(title, [{ value: true, label: o.yes || 'Yes' }, { value: false, label: o.no || 'No' }], { default: o.default ?? false, ...o });
      },
      async chooseAmount(o = {}) {
        active();
        const min = o.min ?? 0, max = o.max ?? 1000, step = o.step ?? 100;
        const count = Math.floor((max - min) / step) + 1;
        let v;
        if (count <= 25) {
          const options = [];
          for (let a = min; a <= max; a += step) options.push({ value: a, label: String(a) });
          v = await room.prompt(o.chooser || meId, { type: 'chooseOption', title: o.title || 'Choose an amount', message: o.message, options, default: o.default ?? min });
        } else {
          v = await room.prompt(o.chooser || meId, { type: 'number', title: o.title || 'Choose an amount', message: o.message, min, max, step, default: o.default ?? min });
        }
        active();
        return v;
      },
      async roll(o = {}) {
        active();
        const who = o.player || meId;
        const sides = o.sides || 6;
        await room.prompt(who, { type: 'roll', title: o.title || `Roll the die${o.label ? ` — ${o.label}` : ''}`, publicTitle: `Rolling${o.label ? ` (${o.label})` : ''}`, options: [{ value: true, label: 'Roll!' }], default: true, timeout: Math.min(15, room.settings.promptTime) });
        active();
        const raw = randInt(1, sides);
        const value = raw + (o.modifier || 0);
        room.lastRoll = { id: crypto.randomUUID(), player: who, name: nameOf(who), value: raw, sides, label: o.label || '', modifier: o.modifier || 0 };
        room.addLog(`${nameOf(who)} rolled ${raw}${o.modifier ? ` (${o.modifier > 0 ? '+' : ''}${o.modifier} = ${value})` : ''}${o.label ? ` for ${o.label}` : ''}.`, 'dice');
        room.sync();
        return value;
      },
      async vote(o = {}) {
        active();
        const voters = o.voters || ctx.others();
        const labels = o.options || ['Yes', 'No'];
        const options = labels.map((l) => ({ value: l, label: l }));
        room.addLog(`Vote: ${o.title || 'Vote'}`, 'vote');
        const answers = await Promise.all(voters.map((id) => room.prompt(id, { type: 'chooseOption', title: o.title || 'Vote', message: o.message, options, publicTitle: `Voting: ${o.title || ''}`, default: o.default ?? labels[labels.length - 1] })));
        active();
        const votes = {}, tally = {};
        labels.forEach((l) => { tally[l] = 0; });
        voters.forEach((id, i) => { votes[id] = answers[i]; tally[answers[i]] = (tally[answers[i]] || 0) + 1; });
        if (o.anonymous) room.addLog(`Result: ${labels.map((l) => `${l} ${tally[l]}`).join(', ')}.`, 'vote');
        else room.addLog(`Result: ${voters.map((id) => `${nameOf(id)}: ${votes[id]}`).join(', ')}.`, 'vote');
        room.sync();
        return { votes, tally };
      },

      // ---- gold ----
      async transfer(from, to, amount, o = {}) {
        active();
        const fromP = from === 'bank' ? null : P(from);
        const toP = to === 'bank' ? null : P(to);
        if ((from !== 'bank' && !fromP) || (to !== 'bank' && !toP)) return 0;
        const kind = o.kind || (from !== 'bank' && to !== 'bank' && to === meId ? 'take' : from !== 'bank' ? 'lose' : null);
        if (!o.ignoreProtection && from !== 'bank' && room.isBlocked(from, kind, meId)) {
          room.addLog(`${nameOf(from)} is protected — no gold moved.`);
          room.sync();
          return 0;
        }
        const t = { from, to, amount, source: meId, card: ctx.card?.id, blocked: false };
        for (const e of room.effects) if (e.beforeTransfer) await e.beforeTransfer(ctx, t);
        for (const p of room.players) for (const s of p.statuses) if (s.beforeTransfer) await s.beforeTransfer(ctx, t, p.id);
        active();
        if (t.blocked) { room.addLog(t.blockReason || 'The transfer was blocked.'); room.sync(); return 0; }
        const moved = room.moveGold(fromP, toP, t.amount);
        room.addLog(`${nameOf(from)} → ${nameOf(to)}: ${moved} gold${moved < t.amount ? ` (wanted ${t.amount})` : ''}.`, 'gold');
        room.sync();
        return moved;
      },
      gain: (id, amount, o) => ctx.transfer('bank', id, amount, o),
      lose: (id, amount, o) => ctx.transfer(id, 'bank', amount, o),
      canAfford: (id, amount) => (P(id)?.gold ?? 0) >= amount,
      setGold(id, amount) {
        const p = P(id); if (!p) return;
        p.gold = Math.min(room.settings.maxGold, Math.max(0, Math.floor(amount)));
        room.crownDirty = true; room.sync();
      },
      swapGold(a, b) {
        const pa = P(a), pb = P(b); if (!pa || !pb) return;
        [pa.gold, pb.gold] = [pb.gold, pa.gold];
        room.crownDirty = true; room.addLog(`${pa.name} and ${pb.name} swapped gold.`, 'gold'); room.sync();
      },

      // ---- the crown ----
      crown(id, reason) { room.crown(id, reason); },

      // ---- cards ----
      draw(id, n = 1) { const d = room.drawCards(id, n); if (d) room.addLog(`${nameOf(id)} drew ${d} card${d > 1 ? 's' : ''}.`); room.sync(); return d; },
      extraPlays(n = 1) { if (room.currentPlayerId === meId) { room.playsRemaining += n; room.sync(); } },
      discardCard(id, uid) {
        const p = P(id); const i = p ? p.hand.findIndex((c) => c.uid === uid) : -1;
        if (i < 0) return false;
        room.discardCard(loseCard(p, i));
        room.addLog(`${p.name} discarded a card and drew a replacement.`); room.sync(); return true;
      },
      moveCard(fromId, toId, uid) {
        const a = P(fromId), b = P(toId); const i = a ? a.hand.findIndex((c) => c.uid === uid) : -1;
        if (i < 0 || !b) return false;
        const deck = DEF_BY_ID.get(a.hand[i].defId).deck;
        const c = loseCard(a, i);
        if (deck !== room.roleOf(toId)) {
          room.discardCard(c);
          room.addLog(`${b.name} can't hold that card, so it was discarded.`);
        } else {
          b.hand.push(c);
          room.addLog(`${b.name} took a card from ${a.name}.`);
        }
        room.sync(); return true;
      },
      async chooseCardFromHand(o = {}) {
        active();
        const owner = P(o.owner || meId);
        const chooser = o.chooser || owner?.id;
        if (!owner || !owner.hand.length) return null;
        const faceUp = o.reveal || chooser === owner.id;
        const hand = faceUp ? owner.hand : shuffle([...owner.hand]);
        const options = hand.map((c, i) => (faceUp
          ? { value: c.uid, label: DEF_BY_ID.get(c.defId).name, card: room.cardView(c) }
          : { value: c.uid, label: `Card ${i + 1}`, back: DEF_BY_ID.get(c.defId).deck }));
        if (o.optional) options.push({ value: null, label: 'None' });
        const v = await room.prompt(chooser, { type: 'chooseOption', title: o.title || 'Choose a card', options, publicTitle: o.publicTitle });
        active();
        return v;
      },
      async reveal(toId, o = {}) {
        active();
        await room.prompt(toId, { type: 'info', title: o.title || 'Revealed', message: o.message || '', cards: o.cards || null, options: [{ value: true, label: 'OK' }], default: true, publicTitle: 'Looking at something…' });
        active();
      },
      async peekHand(viewerId, ownerId) {
        if (room.isBlocked(ownerId, 'peek', viewerId)) { room.addLog(`${nameOf(ownerId)}'s hand is protected.`); return false; }
        room.addLog(`${nameOf(viewerId)} looks at ${nameOf(ownerId)}'s hand.`);
        await ctx.reveal(viewerId, { title: `${nameOf(ownerId)}'s hand`, cards: P(ownerId).hand.map((c) => room.cardView(c)), message: P(ownerId).hand.length ? '' : '(empty)' });
        await ctx.notifyPeek(viewerId, ownerId);
        return true;
      },
      // Lets statuses on `ownerId` react to someone looking at their cards (status hook: onPeek(ctx, { viewer, owner })).
      async notifyPeek(viewerId, ownerId) {
        const p = P(ownerId);
        if (!p || viewerId === ownerId) return;
        for (const s of [...p.statuses]) {
          if (typeof s.onPeek !== 'function') continue;
          try { await s.onPeek(ctx, { viewer: viewerId, owner: ownerId }); } catch (e) { if (e instanceof Abort) throw e; console.error(e); }
        }
        active();
      },
      // Privately show one face-down card in front of `ownerId` to `viewerId`.
      async revealFrontCard(viewerId, ownerId, uid) {
        const t = P(ownerId)?.tableau.find((x) => x.uid === uid);
        if (!t) return null;
        room.addLog(`${nameOf(viewerId)} looks at a face-down card in front of ${nameOf(ownerId)}.`);
        await ctx.reveal(viewerId, { title: `Face-down card in front of ${nameOf(ownerId)}`, cards: [room.cardView(t)] });
        await ctx.notifyPeek(viewerId, ownerId);
        return t.defId;
      },
      keepInFront(o = {}) {
        if (!card) return null;
        const owner = P(o.owner || meId);
        owner.tableau.push({ ...card, faceDown: !!o.faceDown, placedBy: meId, data: o.data || {} });
        ctx._keptInFront = true;
        room.sync();
        return card.uid;
      },
      tableau: (id) => (P(id)?.tableau || []).map((t) => ({ uid: t.uid, id: t.defId, name: DEF_BY_ID.get(t.defId).name, faceDown: t.faceDown, knight: !!DEF_BY_ID.get(t.defId).knight, data: t.data })),
      faceDownCards: (id) => ctx.tableau(id).filter((t) => t.faceDown),
      removeFromFront(id, uid, { toHandOf } = {}) {
        const p = P(id); const i = p ? p.tableau.findIndex((t) => t.uid === uid) : -1;
        if (i < 0) return false;
        const [t] = p.tableau.splice(i, 1);
        const c = { uid: t.uid, defId: t.defId };
        if (toHandOf && P(toHandOf) && DEF_BY_ID.get(c.defId).deck === room.roleOf(toHandOf)) P(toHandOf).hand.push(c);
        else room.discardCard(c);
        room.sync();
        return true;
      },
      /*
       * Knight check: if `targetId` has a face-down card, reveal one.
       * A real Knight blocks the attack (and is discarded) -> returns true.
       * A bluff offers no protection (it's revealed and discarded) -> returns false.
       */
      checkKnight(targetId, o = {}) {
        const p = P(targetId);
        if (!p) return false;
        const i = p.tableau.findIndex((t) => t.faceDown);
        if (i < 0) return false;
        const [t] = p.tableau.splice(i, 1);
        const d = DEF_BY_ID.get(t.defId);
        room.discardCard({ uid: t.uid, defId: t.defId });
        if (d.knight && !o.ignoreKnights) {
          room.addLog(`🛡️ ${p.name}'s face-down card is a real Knight — the attack is blocked!`, 'play');
          room.sync();
          return true;
        }
        room.addLog(`${p.name}'s face-down card was a bluff (${d.name}) — no protection!`, 'play');
        room.sync();
        return false;
      },

      // ---- statuses & effects ----
      addStatus(id, s) {
        const p = P(id); if (!p) return;
        p.statuses = p.statuses.filter((x) => x.key !== s.key);
        p.statuses.push({ ...s, source: meId, expires: room.normalizeExpiry(s.expires, meId, id) });
        if (s.label) room.addLog(`${p.name} is now ${s.label}.`);
        room.sync();
      },
      removeStatus(id, key) { const p = P(id); if (p) { p.statuses = p.statuses.filter((x) => x.key !== key); room.sync(); } },
      hasStatus: (id, key) => !!P(id)?.statuses.some((x) => x.key === key),
      getStatus: (id, key) => P(id)?.statuses.find((x) => x.key === key) || null,
      addEffect(e) {
        room.effects = room.effects.filter((x) => x.key !== e.key);
        room.effects.push({ ...e, owner: e.owner || meId, expires: room.normalizeExpiry(e.expires, meId, meId) });
        room.sync();
      },
      removeEffect(key) { room.effects = room.effects.filter((x) => x.key !== key); room.sync(); },
      hasEffect: (key) => room.effects.some((x) => x.key === key),
    };
    return ctx;
  }
}

module.exports = { Room, GameError };
