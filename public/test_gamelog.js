const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const { CATEGORIES } = require('./scoring');

let nextPort = 3201;

async function withFreshServer(testFn, envOverrides) {
  const port = nextPort++;
  const URL = `http://localhost:${port}`;
  // ROUND_SUMMARY_MS defaults to a fast value for every test in this file
  // (5s in production is far too slow to sit through repeatedly) —
  // callers can still override it via envOverrides if a specific test
  // needs to.
  const server = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'pipe', env: { ...process.env, PORT: String(port), ROUND_SUMMARY_MS: '150', ROUND_INTRO_MS: '150', ...envOverrides } });
  server.stderr.on('data', d => process.stderr.write('[server ERR] ' + d));
  await new Promise((resolve) => {
    const onData = (d) => { if (d.toString().includes('listening')) { server.stdout.off('data', onData); resolve(); } };
    server.stdout.on('data', onData);
    setTimeout(resolve, 1500);
  });
  try {
    await testFn(URL);
  } finally {
    server.kill();
    await new Promise(r => setTimeout(r, 100));
  }
}

async function playFullGame(URL, names) {
  const sockets = {};
  const infos = {};
  let latest = null;
  let gameLogLatest = null;
  for (const name of names) {
    const s = io(URL);
    s.on('state_update', st => { latest = st; });
    s.on('game_log_update', gl => { gameLogLatest = gl; });
    s.on('joined', i => { infos[name] = i; });
    sockets[name] = s;
    await new Promise(r => setTimeout(r, 100));
    s.emit('join_lobby', name);
    await new Promise(r => setTimeout(r, 100));
  }
  sockets[names[0]].emit('claim_host', '8888');
  await new Promise(r => setTimeout(r, 150));
  sockets[names[0]].emit('host_update_settings', { roundAdvance: 'When-Ready' });
  await new Promise(r => setTimeout(r, 150));
  sockets[names[0]].emit('host_confirm_settings');
  await new Promise(r => setTimeout(r, 150));
  for (const name of names) {
    sockets[name].emit('player_accept');
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 200));

  for (let round = 1; round <= 13; round++) {
    for (const name of names) sockets[name].emit('roll_dice');
    await new Promise(r => setTimeout(r, 100));
    const cat = CATEGORIES[round - 1];
    for (const name of names) sockets[name].emit('pick_category', cat);
    await new Promise(r => setTimeout(r, 500)); // long enough to clear BOTH 150ms test phases (summary + intro) before the next round's roll_dice fires
  }
  await new Promise(r => setTimeout(r, 300));

  return { sockets, infos, getState: () => latest, getGameLog: () => gameLogLatest };
}

function closeAll(sockets) { Object.values(sockets).forEach(s => s.close()); }

