// Roatan Yahtzee — multiplayer server
// Phase 1: Lobby + Waiting Room only. Game state stays in memory for the
// life of the process (same tradeoff poker already runs on) — no
// database, no persistent disk, resets on redeploy/restart/spin-down.
// See project memory for why that's an intentional, accepted choice.

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { CATEGORIES, scoreFor, isYahtzeeRoll, grandTotal } = require('./scoring');

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

// Same PIN-gated admin model poker already uses ("🔒 Host PIN Required").
// Host is no longer "whoever happened to join first" — the actual host
// (running game night) might join 2nd, 3rd, or 4th. Anyone who joins can
// tap Admin and enter this PIN to become/reclaim host.
const HOST_PIN = '8888';
const TOTAL_ROUNDS = 13;

function freshState() {
  return {
    players: [],       // [{ id, name }]
    hostId: null,        // set only once someone enters the correct PIN
    phase: 'lobby',     // 'lobby' | 'editing' | 'accepting' | 'playing'
    settings: {
      rollsPerTurn: 5,
      roundAdvance: 'Full-30',
      upperBonus: 35,
      firstYahtzee: 50,
      yahtzeeBonus: 100,
      fillWithBots: true
    },
    accepted: {},        // { [playerId]: true }
    game: null            // set once phase becomes 'playing' — see startGame()
  };
}
let state = freshState();

function isHost(socketId) {
  return socketId !== null && socketId === state.hostId;
}
function publicState() {
  // What every client receives — never send anything socket-internal.
  // gameLog is deliberately NOT included here — see broadcastGameLog()
  // below for why.
  return {
    players: state.players.map(p => ({ id: p.id, name: p.name, connected: p.connected })),
    hostId: state.hostId,
    phase: state.phase,
    settings: state.settings,
    accepted: state.accepted,
    game: state.game ? {
      round: state.game.round,
      totalRounds: TOTAL_ROUNDS,
      roundEndsAt: state.game.roundEndsAt,
      gameOver: state.game.gameOver,
      players: Object.fromEntries(
        Object.entries(state.game.players).map(([pid, pg]) => [pid, {
          dice: pg.dice,
          held: pg.held,
          rollsUsed: pg.rollsUsed,
          scores: pg.scores,
          yahtzeeBonusCount: pg.yahtzeeBonusCount,
          doneThisRound: pg.doneThisRound,
          total: grandTotal(pg.scores, pg.yahtzeeBonusCount, state.settings)
        }])
      )
    } : null
  };
}
function broadcastState() {
  io.emit('state_update', publicState());
}

// How long a disconnected player's seat stays reserved before it's
// actually freed up — long enough to survive a locked phone screen or a
// brief wifi drop, short enough that someone who's truly gone doesn't
// block the room forever.
const RECONNECT_GRACE_MS = parseInt(process.env.RECONNECT_GRACE_MS, 10) || 60000;

function removePlayer(playerId) {
  state.players = state.players.filter(p => p.id !== playerId);
  delete state.accepted[playerId];
  if (state.hostId === playerId) state.hostId = null; // free up host for someone else to claim
  if (state.game && state.game.players[playerId]) delete state.game.players[playerId];
  if (state.players.length === 0) {
    state = freshState();
  } else {
    broadcastState();
  }
}

// ── Gameplay engine ──────────────────────────────────────────────────
let roundTimer = null;

function freshPlayerGameState() {
  return {
    dice: [1, 1, 1, 1, 1],
    held: [false, false, false, false, false],
    rollsUsed: 0,
    scores: {},
    yahtzeeBonusCount: 0,
    doneThisRound: false
  };
}

function startGame() {
  state.game = {
    round: 1,
    gameOver: false,
    roundEndsAt: null,
    players: Object.fromEntries(state.players.map(p => [p.id, freshPlayerGameState()]))
  };
  startRound();
}

function startRound() {
  if (roundTimer) { clearTimeout(roundTimer); roundTimer = null; }
  for (const pg of Object.values(state.game.players)) {
    pg.dice = [1, 1, 1, 1, 1];
    pg.held = [false, false, false, false, false];
    pg.rollsUsed = 0;
    pg.doneThisRound = false;
  }
  if (state.settings.roundAdvance === 'Full-30') {
    state.game.roundEndsAt = Date.now() + 30000;
    roundTimer = setTimeout(() => advanceRound(), 30000);
  } else {
    state.game.roundEndsAt = null;
  }
  broadcastState();
}

