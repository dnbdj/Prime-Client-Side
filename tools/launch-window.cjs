/* Launch a version through Prime's IPC, wait, report window title + log, stop. */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 9341;
const VERSION_ID = process.argv[2] || '1.6.4';
const WAIT_SECONDS = Number(process.argv[3] || 30);
const root = process.cwd();
const say = (...parts) => fs.writeSync(1, parts.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const electron = spawn(
  path.join(root, 'node_modules/electron/dist/electron.exe'),
  ['.', `--remote-debugging-port=${PORT}`],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
const stopElectron = () => {
  try { execFileSync('taskkill', ['/PID', String(electron.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
};
const ps = (command) => {
  try { return execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
};

async function pageSocket() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((entry) => entry.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(400);
  }
  throw new Error('no debuggable page');
}

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
    return typeof raw === 'string' ? JSON.parse(raw) : null;
  };

  const result = await evalJson(`window.prime.launch("${VERSION_ID}")`);
  say('LAUNCH:', JSON.stringify(result));
  if (!result || !result.ok) { stopElectron(); process.exitCode = 2; return; }

  for (let i = 1; i <= WAIT_SECONDS; i += 3) {
    await sleep(3000);
    const alive = ps(`(Get-Process -Id ${result.pid} -ErrorAction SilentlyContinue).Id`);
    const title = ps(`(Get-Process -Id ${result.pid} -ErrorAction SilentlyContinue).MainWindowTitle`);
    say(`[${i}s] alive=${alive === String(result.pid)} title=${JSON.stringify(title)}`);
  }

  const log = fs.existsSync(result.logPath) ? fs.readFileSync(result.logPath, 'utf8') : '';
  say('--- LOG TAIL ---');
  say(log.split(/\r?\n/).slice(-12).join('\n'));
  say('--- WINDOW ---');
  say('title=' + JSON.stringify(ps(`(Get-Process -Id ${result.pid} -ErrorAction SilentlyContinue).MainWindowTitle`)));
  say('kill=' + JSON.stringify(await evalJson('window.prime.kill()')));
  await sleep(4000);
  say('alive after kill=' + JSON.stringify(ps(`(Get-Process -Id ${result.pid} -ErrorAction SilentlyContinue).Id`)));
  ws.close();
  stopElectron();
  process.exitCode = 0;
})().catch((error) => {
  say('HARNESS ERROR ' + (error && error.stack ? error.stack : String(error)));
  stopElectron();
  process.exitCode = 9;
});
