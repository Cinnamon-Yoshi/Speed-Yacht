const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const { CATEGORIES } = require('./scoring');

let nextPort = 3401;

async function withFreshServer(testFn) {
  const port = nextPort++;
  const URL = `http://localhost:${port}`;
  const server = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'pipe', env: { ...process.env, PORT: String(port), ROUND_SUMMARY_MS: '150' } });
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

function closeAll(sockets) { Object.values(sockets).forEach(s => s.close()); }

async function main() {
  await withFreshServer(async (URL) => {
    console.log('=== Test: host sets description at Edit time; it flows into the Game Log entry, then clears for next game ===');
    const denver = io(URL), colton = io(URL);
    let latest = null, gameLogLatest = null, denverInfo = null;
    denver.on('state_update', s => latest = s);
    colton.on('state_update', s => latest = s);
    denver.on('game_log_update', g => gameLogLatest = g);
    denver.on('joined', i => denverInfo = i);

    await new Promise(r => setTimeout(r, 150));
    denver.emit('join_lobby', 'Denver');
    await new Promise(r => setTimeout(r, 150));
    colton.emit('join_lobby', 'Colton');
    await new Promise(r => setTimeout(r, 150));
    denver.emit('claim_host', '8888');
    await new Promise(r => setTimeout(r, 150));

    // Host sets a description WHILE editing, before the game even starts
    denver.emit('host_update_settings', { roundAdvance: 'When-Ready', description: 'First game of the night' });
    await new Promise(r => setTimeout(r, 150));
    console.log('  description visible in live settings during editing:', latest.settings.description);

    denver.emit('host_confirm_settings');
    await new Promise(r => setTimeout(r, 150));
    console.log('  description survives into accepting phase:', latest.settings.description);

    denver.emit('player_accept');
    colton.emit('player_accept');
    await new Promise(r => setTimeout(r, 300));

    // Play the full game
    for (let round = 0; round < 13; round++) {
      denver.emit('roll_dice'); colton.emit('roll_dice');
      await new Promise(r => setTimeout(r, 100));
      denver.emit('pick_category', CATEGORIES[round]);
      colton.emit('pick_category', CATEGORIES[round]);
      await new Promise(r => setTimeout(r, 300)); // long enough to clear the 150ms test round-summary pause
    }
    await new Promise(r => setTimeout(r, 300));

    console.log('  Game Log entry got the host-entered description automatically:', gameLogLatest[0].description);
    console.log('  settings.description reset after being consumed:', latest.settings.description === '');

    // Start another game — description input should start blank this time
    denver.emit('new_game');
    await new Promise(r => setTimeout(r, 200));
    console.log('  new game starts with blank description:', latest.settings.description === '');

    closeAll({ denver, colton });
  });

  console.log('\nALL TESTS RAN.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