function allPlayersDone() {
  const ids = state.players.map(p => p.id);
  return ids.length > 0 && ids.every(id => state.game.players[id] && state.game.players[id].doneThisRound);
}

function advanceRound() {
  if (roundTimer) { clearTimeout(roundTimer); roundTimer = null; }
  if (!state.game || state.game.gameOver) return;
  if (state.game.round >= TOTAL_ROUNDS) {
    state.game.gameOver = true;
    state.game.roundEndsAt = null;
    recordGameLogEntry();
    broadcastState();
    return;
  }
  state.game.round++;
  startRound();
}

// ── Game Log ──────────────────────────────────────────────────────
// Lives outside `state` on purpose — it should survive a room reset
// (new game night, everyone left and came back) for as long as this
// server process itself is alive. Per the accepted persistence
// decision, it does NOT survive a redeploy/restart/spin-down — no
// disk, no database, same tradeoff poker's Stats already runs on.
let gameLog = [];
let nextGameLogId = 1;

// A SEPARATE broadcast channel from broadcastState()/publicState() on
// purpose. gameLog can hold several base64 photo images across past
// games, and broadcastState() fires on every single roll/hold/score
// during active play — bundling the whole log into every one of those
// would mean re-sending potentially-large image data dozens of times a
// round for no reason. This only fires when the log itself changes.
function broadcastGameLog() {
  io.emit('game_log_update', gameLog);
}

function recordGameLogEntry() {
  const ranked = state.players
    .map(p => ({ name: p.name, total: state.game.players[p.id] ? grandTotal(state.game.players[p.id].scores, state.game.players[p.id].yahtzeeBonusCount, state.settings) : 0 }))
    .sort((a, b) => b.total - a.total);
  gameLog.unshift({
    id: nextGameLogId++,
    timestamp: Date.now(),
    description: '',
    photo: null, // data URL, set later by the winner if they choose to
    settings: {
      rollsPerTurn: state.settings.rollsPerTurn,
      upperBonus: state.settings.upperBonus,
      firstYahtzee: state.settings.firstYahtzee,
      yahtzeeBonus: state.settings.yahtzeeBonus
    },
    players: ranked // already ranked winner-first
  });
  broadcastGameLog();
}

function maybeAdvanceWhenReady() {
  // "When-Ready" mode advances the instant everyone's done, instead of
  // waiting on a fixed timer — that's the entire distinction between the
  // two modes. "Full-30" always waits out the full 30s regardless of
  // whether everyone finished early, on purpose.
  if (state.settings.roundAdvance === 'When-Ready' && allPlayersDone()) {
    advanceRound();
  }
}

