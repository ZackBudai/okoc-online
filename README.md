# Multiplayer card game engine

A real-time browser version of a King-and-Nobles card game for a private group.
The rules engine follows the print-and-play rules guide, and both decks use the print-and-play
cards (74 Noble, 25 King; plain-text list in [`custom_card.txt`](custom_card.txt)), with a red/black/white
theme and card backs adapted from the print-and-play files.

**Credit:** the rules are adapted from the *One King One Crown* print-and-play edition
(onecrown.store), licensed **CC BY-NC-SA 4.0**. This adaptation is non-commercial and must be
shared under the same license, with that credit kept. The credit line appears in the site footer
and is set in `public/theme.json`.

## Run it

```
npm install
npm start          # http://localhost:3000
```

Create a room, then share the invite link or the 4-letter code. The host can change the
settings in the lobby and starts the game. The default is 4–8 players, and the minimum can be
lowered in the settings for testing.

Game state is kept in memory. Restarting the server ends any game in progress.

## Rules as implemented (defaults)

**Setup**
- One player is dealt the King role at random (or the host picks). Everyone else is a Noble.
- The King starts with 1000 gold and each Noble with 600. Gold always stays between 0 and 2000.
- There are two decks. The King draws from the King deck and Nobles from the Noble deck.
  Nobles can't hold King cards and vice versa.
- Everyone is dealt 8 cards.

**Each round (4 rounds; clockwise, then counter-clockwise, alternating)**
1. **Playing phase:** the King always goes first. The King plays 3 cards (2 if there are
   3 or fewer Nobles), then draws that many. Then each Noble in seat order plays 2 cards and
   draws 2. Hands never drop below 8 but can grow past it (for example after taking a card
   with Sub Rosa).
   - You must use all your plays if you have a playable card.
   - Playing a card face down counts as a play. Any card can be played face down as a
     claimed Knight. A real Knight blocks one Betrayal and is then discarded; a bluff is
     revealed and gives no protection. Nobles place them in front of themselves; the King
     places them in front of a Noble (never themselves), who can't look at it. Nothing
     protects the King from Betray the King.
   - Choose-one cards ask which option you want.
   - The turn timer pauses while a card resolves. Reaction cards open a short window after
     each play.
2. **Negotiation phase** (2-minute timer; none after the final round): trade gold (a player
   can receive at most 400 per phase), exchange cards one-for-one with a player of the same
   role, or discard a card as part of a deal (you draw a replacement). A deal discard names
   the other player in the deal, who must agree, and each player gets one per negotiation
   phase, so nobody can discard over and over to fish for a better card. Nothing is binding.
   The phase ends early once everyone is Ready and no offer is waiting, or when enough
   players vote to skip.

**At any time**
- **The crown changes hands** as soon as a Noble has more gold than the King. The new King
  swaps seats and hands with the old King, who becomes a Noble. Face-down cards stay in front
  of the seat, so the old King inherits them without seeing them. If the change happens during
  either player's turn, the turn passes to the next seat. If two Nobles qualify at once, they
  roll and the lower roll loses 100.
- Hands are kept at 8 or more. If a card is lost or discarded, a replacement is drawn
  immediately.

**Card rulings** (from the Royal Advisor FAQ on onecrown.store)
- Betrayal needs vocal support after it is played, or it has no effect.
- Isolation (gold option): other players' cards can't take or cost you gold until it ends,
  except Royal Bomb and Betrayal. Your own cards still cost you.
- Helping Hand: draw 2 and play one extra card; Helping Hand itself doesn't use up a play.
- Bad Blood stops the moment its owner becomes King.
- Sub Rosa: after looking at a face-down Knight, a roll of 4+ takes a random card from that
  player's hand, unseen.
- Anchor: the King picks both players first; the first chooses to lose 200, or for the
  second to lose 100 to the King.
- Debt Collector: the chosen player must pick another Noble, never the King.
- People's Champion: you may nominate yourself; a winning challenger swaps gold with the King.

**Spoken card parts** (lobby setting, default *typed and checked*)
- Cards that make someone speak (Loyal Dog, Bend the Knee, Royal Parrot, Loyalty, Council
  Meeting, Actors) ask that player to type the line. The server checks it (fixed lines must
  match, ignoring capitals and punctuation; thanks and praise must name the King; a laugh must
  be a laugh), and a passing line is posted in chat as their speech. Nobody has to vouch for it.
- Not saying it in time counts as refusing: Loyal Dog gives no gold, Council Meeting draws
  nothing, Bend the Knee and Royal Parrot cost 300 (the Royal Parrot's line shows up squeaky).
  Actors and Loyalty have no penalty on the card, so refusals are named publicly.
- *Honour system* keeps the old behaviour: the line is announced and players trust each other.

**Winning:** whoever is King when the last card of the final round is played wins (there is
no negotiation after the final round).

All the numbers above can be changed in the lobby settings.

## Where to customise

| What | File |
|---|---|
| Cards and their effects (both decks) | `server/cards.js` (see `CARD_API.md`) |
| Win condition | `server/rules.js` |
| Default settings and lobby options | `server/config.js` |
| Title, role names, currency, credits | `public/theme.json` |
| Look and feel | `public/style.css` |
| Card art | `public/art/` (set `art: '/art/file.png'` on a card) |

## Testing

`npm test` runs a full 4-bot game and checks the core rules: the King goes first, the King's
play count, hand top-ups, and gold limits. `node test/bot.js CODE Name` adds an auto-playing
bot to a room, which is handy for trying things solo.
