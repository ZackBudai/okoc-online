'use strict';

/*
 * CARD DEFINITIONS
 * ----------------
 * The cards from the One King One Crown print-and-play edition (see custom_card.txt
 * in the repo root for the plain-text list). See CARD_API.md for every helper on `ctx`.
 *
 * Fields:
 *   id        unique string
 *   name      display name
 *   text      rules text shown on the card (auto-built for `choices` cards if omitted)
 *   deck      'noble' (default) | 'king'  — Nobles can't hold King cards and vice versa
 *   copies    how many copies go in that deck
 *   art       optional image URL (put files in public/art/)
 *   timing    'turn' (default) | 'anytime' | 'reaction'
 *   knight    true = a real Knight. It's placed face down; ctx.checkKnight() honours it
 *   discardOnCrown  true = discarded from the hand of a player who becomes King
 *   canPlay(ctx)            optional -> true/false (or a reason string)
 *   play(ctx)               async effect
 *   choices                 [{ label, text, play(ctx) }] — "dotted line" cards: player picks ONE
 *   canReact(ctx, played)   reaction cards: whether they can respond to `played`
 *   react(ctx, played)      reaction cards: return 'cancel' to cancel the played card
 *
 * Wording used on the cards: "noble" means a player who is not the King; "player" means anyone.
 *
 * Gold changes are checked after every card: if a Noble ends up with more gold
 * than the King, the crown changes hands automatically.
 */

const crypto = require('crypto');

// ---- helpers ----
const notKing = (ctx) => (id) => !ctx.isKing(id);
const otherNobles = (ctx) => ctx.nobles().filter((id) => id !== ctx.me);
const shuffled = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
// Both players roll; re-roll ties. Returns [rollA, rollB].
async function rollOff(ctx, a, b, label) {
  for (;;) {
    const ra = await ctx.roll({ player: a, label });
    const rb = await ctx.roll({ player: b, label });
    if (ra !== rb) return [ra, rb];
    ctx.log('Tie — roll again.');
  }
}
// Let `chooser` take a card from `owner`'s (revealed) hand. Royal Bomb can't be stolen.
async function stealCard(ctx, owner) {
  for (let tries = 0; tries < 3; tries++) {
    const stealable = ctx.hand(owner).filter((c) => !STEAL_PROOF.has(c.id));
    if (!stealable.length) { ctx.log(`${ctx.name(owner)} has no card that can be taken.`); return; }
    const uid = await ctx.chooseCardFromHand({ owner, chooser: ctx.me, reveal: true, title: `Take a card from ${ctx.name(owner)}` });
    if (!uid) return;
    const pick = ctx.hand(owner).find((c) => c.uid === uid);
    if (pick && STEAL_PROOF.has(pick.id)) { ctx.log(`${pick.name} cannot be stolen — pick another card.`); continue; }
    ctx.moveCard(owner, ctx.me, uid);
    return;
  }
}
const STEAL_PROOF = new Set(['royal-bomb']);
// Take a random card from `owner` without seeing their hand (Royal Bomb can't be stolen).
async function stealRandomCard(ctx, owner) {
  const stealable = ctx.hand(owner).filter((c) => !STEAL_PROOF.has(c.id));
  if (!stealable.length) { ctx.log(`${ctx.name(owner)} has no card that can be taken.`); return; }
  const pick = stealable[crypto.randomInt(0, stealable.length)];
  ctx.log(`${ctx.name(ctx.me)} takes a random card from ${ctx.name(owner)}.`);
  ctx.moveCard(owner, ctx.me, pick.uid);
}

// ---- spoken card parts (see ctx.speak) ----
const typed = (ctx) => ctx.settings.spokenParts !== 'honour';
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const saysExactly = (phrase) => (t) => norm(t) === norm(phrase);
const mentions = (t, name) => norm(t).includes(norm(name));
const isThanks = (t) => /\b(thank|thanks|thankyou|ty|grateful)\b/.test(norm(t));
const isLaugh = (t) => /(ha){2,}|(he){2,}|(ah){2,}|lol|lmao|rofl|xd/.test(norm(t).replace(/\s/g, ''));
const wordCount = (t) => norm(t).split(' ').filter(Boolean).length;
// Everyone in `ids` speaks at once; returns the ids that didn't.
async function allSpeak(ctx, ids, opts) {
  const results = await Promise.all(ids.map((id) => ctx.speak({ ...opts(id), player: id })));
  return ids.filter((_, i) => !results[i].ok);
}

// King Maker sides, keyed by the uid of the Betray the King card being played.
const kingMakerBets = new Map();

// A card that backs a noble and pays out (or costs) at the end of the next round.
function backingCard({ prefix, label, isHit }) {
  return async (ctx) => {
    const backed = await ctx.choosePlayer({ title: `${label}: back which noble?`, allowSelf: true, includeKing: false, kind: null });
    if (!backed) return;
    const uid = ctx.cardInstance.uid;
    const me = ctx.me;
    const deadline = ctx.round + 1;
    const key = `${prefix}-${uid}`;
    ctx.keepInFront({ data: { backed } });
    const state = { hit: false };
    const settle = async (h, won) => {
      if (!h.hasEffect(key)) return;
      h.removeEffect(key);
      h.removeFromFront(me, uid);
      if (won) { h.announce(`${label}: ${h.name(me)} backed ${h.name(backed)} correctly and gains 300!`); await h.gain(me, 300); }
      else { h.announce(`${label}: ${h.name(me)} backed ${h.name(backed)} wrongly and loses 100.`); await h.lose(me, 100, { ignoreProtection: true }); }
    };
    ctx.addEffect({
      key,
      label: `${ctx.name(me)}'s ${label}: backing ${ctx.name(backed)} (until end of round ${deadline})`,
      onCrown(newId) { if (isHit === 'crown' && newId === backed) state.hit = true; },
      async onCardPlayed(h, played) {
        if (isHit !== 'crown' && isHit(played, backed)) await settle(h, true);
      },
      async onTurnEnd(h) { if (state.hit) await settle(h, true); },
      async onRoundEnd(h, { round }) {
        if (state.hit) await settle(h, true);
        else if (round >= deadline) await settle(h, false);
      },
    });
  };
}

