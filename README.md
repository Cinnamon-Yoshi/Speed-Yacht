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

## v1.33 — dice tumble fix, plus your two reconnection UX ideas

- **Dice sat static/dimmed during the buildup, then only briefly
  spun** — confirmed and fixed: the dimmed/static look was covering
  the entire pre-auto-roll waiting window, not just "finished this
  turn" like intended. Dice now tumble continuously from the moment a
  fresh round begins until the first roll actually resolves —
  matching what you remembered from earlier in the project — and the
  dimmed look is now reserved for a player who's genuinely done for
  the round. Verified directly: confirmed tumbling mid-buildup,
  correctly settling once the roll resolves.

- **Round Summary now shows live connection status, with host
  removal.** Each player's row shows "reconnecting…" in real time
  (looked up fresh each render, not a frozen snapshot — updates the
  instant someone actually reconnects while everyone's looking at this
  screen). The host gets a "Remove from game" action next to anyone
  currently disconnected — confirm, then a PIN prompt, then they're
  out. Tested end to end: wrong PIN rejected, correct PIN succeeds, a
  connected player can't be removed by mistake even if the button is
  somehow tapped, and — importantly — removing someone who was the
  only thing blocking a stuck When-Ready round correctly lets that
  round advance immediately afterward.

- **Lobby now shows disconnected players as tappable names to
  reconnect as.** Anyone landing on the entry screen sees a "were you
  just disconnected?" box listing anyone currently disconnected from
  the game in progress — tap a name instead of having to retype it
  exactly. Worth being upfront about the trade-off: this doesn't add
  any new risk beyond what already existed (anyone could always type
  any name to reconnect as them, since matching is by name only) — it
  just makes an existing capability easier to use, which fits a casual
  in-person game night. Along the way, found and fixed a real gap this
  depended on: the server never actually sent state to a socket that
  had connected but hadn't joined yet, meaning a brand-new visitor
  would have seen nothing until they typed a name themselves. Fixed by
  sending current state proactively on connection, matching the
  existing pattern used for the Game Log.

Full regression suite (6 files) re-run after all changes — all
passing.

## v1.32 — the real numbers finally add up

Your second log was the one that actually cracked this. It showed
reconnection working correctly — right up until you landed on the
Lobby screen with no further entries logged. That gap itself was the
clue: I had no logging on the "kicked out" branch at all, so I closed
that first (now logs exactly why the client thinks it's no longer in
the game, and logs `join_error` directly — the previous log couldn't
have shown a rejection even if one happened).

But working through the actual timestamps in that log turned up
something more concrete than another logging gap. Socket.io's default
server-side dead-connection detection takes about 45 seconds
(pingInterval 25s + pingTimeout 20s). The mid-game reconnect grace
period was 60 seconds *on top of that* — but the client's own
awareness of having disconnected is delayed by however long it was
actually backgrounded, since its JS is frozen the whole time. Working
through your log's real numbers: you were away about 2 minutes 25
seconds. The server would have noticed the dead connection around the
45s mark and started its 60s countdown from there — meaning your seat
was very likely removed a good 40 seconds *before* your phone even
got around to attempting a reconnect. Not a bug in the reconnect logic
itself — the logic was working, it just didn't have enough time left
to work with by the time it got a chance to run.

Increased the mid-game grace period from 60s to 5 minutes, and the
pre-game one from 30s to 90s, for the same reason. Verified with a
proportionally-scaled real test (a gap that would have failed under
the old window now succeeds under the new one, seat and all).

I want to be honest about confidence here: the math lines up cleanly
with everything in your log, and it's the first explanation that
actually accounts for the specific numbers rather than a general
theory. But I don't have a way to 100% confirm it without seeing it
hold up for you. If you get kicked out again after this, the new
`join_error` logging in particular should make it obvious right away
whether this was actually the cause or not.

Full regression suite (6 files) re-run after the change — all
passing, including the join-mechanism suite most relevant to the
grace-period change.

## v1.31 — the long-press was probably the problem, so it's gone

Asked again where to find the log, which is a fair sign the long-press
gesture from v1.30 wasn't actually working — long-press on mobile is
genuinely unreliable (the browser's native text-selection/copy menu
can intercept it, and small finger movement during the hold cancels it
via touchmove). Replaced it entirely with a small, plain "log" link
next to the version number — a direct tap, nothing held, no gesture to
get right. Verified it opens with a single click/tap on the Lobby
screen before even joining a game.

Full regression suite (6 files) re-run after the change — all
passing.

## v1.30 — the diagnostic log was actually inaccessible most of the time

Real gap in v1.29: the log-viewing gesture was only attached to the
"stuck? tap here" link, which is hidden by default and only shows up
while actively stuck. The moment it resolves (on its own, or via the
recover tap), the link disappears again — meaning there was no way to
actually go look at what happened afterward, which defeats the point.

Moved it to the version number in the header instead — that's visible
on every screen, at all times, whether or not anything is currently
stuck. Tap-and-hold it (long-press, ~0.7s) or right-click on desktop
to see the log. Verified directly: confirmed it's reachable even on
the plain Lobby screen before joining a game, not just mid-play.

Full regression suite (6 files) re-run after the change — all
passing.

