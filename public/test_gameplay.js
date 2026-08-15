const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const { scoreFor, CATEGORIES } = require('./scoring');

let nextPort = 3101; // unique port per test — sidesteps any port-release timing race from killing the previous test's server process

async function withFreshServer(testFn) {
  const port = nextPort++;
  const URL = `http://localhost:${port}`;
  // Round summary pause defaults to 5s in production — way too slow to
  // sit through repeatedly in a test, so it's shortened here the same
  // way RECONNECT_GRACE_MS already is.
  const server = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'pipe', env: { ...process.env, PORT: String(port), ROUND_SUMMARY_MS: '150', ROUND_INTRO_MS: '150' } });
  server.stderr.on('data', d => process.stderr.write('[server ERR] ' + d));
  await new Promise((resolve, reject) => {
    const onData = (d) => { if (d.toString().includes('listening')) { server.stdout.off('data', onData); resolve(); } };
    server.stdout.on('data', onData);
    setTimeout(resolve, 1500); // fallback in case the log line format ever changes
  });
  try {
    await testFn(URL);
  } finally {
    server.kill();
    await new Promise(r => setTimeout(r, 100));
  }
}

async function setupGame(URL, names, settingsOverride) {
  const sockets = {};
  const infos = {};
  let latest = null;
  for (const name of names) {
    const s = io(URL);
    s.on('state_update', st => { latest = st; });
    s.on('joined', i => { infos[name] = i; });
    sockets[name] = s;
    await new Promise(r => setTimeout(r, 100));
    s.emit('join_lobby', name);
    await new Promise(r => setTimeout(r, 100));
  }
  sockets[names[0]].emit('claim_host', '8888');
  await new Promise(r => setTimeout(r, 150));
  if (settingsOverride) {
    sockets[names[0]].emit('host_update_settings', settingsOverride);
    await new Promise(r => setTimeout(r, 150));
  }
  sockets[names[0]].emit('host_confirm_settings');
  await new Promise(r => setTimeout(r, 150));
  for (const name of names) {
    sockets[name].emit('player_accept');
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 200));
  return { sockets, infos, getState: () => latest };
}

function closeAll(sockets) {
  Object.values(sockets).forEach(s => s.close());
}

