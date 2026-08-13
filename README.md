# Speed-Yacht — Server (Phase 1–3)

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

## v1.9 — real visual polish pass

Direct response to feedback that the server client's UI had drifted
too far from the proven, tested single-device design — not another
small patch, an actual port of specific proven details:

- **Scoresheet**: rebuilt from loose gapped rows into one continuous
  bordered card with thin row dividers, a darker header bar, fixed
  44px row height, and a visually heavier Total row — matching the
  proven ledger-style layout instead of the "floating pill" look it
  had.
- **OOPS/undo**: was a separate button sitting below Roll. In the
  proven design it morphs the SAME roll button (red-tinted, same slot)
  — ported that approach directly rather than the separate-element
  version.
- **Timer**: added the missing "running low" warning — the fill bar
  now turns red in the last 5 seconds, matching the proven timer's
  urgency cue. (The proven design's initial 3s fill-up buildup wasn't
  ported — it was tied to an intro sequence this architecture doesn't
  have an equivalent of.)
- **Waiting Room player list**: reported as not showing until a 2nd
  person joins. Tested this directly (single player joining alone,
  checked at 50ms and 550ms) and could not reproduce it — the player's
  own name showed up correctly and immediately both times. Given the
  live site was confirmed running old branding (pre-v1.5), this was
  most likely tested against a stale deploy rather than a bug in
  current code — flagging honestly rather than claiming a fix for
  something unverified. Worth re-testing once this version is
  actually live.

## v1.8 — join-mechanism fix + safety valve

Prompted by a real report: "Joining is locked" showing up when no game
had actually started.

- **Root cause**: a disconnected player's seat stayed reserved for the
  full 60s reconnect grace period regardless of whether a game was
  actually in progress. If people were just testing the Lobby/Edit
  screens and closed their tabs, the room stayed stuck outside the
  `lobby` phase — invisibly blocking new joins — for up to a minute
  after everyone had actually left. Worse, a connection that never
  cleanly fires `disconnect` (phone sleeps, flaky network) could leave
  a phantom seat blocking the room indefinitely.
- **Fix**: the grace period is now phase-aware.
  `LOBBY_RECONNECT_GRACE_MS` (5s default) applies before a game has
  started — there's nothing at stake yet, so no reason to make a new
  joiner wait. The full `RECONNECT_GRACE_MS` (60s) still applies once a
  game is actually in progress, where losing your seat costs real
  progress. Verified both paths independently, plus confirmed the
  original bug scenario (someone testing the Edit screen, tab closed,
  new person tries to join) now resolves in seconds instead of a
  minute.
- **Safety valve**: added a PIN-gated "Reset Room" option on the Lobby
  screen, reachable without needing to join first (since the whole
  point is recovering from a room you can't normally join into).
  Immediately wipes state back to a fresh lobby regardless of current
  phase.

⚠️ **Known incomplete work included in this build**: drag-to-reorder
dice was mid-implementation when the join-mechanism bug report came
in. The core swap logic works (verified no dice get lost/duplicated,
and tap-to-hold correctly follows the right die after reordering), but
two issues are still open and NOT yet fixed: a `setPointerCapture`
error during drag, and a drag gesture not always reaching the exact
intended slot. Don't rely on it working smoothly yet.

## v1.7 — 3D dice tumble animation

- Dice are real 3D CSS cubes now (6 faces, `preserve-3d`/`rotateX`/
  `rotateY`), ported directly from the original single-device
  prototype's proven implementation rather than rebuilt from scratch.
- Tapping Roll plays a fixed 750ms tumble (`ROLL_ANIM_MS`, matching the
  original) — but since dice values now come from the server, not
  locally, the reveal is gated on BOTH the animation timer finishing
  AND the server's response actually arriving, whichever comes later.
  Never shows spinning without a real roll in flight, never shows
  stale/guessed values.
- Held dice correctly don't spin when the other dice re-roll.
- Scoped to the player's own dice only this pass — the client doesn't
  currently show opponents' live dice at all (only their scores), so
  animating rolls you can't see wasn't in scope here. Worth a look as
  its own feature if a "watch everyone roll" view is wanted later.

## v1.6 — feel/look improvements

- **Round-summary pause**: instead of jumping straight to the next
  round, there's now a brief pause (`ROUND_SUMMARY_MS`, 5s by default)
  showing what everyone took that round, including a "63 BONUS!" badge
  for anyone who crossed the upper-section threshold on that specific
  round's pick.
- **OOPS/undo**: tapping a category can be undone right up until the
  round ends — reverses the score (and the Yahtzee bonus, if that pick
  triggered one) without touching dice, held state, or rolls used, so
  you land right back where you were and can pick something else with
  the same roll. Once the round moves to the summary pause, the window
  closes — matches "disappears at the end of the timer."
- **Yahtzee Bonus row**: now shown as its own line on the scoresheet
  between the Yahtzee category and the Total, instead of only being
  folded invisibly into the total.
- Deliberately NOT done this pass: the 3D dice tumble animation and
  drag-to-reorder dice. Each was a substantial standalone effort in the
  original single-device build and is being picked up in a follow-up
  rather than rushed alongside everything else here.

## v1.5 fixes

- Rebranded from "Roatan Yahtzee" to "Speed-Yacht" throughout — page
  title, header (with the die icon replacing the old spade), and the
  iOS/Android home-screen name.
- Edit screen was missing 3 of the 5 original scoring settings (Upper
  63 Bonus, 1st Yahtzee Score, Yahtzee Bonus) — only Rolls/Round
  Advance/bots made it into the server build. Added the missing three,
  plus the Edit form now correctly populates from real server state
  (matters on reconnect and "Start Another Game") instead of always
  showing stale HTML defaults.
- "Waiting" now renders in white on the Accept screen; "Accepted"
  stays gold — previously both used the same gold color.
- Description moved from "any player can add one after the game ends"
  to "host enters it on the Edit screen before the game starts" — it
  flows automatically into the Game Log entry when the game ends, then
  resets to blank for the next game.
- Game Log admin PIN is now verified with a real round-trip to the
  server *before* delete/edit controls appear, instead of only
  discovering the PIN was wrong when an actual delete was attempted.
- Admin mode on the Game Log screen can now edit an entry's
  description after the fact, not just delete entries.
- Delete now requires confirming first — no more one-tap accidental
  removal.

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
- `node test_description_flow.js` — verifies the host-entered
  description at Edit time flows through to the Game Log entry and
  resets cleanly for the next game.
- `node test_oops_summary.js` — OOPS/undo (including that it correctly
  leaves dice/held/rolls-used untouched, and that the window closes
  once the round ends), and the round-summary "63 bonus this round"
  flag verified against independently-computed ground truth.

All of the above set `ROUND_SUMMARY_MS` and `RECONNECT_GRACE_MS` to
short values via env vars when spawning the test server — production
defaults (5s and 60s) are far too slow to sit through repeatedly.

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