## v1.29 — changed strategy: a manual escape hatch instead of another guess

Four attempts in a row at automatically detecting and fixing this
haven't held up on your actual phone, and I have no way to reproduce
the real failure in this environment. Continuing to ship guesses isn't
fair to you, so this version does something different: it doesn't try
to be clever about automatic detection at all.

A small "Dice stuck? Tap here to reconnect" link now appears on the
Playing screen on its own, checked by a plain always-running timer
that doesn't depend on any of the other reconnection logic actually
working — if a roll has been "in progress" for more than 3.5 seconds
(a real roll only ever takes ~750ms), it shows up. Tapping it does a
hard reset: fully disconnects and reconnects the socket, clears every
animation flag, and re-syncs from whatever the server currently says
is true. This doesn't depend on me having correctly guessed why it got
stuck — it just gets you unstuck.

Also added: a lightweight diagnostic trail. The last 40 key events
(connects, disconnects, reconnect attempts, every roll request, every
auto-roll schedule/fire, visibility changes) get timestamped and kept
in memory. Tap-and-hold (or right-click on desktop) the recover link
to see them. If this happens again, that log — even just read aloud or
photographed — would finally give me real data instead of another
blind guess.

I'm not claiming this fixes the underlying cause. I don't know what it
is yet. This is a safety net so a real game night isn't blocked by it
while I keep working on the actual root cause with better information.

Full regression suite (6 files) re-run after the change — all
passing.

## v1.28 — a real gap in my testing approach, and a new recovery path

Good news: the animation regression from v1.26 is confirmed fixed on
your end. The home-screen reconnection issue is not.

I need to flag something about my own testing here rather than just
describe another fix. Every recovery test I've run across the last
several versions used Chrome DevTools' page-lifecycle "frozen" state
to simulate backgrounding. Testing this specific fix, I discovered
that mechanism does NOT reliably trigger the browser's actual
`visibilitychange` event — the standard API real backgrounding is
supposed to fire. That means my testing tool has had a real blind
spot around exactly the scenario you keep hitting: everything I could
verify with it kept passing, while the real thing you're testing on
an actual phone kept failing. That's on me, and it explains why the
last two "fixes" didn't hold up.

What's new: a `visibilitychange` listener, independent of whatever
socket.io's own reconnection logic is doing. The moment the tab is
actually looked at again, it immediately clears any stuck roll
animation (a real roll only ever takes ~750ms — if one is still
"in progress" right as the page becomes visible again, it did not
survive the background period, full stop) and re-syncs from current
state, rather than waiting on retry timers that themselves depend on
JS timers that may not have fired reliably while backgrounded. I
verified the handler's own logic directly (by dispatching the event
manually, since CDP can't trigger it naturally) and confirmed it
correctly clears a stuck state immediately rather than waiting on the
old multi-second retry cycle.

I want to be direct: I cannot fully verify this against a true
backgrounding scenario in this environment, for the reason above. This
needs a real test on your actual device to know whether it holds.

Full regression suite (6 files) re-run after the change — all
passing.

## v1.27 — found the actual bug: I broke the roll button in v1.26

Your second detail — "dice roll animation was turned off (broken) on
all devices after the initial first auto roll" — was the one that
cracked this open. That's not a reconnection issue at all; it's a
plain regression I introduced in v1.26.

`rollBtn.onclick = requestRoll` passes the click event as
`requestRoll`'s first argument. v1.26 added a `retryCount` parameter
to that same function, defaulted with `retryCount = retryCount || 0`.
A click event is a truthy object, so every single manual roll click
was silently being read as a nonzero retry count — which skips the
entire block that sets `isRollingLocally = true` and actually shows
the spin. The dice still updated once the server responded (so it
"worked", technically), just with zero animation, for every roll after
the first auto-roll (which was the one call site that correctly passed
no arguments). That matches exactly what you saw.

It also very plausibly explains the still-stuck-spinning report: with
that bug in place, clicking the roll button while a roll was already
stuck (e.g. mid-reconnect) skipped the `if (isRollingLocally) return`
guard too — since that guard was inside the same now-skipped block —
letting a frustrated retry tap fire a second overlapping roll instead
of being safely ignored.

Fixed the actual bug (wrapped the click handler so the event is never
passed through) and hardened `requestRoll` itself against the same
class of mistake (strict type check instead of a truthy default, so
any future accidental event-as-argument can't silently misfire this
way again). Verified directly: polled `isRollingLocally` at 20ms
resolution through a real manual click and confirmed the spin now
genuinely fires, where before this exact test would have shown it
never becoming true at all.

I'm not walking back the v1.25/v1.26 reconnection-timing fixes — those
addressed real, separately-confirmed issues — but this was clearly the
dominant bug hiding underneath them the whole time.

Full regression suite (6 files) re-run after the fix — all passing.

## v1.26 — the watchdog itself was the bug

Your v1.25 report was the missing piece: "dice roll and then stop" —
not spinning forever, but landing frozen on dimmed all-1s dice with
nothing pickable. That's a different, more specific symptom than
before, and it pointed straight at the watchdog I'd added in v1.25 as
a safety net.

