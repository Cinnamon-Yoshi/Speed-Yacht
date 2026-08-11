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
    players: state.players.map(p => ({ id: p.id, name: p.name, connected: p.connected })),
    hostId: hostId(),
    phase: state.phase,
    settings: state.settings,
    accepted: state.accepted
  };
}
function broadcastState() {
  io.emit('state_update', publicState());
}

// How long a disconnected player's seat stays reserved before it's
// actually freed up — long enough to survive a locked phone screen or a
// brief wifi drop, short enough that someone who's truly gone doesn't
// block the room forever.
const RECONNECT_GRACE_MS = 60000;

function removePlayer(playerId) {
  state.players = state.players.filter(p => p.id !== playerId);
  delete state.accepted[playerId];
  if (state.players.length === 0) {
    state = freshState();
  } else {
    broadcastState();
  }
}

io.on('connection', (socket) => {

  socket.on('join_lobby', (name) => {
    name = (name || '').toString().trim().slice(0, 20);
    if (!name) {
      socket.emit('join_error', 'Enter a name first.');
      return;
    }

    // Reconnect path: if this name already belongs to a player in the
    // game, treat this as the SAME player reconnecting (dropped wifi,
    // locked screen, backgrounded tab — all normal on real phones), not
    // a new join attempt. This works regardless of phase — a player who
    // already joined should never get locked out by their own
    // connection hiccup, even mid-game. Re-point their existing seat at
    // the new socket id instead of rejecting them.
    const existing = state.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      const oldSocketStillConnected = existing.connected && io.sockets.sockets.has(existing.id) && existing.id !== socket.id;
      if (oldSocketStillConnected) {
        // The name is genuinely in use by someone still connected right
        // now — this is a naming conflict, not a reconnect. Don't let a
        // second person quietly take over an active player's seat.
        socket.emit('join_error', 'That name is already taken this game.');
        return;
      }
      // Either this IS that socket, or the old one dropped and we're
      // inside (or just past) the grace period — safe to treat as the
      // same player reconnecting. Cancel any pending seat-removal timer.
      if (existing.disconnectTimer) {
        clearTimeout(existing.disconnectTimer);
        existing.disconnectTimer = null;
      }
      const wasHost = isHost(existing.id);
      const hadAccepted = !!state.accepted[existing.id];
      if (existing.id !== socket.id) {
        delete state.accepted[existing.id];
        existing.id = socket.id;
        if (hadAccepted) state.accepted[socket.id] = true;
      }
      existing.connected = true;
      socket.emit('joined', { id: socket.id, isHost: wasHost });
      broadcastState();
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

    state.players.push({ id: socket.id, name, connected: true, disconnectTimer: null });
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
    const player = state.players.find(p => p.id === socket.id);
    if (!player) return; // socket never actually joined (e.g. left on the Lobby screen)

    // Don't remove the seat immediately — mark it disconnected and give
    // it a grace period to reconnect (locked phone screen, backgrounded
    // tab, brief wifi drop are all completely normal and shouldn't cost
    // someone their spot mid-game). Only actually free the seat if they
    // haven't come back by the time the grace period runs out.
    player.connected = false;
    broadcastState();
    player.disconnectTimer = setTimeout(() => {
      // Re-check they're still the same disconnected entry before
      // removing — if they reconnected in the meantime, join_lobby
      // already cleared this timer and this callback is stale.
      const stillThere = state.players.find(p => p.id === socket.id && !p.connected);
      if (stillThere) removePlayer(socket.id);
    }, RECONNECT_GRACE_MS);
  });
});

server.listen(PORT, () => {
  console.log(`Roatan Yahtzee server listening on port ${PORT}`);
});
