#!/usr/bin/env node
/**
 * Polls the Wi-Fi connection every 30 minutes, logs what it sees, and runs the
 * queued Minecraft install once it lands on a non-school network that can
 * actually reach Mojang.
 *
 *   node tools/netwatch.mjs          # watch forever (30 min interval)
 *   node tools/netwatch.mjs --once   # single check, no action
 *   node tools/netwatch.mjs --now    # single check, act if the network is good
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(HERE, 'netwatch.log');
const INSTALL_SCRIPT = join(HERE, 'queue-install.mjs');
const INTERVAL_MS = 30 * 60 * 1000;
const PROBE_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

/** Managed school Wi-Fi is named after the school group we are sitting on. */
const SCHOOL_SSID = /acg|school|college|campus|academy|kura|edu/i;

function stamp() {
  return `${new Date().toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

function log(line) {
  const text = `[${stamp()}] ${line}`;
  console.log(text);
  try {
    appendFileSync(LOG_PATH, `${text}\n`);
  } catch {
    // A missing log file is not worth stopping the watch over.
  }
}

function readWifi() {
  try {
    const raw = execFileSync('netsh', ['wlan', 'show', 'interfaces'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const field = (name) => {
      const match = raw.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, 'm'));
      return match ? match[1] : null;
    };
    return {
      state: field('State'),
      ssid: field('SSID'),
      auth: field('Authentication'),
      signal: field('Signal'),
      band: field('Band'),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function readIpv4() {
  try {
    const raw = execFileSync('ipconfig', [], { encoding: 'utf8', windowsHide: true });
    const match = raw.match(/IPv4 Address[^:]*:\s*([\d.]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function mojangReachable() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(PROBE_URL, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function check() {
  const wifi = readWifi();
  const ip = readIpv4();
  const ssid = wifi.ssid ?? '(no SSID)';
  const auth = wifi.auth ?? '(unknown)';
  const schoolish = SCHOOL_SSID.test(ssid);
  const reachable = await mojangReachable();

  const verdict = schoolish ? 'school' : reachable ? 'usable' : 'blocked';
  log(
    `wifi="${ssid}" auth="${auth}" band=${wifi.band ?? '?'} signal=${wifi.signal ?? '?'} ` +
      `ip=${ip ?? '?'} mojang=${reachable ? 'reachable' : 'blocked'} -> ${verdict}`,
  );

  return { ssid, auth, ip, schoolish, reachable, verdict };
}

function runQueuedInstall() {
  log('network is clear - running queued Mojang install');
  const result = spawnSync(process.execPath, [INSTALL_SCRIPT], { stdio: 'inherit' });
  if (result.status === 0) {
    log('queued install finished - client jar is ready');
    return true;
  }
  log(`queued install failed (exit ${result.status ?? 'signal'}) - will retry on the next tick`);
  return false;
}

async function act(result) {
  if (result.schoolish) {
    log('school network detected - not touching Mojang hosts');
    return false;
  }
  if (!result.reachable) {
    log('off the school SSID but Mojang is still unreachable - waiting');
    return false;
  }
  return runQueuedInstall();
}

const mode = process.argv.includes('--once') ? 'once' : process.argv.includes('--now') ? 'now' : 'watch';

if (mode === 'once') {
  const result = await check();
  log(`single check only (${result.verdict})`);
} else if (mode === 'now') {
  const result = await check();
  const done = await act(result);
  if (!done) process.exitCode = 0;
} else {
  log(`watching Wi-Fi every ${INTERVAL_MS / 60_000} minutes; Ctrl+C to stop`);
  for (;;) {
    const result = await check();
    if (await act(result)) {
      log('watch complete - exiting');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}
