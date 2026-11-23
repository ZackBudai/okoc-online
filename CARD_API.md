# Card API

Cards live in `server/cards.js`. Each card's `play(ctx)` (or `react(ctx, played)`) gets a
`ctx` object. Everything that waits on a player (choices, rolls, votes) is `async`, so use `await`.
Gold amounts are always whole numbers, and a player's gold can never drop below 0.

```js
{
  id: 'my-card',            // unique
  name: 'My Card',
  text: 'Rules text shown on the card.',
  deck: 'noble',            // 'noble' (default) | 'king'
  copies: 2,
  art: '/art/my-card.png',  // optional, file goes in public/art/
  timing: 'turn',           // 'turn' | 'anytime' | 'reaction'
  knight: false,            // true = a real Knight (placed face down; no play() needed)
  discardOnCrown: false,    // true = discarded from the hand of a player who becomes King
  canPlay: (ctx) => true,   // optional: true, false, or a reason string
  async play(ctx) { ... },
}
```

### Choose-one cards ("dotted line")

```js
{
  id: 'two-way', name: 'Two Way', copies: 2,
  choices: [
    { label: 'Option A', text: 'Lose 100; a player of your choice loses 300.', async play(ctx) { ... } },
    { label: 'Option B', text: 'Make a player lose 100.', async play(ctx) { ... } },
  ],
}
```
The player picks one option when they play the card. If you leave out `text`, the card's text
is built from the options.

### Knights and bluffs

Any card can be placed face down from the hand (this uses a play). In an attack card, call:

```js
if (ctx.checkKnight(target)) return;   // a real Knight blocked it
```
`checkKnight` reveals one of the target's face-down cards. If it's a real Knight (`knight: true`),
it is discarded and the call returns `true`. If it's a bluff, it is revealed and discarded, and
the call returns `false`, meaning no protection. If a card ignores Knights (for example an attack
on the King that Knights can't stop), just don't call it.

### The crown

After every card, hook and negotiation gift, the engine checks gold. If a Noble has more than
the King, the crown changes hands automatically. That means seat swap, hand swap, the turn
passes if needed, and a roll-off if two Nobles tie. To change the King directly from a card,
use `ctx.crown(id, 'reason')`.

## Who and what

| Helper | Returns |
|---|---|
| `ctx.me` | id of the player using the card |
| `ctx.king` | the current King's id |
| `ctx.round`, `ctx.totalRounds`, `ctx.isFirstRound`, `ctx.isLastRound`, `ctx.direction` | round info (`'cw'` / `'ccw'`) |
| `ctx.players()`, `ctx.others(id?)`, `ctx.nobles()` | arrays of player ids |
| `ctx.name(id)`, `ctx.gold(id)`, `ctx.isKing(id)`, `ctx.role(id)`, `ctx.handSize(id)` | info about a player (`role` is `'king'` or `'noble'`) |
| `ctx.seatNeighbours(id?)` | `{ left, right }` player ids |
| `ctx.hand(id)` | `[{ uid, id, name }]` (server-side only, nobody else sees it) |
| `ctx.cardInstance.uid` | unique id of this physical card |

## Choices (each one shows a pop-up with a timer to the chosen player)

| Helper | Notes |
|---|---|
| `await ctx.choosePlayer({ title, chooser, allowSelf, includeKing, exclude, filter, kind, optional })` | returns an id or `null`. `kind` (default `'target'`) leaves out players who are protected from that kind of effect. Pass `kind: null` to ignore protection |
| `await ctx.choosePlayers(n, opts)` | picks n different players |
| `await ctx.chooseOption(title, ['A','B'] or [{value,label}], { chooser })` | returns the chosen value |
| `await ctx.confirm(title, { chooser, yes, no })` | `true` / `false` |
| `await ctx.chooseAmount({ title, min, max, step, chooser })` | a number |
| `await ctx.chooseCardFromHand({ owner, chooser, reveal, optional, title })` | a card uid. The cards are face down unless `chooser === owner` or `reveal: true` |
| `await ctx.roll({ player, sides, label, modifier })` | that player clicks Roll and everyone sees the die. Returns roll plus modifier |
| `await ctx.vote({ voters, title, options, anonymous })` | `{ votes: {id: choice}, tally: {choice: count} }` |
| `await ctx.reveal(toId, { title, message, cards })` | shows information privately to one player |
| `await ctx.peekHand(viewerId, ownerId)` | shows a hand, unless the owner is protected from `'peek'` |
| `await ctx.revealFrontCard(viewerId, ownerId, uid)` | privately shows one face-down card in front of a player |

If a player runs out of time, the default answer is used (a random option, unless the card
supplies `default`).

## Gold

| Helper | Notes |
|---|---|
| `await ctx.transfer(from, to, amount, { kind, ignoreProtection })` | `from`/`to` are a player id or `'bank'`. Moves as much as the payer can afford, up to the gold cap. Returns the amount actually moved |
| `await ctx.gain(id, n)` / `await ctx.lose(id, n)` | to or from the bank |
| `ctx.canAfford(id, n)`, `ctx.setGold(id, n)`, `ctx.swapGold(a, b)` | |

Gold is always kept between 0 and the gold limit (2000 by default).

Protection kinds checked automatically: taking gold from another player to yourself is `'take'`.
Paying any other player-to-somewhere transfer is `'lose'`.

## Cards

`ctx.draw(id, n)` draws from the deck that matches the player's role.
`ctx.discardCard(id, uid)` and `ctx.moveCard(fromId, toId, uid)` both give the player who
lost the card an instant replacement. A card the receiver isn't allowed to hold goes to the
discard pile instead.
`ctx.extraPlays(n)` works for the current player only.
`ctx.keepInFront({ faceDown, owner, data })` leaves the card on the table instead of
discarding it.
`ctx.tableau(id)` lists the cards in front of a player, `ctx.faceDownCards(id)` lists only the
face-down ones, and `ctx.removeFromFront(id, uid, { toHandOf })` takes one away.
`ctx.checkKnight(id)` (see above).

## Statuses (attached to a player, shown as a badge)

```js
ctx.addStatus(playerId, {
  key: 'shield', label: 'Shielded', description: '...',
  blocks: ['take', 'peek', 'target', 'lose'],   // optional
  expires: 'ownerNextTurn',  // 'holderNextTurn' | 'ownerNextTurnEnd' | 'holderNextTurnEnd' | 'roundEnd' | 'never' | { turnStartOf: id }
  data: {},                  // anything you want to store
  // optional hooks, same as effects below
});
ctx.removeStatus(id, key); ctx.hasStatus(id, key); ctx.getStatus(id, key);
```

## Ongoing effects (game-wide hooks)

```js
ctx.addEffect({
  key: 'unique-key', label: 'Shown under "Ongoing effects"', expires: 'never',
  async onRoundStart(hctx, { round }) {},
  async onRoundEnd(hctx, { round }) {},
  async onTurnStart(hctx, { player }) {},
  async onTurnEnd(hctx, { player }) {},
  async beforeTransfer(hctx, t) { /* t = { from, to, amount, source, card }; set t.amount or t.blocked = true */ },
  async onCardPlayed(hctx, { player, cardId, cardName, uid }) {},  // after a card resolves
  async onGift(hctx, { from, to, amount }) {},  // a player gave gold during negotiation
  onCrown(newKingId, oldKingId) {},  // synchronous; called the moment the crown changes hands
});
ctx.removeEffect(key); ctx.hasEffect(key);
```
Inside a hook, `hctx.me` is the player who created the effect, and `hctx.effect` is the effect itself.
Statuses can use the same hooks, plus `onPeek(ctx, { viewer, owner })`, which runs when someone
looks at the holder's hand (`peekHand`) or a face-down card in front of them (`revealFrontCard`).
`'ownerNextTurnEnd'` lasts until the END of the owner's next turn (the current turn doesn't count).

## Reaction cards

```js
{
  timing: 'reaction',
  canReact: (ctx, played) => played.player !== ctx.me,  // played = { player, cardId, cardName, uid }
  async react(ctx, played) { return 'cancel'; },        // or do anything else and return nothing
}
```
Each time a card is played, players holding a reaction card that can respond get a short
pop-up offering it.

## Other

`ctx.log(text)` adds a line to the game log. `ctx.announce(text)` adds a log line and shows
a pop-up message to everyone. `ctx.crown(id, reason)` makes a player King immediately.