io.on('connection', (socket) => {
  // Send the current log immediately — broadcastGameLog() only fires on
  // future changes, so a socket connecting now would otherwise never
  // see any of the games already logged before it connected.
  socket.emit('game_log_update', gameLog);

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
        if (wasHost) state.hostId = socket.id; // keep host pointed at the same person, not their stale old socket
        if (state.game && state.game.players[existing.id]) {
          state.game.players[socket.id] = state.game.players[existing.id];
          delete state.game.players[existing.id];
        }
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
    socket.emit('joined', { id: socket.id, isHost: false });
    broadcastState();
  });

  // Anyone who's joined can tap Admin and enter the PIN — this is what
  // actually grants host powers now, not join order. Works at any point
  // before gameplay starts, so if the wrong PIN got tried, or the actual
  // host joined 3rd instead of 1st, or the current host's phone died and
  // someone else needs to take over, any correct-PIN entry re-points
  // host at whoever just entered it.
  socket.on('claim_host', (pin) => {
    const player = state.players.find(p => p.id === socket.id);
    if (!player) return; // must have joined first
    if (state.phase === 'playing') {
      socket.emit('host_claim_result', { success: false, message: 'Game already in progress.' });
      return;
    }
    if (pin !== HOST_PIN) {
      socket.emit('host_claim_result', { success: false, message: 'Incorrect PIN.' });
      return;
    }
    state.hostId = socket.id;
    // Claiming host from the lobby also kicks off editing in the same
    // step — matches the original single-tap flow, just PIN-gated now.
    // If host is being reclaimed mid-edit/mid-accept (e.g. the original
    // host's phone died), leave the phase where it is — don't throw
    // away progress just because host changed hands.
    if (state.phase === 'lobby') state.phase = 'editing';
    socket.emit('host_claim_result', { success: true });
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
      startGame();
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

  // Host starts another game with the same group once the current one's
  // over — keeps everyone's seat (no need to rejoin), jumps straight to
  // editing so the group can re-confirm/adjust settings and Accept
  // again, same flow as starting the very first game. gameLog itself is
  // untouched — it lives outside `state` specifically so this doesn't
  // clear it.
  socket.on('new_game', () => {
    if (!isHost(socket.id)) return;
    if (!state.game || !state.game.gameOver) return;
    state.game = null;
    state.phase = 'editing';
    state.accepted = {};
    broadcastState();
  });

  // ── Gameplay ──────────────────────────────────────────────────────
  socket.on('roll_dice', () => {
    if (state.phase !== 'playing' || !state.game || state.game.gameOver) return;
    const pg = state.game.players[socket.id];
    if (!pg || pg.doneThisRound) return;
    if (pg.rollsUsed >= state.settings.rollsPerTurn) return;
    for (let i = 0; i < 5; i++) {
      if (!pg.held[i]) pg.dice[i] = 1 + Math.floor(Math.random() * 6);
    }
    pg.rollsUsed++;
    broadcastState();
  });

  socket.on('toggle_hold', (dieIndex) => {
    if (state.phase !== 'playing' || !state.game || state.game.gameOver) return;
    const pg = state.game.players[socket.id];
    if (!pg || pg.doneThisRound) return;
    if (!Number.isInteger(dieIndex) || dieIndex < 0 || dieIndex > 4) return;
    if (pg.rollsUsed === 0) return; // nothing to hold before the first roll
    pg.held[dieIndex] = !pg.held[dieIndex];
    broadcastState();
  });

  socket.on('pick_category', (key) => {
    if (state.phase !== 'playing' || !state.game || state.game.gameOver) return;
    const pg = state.game.players[socket.id];
    if (!pg || pg.doneThisRound) return;
    if (!CATEGORIES.includes(key)) return;
    if (Object.prototype.hasOwnProperty.call(pg.scores, key)) return; // already scored
    if (pg.rollsUsed === 0) return; // must roll at least once first

    // Yahtzee bonus: this roll IS a Yahtzee, and they've already banked
    // their first Yahtzee (a positive score already sitting in that
    // category) — award the bonus regardless of which category this
    // particular roll ultimately gets scored into.
    if (isYahtzeeRoll(pg.dice) && pg.scores.yahtzee > 0) {
      pg.yahtzeeBonusCount = (pg.yahtzeeBonusCount || 0) + 1;
    }

    pg.scores[key] = scoreFor(key, pg.dice, state.settings);
    pg.doneThisRound = true;
    broadcastState();
    maybeAdvanceWhenReady();
  });

  // ── Game Log ────────────────────────────────────────────────────
  // Description: anyone can add one, but only to the game that JUST
  // ended for this room (matches "host can enter a description" intent
  // loosely — kept simple/permissive since this is a private friend
  // group, not gated by host specifically).
  socket.on('set_game_log_description', ({ id, text }) => {
    const entry = gameLog.find(e => e.id === id);
    if (!entry) return;
    entry.description = (text || '').toString().slice(0, 200);
    broadcastGameLog();
  });

  // Winner photo: only lets the submitter attach it to an entry where
  // they're actually the recorded winner (rank 0) — prevents anyone
  // else's photo ending up on someone else's win.
  // Winner photo: identity is derived from the submitting socket's own
  // player record, never from a client-claimed name — otherwise anyone
  // could just say `name: <the winner>` and attach whatever they want to
  // someone else's win, regardless of who they actually are.
  socket.on('set_winner_photo', ({ id, photo }) => {
    const entry = gameLog.find(e => e.id === id);
    if (!entry) return;
    const player = state.players.find(p => p.id === socket.id);
    if (!player) return;
    if (!entry.players.length || entry.players[0].name !== player.name) return;
    if (typeof photo !== 'string' || !photo.startsWith('data:image/')) return;
    if (photo.length > 300000) return; // ~200KB decoded — plenty for a deliberately low-res capture, guards against a misbehaving client sending something huge
    entry.photo = photo;
    broadcastGameLog();
  });

  socket.on('delete_game_log_entry', ({ id, pin }) => {
    if (pin !== HOST_PIN) {
      socket.emit('game_log_delete_result', { success: false, message: 'Incorrect PIN.' });
      return;
    }
    gameLog = gameLog.filter(e => e.id !== id);
    socket.emit('game_log_delete_result', { success: true });
    broadcastGameLog();
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