async function main() {
  await withFreshServer(async (URL) => {
    console.log('=== Test 1: game starts correctly, fresh state per player ===');
    const { sockets, infos, getState } = await setupGame(URL, ['Denver', 'Colton'], { roundAdvance: 'When-Ready' });
    const st = getState();
    console.log('  phase:', st.phase, '(expect playing)');
    console.log('  round:', st.game.round, '(expect 1)');
    const pg = st.game.players[infos.Denver.id];
    console.log('  starting dice:', pg.dice, '(expect all 1s)');
    console.log('  rollsUsed:', pg.rollsUsed, '(expect 0)');
    console.log('  scores empty:', Object.keys(pg.scores).length === 0);
    closeAll(sockets);
  });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 2: rolling works, held dice stay fixed across rolls ===');
    const { sockets, infos, getState } = await setupGame(URL, ['Denver', 'Colton'], { roundAdvance: 'When-Ready' });
    sockets.Denver.emit('roll_dice');
    await new Promise(r => setTimeout(r, 150));
    let pg = getState().game.players[infos.Denver.id];
    console.log('  rollsUsed after 1 roll:', pg.rollsUsed, '(expect 1)');
    const firstRollDice = pg.dice.slice();

    sockets.Denver.emit('toggle_hold', 0);
    await new Promise(r => setTimeout(r, 100));
    console.log('  die 0 held:', getState().game.players[infos.Denver.id].held[0]);

    sockets.Denver.emit('roll_dice');
    await new Promise(r => setTimeout(r, 150));
    pg = getState().game.players[infos.Denver.id];
    console.log('  rollsUsed after 2nd roll:', pg.rollsUsed, '(expect 2)');
    console.log('  held die 0 unchanged:', pg.dice[0] === firstRollDice[0], '(expect true)');
    closeAll(sockets);
  });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 3: cannot roll beyond rollsPerTurn ===');
    const { sockets, infos, getState } = await setupGame(URL, ['Denver', 'Colton'], { rollsPerTurn: 3, roundAdvance: 'When-Ready' });
    console.log('  confirmed rollsPerTurn setting:', getState().settings.rollsPerTurn);
    for (let i = 0; i < 5; i++) {
      sockets.Denver.emit('roll_dice');
      await new Promise(r => setTimeout(r, 120));
    }
    console.log('  rollsUsed after 5 attempts with cap=3:', getState().game.players[infos.Denver.id].rollsUsed, '(expect 3)');
    closeAll(sockets);
  });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 4: cannot hold before rolling; cannot score before rolling ===');
    const { sockets, infos, getState } = await setupGame(URL, ['Denver', 'Colton'], { roundAdvance: 'When-Ready' });
    sockets.Denver.emit('toggle_hold', 2);
    await new Promise(r => setTimeout(r, 120));
    console.log('  hold before any roll rejected:', getState().game.players[infos.Denver.id].held[2] === false);

    sockets.Denver.emit('pick_category', 'chance');
    await new Promise(r => setTimeout(r, 120));
    console.log('  score before any roll rejected:', !Object.prototype.hasOwnProperty.call(getState().game.players[infos.Denver.id].scores, 'chance'));
    closeAll(sockets);
  });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 5: scoring commits the server-computed value, matches scoring engine ===');
    const { sockets, infos, getState } = await setupGame(URL, ['Denver', 'Colton'], { roundAdvance: 'When-Ready' });
    sockets.Denver.emit('roll_dice');
    await new Promise(r => setTimeout(r, 150));
    let st = getState();
    const dice = st.game.players[infos.Denver.id].dice;
    const expectedChance = scoreFor('chance', dice, st.settings);

    sockets.Denver.emit('pick_category', 'chance');
    await new Promise(r => setTimeout(r, 150));
    st = getState();
    const pg = st.game.players[infos.Denver.id];
    console.log('  dice:', dice, '| chance score:', pg.scores.chance, '(expect', expectedChance + ')');
    console.log('  doneThisRound:', pg.doneThisRound, '(expect true)');

    sockets.Denver.emit('pick_category', 'ones');
    await new Promise(r => setTimeout(r, 120));
    console.log('  cannot score twice in one round:', !Object.prototype.hasOwnProperty.call(getState().game.players[infos.Denver.id].scores, 'ones'));
    closeAll(sockets);
  });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 6: When-Ready mode moves to round-summary the instant everyone is done, then advances after the summary pause ===');
    const { sockets, infos, getState } = await setupGame(URL, ['Denver', 'Colton'], { roundAdvance: 'When-Ready' });
    sockets.Denver.emit('roll_dice');
    sockets.Colton.emit('roll_dice');
    await new Promise(r => setTimeout(r, 150));
    sockets.Denver.emit('pick_category', 'chance');
    await new Promise(r => setTimeout(r, 150));
    console.log('  round after only one player done:', getState().game.round, '(expect still 1)');
    console.log('  roundPhase after only one player done:', getState().game.roundPhase, '(expect playing)');

    sockets.Colton.emit('pick_category', 'chance');
    await new Promise(r => setTimeout(r, 80)); // shorter than the 150ms test ROUND_SUMMARY_MS — should be mid-summary
    const midSummary = getState();
    console.log('  round still 1 during the summary pause:', midSummary.game.round, '(expect 1)');
    console.log('  roundPhase during the pause:', midSummary.game.roundPhase, '(expect summary)');
    console.log('  roundSummary has both players\' picks:', midSummary.game.roundSummary && midSummary.game.roundSummary.length === 2);

    await new Promise(r => setTimeout(r, 250)); // let the summary pause finish
    const st = getState();
    console.log('  round after summary pause ends:', st.game.round, '(expect 2)');
    console.log('  roundPhase back to playing:', st.game.roundPhase, '(expect playing)');
    console.log('  new round dice reset:', JSON.stringify(st.game.players[infos.Denver.id].dice) === JSON.stringify([1,1,1,1,1]));
    console.log('  new round doneThisRound reset:', st.game.players[infos.Denver.id].doneThisRound === false);
    console.log('  round 1 score preserved:', st.game.players[infos.Denver.id].scores.chance !== undefined);
    closeAll(sockets);
  });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 7: Full-30 mode does NOT advance early even if everyone finishes ===');
    const { sockets, infos, getState } = await setupGame(URL, ['Denver', 'Colton'], { roundAdvance: 'Full-30' });
    console.log('  confirmed roundAdvance setting:', getState().settings.roundAdvance);
    console.log('  roundEndsAt is set:', !!getState().game.roundEndsAt);
    sockets.Denver.emit('roll_dice');
    sockets.Colton.emit('roll_dice');
    await new Promise(r => setTimeout(r, 150));
    sockets.Denver.emit('pick_category', 'chance');
    sockets.Colton.emit('pick_category', 'chance');
    await new Promise(r => setTimeout(r, 300));
    console.log('  round stays 1 even though both are done:', getState().game.round, '(expect 1)');
    closeAll(sockets);
  });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 8: full 13-round game reaches gameOver, totals computed correctly ===');
    const { sockets, infos, getState } = await setupGame(URL, ['Denver', 'Colton'], { roundAdvance: 'When-Ready' });
    for (let round = 1; round <= 13; round++) {
      sockets.Denver.emit('roll_dice');
      sockets.Colton.emit('roll_dice');
      await new Promise(r => setTimeout(r, 100));
      const cat = CATEGORIES[round - 1];
      sockets.Denver.emit('pick_category', cat);
      sockets.Colton.emit('pick_category', cat);
      await new Promise(r => setTimeout(r, 500)); // long enough to clear BOTH 150ms test phases (summary + intro)
    }
    const st = getState();
    console.log('  gameOver:', st.game.gameOver, '(expect true)');
    const pg = st.game.players[infos.Denver.id];
    console.log('  all 13 categories scored:', Object.keys(pg.scores).length, '(expect 13)');
    console.log('  total is a computed number:', typeof pg.total === 'number', pg.total);
    closeAll(sockets);
  });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 9: reconnect mid-game preserves dice/scores/rollsUsed ===');
    const { sockets, infos, getState } = await setupGame(URL, ['Denver', 'Colton'], { roundAdvance: 'When-Ready' });
    sockets.Denver.emit('roll_dice');
    await new Promise(r => setTimeout(r, 150));
    const before = getState().game.players[infos.Denver.id];
    const diceBefore = before.dice.slice();
    const rollsBefore = before.rollsUsed;

    sockets.Denver.close();
    await new Promise(r => setTimeout(r, 400));

    const denver2 = io(URL);
    let st2 = null, info2 = null;
    denver2.on('state_update', s => st2 = s);
    denver2.on('joined', i => info2 = i);
    await new Promise(r => setTimeout(r, 150));
    denver2.emit('join_lobby', 'Denver');
    await new Promise(r => setTimeout(r, 300));

    const after = st2.game.players[info2.id];
    console.log('  dice preserved:', JSON.stringify(after.dice) === JSON.stringify(diceBefore));
    console.log('  rollsUsed preserved:', after.rollsUsed === rollsBefore);
    denver2.close();
    sockets.Colton.close();
  });

  console.log('\nALL GAMEPLAY TESTS RAN.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