Confirmed by reading it back: the watchdog fired after 4 seconds and
force-set `isRollingLocally = false`, then re-rendered from whatever
state the client currently had — which, if the roll's actual response
never arrived (returning from the home screen right as a new round's
auto-roll fires being the most likely trigger), was still the
pre-roll data: dice at their default `[1,1,1,1,1]`, `rollsUsed` still
0. So instead of an endless spin, the "fix" produced a different dead
end — frozen dice, nothing to pick, roll button quietly re-enabled
but with no visual sign that trying again would do anything.

Rebuilt it properly: if the roll doesn't resolve normally within ~4s,
it now checks whether the connection is actually alive. If yes, it
retries the roll itself (up to 3 times) rather than giving up. If
no, it does nothing and leaves the spin state alone — reconnection
already resets things properly once it actually succeeds, so forcing
a "resolution" while still offline was exactly what was producing the
stale frozen dice. Verified directly: severed the connection mid-roll
and confirmed it now waits correctly through the disconnect (no more
premature stale render) and resolves with the real rolled dice values
the moment reconnection genuinely completes, typically within ~2
seconds.

Full regression suite (6 files) re-run after the change — all
passing.

## v1.25 — an honest non-fix: couldn't reproduce it, added a safety net instead

You confirmed v1.24, minimized (not closed) for ~25 seconds after
already picking your category, and came back to dice spinning forever
— unable to make a play.

I threw a lot at trying to reproduce this precisely, using Chrome's
real page-lifecycle "frozen" state (which genuinely throttles JS
timers and lets the server's keep-alive pings time out, unlike a
scripted `disconnect()` call): picking a category then freezing for
25s with a round transition happening underneath, freezing right at
the tail end of a round's timer specifically to try to force the
auto-roll feature to collide with a second round transition, disabling
the network mid-roll to try to strand the resolution logic — six
different constructions in total. Every one of them recovered
correctly. I don't have a confirmed root cause, and I want to be
upfront about that rather than claim I fixed something I can't
actually verify.

What I did add: a watchdog on the roll animation. If it's still
spinning more than a few seconds after being triggered — for
whatever reason, reconnect-related or not — it now force-resolves
using the latest known state rather than staying stuck indefinitely.
This doesn't explain what happened, but it makes sure it can't
strand a player's turn regardless of the cause. Also added a related
safety check: the auto-roll feature now skips itself entirely if a
round's timer is already down to its last few seconds when the client
catches up (most relevant right after a reconnect) — auto-rolling
into a round that's about to end anyway was a plausible contributor
worth closing off even without a confirmed reproduction.

If this happens again, the two most useful things to note are (1)
whether it was Full-30/Timer mode or When-Ready, and (2) whether it
resolves on its own after a few seconds now (watchdog working) or
stays stuck (the underlying cause is still there and needs more
digging).

Full regression suite (6 files) re-run after the change — all
passing.

## v1.24 — the actual gap behind "closing the app broke things"

Last session's reconnection fix (v1.22) covered a socket dropping and
reconnecting within the same page load — verified that works. But
"closing the app and rejoining" is a different, harder case: a
genuinely fresh page load, where every client-side variable resets.
Tested that exact scenario directly (close, reopen, manually retype
the name and rejoin) and it actually worked correctly too — the
server's name-matching reconnect logic doesn't care whether the
client remembered anything, since the player is re-announcing
themselves manually either way.

So where the real gap was: the **pre-game grace period** — the window
a disconnected player's seat stays reserved before the server gives up
and removes it — defaulted to 5 seconds. That's nowhere near enough
time for a real app close-and-reopen cycle (backgrounding, OS
app-switching, a fresh page load, a new WebSocket handshake). Confirmed
by direct reproduction: disconnect during setup, wait past 5 seconds
while the host proceeds with settings/accept, then try to rejoin —
seat's already gone, and since the game has moved past the 'lobby'
phase, the response is exactly "Joining is locked — the host has
already started setting up this game," matching the report precisely.