async function main() {
  await withFreshServer(async (URL) => {
    console.log('=== Test 1: game log entry auto-created when game ends ===');
    const { sockets, infos, getState, getGameLog } = await playFullGame(URL, ['Denver', 'Colton']);
    const st = getState();
    console.log('  gameOver:', st.game.gameOver);
    const log = getGameLog();
    console.log('  log has 1 entry:', log.length === 1);
    console.log('  entry has ranked players:', log[0].players.length === 2);
    console.log('  winner is players[0]:', log[0].players[0].total >= log[0].players[1].total);
    console.log('  entry has settings snapshot:', JSON.stringify(log[0].settings));
    console.log('  description starts empty:', log[0].description === '');
    console.log('  photo starts null:', log[0].photo === null);
    closeAll(sockets);
  });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 2: admin-edited description (with correct PIN) syncs to other players ===');
    const { sockets, infos, getGameLog } = await playFullGame(URL, ['Denver', 'Colton']);
    const entryId = getGameLog()[0].id;

    // Wrong PIN should be silently rejected — no change
    sockets.Denver.emit('set_game_log_description', { id: entryId, text: 'should not stick', pin: '0000' });
    await new Promise(r => setTimeout(r, 200));
    console.log('  wrong PIN does not set description:', getGameLog()[0].description === '');

    // Correct PIN should work and sync to the other player
    sockets.Denver.emit('set_game_log_description', { id: entryId, text: 'Game night at the lake house', pin: '8888' });
    await new Promise(r => setTimeout(r, 200));
    console.log('  Colton sees the description Denver added:', getGameLog()[0].description);
    closeAll(sockets);
  });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 2b: PIN can be verified without any side effects ===');
    const { sockets, getGameLog } = await playFullGame(URL, ['Denver', 'Colton']);
    let result = null;
    sockets.Denver.on('game_log_pin_result', r => result = r);
    sockets.Denver.emit('verify_game_log_pin', '0000');
    await new Promise(r => setTimeout(r, 200));
    console.log('  wrong pin verify result:', result);
    sockets.Denver.emit('verify_game_log_pin', '8888');
    await new Promise(r => setTimeout(r, 200));
    console.log('  correct pin verify result:', result);
    closeAll(sockets);
  });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 3: only the actual winner can attach a photo to their win ===');
    const { sockets, infos, getGameLog } = await playFullGame(URL, ['Denver', 'Colton']);
    const entry = getGameLog()[0];
    const winnerName = entry.players[0].name;
    const loserName = entry.players[1].name;
    console.log('  winner is:', winnerName);

    // Loser's own socket tries to attach a photo to the winner's entry —
    // identity is derived server-side from the socket, not any client-
    // claimed name, so this should be rejected regardless.
    sockets[loserName].emit('set_winner_photo', { id: entry.id, photo: 'data:image/jpeg;base64,AAAA' });
    await new Promise(r => setTimeout(r, 200));
    console.log('  non-winner rejected (photo still null):', getGameLog()[0].photo === null);

    // Actual winner attaches their own photo — should work
    sockets[winnerName].emit('set_winner_photo', { id: entry.id, photo: 'data:image/jpeg;base64,AAAA' });
    await new Promise(r => setTimeout(r, 200));
    console.log('  real winner\'s photo accepted:', getGameLog()[0].photo === 'data:image/jpeg;base64,AAAA');
    closeAll(sockets);
  });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 4: delete requires correct PIN ===');
    const { sockets, infos, getGameLog } = await playFullGame(URL, ['Denver', 'Colton']);
    const entryId = getGameLog()[0].id;

    let deleteResult = null;
    sockets.Denver.on('game_log_delete_result', r => deleteResult = r);
    sockets.Denver.emit('delete_game_log_entry', { id: entryId, pin: '0000' });
    await new Promise(r => setTimeout(r, 200));
    console.log('  wrong PIN result:', deleteResult);
    console.log('  entry still present:', getGameLog().length === 1);

    sockets.Denver.emit('delete_game_log_entry', { id: entryId, pin: '8888' });
    await new Promise(r => setTimeout(r, 200));
    console.log('  correct PIN result:', deleteResult);
    console.log('  entry removed:', getGameLog().length === 0);
    closeAll(sockets);
  });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 5: multiple games accumulate in the log, most recent first ===');
    let { sockets, getGameLog } = await playFullGame(URL, ['Denver', 'Colton']);
    closeAll(sockets);
    // With a short grace period (set via env below), the room fully
    // resets to 'lobby' shortly after both players disconnect, letting a
    // second game actually start on the same server process — proving
    // gameLog itself survives a room reset, which is the whole point of
    // keeping it outside `state`.
    await new Promise(r => setTimeout(r, 600));
    ({ sockets, getGameLog } = await playFullGame(URL, ['Sally', 'Alex']));
    const log = getGameLog();
    console.log('  log has 2 entries:', log.length === 2);
    console.log('  most recent game (Sally/Alex) is first:', log[0] && log[0].players.some(p => p.name === 'Sally' || p.name === 'Alex'));
    console.log('  older game (Denver/Colton) is second:', log[1] && log[1].players.some(p => p.name === 'Denver' || p.name === 'Colton'));
    closeAll(sockets);
  }, { RECONNECT_GRACE_MS: '300' });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 6: a newly-connecting socket receives the existing log immediately ===');
    const { sockets, getGameLog } = await playFullGame(URL, ['Denver', 'Colton']);
    const entryId = getGameLog()[0].id;
    closeAll(sockets);
    await new Promise(r => setTimeout(r, 200));

    const late = io(URL);
    let lateLog = null;
    late.on('game_log_update', gl => { lateLog = gl; });
    await new Promise(r => setTimeout(r, 300));
    console.log('  late-connecting socket sees the existing entry without any game action:', lateLog && lateLog.length === 1 && lateLog[0].id === entryId);
    late.close();
  });

  console.log('\nALL GAME LOG TESTS RAN.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
