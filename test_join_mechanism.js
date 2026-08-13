const { io } = require('socket.io-client');
const { spawn } = require('child_process');

let nextPort = 4001;

async function withFreshServer(testFn, envOverrides) {
  const port = nextPort++;
  const URL = `http://localhost:${port}`;
  const server = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'pipe', env: { ...process.env, PORT: String(port), ...envOverrides } });
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

async function main() {
  await withFreshServer(async (URL) => {
    console.log('=== Test 1: reproduce the exact reported bug scenario ===');
    console.log('    (someone was testing the Edit screen, closed their tab; a NEW person tries to join shortly after)');

    const denver = io(URL);
    let latest = null;
    denver.on('state_update', s => latest = s);
    await new Promise(r => setTimeout(r, 150));
    denver.emit('join_lobby', 'Denver');
    await new Promise(r => setTimeout(r, 150));
    denver.emit('claim_host', '8888'); // moves phase to 'editing' — matches "was testing the Edit screen"
    await new Promise(r => setTimeout(r, 150));
    console.log('  phase while testing:', latest.phase, '(expect editing)');

    console.log('  Denver closes the tab (abrupt disconnect, game never started)...');
    denver.close();
    await new Promise(r => setTimeout(r, 300)); // well under the OLD 60s grace, but past the NEW short test grace

    console.log('  A new person tries to join shortly after...');
    const colton = io(URL);
    let coltonError = null, coltonJoined = false;
    colton.on('join_error', m => coltonError = m);
    colton.on('joined', () => coltonJoined = true);
    await new Promise(r => setTimeout(r, 150));
    colton.emit('join_lobby', 'Colton');
    await new Promise(r => setTimeout(r, 200));
    console.log('  join error (expect null now):', coltonError);
    console.log('  joined successfully:', coltonJoined);
    colton.close();
  }, { LOBBY_RECONNECT_GRACE_MS: '200' });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 2: mid-GAME disconnects still get the LONG grace period (not shortened) ===');
    const denver = io(URL), colton = io(URL);
    let latest = null;
    denver.on('state_update', s => latest = s);
    colton.on('state_update', s => latest = s);
    await new Promise(r => setTimeout(r, 150));
    denver.emit('join_lobby', 'Denver');
    await new Promise(r => setTimeout(r, 150));
    colton.emit('join_lobby', 'Colton');
    await new Promise(r => setTimeout(r, 150));
    denver.emit('claim_host', '8888');
    await new Promise(r => setTimeout(r, 150));
    denver.emit('host_confirm_settings');
    await new Promise(r => setTimeout(r, 150));
    denver.emit('player_accept'); colton.emit('player_accept');
    await new Promise(r => setTimeout(r, 300));
    console.log('  phase:', latest.phase, '(expect playing)');

    denver.close();
    await new Promise(r => setTimeout(r, 300)); // past the SHORT lobby grace, well under the LONG game grace
    const stillThereMidGame = latest.players.find(p => p.name === 'Denver');
    console.log('  Denver still reserved mid-game after 300ms (expect true, uses the LONG grace):', !!stillThereMidGame && !stillThereMidGame.connected);
    colton.close();
  }, { LOBBY_RECONNECT_GRACE_MS: '100', RECONNECT_GRACE_MS: '5000' });

  await withFreshServer(async (URL) => {
    console.log('\n=== Test 3: reset_room safety valve — wrong PIN rejected, correct PIN wipes the room ===');
    const denver = io(URL);
    let latest = null;
    denver.on('state_update', s => latest = s);
    await new Promise(r => setTimeout(r, 150));
    denver.emit('join_lobby', 'Denver');
    await new Promise(r => setTimeout(r, 150));
    denver.emit('claim_host', '8888');
    await new Promise(r => setTimeout(r, 150));
    console.log('  phase before reset:', latest.phase, '| players:', latest.players.length);

    let resetResult = null;
    denver.on('reset_room_result', r => resetResult = r);
    denver.emit('reset_room', '0000');
    await new Promise(r => setTimeout(r, 150));
    console.log('  wrong PIN result:', resetResult);
    console.log('  room NOT reset yet:', latest.phase !== 'lobby' || latest.players.length !== 0);

    denver.emit('reset_room', '8888');
    await new Promise(r => setTimeout(r, 150));
    console.log('  correct PIN result:', resetResult);
    console.log('  room fully reset:', latest.phase === 'lobby' && latest.players.length === 0 && latest.hostId === null);
    denver.close();
  });

  console.log('\nALL JOIN-MECHANISM TESTS RAN.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
