'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Room, GameError } = require('./room');
const { schema } = require('./config');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/api/schema', (_req, res) => res.json(schema));

const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}

const reply = (cb, data) => { if (typeof cb === 'function') cb(data); };
const fail = (cb, e) => {
  if (!(e instanceof GameError)) console.error(e);
  reply(cb, { ok: false, error: e instanceof GameError ? e.message : 'Something went wrong' });
};

io.on('connection', (socket) => {
  const roomOf = () => rooms.get(socket.data.roomCode);

  socket.on('createRoom', ({ name } = {}, cb) => {
    try {
      const code = newCode();
      const room = new Room(code, io, (c) => rooms.delete(c));
      rooms.set(code, room);
      const p = room.addPlayer(name, socket);
      reply(cb, { ok: true, code, token: p.token });
    } catch (e) { fail(cb, e); }
  });

  socket.on('joinRoom', ({ code, name } = {}, cb) => {
    try {
      const room = rooms.get(String(code || '').toUpperCase().trim());
      if (!room) throw new GameError('Room not found');
      const p = room.addPlayer(name, socket);
      reply(cb, { ok: true, code: room.code, token: p.token });
    } catch (e) { fail(cb, e); }
  });

  socket.on('rejoin', ({ code, token } = {}, cb) => {
    try {
      const room = rooms.get(String(code || '').toUpperCase());
      if (!room) throw new GameError('Room no longer exists');
      room.rejoin(String(token || ''), socket);
      reply(cb, { ok: true, code: room.code });
    } catch (e) { fail(cb, e); }
  });

  socket.on('action', async ({ type, payload } = {}, cb) => {
    try {
      const room = roomOf();
      if (!room) throw new GameError('Not in a room');
      // playCard resolves only after the whole effect finishes; ack immediately instead
      const p = room.handleAction(socket.data.playerId, String(type), payload || {});
      if (type === 'playCard') {
        p.catch(() => {}); // effect errors are logged inside playCard
        // validation errors are thrown before the first await, so they surface here
        await Promise.race([p, new Promise((r) => setImmediate(r))]);
      } else {
        await p;
      }
      reply(cb, { ok: true });
    } catch (e) { fail(cb, e); }
  });

  socket.on('disconnect', () => { const room = roomOf(); if (room) room.handleDisconnect(socket); });
});

server.listen(PORT, () => console.log(`Game server running at http://localhost:${PORT}`));
module.exports = { rooms };
