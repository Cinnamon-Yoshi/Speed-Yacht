# Roatan Yahtzee — Server (Phase 1–3)

Real-time multiplayer backend, mirroring the same stack and deployment
pattern as Roatan Poker Club: Node.js + Express + Socket.io, deployed to
its own Render web service on the free tier.

## What's built

**Phase 1 — Lobby / Waiting Room / Edit / Accept**
- Full flow working over real Socket.io connections (not simulated
  locally).
- Host is PIN-gated, not join-order — anyone who's joined can tap the
  Admin button and enter the host PIN (`8888` by default, change it in
  server.js) to become host. Matches poker's own "🔒 Host PIN Required"
  pattern. Works even to reclaim host mid-setup if the original host's
  connection drops for good.
- Host taps Admin to start editing — joining locks at that moment.
- Host's setting changes broadcast live to everyone still in the
  Waiting Room, in real time.
- Host confirms → everyone moves to the Accept screen; host is
  auto-accepted. Game starts once every player has tapped Accept.
- Host can jump back to editing from the Accept screen — this resets
  everyone's Accepted status, so the group re-confirms the changed
  settings.
- A disconnected player's seat stays reserved for 60 seconds (locked
  phone screen, dropped wifi) before being freed up — reconnecting under
  the same name restores host role, Accepted status, and (once a game
  is underway) dice/scores/rolls-used, all automatically.
- Room resets to a clean slate once every player has disconnected.

**Phase 3 — real gameplay**
- Full 13-round Yahtzee, server-authoritative: the server rolls the
  dice and computes every score — clients only ever send "roll," "hold
  this die," or "score me in this category," never a value. See
  `scoring.js` for the scoring rules themselves (unit tested in
  `test_scoring.js`).
- Both round-advance modes: "Full-30" always runs the full 30-second
  timer regardless of who's finished; "When-Ready" advances the instant
  every player has scored, no fixed wait.
- Live scoreboard visible to everyone, with your own live preview of
  what each open category would score before you commit to it.
- Yahtzee bonus (extra points for a second-or-later Yahtzee once the
  first is already banked) implemented per standard rules.

**Phase 4 — Game Log, home-screen icon**
- A game is automatically logged the moment it ends — ranked scores,
  the 4 always-shown settings, timestamp. No action required for this
  part to happen.
- Winner can optionally attach a low-res selfie via the device camera;
  anyone can add a short description. Both are purely additive and
  never block the game from being logged.
- Game Log is browsable from the Lobby (before joining) or from the
  Results screen right after a game — matches Denver's approved
  stacked-card design (date/description → scores+settings side by side
  → photo, omitted entirely when absent, not shown as an empty box).
- Admin-PIN-gated delete, same PIN as claiming host.
- Sent as a *separate* broadcast channel from the main game state
  deliberately — bundling potentially-large photo data into every
  single roll/hold/score broadcast during active play would have been
  wasteful.
- **Security note**: the winner-photo handler originally trusted a
  client-submitted name to decide who's allowed to attach a photo —
  caught this letting a non-winner impersonate the winner during
  testing, fixed to derive identity from the actual connected socket.
- Custom home-screen icon for "Add to Home Screen" — real PNG files
  (iOS requires this; SVG only works for the browser-tab favicon) plus
  `manifest.json` and the iOS meta tags for a proper standalone launch.
- Added a "Start Another Game" button (host-only, appears once a game
  ends) — the same group can play again without needing to rejoin;
  previously there was no way to do this without restarting the server.

All state lives in server memory only, on purpose (see project memory
for why) — it resets on redeploy/restart/spin-down, same tradeoff
poker's Stats screen already runs on. No persistent disk, no database,
no ongoing cost beyond Render's free tier.

## Not built yet

- Bots-fill-empty-seats wiring (Phase 6 — the toggle exists in Game
  Info settings but doesn't do anything functional yet).
- "Save Image" (download the scoreboard+photo as one shareable image
  to your camera roll) — noted in project memory as wanted, not yet
  built.

## Testing

- `node test_scoring.js` — pure scoring-rule unit tests, no server
  needed.
- `node test_gameplay.js` — full integration tests against a real
  running server instance (rolling, holding, scoring, both round-advance
  modes, a complete 13-round game, reconnect mid-game). Both use plain
  Node.js + socket.io-client (`npm install` first) — no browser needed.
- `node test_gamelog.js` — Game Log recording, description, winner-photo
  identity verification (including the impersonation-attempt test),
  admin-PIN delete, multi-game accumulation, late-joining sync. Also
  plain Node.js, no browser needed.

## Deploying (mirrors poker's setup)

1. Create a **new GitHub repository** (separate from poker's).
2. Push everything in this folder except `node_modules/` (Render
   installs dependencies itself from `package.json`).
3. On Render: **New → Web Service**, connect the new repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Free tier is fine to start.
4. Render will assign its own `*.onrender.com` URL — completely
   separate from poker's, no shared code or process.

## Local testing

```
npm install
npm start
```
Then open `http://localhost:3000` in two browser tabs to see the
Lobby/Waiting Room sync between two "players."

