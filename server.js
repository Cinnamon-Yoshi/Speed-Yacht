// Roatan Yahtzee — multiplayer server
// Phase 1: Lobby + Waiting Room only. Game state stays in memory for the
// life of the process (same tradeoff poker already runs on) — no
// database, no persistent disk, resets on redeploy/restart/spin-down.
// See project memory for why that's an intentional, accepted choice.

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;

app.use(express.static(path.join(__dirname, 'public'), {
  // Mirrors the poker app's own fix for a real bug we hit there: some
  // browsers/CDNs cache index.html aggressively even across hard
  // refreshes, which serves stale HTML after a deploy.
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// ── In-memory game/room state ──────────────────────────────────────
// Single shared room — one game night at a time, matching poker's model.
// Reset to this shape whenever the last player leaves, so a fresh game
// night always starts clean.
function freshState() {
  return {
    players: [],       // [{ id, name }] — order = join order; players[0] is host
    phase: 'lobby',     // 'lobby' | 'editing' | 'accepting' | 'playing'
    settings: {
      rollsPerTurn: 5,
      roundAdvance: 'Full-30',
      upperBonus: 35,
      firstYahtzee: 50,
      yahtzeeBonus: 100,
      fillWithBots: true
    },
    accepted: {}         // { [playerId]: true }
  };
}
let state = freshState();

function hostId() {
  return state.players[0] ? state.players[0].id : null;
}
function isHost(socketId) {
  return socketId === hostId();
}
function publicState() {
  // What every client receives — never send anything socket-internal.
  return {
    players: state.players.map(p => ({ id: p.id, name: p.name })),
    hostId: hostId(),
    phase: state.phase,
    settings: state.settings,
    accepted: state.accepted
  };
}
function broadcastState() {
  io.emit('state_update', publicState());
}

io.on('connection', (socket) => {

  socket.on('join_lobby', (name) => {
    name = (name || '').toString().trim().slice(0, 20);
    if (!name) {
      socket.emit('join_error', 'Enter a name first.');
      return;
    }
    if (state.phase !== 'lobby') {
      socket.emit('join_error', 'Joining is locked — the host has already started setting up this game.');
      return;
    }
    if (state.players.length >= MAX_PLAYERS) {
      socket.emit('join_error', 'This game already has 4 players.');
      return;
    }
    if (state.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      socket.emit('join_error', 'That name is already taken this game.');
      return;
    }

    state.players.push({ id: socket.id, name });
    socket.emit('joined', { id: socket.id, isHost: isHost(socket.id) });
    broadcastState();
  });

  // Host taps Admin → moves everyone from Lobby/Waiting Room into the
  // live-edit phase. Locks joining, per the confirmed flow.
  socket.on('host_start_editing', () => {
    if (!isHost(socket.id)) return;
    if (state.players.length < 1) return;
    state.phase = 'editing';
    broadcastState();
  });

  // Host changes a setting while editing — broadcasts live so every
  // player's Waiting Room mirrors it in real time.
  socket.on('host_update_settings', (partialSettings) => {
    if (!isHost(socket.id)) return;
    if (state.phase !== 'editing') return;
    const allowed = ['rollsPerTurn', 'roundAdvance', 'upperBonus', 'firstYahtzee', 'yahtzeeBonus', 'fillWithBots'];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(partialSettings, key)) {
        state.settings[key] = partialSettings[key];
      }
    }
    broadcastState();
  });

  // Host confirms → everyone moves to the Accept screen.
  socket.on('host_confirm_settings', () => {
    if (!isHost(socket.id)) return;
    if (state.phase !== 'editing') return;
    state.phase = 'accepting';
    state.accepted = {};
    // Host is auto-accepted — they just confirmed the settings themselves.
    state.accepted[socket.id] = true;
    broadcastState();
  });

  socket.on('player_accept', () => {
    if (state.phase !== 'accepting') return;
    if (!state.players.some(p => p.id === socket.id)) return;
    state.accepted[socket.id] = true;
    broadcastState();
    const allAccepted = state.players.length > 0 &&
      state.players.every(p => state.accepted[p.id]);
    if (allAccepted) {
      state.phase = 'playing';
      broadcastState();
    }
  });

  // Host jumps back to editing from the Accept screen — resets everyone's
  // accepted status, per the confirmed flow.
  socket.on('host_edit_again', () => {
    if (!isHost(socket.id)) return;
    if (state.phase !== 'accepting') return;
    state.phase = 'editing';
    state.accepted = {};
    broadcastState();
  });

  socket.on('disconnect', () => {
    const wasPlayer = state.players.some(p => p.id === socket.id);
    state.players = state.players.filter(p => p.id !== socket.id);
    delete state.accepted[socket.id];

    if (state.players.length === 0) {
      // Last one out — reset for the next game night.
      state = freshState();
    } else if (wasPlayer) {
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Roatan Yahtzee server listening on port ${PORT}`);
});
