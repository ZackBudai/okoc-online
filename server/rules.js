'use strict';

/*
 * End-of-game scoring. Receives [{ id, name, gold }] and the King's id.
 * Must return the players sorted best-first, each with { rank, winner }.
 *
 * Rule: whoever is the King after the final round wins.
 * Everyone else is ranked by gold for bragging rights.
 */
function scoreGame(players, kingId) {
  const king = players.find((p) => p.id === kingId);
  const rest = players.filter((p) => p.id !== kingId).sort((a, b) => b.gold - a.gold);
  const ordered = king ? [king, ...rest] : rest;
  return ordered.map((p, i) => ({ ...p, rank: i + 1, winner: p.id === kingId, wasKing: p.id === kingId }));
}

module.exports = { scoreGame };