Increased the default to 30 seconds — genuine headroom for a real
reconnect, while still well short of the 60s window used once actual
gameplay is underway (nothing irreversible has happened pre-game, so
there's less urgency than mid-round). Verified directly: the same
reproduction scenario, now waiting a realistic amount of time, results
in a clean rejoin with the seat and phase both correctly preserved.

Full regression suite (6 files) re-run after the change — all passing,
including the join-mechanism suite most relevant here (which uses its
own short test-only override, unaffected by the new default).

## v1.23 — full-bleed layout redesign, no more black bars or wasted margins

- **Black background bars on shorter screens** — confirmed real:
  `.phone` only had natural, content-driven height on every screen
  except Playing, so a screen with little content (like Round Summary)
  left the dark body background (`#111`, near-black) showing through
  below it. Fixed by making the body itself match the app's green
  (`--bg`) and giving `.phone` `min-height: 100vh`, so there's no
  scenario where anything but green is visible. Verified directly: the
  Round Summary screen (the exact one in the screenshot) now fills the
  full viewport with green all the way down.
- **Wasted space on the sides, whole layout redesigned to be full-
  bleed.** The old structure double-padded everything — the body had
  its own outer padding, then a `max-width: 430px` wrap on top of
  that, then `.phone` had its own separate padding again — and capped
  the whole app at 430px regardless of actual device width. Removed
  the outer body padding and the wrap constraint entirely; `.phone`
  now spans the full viewport edge to edge, with only its own 16px
  padding keeping content (dice, header text, everything) inset from
  the true screen edge rather than floating in a black margin.
  Because die size is already computed dynamically from available
  width (from a previous session), this alone made dice measurably
  larger without any hardcoded size change — verified directly: on a
  390px-wide viewport, removing the old double-padding gained 20px of
  real usable width, and the die-size formula correctly picked that up
  (50px → 53px). Also adjusted the Playing screen's fixed-height calc,
  which had assumed 32px of now-removed outer padding.
- **Roll button's gap to die 1** — the button's border sits right at
  its edge, so a couple of extra px of margin were added there
  specifically, and the width-budgeting math was updated so this
  doesn't reintroduce any overflow.
- **Header text touching the edges** — verified directly with the new
  layout: the header now sits inset exactly 16px from both the left
  and right true screen edges, matching the padding everywhere else,
  not running off.
- Verified the full combination with real browser measurements (not
  just visual inspection): body background color, phone height vs.
  viewport height, die size, last-die position vs. phone edge, header
  left/right position, and body scrollWidth vs. clientWidth (still
  zero overflow with the larger dice) — plus real screenshots of both
  the Playing screen and the Round Summary screen for direct visual
  confirmation.

Full regression suite (6 files) re-run after all changes — all
passing.

## v1.22 — a real, serious reconnection bug, plus three smaller fixes

- **Reconnection bug — the important one.** Reported symptom: during a
  timer game, a player who got disconnected (minimized the app,
  backgrounded the tab) and came back would find their dice frozen
  mid-spin forever, unable to make a selection, and eventually got
  kicked to the lobby with "game is still running" blocking them from
  rejoining. Root cause, confirmed by reading the actual reconnection
  path end to end: the server's `join_lobby` handler has real,
  correct logic to re-associate a reconnecting socket with a player's
  existing seat (matched by name) — but that logic only ever runs if
  `join_lobby` gets emitted, and the client's `connect` handler only
  ever updated the "Connected" status text. It never told the server
  who was reconnecting. So `myId` kept pointing at the old, dead
  socket, the player's game state resolved to nothing, and the UI
  just stayed exactly where it was when the connection dropped —
  including mid-roll-animation, permanently. Given enough time, the
  disconnect grace period would expire and their seat would be
  removed entirely, matching the "game is still running" lockout
  exactly. Fixed: the client now remembers its name after a
  server-confirmed join and automatically re-emits `join_lobby` with
  it on every reconnect, plus a defensive reset of any stuck
  roll-animation state as a safety net in case a queued browser timer
  never fires (a real possibility for a suspended/backgrounded
  mobile tab). Verified directly: rolled, force-disconnected
  mid-spin, waited, reconnected, and confirmed the player recovers
  with accurate state and a working, clickable roll button — not
  stuck.
- **Scoresheet still draggable/bouncing horizontally** — found the
  actual cause this time, not just another band-aid: the scoresheet's
  scroll container only declared `overflow-y`, and per the CSS spec,
  leaving the other axis at `visible` while one axis is constrained
  gets silently computed as `auto` instead — meaning it was likely
  already implicitly horizontally scrollable, primed to catch any
  tiny sub-pixel rounding overflow as a draggable gesture. Added an
  explicit `overflow-x: hidden`. Verified at the worst-case 4-player
  width: zero overflow, and a forced scroll attempt correctly gets
  rejected back to 0.
- **Scroll to top at round start** — added, using the existing
  round-change detection.
- **Gap next to the roll button** — confirmed as a real optical
  effect: the button's bright white border sits right at its edge,
  making the same numeric gap read as visually tighter than a
  die-to-die gap. Added a small compensating margin, and adjusted the
  dynamic width calculation so this doesn't reintroduce any overflow.

Full regression suite (6 files) re-run after all changes — all
passing, including the join-mechanism suite most relevant to the
reconnection fix.

## v1.21 — bots removed, screens merged, real margin fix confirmed

Same four items as last time — this entry documents the actual
verification, since last session's response got cut off before I'd
confirmed the fixes actually worked (a Puppeteer test was crashing and
I hadn't yet determined why).

- **Bots removed entirely**, as requested rather than continuing to
  debug them. Swept both `server.js` and the client for every trace —
  the toggle UI, the settings field, the autonomous bot AI, the
  `ENABLE_BOTS` gate, the round-start bot-adding logic. Confirmed
  clean via a full grep sweep.
- **Round Summary + "…and now Round X" merged into one screen**,
  matching the explicit request: the scores table now stays visible
  throughout, with the intro message added below it (with a divider)
  rather than replacing it on a second screen. Worth being clear this
  is a deliberate departure from the proven reference file, which does
  use two separate screens here — implemented what was asked for
  specifically.
- **Margin/border issue — real cause found and fixed.** `.scoresheet`
  carried a `padding: 0 4px` that the Playing-screen-specific override
  reset border/radius/overflow for, but never reset padding — so every
  row, including Total, sat 4px inset from the container on both
  sides. Removed it, and added the reference's own small
  `padding-right: 5px` on individual rows so the last column still
  gets breathing room without a wrapper-level inset. Verified by
  measuring the Total row's actual edges against the phone container's
  edges: now 17px on both sides, matching the phone's own intentional
  16px padding — meaning the extra unwanted inset is gone.
- **"Full-30" → "Timer"** in both places it's shown (the settings
  dropdown and the Accept-screen summary), leaving the underlying
  stored value unchanged so no server logic or existing tests needed
  touching.

Also worth documenting: hit a real, reproducible-looking crash while
testing this batch (Puppeteer's screenshot call consistently killing
the page). Traced it to a known sandbox quirk from earlier in this
project — 2+ pages with active Socket.io connections plus a screenshot
call can crash the target — not a bug in the app itself. Confirmed by
isolating the exact same interaction sequence without a screenshot
(clean), then with one after closing the second page first (also
clean, screenshot succeeded). All three visual fixes above were then
verified through both direct geometry/state checks and a real
screenshot.

Full regression suite (6 files) re-run after all changes — all
passing.

## v1.20 — roll button text, a real iOS scroll fix, and row-height consistency

- **Roll button showed "…" during the spin instead of "ROLL"** —
  confirmed against the reference: it always shows "ROLL", never a
  substitute. That "…" swap was something I'd added with no basis in
  the proven design. Removed it.
- **Horizontal scroll still possible on mobile despite last session's
  `overflow-x:hidden`** — the screenshot made this click: that's a
  well-known iOS Safari quirk where `overflow-x:hidden` on `body`
  alone often isn't sufficient to actually prevent scrolling; `html`
  needs it too. Added it there as well. (Checked for actual DOM
  overflow during the dice roll animation itself, in case the 3D
  rotation was pushing real layout bounds — it wasn't; `scrollWidth`
  stayed matched to `clientWidth` throughout. The visual overlap
  during rotation is the intended 3D tumble effect, matching the
  reference's identical technique, not overflow.)
- **Yahtzee Bonus row shorter than every other row** — confirmed
  real: it had its own `height:36px` override where the reference
  (for its equivalent bonus-style rows) has no special height at all,
  just the same shared row height as everything else. Removed the
  override.

Full regression suite (6 files) re-run after all three fixes — all
passing. Also directly verified in a real browser: the roll button
correctly reads "ROLL1" mid-animation, and every row measures the same
50px height including both bonus rows.

## v1.19 — dice dimming, zero-preview cleanup, Total alignment, and a real finding on bots

- **Dice looked transparent/dimmed during the roll animation** —
  confirmed real: the same `.locked` (dimmed) styling that's meant for
  "hasn't rolled yet" was also being applied during every spin
  animation, since both conditions shared the same `!clickable` check.
  Separated them — dimming now only applies before the very first roll,
  never while a die is actively spinning.
- **Zero-value categories showed a gold outline and the literal text
  "0"** — confirmed real against the reference: the outline should
  only appear for a positive preview, and a zero preview should render
  blank, not as text. Both fixed to match exactly.
- **"63 Bonus (need)" label too small** — it had its own smaller
  font-size override; the reference just lets it inherit the same size
  as regular category labels. Removed the override.
- **"Total" not centered** — confirmed against the reference, which
  explicitly adds a `centered` class to this specific label (unlike
  every other row, which is left-aligned). Fixed to match.
- **Connected indicator on its own line** — moved into the same row as
  the title and version, removing the extra vertical space.
- **No Game Log link outside the Lobby** — it existed on the Lobby
  screen but nowhere else; the Waiting Room (where players actually
  spend time before a game starts) had no way to reach it. Added it
  there too, correctly wired to return to the Waiting Room rather than
  the Lobby.
- **Horizontal scroll on mobile** — tested directly at 320px and 375px
  viewports, including with long player names, across every pre-game
  screen and the Playing screen with 4 players — found zero overflow
  with the current code. This was very likely already resolved by the
  dynamic die-size fix from the previous session (which hadn't shipped
  yet when the screenshot was taken). Added `overflow-x:hidden` on the
  body as a defensive safety net regardless, so a future few-pixel
  miscalculation clips invisibly instead of becoming visible scroll.
- **Bots** — real progress on understanding the failure, but not
  fixed. A moderately-paced full-game test (bots committing every
  0.6–1.2s, well short of the earlier extreme 50-150ms range) hung at
  round 3 — the same failure mode as before, now confirmed to
  reproduce at more realistic speeds too, not just extreme ones. This
  rules out my earlier hope that production-realistic timing would
  sidestep it. There's a genuine, timing-correlated bug in the bot
  round-advancement logic that needs focused debugging time on its
  own, not something to patch in alongside everything else. Still
  gated behind `ENABLE_BOTS`, off by default.

Full regression suite (6 files) re-run after all of the above — all
passing.

## v1.18 — six real fixes from screenshot feedback, one honest non-fix

You sent side-by-side screenshots this time, which made a couple of
these very easy to confirm precisely against the reference's actual
CSS values rather than eyeballing.

- **Player names duplicated** — confirmed in the screenshot: names
  appeared once above the timer (correct, matches the reference) AND
  again as a repeated header row inside the scoresheet itself (which
  doesn't exist in the reference at all). Removed the scoresheet's own
  duplicate header entirely.
- **First roll not auto-triggered** — the proven design auto-rolls the
  opening dice once the round's intro/timer settles, rather than
  requiring a manual first click. That behavior never existed in the
  server build at all. Added it: in Full-30 mode it fires once the 3s
  buildup completes (matching the reference's timing exactly), in
  When-Ready mode (no timer bar) after a short fixed delay so it
  doesn't feel instant. Verified end-to-end: `rollsUsed` reaches 1
  with zero manual clicks sent.
- **Columns misaligned + excess side margins** — same root cause,
  confirmed and fixed together. `--die-size` was a static 56px
  assumption; on any viewport wider than that happened to exactly fit,
  both the dice row and the scoresheet ended up narrower than the
  available space. Ported the proven design's actual approach: measure
  the real available width and compute `--die-size` (and everything
  derived from it) to fill it, recomputed on resize. Both the dice row
  and the scoresheet now scale together instead of independently
  guessing.
- **Score fonts didn't match** — confirmed precisely against the
  reference's CSS: current-round picks should be 1.65em/weight 900,
  older picks 1.1em/weight 400 — mine used a flat 0.85em for both,
  with no size distinction at all between "just picked" and "older."
  Fixed both sizes, plus the live pickable-preview number, to match
  exactly.
- **Category icons too small** — confirmed against the reference's
  exact values: solo mini-die 28px→32px, trophy 1.3em→1.6em, chance
  mark 1.5em→1.8em. All three were undersized; fixed to match exactly.
- **Bots still not filling despite being selected** — not fixed this
  round, and I want to be direct about why rather than leave it
  ambiguous: bots remain deliberately gated behind an `ENABLE_BOTS`
  server env var that isn't set in normal deployment, because last
  session's testing found a real, unresolved reliability issue (one
  full game completed correctly, a near-identical run under slightly
  different timing hung indefinitely with no confirmed root cause).
  The Edit-screen toggle currently doesn't reflect this — turning it
  on has no effect, silently. That's a real gap worth fixing (either
  hide/disable the toggle until bots are trustworthy, or finish
  debugging bots properly), just not something to rush into this
  batch alongside six other fixes.

Full regression suite (6 files) re-run after all six fixes — all
passing.

## v1.17 — seven specific reported bugs, all fixed and verified

- **Total row wasn't sticky** — `.scoresheet` had `overflow:hidden`,
  and since it's the direct parent of the sticky total row, that
  silently broke `position:sticky` entirely. Fixed by making the
  Playing-screen-scoped override explicitly `overflow:visible`.
- **Bots showing up** — the toggle's HTML was hardcoded to
  `class="toggle on"` regardless of the actual (deliberately disabled)
  feature state, and `fillWithBots` defaulted to `true` server-side.
  Fixed both defaults to off. The bot-adding code itself can only ever
  run through one explicitly `ENABLE_BOTS`-gated path server-side.
- **Columns misaligned under dice 3/4/5/6** — confirmed real: the dice
  used an independently-computed gap based on the slider's own
  rendered width, completely disconnected from the scoresheet grid's
  fixed `--gap`. Rewired both to derive from the same `--gap` variable
  instead. Verified programmatically (dice and column centers spaced
  identically, 63px apart) and visually via screenshot.
- **Too much border on the sides** — same root cause as the alignment
  issue; fixed alongside it. Also increased `--gap` from 4px to 7px
  for more breathing room, as requested.
- **"Tap Roll to get started" line** — confirmed neither this nor its
  sibling status line exist anywhere in the proven reference. Removed
  the entire status element, not just the one line.
- **Timer not starting at round begin, waiting for the first roll
  instead** — the real bug, found via actual debug logging rather than
  further guessing: the buildup animation depended on a double-
  `requestAnimationFrame` callback to force a layout flush, and that
  callback simply never fired, leaving the fill stuck at 0% until
  something else (like a roll) happened to trigger a fresh render.
  Replaced with a synchronous reflow (`void fillEl.offsetWidth`) that
  doesn't depend on the browser scheduling a paint frame. Verified
  with real screenshots at 1s/2s/3s showing genuine progression before
  any roll — a plain inline-style check turned out to be an unreliable
  way to confirm this given how headless rendering handles CSS
  transitions.
- **Score font not staying bold gold for the round it was picked** —
  confirmed real: every scored cell got the same plain white styling
  regardless of when it was picked; the "this round's pick gets
  emphasized" distinction from the proven design didn't exist in the
  code at all. Restored it using the `pickedThisRound` data the server
  already tracks. Verified end-to-end across two browser sessions: the
  cell shows bold gold to other players right after picking, and
  correctly reverts to plain white once the next round begins (not
  immediately after committing within the same round).

Full regression suite (6 files) re-run after all seven fixes — all
passing.

## v1.16 — a genuine scoring rule bug, resolved drag-to-reorder, haptics, and settings-field widths

You asked directly whether everything good in the reference file had
actually been matched — rather than assert yes, went through it
function-by-function against the current server build. Found real
things:

- **Scoring bug, not cosmetic**: the proven design implements the
  official Yahtzee "Joker Rule" — once a player's first Yahtzee is
  banked, a second Yahtzee can be used as a joker for Full House/Sm
  Straight/Lg Straight, but ONLY once the upper-section slot matching
  the rolled face is already filled. My `scoring.js` never implemented
  this at all — worse, it had a different, simpler shortcut baked in
  (any 5-of-a-kind always counted as Full House, unconditionally, with
  no joker gating), which doesn't match the proven rule and gives
  incorrect scores in this scenario. Rewrote `scoreFor()` to match the
  real rule exactly, updated all 3 server call sites and the client's
  preview copy to pass the player's current scores through, and added
  10 dedicated unit tests covering every branch of the rule (open
  upper slot vs. filled, before vs. after banking the first Yahtzee,
  confirming unrelated categories like Chance/3oak stay unaffected).
  One pre-existing test had literally encoded the old wrong behavior
  as its expected result — fixed that too.
- **Drag-to-reorder dice — turns out this already works.** Re-tested
  directly rather than assuming: the pointer-capture error and
  short-landing bug from earlier in the project are both gone, most
  likely as a side effect of the later sticky-layout restructuring.
  Verified with a real drag simulation landing in the correct final
  slot with no errors.
- **Haptic feedback was entirely missing.** The proven design fires a
  short vibration on every meaningful interaction — rolling, holding a
  die, picking a category, undo, and each swap during a drag. Ported
  `triggerHaptic()` and wired it into the same set of interaction
  points.
- **Settings field widths were inconsistent** — dropdowns and number
  inputs had different hardcoded widths (108px vs 70px) side by side
  on the Edit screen. Ported the dynamic width-measurement approach
  that sizes every field to match the widest dropdown option, so they
  read as one consistent column.
- Confirmed `handicap` (referenced in the proven design's timeout
  handling) is dead/unused code even in the reference itself — hardcoded
  false everywhere, no UI ever sets it true — so this isn't something
  I was missing; my existing "unfinished players get skipped, not
  scored" behavior on a Full-30 timeout already matches the real
  (non-dormant) behavior.
- Full regression suite (6 files, plus the 10 new scoring tests) run
  after all of the above — all passing.

## v1.15 — frozen header/footer layout, timer buildup, and a caught regression

Denver shared the actual `v3.8.html` source directly (not just a
screenshot) — reading the real CSS/JS surfaced three genuine gaps code-
reading alone had missed:

- **Frozen header, scrollable middle, sticky footer**: the proven
  design keeps dice/roll-button/round-and-player-header/timer all
  permanently visible at the top, with ONLY the category rows
  scrolling underneath, and the Total row stuck to the bottom of that
  scrollable area. My Playing screen let everything scroll together —
  meaning the dice and roll button would disappear off-screen once you
  scrolled down to later categories. Rebuilt to match, scoped
  specifically to the Playing screen via a JS-toggled class (not
  applied globally, since the other screens rely on normal page
  scrolling and were never built for this). Verified directly: the
  dice stayed at the exact same screen position before and after
  scrolling the scoresheet 300px.
- **Timer is a two-phase animation, not just a countdown**: fills
  0%→100% over a 3s "buildup" first, then drains back down over the
  real 30s. Only the drain existed before.
- **Timer fill is right-anchored** (`justify-content:flex-end` on the
  track), not left-anchored — it erodes from the left side while
  staying pinned to the right, not the more typical direction. Ported
  directly.
- **Caught a real regression while testing this**: the in-progress,
  not-yet-finished bot code (mid-implementation from earlier this
  session) was auto-adding bots by default whenever `fillWithBots` was
  true — which broke several already-working, previously-passing
  tests that assumed exactly 2 players. Gated the bot-adding behind an
  explicit `ENABLE_BOTS` env var so the work-in-progress code doesn't
  affect default behavior until it's actually finished and properly
  tested end-to-end — bots remain a genuinely open item, not
  something silently half-shipped.
- Full regression suite (6 files) re-run after all of the above — all
  passing.

## v1.14 — the "…and now Round X of 13" transition, and a re-verified timer

- **Round transition is genuinely two phases**, not one — the proven
  design shows "Scores played that round:" for `ROUND_SUMMARY_MS`
  (5s default), THEN separately shows "…and now Round X of 13" for
  `ROUND_INTRO_MS` (2s default, new env var) before gameplay resumes.
  Only the first phase existed before; the second was missing entirely.
  New `game.roundPhase` value `'intro'` added alongside `'summary'`.
- Found and fixed a related discrepancy while implementing this: the
  proven design skips the WHOLE transition after the final round —
  jumps straight to Game Complete, no "and now Round 14" (which
  wouldn't make sense). Verified directly that round 13 now does the
  same.
- **Timer**: re-verified directly with 4 real players in the actual
  default (Full-30) mode — genuinely works (99%→89% fill over 3 real
  seconds). Given this is the second explicit report of something that
  tests as working in the current code, the deployed site is very
  likely still behind — worth checking the version number shown in the
  app header against what's actually live.
- Retrofitted `ROUND_INTRO_MS` into all 6 test suites (same pattern as
  `ROUND_SUMMARY_MS`/`RECONNECT_GRACE_MS`) — adding the second phase
  broke every existing "play N rounds" test's timing assumptions since
  each round transition now genuinely takes longer. Fixed and
  confirmed all 6 pass.

## v1.13 — extended ground-truth verification to Round Summary and Results

Continued the same approach as v1.12 proactively, before being asked —
screenshotted the actual proven Round Summary and Final Results screens
directly from `v3.8.html` (had to work around the bots' real 10-20s
randomized commit delay and the 5s round-summary pause to capture them
at all — see `ground_truth2.js`'s approach if resurrecting it) and
compared side-by-side.

- **Round Summary**: was a loosely-styled approximation. Rebuilt to the
  exact proven structure — the grid-based "Name | took | value | for |
  category icon" row layout, players sorted alphabetically, the exact
  "Scores played that round:" title. Worth noting: the "63 BONUS!"
  badge is a genuine addition beyond the proven design, not a
  restoration — it was only ever a documented backlog wish, never
  actually implemented there.
- **Results screen**: was missing the winner's trophy icon entirely,
  and the satisfying staggered reveal (rows fade in from last place up
  to the winner, building suspense, before the button appears). Both
  ported directly. Verified the "New Game" flow correctly resets the
  reveal so a second game's results screen animates fresh instead of
  silently skipping the animation the second time.
- Full regression suite re-run after both changes — all 6 suites
  passing.

## v1.12 — rebuilt against actual ground truth, not code-reading

This pass was done differently on purpose: instead of reading CSS/JS
and re-deriving values by hand (the process that produced several
rounds of "you missed something"), the actual proven `v3.8.html` was
run directly in headless Chrome and screenshotted as ground truth,
then compared side-by-side against this client repeatedly until they
matched.

- **Duplicate version number**: was showing on both the title screen
  and the Playing screen. Now one shared header (title left, version
  right) used by every screen, matching the proven layout exactly —
  one instance, not two.
- **Round indicator position**: was oddly placed next to the dice/
  timer. The proven design puts it inline with the player-names header
  row of the scoresheet — rebuilt to match.
- **Timer**: rebuilt as its own full-width row in the correct position
  (was correctly implemented but positioned wrong, which combined with
  a previous demo happening to use When-Ready mode made it look
  broken/missing).
- **Scoresheet architecture**: replaced the flexbox approximation with
  the actual CSS Grid system the proven version uses — real
  `--cat-col-width`/`--player-col-width`/`--player-count` custom
  properties, not fixed/guessed pixel values. The current player's
  pickable cell now spans icon+score as one merged, gold-outlined
  unit, matching `.cat-player-merged`/`.thin-outline`, not just a
  highlighted number.
- **4-player support**: tested with all 4 real players for the first
  time (previous testing only ever used 2) — caught a real overflow
  bug where my originally-guessed column widths (150px/75px) were
  significantly wider than the proven design's actual formula
  (`die-size*2+9` / `die-size`), causing the 4th column to run off the
  right edge. Fixed by deriving column widths from `--die-size` via
  `calc()` instead of hardcoding them.
- Row height corrected to 50px (was 44px) and the Total row's text
  size corrected to match (was noticeably smaller than the proven
  1.5em label / 1.1em numbers).
- Full regression suite (6 test files) plus a new real-browser
  end-to-end test re-run after these changes, since this touched
  enough shared structure (header IDs, the whole scoresheet render
  function, the timer element) that regressions were a real risk —
  all passing.

## v1.11 — roll button restructure + timer clarification

- **Roll button**: was a full-width bar below the dice. Ported the
  actual proven structure — a square button sized exactly like a die,
  sitting as the first element inline with the dice row, not below it.
  Also matched the proven counting semantic: shows which roll you're
  about to make (1, 2, 3…), not a countdown of rolls remaining.
  OOPS/undo morphs this same button (red border/background, "OOPS" /
  "UNDO" two-line label) rather than a separate element, matching the
  original `.roll-die-btn.oops-mode`.
- **Timer**: verified directly — it was never actually broken. A
  prior screenshot happened to be taken in When-Ready mode, where the
  timer is correctly hidden (there's no fixed countdown in that mode).
  Tested the actual default (Full-30) directly: the bar is present and
  genuinely ticking down in real time.

## v1.10 — category icon system + 63-bonus progress row

Direct follow-up after seeing real screenshots of the proven scoresheet
— the v1.9 pass fixed row structure/borders but completely missed that
categories were never text labels in the first place, they were
pictorial dice icons. Actually ported this time, not just described:

- **Category icons**: each row now shows the real icon — a mini die
  face for Ones-Sixes, three dice for 3-of-a-Kind, a 2×2 grid for
  4-of-a-Kind, mixed grids for Full House/straights, "?" for Chance,
  🏆 for Yahtzee — pulled directly from the proven `catIconHtml()`/
  `miniDieHtml()`/`catGridHtml()` functions rather than reinvented.
- **63-bonus progress row**: added the live "(need N)" countdown row
  after Sixes that was missing entirely before (only a flat Yahtzee
  Bonus row existed). Three states, all verified against real
  gameplay: still in progress shows how many points still needed,
  already qualified shows the actual bonus amount, finished the upper
  section without qualifying shows a dimmed dash.
- Round-summary screen still uses text labels, not icons — that
  wasn't in the screenshots flagged, so left as-is for now rather than
  assumed.

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

