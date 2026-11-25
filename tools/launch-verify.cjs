/* Temporary verification harness: drives Prime's real IPC launch path for a
   version, waits for the client's title screen, then shuts the game down. */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 9339;
const VERSION_ID = process.argv[2] || '26.3';
const root = process.cwd();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const electron = spawn(
  path.join(root, 'node_modules/electron/dist/electron.exe'),
  ['.', `--remote-debugging-port=${PORT}`],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
let electronOut = '';
electron.stdout.on('data', (chunk) => { electronOut += chunk; });
electron.stderr.on('data', (chunk) => { electronOut += chunk; });
const stopElectron = () => {
  try { execFileSync('taskkill', ['/PID', String(electron.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
};

function pidAlive(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Id`], { encoding: 'utf8' });
    return out.trim() === String(pid);
  } catch { return false; }
}

function windowTitle(pid) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).MainWindowTitle`], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

async function pageSocket() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((entry) => entry.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(400);
  }
  throw new Error('Prime window never exposed a debuggable page');
}

const MENU = /(Sound engine started|Created: \d+x\d+ .*atlas|OpenAL initialized)/;

(async () => {
  const ws = new WebSocket(await pageSocket());
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  const send = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJson = async (expression) => {
    const reply = await send('Runtime.evaluate', {
      expression: `(async () => JSON.stringify(await (${expression})))()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const raw = reply?.result?.result?.value;
    if (typeof raw !== 'string') throw new Error(`evaluate failed: ${JSON.stringify(reply)}`);
    return JSON.parse(raw);
  };

  await evalJson(`(() => {
    window.__ev = [];
    window.__exit = null;
    window.prime.onLog((line) => window.__ev.push(line));
    window.prime.onExit((code) => { window.__exit = code; window.__ev.push('[[EXIT ' + code + ']]'); });
    return 'armed';
  })()`);

  const result = await evalJson(`window.prime.launch("${VERSION_ID}")`);
  console.log('LAUNCH RESULT:', JSON.stringify(result));
  if (!result.ok) {
    console.log('launch refused:', result.error);
    stopElectron();
    process.exit(2);
  }

  const logPath = result.logPath;
  let menuSeen = 0;
  let menuLines = [];
  let finished = false;

  for (let tick = 1; tick <= 60; tick += 1) {
    await sleep(2000);
    const state = await evalJson('({ exit: window.__exit, count: window.__ev.length })');
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    const lines = log.split(/\r?\n/);
    const hits = lines.filter((line) => MENU.test(line));
    const alive = result.pid ? pidAlive(result.pid) : false;
    console.log(`[${tick * 2}s] alive=${alive} exit=${state.exit} loglines=${lines.length} menulines=${hits.length}`);
    if (state.exit !== null) {
      console.log('GAME EXITED, code=' + state.exit);
      console.log('--- SESSION LOG ---\n' + log);
      stopElectron();
      process.exit(3);
    }
    if (!alive) {
      console.log('GAME PROCESS GONE WITH NO EXIT EVENT\n--- SESSION LOG ---\n' + log);
      stopElectron();
      process.exit(4);
    }
    if (hits.length > 0) {
      menuSeen += 1;
      menuLines = hits;
      if (menuSeen >= 3) { finished = true; break; }
    }
  }

  const log = fs.readFileSync(logPath, 'utf8');
  console.log('--- MENU MARKERS ---\n' + menuLines.slice(0, 6).join('\n'));
  console.log('WINDOW TITLE:', JSON.stringify(windowTitle(result.pid)));
  console.log('--- FULL SESSION LOG ---\n' + log);

  const external = process.argv[3] === 'external';
  let killed;
  if (external) {
    // Kill the game out from under the launcher to prove the exit event streams.
    execFileSync('taskkill', ['/PID', String(result.pid), '/T', '/F'], { stdio: 'ignore' });
    killed = 'external taskkill';
    for (let i = 0; i < 10; i += 1) {
      await sleep(1000);
      const code = await evalJson('window.__exit');
      if (code !== null) { console.log('EXIT EVENT AFTER EXTERNAL KILL:', JSON.stringify(code)); break; }
    }
  } else {
    killed = await evalJson('window.prime.kill()');
    await sleep(5000);
  }
  const exitAfter = await evalJson('window.__exit');
  const aliveAfter = result.pid ? pidAlive(result.pid) : 'unknown';
  console.log('KILL:', JSON.stringify(killed), 'EXIT EVENT:', JSON.stringify(exitAfter), 'PROCESS ALIVE:', aliveAfter);
  console.log('--- LOG TAIL AFTER KILL ---\n' + fs.readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-8).join('\n'));

  const crashFiles = fs.readdirSync(root).filter((name) => name.startsWith('hs_err'));
  console.log('CRASH FILES:', crashFiles.length ? crashFiles.join(',') : 'none');
  if (electronOut.trim()) console.log('--- ELECTRON OUTPUT ---\n' + electronOut.trim().split(/\r?\n/).slice(-8).join('\n'));

  stopElectron();
  process.exit(finished && aliveAfter === false ? 0 : 5);
})().catch((error) => {
  console.error('VERIFIER ERROR', error);
  stopElectron();
  process.exit(9);
});
