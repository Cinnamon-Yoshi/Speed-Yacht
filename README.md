# Roatan Yahtzee — Server (Phase 1)

Real-time multiplayer backend, mirroring the same stack and deployment
pattern as Roatan Poker Club: Node.js + Express + Socket.io, deployed to
its own Render web service on the free tier.

## What's built (Phase 1)

- Lobby → Waiting Room → Edit → Accept flow, fully working over real
  Socket.io connections (not simulated locally).
- First player to join becomes host.
- Host taps Admin to start editing — joining locks at that moment.
- Host's setting changes broadcast live to everyone still in the
  Waiting Room, in real time.
- Host confirms → everyone moves to the Accept screen; host is
  auto-accepted. Game starts once every player has tapped Accept.
- Host can jump back to editing from the Accept screen — this resets
  everyone's Accepted status, so the group re-confirms the changed
  settings.
- Room resets to a clean slate once every player has disconnected.

All state lives in server memory only, on purpose (see project memory
for why) — it resets on redeploy/restart/spin-down, same tradeoff
poker's Stats screen already runs on. No persistent disk, no database,
no ongoing cost beyond Render's free tier.

## Not built yet

- Actual gameplay (dice, holds, scoring) — currently a placeholder
  screen once everyone accepts. This is Phase 3.
- Game Log (Phase 4), winner photo capture (Phase 5), bots-fill-empty-
  seats wiring (Phase 6).

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