module.exports = [
  // =================================================================== NOBLE DECK (74)
  {
    id: 'actors', name: 'Actors', copies: 3,
    choices: [
      { label: 'Thank the King', text: 'Everyone must thank the king for their glorious rule however horrible and cruel it might have been.',
        async play(ctx) {
          const king = ctx.king, K = ctx.name(king);
          if (!typed(ctx)) { ctx.announce(`🎭 Everyone must now thank ${K} for their glorious rule, however horrible and cruel it might have been.`); return; }
          const refused = await allSpeak(ctx, ctx.players().filter((id) => id !== king), () => ({
            title: `Actors: thank ${K} for their glorious rule`,
            instruction: 'However horrible and cruel it might have been. It has to be a thank-you.',
            check: isThanks, failHint: 'it has to thank them', suggestion: `Thank you, ${K}, for your glorious rule!`,
          }));
          if (refused.length) ctx.announce(`🎭 ${refused.map((id) => ctx.name(id)).join(', ')} refused to thank ${K}.`);
        } },
      { label: 'Laugh at a player', text: 'Everyone must laugh at the player of your choice.',
        async play(ctx) {
          const t = await ctx.choosePlayer({ title: 'Who does everyone laugh at?', kind: null });
          if (!t) return;
          ctx.announce(`🎭 Everyone must laugh at ${ctx.name(t)}!`);
          if (!typed(ctx)) return;
          const refused = await allSpeak(ctx, ctx.players().filter((id) => id !== t), () => ({
            title: `Actors: laugh at ${ctx.name(t)}`, check: isLaugh, failHint: 'it has to be a laugh, like "hahaha"',
            suggestion: 'HAHAHAHA', placeholder: 'hahaha…',
          }));
          if (refused.length) ctx.announce(`🎭 ${refused.map((id) => ctx.name(id)).join(', ')} refused to laugh.`);
        } },
    ],
  },
  {
    id: 'allies', name: 'Allies', copies: 3,
    text: 'Pick a noble. They choose if you gain 100 gold or lose 200 to the bank. Other players can convince them to take the second option.',
    async play(ctx) {
      const t = await ctx.choosePlayer({ title: 'Allies: pick a noble to decide', includeKing: false, kind: null });
      if (!t) return;
      const gain = await ctx.chooseOption(`Allies: does ${ctx.name(ctx.me)} gain 100 gold or lose 200 to the bank?`,
        [{ value: true, label: `${ctx.name(ctx.me)} gains 100` }, { value: false, label: `${ctx.name(ctx.me)} loses 200` }],
        { chooser: t, publicTitle: 'Deciding (Allies)' });
      if (gain) await ctx.gain(ctx.me, 100); else await ctx.lose(ctx.me, 200, { ignoreProtection: true });
    },
  },
  {
    id: 'bad-blood', name: 'Bad Blood', copies: 3,
    text: 'Pick two nobles. You gain 200 gold from the bank at the beginning of every round until one of them gives the other 200 gold. They can make this payment out of turn.',
    async play(ctx) {
      const pair = await ctx.choosePlayers(2, { title: 'Bad Blood: pick two nobles', includeKing: false, kind: null });
      if (pair.length < 2) return;
      const [a, b] = pair;
      const key = `bad-blood-${ctx.cardInstance.uid}`;
      const owner = ctx.me;
      const state = { ended: false };
      // Royal Advisor FAQ: Bad Blood stops the moment you become King.
      const stopIfKing = (h) => {
        if (!state.ended || !h.hasEffect(key)) return false;
        h.removeEffect(key);
        h.log(`Bad Blood ends: ${h.name(owner)} became King.`);
        return true;
      };
      ctx.addEffect({
        key,
        label: `Bad Blood: ${ctx.name(ctx.me)} gains 200 each round until ${ctx.name(a)} or ${ctx.name(b)} gives the other 200 (during negotiation)`,
        onCrown(newId) { if (newId === owner) state.ended = true; },
        async onTurnEnd(h) { stopIfKing(h); },
        async onRoundStart(h) { if (stopIfKing(h) || h.isKing(owner)) { h.removeEffect(key); return; } await h.gain(h.me, 200); },
        async onGift(h, { from, to, amount }) {
          if (amount >= 200 && ((from === a && to === b) || (from === b && to === a))) {
            h.removeEffect(key);
            h.announce(`Bad Blood between ${h.name(a)} and ${h.name(b)} is settled.`);
          }
        },
      });
      ctx.announce(`Bad Blood: ${ctx.name(a)} and ${ctx.name(b)} can end this by one giving the other 200 gold in a negotiation phase.`);
    },
  },
  {
    id: 'beggars-blessing', name: "Beggar's Blessing", copies: 3,
    text: 'All nobles with 300 gold or lower gain 200.',
    async play(ctx) {
      for (const id of ctx.nobles()) if (ctx.gold(id) <= 300) await ctx.gain(id, 200);
    },
  },
  {
    id: 'betrayal', name: 'Betrayal', copies: 4,
    text: "Take all gold from another noble. Requires vocal support from another noble after it's played or it has no effect. Not playable in the first round.",
    canPlay: (ctx) => !ctx.isFirstRound || 'Not playable in the first round',
    async play(ctx) {
      const t = await ctx.choosePlayer({ title: 'Betrayal: take all gold from which noble?', includeKing: false, kind: null });
      if (!t) return;
      const voters = ctx.nobles().filter((id) => id !== ctx.me && id !== t);
      if (!voters.length) { ctx.log('Nobody can support the Betrayal — no effect.'); return; }
      const { tally } = await ctx.vote({ voters, title: `Do you support ${ctx.name(ctx.me)} betraying ${ctx.name(t)}?`, options: ['Support', 'Stay silent'] });
      if (!tally.Support) { ctx.announce('Nobody supported the Betrayal — it has no effect.'); return; }
      if (ctx.checkKnight(t)) return;
      // Isolation does not protect against Betrayal.
      await ctx.transfer(t, ctx.me, ctx.gold(t), { ignoreProtection: true });
    },
  },
  {
    id: 'betray-the-king', name: 'Betray the King', copies: 2,
    text: "The King rolls: 1–3, you switch places and gold. 4–6, they remain king and gain 200 gold from the bank. After it's played, you must gain vocal support from TWO players or it has no effect. Not playable in the first round.",
    canPlay: (ctx) => !ctx.isFirstRound || 'Not playable in the first round',
    async play(ctx) {
      const uid = ctx.cardInstance.uid;
      const bets = kingMakerBets.get(uid) || [];
      kingMakerBets.delete(uid);
      const king = ctx.king;
      const voters = ctx.players().filter((id) => id !== ctx.me && id !== king);
      const { tally } = voters.length
        ? await ctx.vote({ voters, title: `Do you support ${ctx.name(ctx.me)} betraying the King?`, options: ['Support', 'Stay silent'] })
        : { tally: {} };
      if ((tally.Support || 0) < 2) { ctx.announce('Betray the King needs support from TWO players — it has no effect.'); return; }
      const modifier = bets.reduce((m, b) => m + (b.side === 'support' ? 1 : -1), 0);
      const r = await ctx.roll({ player: king, label: 'Betray the King', modifier });
      const kingHolds = r >= 4;
      if (kingHolds) {
        ctx.announce(`${ctx.name(king)} survives the betrayal and gains 200!`);
        await ctx.gain(king, 200);
      } else {
        ctx.announce(`${ctx.name(ctx.me)} overthrows ${ctx.name(king)}! They switch places and gold.`);
        ctx.swapGold(ctx.me, king);
        ctx.crown(ctx.me, 'betrayed the King');
      }
      for (const b of bets) {
        const failed = (b.side === 'support') !== kingHolds;
        if (failed) { ctx.log(`King Maker: ${ctx.name(b.player)} picked the losing side.`); await ctx.lose(b.player, 300, { ignoreProtection: true }); }
      }
    },
  },
  {
    id: 'council-meeting', name: 'Council Meeting', copies: 3,
    choices: [
      { label: 'Call a vote', text: 'If all players vote yes, you take 100 gold from the king. If one votes no, you lose 100 to the bank.',
        async play(ctx) {
          const { tally } = await ctx.vote({ voters: ctx.others(), title: `Council Meeting: should ${ctx.name(ctx.me)} take 100 gold from the King?` });
          if (!tally.No) await ctx.transfer(ctx.king, ctx.me, 100);
          else await ctx.lose(ctx.me, 100, { ignoreProtection: true });
        } },
      { label: 'Draw two', text: 'Draw two cards, but you must praise the king.',
        async play(ctx) {
          const K = ctx.name(ctx.king);
          if (!typed(ctx)) { ctx.draw(ctx.me, 2); ctx.announce(`${ctx.name(ctx.me)} must now praise ${K}!`); return; }
          // The draw depends on the praise.
          const r = await ctx.speak({
            title: `Council Meeting: praise ${K} to draw two cards`, instruction: `Say something nice about ${K}, using their name.`,
            check: (t) => mentions(t, K) && wordCount(t) >= 3, failHint: `name ${K} and use at least 3 words`,
            suggestion: `All hail ${K}, the greatest ruler this kingdom has known!`,
          });
          if (r.ok) ctx.draw(ctx.me, 2);
          else ctx.announce(`${ctx.name(ctx.me)} wouldn't praise ${K}, so they draw nothing.`);
        } },
    ],
  },
  {
    id: 'divine-right', name: 'Divine Right', copies: 1,
    text: 'If you roll 5+: You gain 1200 gold. Play only if you have 300 gold or less. Can only be played or discarded in the last 2 rounds.',
    canPlay: (ctx) => {
      if (ctx.round < ctx.totalRounds - 1) return 'Only in the last 2 rounds';
      return ctx.gold(ctx.me) <= 300 || 'Only if you have 300 gold or less';
    },
    async play(ctx) {
      if ((await ctx.roll({ label: 'Divine Right' })) >= 5) await ctx.gain(ctx.me, 1200);
      else ctx.log('Divine Right fails.');
    },
  },
  {
    id: 'grudge', name: 'Grudge', copies: 2,
    text: 'Pick a player. They have to agree to you taking 200 gold from the noble of your choice. If they disagree, you lose 100 gold to the bank.',
    async play(ctx) {
      const judge = await ctx.choosePlayer({ title: 'Grudge: who has to agree?', kind: null });
      if (!judge) return;
      const victim = await ctx.choosePlayer({ title: 'Grudge: take 200 from which noble?', includeKing: false, kind: 'take' });
      if (!victim) return;
      const ok = await ctx.confirm(`Grudge: do you agree to ${ctx.name(ctx.me)} taking 200 gold from ${ctx.name(victim)}?`,
        { chooser: judge, yes: 'Agree', no: 'Disagree', publicTitle: 'Deciding (Grudge)' });
      if (ok) await ctx.transfer(victim, ctx.me, 200);
      else await ctx.lose(ctx.me, 100, { ignoreProtection: true });
    },
  },
  {
    id: 'helping-hand', name: 'Helping Hand', copies: 3,
    text: 'Draw 2 extra cards and play an extra card. So, if this is your first card, you get to play 3 more now.',
    async play(ctx) { ctx.draw(ctx.me, 2); ctx.extraPlays(2); },
  },
  {
    id: 'hindsight', name: 'Hindsight', copies: 2,
    text: 'Back a specific noble to play the "Betrayal" card before the end of the next round. If correct, gain 300 gold from the bank. If not, lose 100. Keep this in front of you until then.',
    play: backingCard({ prefix: 'hindsight', label: 'Hindsight', isHit: (played, backed) => played.player === backed && played.cardId === 'betrayal' }),
  },
  {
    id: 'icarus', name: 'Icarus', copies: 2,
    text: 'If you roll a 4-6, all nobles must pay you 100 gold. If you fail, you must pay each noble 100 gold. You can only play this card if you can afford it.',
    canPlay: (ctx) => ctx.canAfford(ctx.me, 100 * otherNobles(ctx).length) || "You can't afford to pay every noble 100",
    async play(ctx) {
      const r = await ctx.roll({ label: 'Icarus' });
      for (const id of otherNobles(ctx)) {
        if (r >= 4) await ctx.transfer(id, ctx.me, 100);
        else await ctx.transfer(ctx.me, id, 100);
      }
    },
  },
  {
    id: 'indebted', name: 'Indebted', copies: 2,
    text: 'If you roll a 3-6, a noble has to pay you 100 gold at the beginning of every round until another player frees them by paying you 200. This payment can be made at any time. Any debts are gone if you become king.',
    async play(ctx) {
      if ((await ctx.roll({ label: 'Indebted' })) < 3) { ctx.log('Indebted fails.'); return; }
      const debtor = await ctx.choosePlayer({ title: 'Indebted: who owes you?', includeKing: false, kind: null });
      if (!debtor) return;
      const creditor = ctx.me;
      const key = `indebted-${ctx.cardInstance.uid}`;
      const state = { cleared: false };
      ctx.addStatus(debtor, {
        key, label: `Indebted to ${ctx.name(creditor)}`, expires: 'never',
        description: `Pays ${ctx.name(creditor)} 100 at the start of every round, until another player gives ${ctx.name(creditor)} 200 in a negotiation phase. Cleared if ${ctx.name(creditor)} becomes King.`,
        onCrown(newId) { if (newId === creditor) state.cleared = true; },
        async onRoundStart(h) {
          if (state.cleared || h.isKing(creditor)) { h.removeStatus(debtor, key); h.log(`${h.name(creditor)}'s debts are gone.`); return; }
          await h.transfer(debtor, creditor, 100);
        },
        async onGift(h, { from, to, amount }) {
          if (to === creditor && from !== debtor && amount >= 200) {
            h.removeStatus(debtor, key);
            h.announce(`${h.name(from)} frees ${h.name(debtor)} from their debt to ${h.name(creditor)}.`);
          }
        },
      });
    },
  },
  {
    id: 'isolation', name: 'Isolation', copies: 3,
    choices: [
      { label: 'Hide your cards', text: 'No one can look at your cards until the end of your next turn.',
        async play(ctx) { ctx.addStatus(ctx.me, { key: 'isolation-peek', label: 'Isolated (cards hidden)', blocks: ['peek'], expires: 'ownerNextTurnEnd' }); } },
      { label: 'Guard your gold', text: 'No one can take gold from you until the end of your next turn. This does not apply to the Betrayal card.',
        // Royal Advisor FAQ: while Isolated you can't lose gold to cards other players play,
        // except Royal Bomb and Betrayal (those ignore protection). Your own cards still cost you.
        async play(ctx) { ctx.addStatus(ctx.me, { key: 'isolation-gold', label: 'Isolated (gold guarded)', description: "Other players' cards can't take or cost you gold. Royal Bomb and Betrayal still work.", blocks: ['take', 'lose'], expires: 'ownerNextTurnEnd' }); } },
    ],
  },
  {
    id: 'king-maker', name: 'King Maker', copies: 2, timing: 'reaction',
    text: 'Play this card out of turn when you or someone plays "Betray the King". Choose a side: support (+1 to the King\'s roll) or oppose (−1 to the King\'s roll). If your side fails, pay 300 gold to the bank.',
    canReact: (ctx, played) => played.cardId === 'betray-the-king',
    async react(ctx, played) {
      const side = await ctx.chooseOption('King Maker: choose a side', [
        { value: 'support', label: "Support the King (+1 to the King's roll)" },
        { value: 'oppose', label: "Oppose the King (−1 to the King's roll)" },
      ]);
      const list = kingMakerBets.get(played.uid) || [];
      list.push({ player: ctx.me, side });
      kingMakerBets.set(played.uid, list);
      ctx.announce(`King Maker: ${ctx.name(ctx.me)} ${side === 'support' ? 'supports' : 'opposes'} the King.`);
    },
  },
  {
    id: 'knight', name: 'Knight', copies: 2, knight: true,
    text: 'Place this card FACE DOWN in front of you to protect you from one betrayal. Placing a knight down counts as a card played.',
  },
  {
    id: 'loyalty', name: 'Loyalty', copies: 3,
    choices: [
      { label: 'Pay or make the King pay', text: 'Pick a player. They choose whether to pay you 100 gold or force the king pay you.',
        async play(ctx) {
          const t = await ctx.choosePlayer({ title: 'Loyalty: pick a player', kind: null });
          if (!t) return;
          const payer = await ctx.chooseOption(`Loyalty: who pays ${ctx.name(ctx.me)} 100 gold?`,
            [{ value: t, label: 'I pay 100' }, { value: ctx.king, label: `The King (${ctx.name(ctx.king)}) pays 100` }],
            { chooser: t, publicTitle: 'Deciding (Loyalty)' });
          await ctx.transfer(payer, ctx.me, 100);
        } },
      { label: 'Pledge to the King', text: 'Force a player to pay the king 100 gold and pledge their loyalty to them.',
        async play(ctx) {
          const t = await ctx.choosePlayer({ title: 'Loyalty: who pays the King?', includeKing: false, kind: 'lose' });
          if (!t) return;
          await ctx.transfer(t, ctx.king, 100);
          const K = ctx.name(ctx.king);
          if (!typed(ctx)) { ctx.announce(`${ctx.name(t)} must pledge their loyalty to ${K}!`); return; }
          const pledge = `I pledge my loyalty to ${K}`;
          const r = await ctx.speak({
            player: t, title: `Loyalty: pledge your loyalty to ${K}`, instruction: `Type: “${pledge}”.`,
            check: saysExactly(pledge), failHint: `type “${pledge}”`, suggestion: pledge,
          });
          if (!r.ok) ctx.announce(`${ctx.name(t)} refused to pledge their loyalty to ${K}.`);
        } },
    ],
  },
  {
    id: 'meat-for-meat', name: 'Meat for Meat', copies: 4,
    text: 'You and another noble roll. If you roll higher, you collect 200 from them.',
    async play(ctx) {
      const t = await ctx.choosePlayer({ title: 'Meat for Meat: roll against which noble?', includeKing: false, kind: 'take' });
      if (!t) return;
      const mine = await ctx.roll({ label: 'Meat for Meat' });
      const theirs = await ctx.roll({ player: t, label: 'Meat for Meat' });
      if (mine > theirs) await ctx.transfer(t, ctx.me, 200);
      else ctx.log(`${ctx.name(ctx.me)} did not roll higher.`);
    },
  },
  {
    id: 'peoples-champion', name: "People's Champion", copies: 1,
    text: 'Nominate a noble as King. If all other nobles agree, they roll against the current King to take the throne. Can only be played or discarded in the last round.',
    canPlay: (ctx) => ctx.isLastRound || 'Only in the last round',
    async play(ctx) {
      const nominee = await ctx.choosePlayer({ title: "People's Champion: nominate a noble as King", allowSelf: true, includeKing: false, kind: null });
      if (!nominee) return;
      const voters = ctx.nobles().filter((id) => id !== nominee && id !== ctx.me);
      if (voters.length) {
        const { tally } = await ctx.vote({ voters, title: `Should ${ctx.name(nominee)} challenge the King for the throne?` });
        if (tally.No) { ctx.announce("Not every noble agreed — People's Champion has no effect."); return; }
      }
      const king = ctx.king;
      const [rn, rk] = await rollOff(ctx, nominee, king, "People's Champion");
      if (rn > rk) {
        // They also switch gold, otherwise the richer old King would take the crown straight back.
        ctx.swapGold(nominee, king);
        ctx.crown(nominee, 'is the People\'s Champion');
      } else ctx.announce(`${ctx.name(king)} holds the throne.`);
    },
  },
  {
    id: 'royal-bomb', name: 'Royal Bomb', copies: 1, discardOnCrown: true,
    text: 'You and everyone else (excluding the king) lose 800 gold. This card cannot be stolen and can only be discarded or given away by you during the "Negotiation Phase". If you become king, the card is discarded. Use this card to pressure and negotiate.',
    async play(ctx) {
      ctx.announce('💣 The Royal Bomb goes off! Every noble loses 800 gold.');
      for (const id of ctx.nobles()) await ctx.lose(id, 800, { ignoreProtection: true });
    },
  },
  {
    id: 'scout', name: 'Scout', copies: 2,
    text: "Back a noble to become king by the end of the next round. If you're correct, earn 300 gold from the bank. If you're wrong, lose 100. Keep this card in front of you until then.",
    play: backingCard({ prefix: 'scout', label: 'Scout', isHit: 'crown' }),
  },
  {
    id: 'shadow-deal', name: 'Shadow Deal', copies: 5,
    text: 'Give another player 100 or 200 gold (you pick) from the bank. You can give it to the king.',
    async play(ctx) {
      const t = await ctx.choosePlayer({ title: 'Shadow Deal: give gold to whom?', kind: null });
      if (!t) return;
      const amt = await ctx.chooseAmount({ title: `Shadow Deal: how much for ${ctx.name(t)}?`, min: 100, max: 200, step: 100 });
      await ctx.gain(t, amt);
    },
  },
  {
    id: 'sub-rosa', name: 'Sub Rosa', copies: 5,
    text: "Look at any player's hand or one face down knight card (pick one). If you roll a 4 or higher you can take a card from their hand.",
    async play(ctx) {
      const withFaceDown = ctx.others().filter((id) => ctx.faceDownCards(id).length && ctx.isTargetable(id, 'peek'));
      const mode = withFaceDown.length
        ? await ctx.chooseOption('Sub Rosa: look at…', [{ value: 'hand', label: "A player's hand" }, { value: 'knight', label: 'A face-down knight card' }])
        : 'hand';
      let t;
      if (mode === 'knight') {
        t = await ctx.choosePlayer({ title: 'Sub Rosa: whose face-down card?', filter: (id) => withFaceDown.includes(id), kind: 'peek' });
        if (!t) return;
        const cards = ctx.faceDownCards(t);
        const uid = cards.length === 1 ? cards[0].uid
          : await ctx.chooseOption('Which face-down card?', cards.map((c, i) => ({ value: c.uid, label: `Face-down card ${i + 1}` })));
        await ctx.revealFrontCard(ctx.me, t, uid);
      } else {
        t = await ctx.choosePlayer({ title: 'Sub Rosa: whose hand?', kind: 'peek' });
        if (!t || !(await ctx.peekHand(ctx.me, t))) return;
      }
      if ((await ctx.roll({ label: 'Sub Rosa' })) < 4) return;
      if (mode === 'knight') await stealRandomCard(ctx, t); // FAQ: blind, at random
      else await stealCard(ctx, t);
    },
  },
  {
    id: 'subsidies', name: 'Subsidies', copies: 3,
    text: 'All nobles get gold for as much gold as they have:\nNo gold – Receive 300\n100-300 – Receive 200\n400-500 – Receive 100',
    async play(ctx) {
      for (const id of ctx.nobles()) {
        const g = ctx.gold(id);
        const amt = g === 0 ? 300 : g <= 300 ? 200 : g <= 500 ? 100 : 0;
        if (amt) await ctx.gain(id, amt);
      }
    },
  },
  {
    id: 'suppress-rebellion', name: 'Suppress Rebellion', copies: 2,
    text: 'If the king pathetically rolls a 1-3, the bank must give you 200 gold and every other noble 100 gold.',
    async play(ctx) {
      const r = await ctx.roll({ player: ctx.king, label: 'Suppress Rebellion' });
      if (r > 3) { ctx.log('The rebellion is suppressed.'); return; }
      await ctx.gain(ctx.me, 200);
      for (const id of otherNobles(ctx)) await ctx.gain(id, 100);
    },
  },
  {
    id: 'tithe', name: 'Tithe', copies: 2,
    text: 'Pick a player. They must pick a noble to give you 100 gold.',
    async play(ctx) {
      const t = await ctx.choosePlayer({ title: 'Tithe: who picks?', kind: null });
      if (!t) return;
      const payer = await ctx.choosePlayer({ chooser: t, title: `Tithe: which noble gives ${ctx.name(ctx.me)} 100 gold?`, allowSelf: true, exclude: [ctx.me], includeKing: false, kind: 'take' });
      if (payer) await ctx.transfer(payer, ctx.me, 100);
    },
  },
  {
    id: 'unprotected', name: 'Unprotected', copies: 2,
    text: 'If you roll a 5-6, all face down knights in play are removed except yours.',
    async play(ctx) {
      if ((await ctx.roll({ label: 'Unprotected' })) < 5) { ctx.log('Unprotected fails.'); return; }
      let n = 0;
      for (const id of ctx.others()) for (const c of ctx.faceDownCards(id)) { ctx.removeFromFront(id, c.uid); n++; }
      ctx.announce(`Unprotected: ${n} face-down card${n === 1 ? '' : 's'} removed.`);
    },
  },
  {
    id: 'wrath', name: 'Wrath', copies: 4,
    choices: [
      { label: 'Lose 100, they lose 300', text: 'You lose 100 gold, but a noble of your choice loses 300.',
        async play(ctx) {
          await ctx.lose(ctx.me, 100, { ignoreProtection: true });
          const t = await ctx.choosePlayer({ title: 'Wrath: which noble loses 300?', includeKing: false, kind: 'lose' });
          if (t) await ctx.lose(t, 300);
        } },
      { label: 'They lose 100', text: 'Make a player lose 100 to the bank.',
        async play(ctx) {
          const t = await ctx.choosePlayer({ title: 'Wrath: who loses 100?', kind: 'lose' });
          if (t) await ctx.lose(t, 100);
        } },
    ],
  },

  // =================================================================== KING DECK (25)
  {
    id: 'anchor', name: 'Anchor', deck: 'king', copies: 2,
    text: 'Player loses 200 gold to the bank or lets the player of your choice lose 100 to you.',
    // Royal Advisor FAQ: the King picks player A and player B, then A chooses: A loses 200 to
    // the bank, or B loses 100 to the King.
    async play(ctx) {
      const a = await ctx.choosePlayer({ title: 'Anchor: who makes the choice? (player A)', kind: null });
      if (!a) return;
      const b = await ctx.choosePlayer({ title: `Anchor: who might lose 100 to you? (player B, ${ctx.name(a)} decides)`, exclude: [a], kind: null });
      const pay = !b || await ctx.chooseOption('Anchor: choose one', [
        { value: true, label: 'I lose 200 gold to the bank' },
        { value: false, label: `${ctx.name(b)} loses 100 to ${ctx.name(ctx.me)}` },
      ], { chooser: a, publicTitle: 'Deciding (Anchor)' });
      if (pay) await ctx.lose(a, 200);
      else await ctx.transfer(b, ctx.me, 100);
    },
  },
  {
    id: 'bend-the-knee', name: 'Bend the Knee', deck: 'king', copies: 2,
    text: "Force a player to thank you for everything you've done for them. If they refuse, they pay the bank 300 gold. If they cannot afford to, they must thank you.",
    async play(ctx) {
      const t = await ctx.choosePlayer({ title: 'Bend the Knee: who must thank you?', kind: null });
      if (!t) return;
      const K = ctx.name(ctx.me);
      const canPay = ctx.canAfford(t, 300);
      if (!typed(ctx)) {
        const refuse = canPay && !(await ctx.confirm(`Bend the Knee: thank ${K} for everything they've done for you, or pay the bank 300?`,
          { chooser: t, yes: 'Thank the King', no: 'Refuse and pay 300', publicTitle: 'Deciding (Bend the Knee)', default: true }));
        if (refuse) await ctx.lose(t, 300);
        else ctx.announce(`${ctx.name(t)} must thank ${K} for everything they've done for them!`);
        return;
      }
      const r = await ctx.speak({
        player: t, title: `Bend the Knee: thank ${K} for everything they've done for you`,
        instruction: canPay ? 'Thank them by name, or refuse and pay the bank 300.' : "You can't afford to refuse: thank them by name.",
        check: (x) => isThanks(x) && mentions(x, K), failHint: `thank ${K} by name`,
        suggestion: `Thank you, ${K}, for everything you have done for me.`,
        refuseLabel: canPay ? 'Refuse and pay 300' : '',
      });
      // Not thanking counts as refusing; someone who can't afford 300 loses what they have.
      if (!r.ok) await ctx.lose(t, 300);
    },
  },
  {
    id: 'black-plague', name: 'Black Plague', deck: 'king', copies: 1,
    text: 'All nobles pair up and each roll a die. If either noble in a pair rolls a 1, both nobles in that pair lose 200 gold. If there is an odd number of nobles, roll with a lone one, but only they can lose gold.',
    async play(ctx) {
      const order = shuffled(ctx.nobles());
      const pairs = [];
      for (let i = 0; i + 1 < order.length; i += 2) pairs.push([order[i], order[i + 1]]);
      const lone = order.length % 2 ? order[order.length - 1] : null;
      ctx.announce(`Black Plague pairs: ${pairs.map(([a, b]) => `${ctx.name(a)} & ${ctx.name(b)}`).join(', ')}${lone ? `; ${ctx.name(lone)} is alone` : ''}.`);
      for (const [a, b] of pairs) {
        const ra = await ctx.roll({ player: a, label: 'Black Plague' });
        const rb = await ctx.roll({ player: b, label: 'Black Plague' });
        if (ra === 1 || rb === 1) for (const id of [a, b]) await ctx.lose(id, 200);
      }
      if (lone) {
        const partner = order.length > 1 ? order[crypto.randomInt(0, order.length - 1)] : null;
        const rl = await ctx.roll({ player: lone, label: 'Black Plague' });
        const rp = partner ? await ctx.roll({ player: partner, label: `Black Plague (with ${ctx.name(lone)}, can't lose)` }) : 0;
        if (rl === 1 || rp === 1) await ctx.lose(lone, 200);
      }
    },
  },
  {
    id: 'debt-collector', name: 'Debt Collector', deck: 'king', copies: 2,
    text: 'Pick a player. This player picks someone to lose 200 gold to the bank.',
    async play(ctx) {
      const t = await ctx.choosePlayer({ title: 'Debt Collector: who picks?', kind: null });
      if (!t) return;
      // Royal Advisor FAQ: only another Noble, never the King.
      const v = await ctx.choosePlayer({ chooser: t, title: 'Debt Collector: which Noble loses 200 to the bank?', includeKing: false, kind: 'lose' });
      if (v) await ctx.lose(v, 200);
    },
  },
  {
    id: 'eye-for-an-eye', name: 'Eye for an Eye', deck: 'king', copies: 1,
    text: 'You lose 100 gold to the bank but a player of your choice loses 300.',
    async play(ctx) {
      await ctx.lose(ctx.me, 100, { ignoreProtection: true });
      const t = await ctx.choosePlayer({ title: 'Eye for an Eye: who loses 300?', kind: 'lose' });
      if (t) await ctx.lose(t, 300);
    },
  },
  {
    id: 'king-helping-hand', name: 'Helping Hand', deck: 'king', copies: 1,
    text: "First draw two, then play an extra card. So, if this is your first card, you play 4 more now (or 3, if you're only playing with 3 nobles).",
    async play(ctx) { ctx.draw(ctx.me, 2); ctx.extraPlays(2); },
  },
  {
    id: 'kings-eye', name: "King's Eye", deck: 'king', copies: 2,
    text: 'Protect a player of your choice until your next turn. If a noble looks at their cards or takes gold from them, they must pay the bank 100 gold.',
    async play(ctx) {
      const t = await ctx.choosePlayer({ title: "King's Eye: protect whom?", allowSelf: true, kind: null });
      if (!t) return;
      const fine = async (h, who, why) => {
        if (h.isKing(who)) return;
        h.announce(`👁️ King's Eye: ${h.name(who)} ${why} and pays the bank 100.`);
        await h.lose(who, 100, { ignoreProtection: true });
      };
      ctx.addStatus(t, {
        key: `kings-eye-${ctx.cardInstance.uid}`, label: "under the King's Eye", expires: 'ownerNextTurn',
        description: 'A noble who looks at their cards or takes gold from them pays the bank 100.',
        async beforeTransfer(h, tr, holder) {
          if (tr.from === holder && tr.to !== 'bank' && tr.to === tr.source && tr.source !== holder) await fine(h, tr.source, `took gold from ${h.name(holder)}`);
        },
        async onPeek(h, { viewer, owner }) { await fine(h, viewer, `looked at ${h.name(owner)}'s cards`); },
      });
    },
  },
  {
    id: 'king-knight', name: 'Knight', deck: 'king', copies: 1, knight: true,
    text: "Place this card face down in front of a player to protect them from one Betrayal card. They can't look at it.",
  },
  {
    id: 'loyal-dog', name: 'Loyal Dog', deck: 'king', copies: 3,
    text: 'Give a player 100 to 300 gold (you pick) from the bank but they must say "Thank you my king, I pledge my loyalty to you my king."',
    async play(ctx) {
      const t = await ctx.choosePlayer({ title: 'Loyal Dog: reward whom?', kind: null });
      if (!t) return;
      const amt = await ctx.chooseAmount({ title: `Loyal Dog: how much for ${ctx.name(t)}?`, min: 100, max: 300, step: 100 });
      const line = 'Thank you my king, I pledge my loyalty to you my king.';
      if (!typed(ctx)) { await ctx.gain(t, amt); ctx.announce(`${ctx.name(t)} must say: "${line}"`); return; }
      // The gold depends on saying the line.
      const r = await ctx.speak({
        player: t, title: `Loyal Dog: say the line to receive ${amt} gold`, instruction: `Type: “${line}”`,
        check: saysExactly(line), failHint: 'type the line exactly', suggestion: line,
        refuseLabel: 'Refuse (no gold)',
      });
      if (r.ok) await ctx.gain(t, amt);
      else ctx.announce(`${ctx.name(t)} wouldn't say it, so they get no gold.`);
    },
  },
  {
    id: 'mad-king', name: 'Mad King', deck: 'king', copies: 1,
    text: 'Force everyone to roll dice. Whoever rolls a 1 loses 300 to the bank. You must roll as well. If you roll a 1 you lose 500.',
    async play(ctx) {
      for (const id of ctx.players()) {
        if ((await ctx.roll({ player: id, label: 'Mad King' })) === 1) await ctx.lose(id, id === ctx.me ? 500 : 300);
      }
    },
  },
  {
    id: 'royal-parrot', name: 'Royal Parrot', deck: 'king', copies: 2,
    text: 'As the royal parrot, a player of your choice has to pay the bank 100 gold then repeat a sentence you give them in a high-pitched voice. 300 to the bank if they refuse.',
    async play(ctx) {
      const t = await ctx.choosePlayer({ title: 'Royal Parrot: who is the parrot?', kind: null });
      if (!t) return;
      if (!typed(ctx)) {
        const comply = await ctx.confirm(`Royal Parrot: pay 100 and repeat ${ctx.name(ctx.me)}'s sentence in a high-pitched voice, or refuse and pay 300?`,
          { chooser: t, yes: 'Pay 100 and squawk', no: 'Refuse (pay 300)', publicTitle: 'Deciding (Royal Parrot)', default: true });
        if (comply) {
          await ctx.lose(t, 100);
          ctx.announce(`🦜 ${ctx.name(t)} must repeat ${ctx.name(ctx.me)}'s sentence in a high-pitched voice!`);
        } else await ctx.lose(t, 300);
        return;
      }
      const fallback = 'Long live the King, the wisest ruler of all!';
      const given = await ctx.speak({
        title: `Royal Parrot: give ${ctx.name(t)} a sentence to repeat`, instruction: 'At least two words.',
        check: (x) => wordCount(x) >= 2 && x.length <= 120, failHint: 'two words or more, up to 120 characters', suggestion: fallback,
      });
      const sentence = given.ok ? given.text : fallback;
      const r = await ctx.speak({
        player: t, title: `🦜 Royal Parrot: repeat ${ctx.name(ctx.me)}'s sentence`,
        instruction: `Pay 100 and repeat exactly: “${sentence}” (or refuse and pay 300).`,
        check: saysExactly(sentence), failHint: 'repeat it exactly', suggestion: sentence,
        refuseLabel: 'Refuse and pay 300', style: 'squeak',
      });
      if (r.ok) await ctx.lose(t, 100);
      else await ctx.lose(t, 300);
    },
  },
  {
    id: 'scapegoat', name: 'Scapegoat', deck: 'king', copies: 1,
    text: 'Each noble must vote on another noble to lose 300 gold to the bank, starting from the noble to your left. A tie is decided by a dice roll.',
    async play(ctx) {
      const nobles = ctx.nobles();
      if (nobles.length < 2) return;
      const order = [];
      for (let id = ctx.seatNeighbours(ctx.me).left; id !== ctx.me; id = ctx.seatNeighbours(id).left) order.push(id);
      const votes = {};
      for (const v of order) {
        const pick = await ctx.choosePlayer({ chooser: v, title: 'Scapegoat: which noble loses 300?', includeKing: false, kind: null });
        if (pick) votes[pick] = (votes[pick] || 0) + 1;
      }
      const top = Math.max(0, ...Object.values(votes));
      let tied = Object.keys(votes).filter((id) => votes[id] === top);
      if (!tied.length) return;
      while (tied.length > 1) {
        ctx.log(`Scapegoat tie between ${tied.map((id) => ctx.name(id)).join(', ')} — lowest roll loses.`);
        const rolls = [];
        for (const id of tied) rolls.push(await ctx.roll({ player: id, label: 'Scapegoat tie' }));
        const low = Math.min(...rolls);
        tied = tied.filter((_, i) => rolls[i] === low);
      }
      ctx.announce(`${ctx.name(tied[0])} is the scapegoat!`);
      await ctx.lose(tied[0], 300);
    },
  },
  {
    id: 'shifting-tides', name: 'Shifting Tides', deck: 'king', copies: 1,
    text: 'Pick two nobles. They can only take gold from each other until your next turn. This does not include Betrayal cards.',
    async play(ctx) {
      const pair = await ctx.choosePlayers(2, { title: 'Shifting Tides: pick two nobles', includeKing: false, kind: null });
      if (pair.length < 2) return;
      const [a, b] = pair;
      ctx.addEffect({
        key: `shifting-tides-${ctx.cardInstance.uid}`, expires: 'ownerNextTurn',
        label: `Shifting Tides: ${ctx.name(a)} and ${ctx.name(b)} can only take gold from each other`,
        async beforeTransfer(h, t) {
          if (t.from === 'bank' || t.to === 'bank' || t.card === 'betrayal' || t.to !== t.source) return;
          const partner = t.source === a ? b : t.source === b ? a : null;
          if (partner && t.from !== partner) { t.blocked = true; t.blockReason = `Shifting Tides: ${h.name(t.source)} can only take gold from ${h.name(partner)}.`; }
        },
      });
    },
  },
  {
    id: 'snakes', name: 'Snakes', deck: 'king', copies: 1,
    text: 'Pick a player and announce it. All nobles must vote by raising their hand. If even one noble raises their hand, the chosen player loses 300 gold to the bank.',
    async play(ctx) {
      const t = await ctx.choosePlayer({ title: 'Snakes: pick a player', kind: null });
      if (!t) return;
      ctx.announce(`🐍 ${ctx.name(ctx.me)} names ${ctx.name(t)}. Raise your hand to make them lose 300!`);
      const voters = ctx.nobles().filter((id) => id !== t);
      if (!voters.length) return;
      const { tally } = await ctx.vote({ voters, title: `Snakes: raise your hand against ${ctx.name(t)}?`, options: ['Raise hand', 'Keep hand down'] });
      if (tally['Raise hand']) await ctx.lose(t, 300);
    },
  },
  {
    id: 'king-sub-rosa', name: 'Sub Rosa', deck: 'king', copies: 2,
    text: "Look at another player's hand. If you roll a 4 or higher, you can also discard a card.",
    async play(ctx) {
      const t = await ctx.choosePlayer({ title: 'Sub Rosa: whose hand?', kind: 'peek' });
      if (!t || !(await ctx.peekHand(ctx.me, t))) return;
      if ((await ctx.roll({ label: 'Sub Rosa' })) < 4) return;
      const uid = await ctx.chooseCardFromHand({ owner: t, chooser: ctx.me, reveal: true, optional: true, title: `Discard one of ${ctx.name(t)}'s cards?` });
      if (uid) ctx.discardCard(t, uid);
    },
  },
  {
    id: 'we-ride-together', name: 'We Ride Together', deck: 'king', copies: 2,
    text: 'Pick two players. Whoever rolls lower between them has to lose 200 gold to the bank. Players can agree to lose 100 gold each instead only AFTER they both roll. Roll again if they tie.',
    async play(ctx) {
      const pair = await ctx.choosePlayers(2, { title: 'We Ride Together: pick two players', kind: null });
      if (pair.length < 2) return;
      const [a, b] = pair;
      const [ra, rb] = await rollOff(ctx, a, b, 'We Ride Together');
      const low = ra < rb ? a : b;
      const q = (id) => ctx.confirm(`We Ride Together: ${ctx.name(low)} rolled lower. Agree that you both lose 100 instead?`,
        { chooser: id, yes: 'Both lose 100', no: `${ctx.name(low)} loses 200`, publicTitle: 'Deciding (We Ride Together)' });
      const [okA, okB] = await Promise.all([q(a), q(b)]);
      if (okA && okB) { for (const id of pair) await ctx.lose(id, 100); }
      else await ctx.lose(low, 200);
    },
  },
];
