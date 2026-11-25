/* Drives the running Prime window: clicks Install Fabric / Install Forge /
   Play on the Versions panel and watches for real game windows. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const PORT = Number(process.argv[2] || 9352);
const GAME_VERSION = process.argv[3] || '26.3';
const root = process.cwd();
const electron = spawn(
  path.join(root, 'node_modules/electron/dist/electron.exe'),
  ['.', `--remote-debugging-port=${PORT}`],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
const stopElectron = () => {
  try { execFileSync('taskkill', ['/PID', String(electron.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
};
const say = (...parts) => fs.writeSync(1, parts.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (command) => {
  try { return execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
};
const gameWindows = () =>
  ps('Get-Process java -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.Id.ToString() + "|" + $_.MainWindowTitle }')
    .split(/\r?\n/).filter(Boolean);

async function connect() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((entry) => entry.type === 'page');
      if (page) return new WebSocket(page.webSocketDebuggerUrl);
    } catch {}
    await sleep(500);
  }
  throw new Error('Prime window is not debuggable');
}

(async () => {
  const ws = await connect();
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
    if (typeof raw !== 'string') throw new Error('evaluate failed: ' + JSON.stringify(reply?.result?.result?.exceptionDetails || reply));
    return JSON.parse(raw);
  };
  const clickText = async (label) => {
    const clicked = await evalJson(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const hit = buttons.find((b) => b.textContent.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)});
      if (hit) hit.click();
      return { clicked: !!hit, labels: buttons.map((b) => b.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 24) };
    })()`);
    if (!clicked.clicked) say('BUTTON MISSING:', label, '->', JSON.stringify(clicked.labels));
    return clicked.clicked;
  };
  const waitForProfile = async (pattern, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const versions = await evalJson('(await window.prime.listVersions()).map((v) => ({ id: v.id, loader: v.loader || null }))');
      const hit = versions.find((v) => pattern.test(v.id));
      if (hit) return hit;
      await sleep(3000);
    }
    return null;
  };
  const installLogs = async () => evalJson('(window.__installLogs || []).slice(-12)');

  const waitRows = async (timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const count = await evalJson("document.querySelectorAll('.vrow').length");
      if (count > 0) return count;
      await sleep(800);
    }
    return 0;
  };

  const clickVersion = async (id) => {
    await waitRows();
    const clicked = await evalJson(`(() => {
      const rows = [...document.querySelectorAll('.vrow')];
      const hit = rows.find((row) => {
        const label = row.querySelector('.v-id');
        return label && label.textContent.trim() === ${JSON.stringify(id)};
      });
      if (hit) hit.click();
      return { clicked: !!hit, ids: rows.map((r) => (r.querySelector('.v-id') || {}).textContent).slice(0, 12) };
    })()`);
    if (!clicked.clicked) say('ROW MISSING:', id, '->', JSON.stringify(clicked.ids));
    await sleep(1200);
    return clicked.clicked;
  };

  await evalJson('(() => { window.__installLogs = []; window.prime.onLog((line) => window.__installLogs.push(line)); return true; })()');

  await evalJson(`(() => { const nav = [...document.querySelectorAll('.rail-btn')].find((b) => (b.getAttribute('aria-label') || '').toLowerCase() === 'versions'); if (nav) nav.click(); return !!nav; })()`);
  await sleep(800);
  await clickVersion(GAME_VERSION);
  say('selected version row:', GAME_VERSION);

  const fabricPattern = new RegExp(`^fabric-loader-.*-${GAME_VERSION.replace(/\./g, '\\.')}$`);
  let fabric = await waitForProfile(fabricPattern, 3000);
  if (!fabric) {
    say('== installing Fabric for', GAME_VERSION);
    if (!(await clickText('Install Fabric'))) throw new Error('no Install Fabric button');
    fabric = await waitForProfile(fabricPattern, 240000);
  } else {
    say('== Fabric already installed:', fabric.id);
  }
  say('FABRIC PROFILE:', JSON.stringify(fabric));
  say('FABRIC LOG:\n' + (await installLogs()).join('\n'));
  if (!fabric) throw new Error('Fabric install did not produce a profile');

  await sleep(1500);
  await clickVersion(GAME_VERSION);
  const forgePattern = new RegExp(`^${GAME_VERSION.replace(/\./g, '\\.')}-forge-`);
  let forge = await waitForProfile(forgePattern, 3000);
  if (!forge) {
    say('== installing Forge for', GAME_VERSION);
    if (!(await clickText('Install Forge'))) throw new Error('no Install Forge button');
    forge = await waitForProfile(forgePattern, 420000);
  } else {
    say('== Forge profile already present:', forge.id);
  }
  say('FORGE PROFILE:', JSON.stringify(forge));
  say('FORGE LOG:\n' + (await installLogs()).join('\n'));
  if (!forge) throw new Error('Forge install did not produce a profile');

  for (const [label, profile] of [['fabric', fabric], ['forge', forge]]) {
    say(`== launching ${label} profile ${profile.id}`);
    await clickVersion(profile.id);
    await clickText('Play this version');
    let window_ = null;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await sleep(4000);
      const windows = gameWindows();
      if (windows.length) { window_ = windows[0]; break; }
      const busy = await evalJson('document.body.innerText.includes("Launching…")');
      if (!busy) {
        const error = await evalJson('(document.querySelector("[role=alert]") || {}).textContent || ""');
        if (error.trim()) { say('LAUNCH ERROR:', error.trim()); break; }
      }
    }
    say(`${label} GAME WINDOW:`, window_ ? JSON.stringify(window_) : 'NONE');
    await sleep(8000);
    say(`${label} WINDOW AFTER 8s:`, JSON.stringify(gameWindows()));
    const killed = await evalJson('window.prime.kill()');
    say(`${label} kill ->`, JSON.stringify(killed));
    await sleep(5000);
    say(`${label} WINDOWS AFTER KILL:`, JSON.stringify(gameWindows()));
    if (!window_) throw new Error(`${label} never opened a game window`);
  }

  ws.close();
  stopElectron();
  process.exitCode = 0;
})().catch((error) => {
  say('E2E ERROR ' + (error && error.stack ? error.stack : String(error)));
  stopElectron();
  process.exitCode = 1;
});
