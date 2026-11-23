'use strict';

// Defaults follow the print-and-play rules guide. The host can change anything in `schema` from the lobby.
const defaults = {
  rounds: 4,
  kingStartingGold: 1000,
  nobleStartingGold: 600,
  maxGold: 2000,              // gold is limited to 0..maxGold
  handSize: 8,                // dealt at start; hands are kept topped up to this
  kingPlays: 3,               // King plays this many, then draws back up
  kingPlaysFewNobles: 2,      // ...or this many when there are only 3 (or fewer) Nobles
  noblePlays: 2,
  mustPlayAll: true,          // can't end your turn early while you still have a playable card
  negotiationTime: 120,       // seconds; 0 = skip
  negotiationReceiveCap: 400, // max gold one player may RECEIVE per negotiation phase (0 = no cap)
  negotiationSkipVote: 'majority', // 'majority' | 'all' | 'off' — votes needed to skip the rest of negotiation
  turnTime: 90,
  promptTime: 30,
  reactionTime: 8,            // 0 disables reaction windows
  autoCrown: true,            // a Noble with more gold than the King takes the crown
  alternateDirection: true,
  leaderSelection: 'deal',    // 'deal' (random, like dealing character cards) | 'host'
  skipDisconnected: true,
  minPlayers: 4,
  maxPlayers: 8,
};

const schema = [
  { key: 'rounds', label: 'Rounds', type: 'number', min: 1, max: 12, step: 1 },
  { key: 'kingStartingGold', label: 'King starting gold', type: 'number', min: 0, max: 2000, step: 100 },
  { key: 'nobleStartingGold', label: 'Noble starting gold', type: 'number', min: 0, max: 2000, step: 100 },
  { key: 'maxGold', label: 'Gold limit', type: 'number', min: 100, max: 100000, step: 100 },
  { key: 'handSize', label: 'Hand size (kept topped up)', type: 'number', min: 1, max: 15, step: 1 },
  { key: 'kingPlays', label: 'King plays per turn', type: 'number', min: 1, max: 6, step: 1 },
  { key: 'kingPlaysFewNobles', label: 'King plays (3 or fewer Nobles)', type: 'number', min: 1, max: 6, step: 1 },
  { key: 'noblePlays', label: 'Noble plays per turn', type: 'number', min: 1, max: 6, step: 1 },
  { key: 'mustPlayAll', label: 'Must use all plays if able', type: 'bool' },
  { key: 'negotiationTime', label: 'Negotiation timer (s, 0 = skip)', type: 'number', min: 0, max: 900, step: 5 },
  { key: 'negotiationReceiveCap', label: 'Max gold received per negotiation (0 = none)', type: 'number', min: 0, max: 5000, step: 100 },
  { key: 'turnTime', label: 'Turn timer (s)', type: 'number', min: 15, max: 600, step: 5 },
  { key: 'promptTime', label: 'Choice/vote timer (s)', type: 'number', min: 5, max: 180, step: 5 },
  { key: 'reactionTime', label: 'Reaction window (s, 0 = off)', type: 'number', min: 0, max: 30, step: 1 },
  { key: 'autoCrown', label: 'Richer Noble takes the crown', type: 'bool' },
  { key: 'alternateDirection', label: 'Alternate turn direction each round', type: 'bool' },
  { key: 'skipDisconnected', label: 'Auto-skip disconnected players', type: 'bool' },
  { key: 'minPlayers', label: 'Minimum players', type: 'number', min: 2, max: 8, step: 1 },
  {
    key: 'negotiationSkipVote', label: 'Vote to skip negotiation', type: 'select',
    options: [['majority', 'Majority of players'], ['all', 'Everyone'], ['off', 'Off']],
  },
  {
    key: 'leaderSelection', label: 'First King chosen by', type: 'select',
    options: [['deal', 'Random deal'], ['host', 'Host picks']],
  },
];

function sanitizeSettings(current, input) {
  const out = { ...current };
  for (const f of schema) {
    if (!(f.key in input)) continue;
    const v = input[f.key];
    if (f.type === 'number') {
      let n = Math.round(Number(v));
      if (!Number.isFinite(n)) continue;
      out[f.key] = Math.min(f.max, Math.max(f.min, n));
    } else if (f.type === 'bool') {
      out[f.key] = !!v;
    } else if (f.type === 'select') {
      if (f.options.some(([val]) => val === v)) out[f.key] = v;
    }
  }
  return out;
}

module.exports = { defaults, schema, sanitizeSettings };
