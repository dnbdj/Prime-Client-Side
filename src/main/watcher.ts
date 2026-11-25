import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { WatcherStatus } from '../shared/api';

/**
 * The Wi-Fi watcher used to live only in a terminal (tools/netwatch.mjs), so it
 * stopped the moment the window that started it closed. Registering it with the
 * Windows Task Scheduler gives it its own lifetime: the task runs a single
 * check every half hour and keeps doing that with Prime shut.
 */
const TASK_NAME = 'Prime Watcher';
const INTERVAL_MINUTES = 30;

function watcherScript(): string {
  return join(app.getAppPath(), 'tools', 'netwatch.mjs');
}

function watcherLog(): string {
  return join(app.getAppPath(), 'tools', 'netwatch.log');
}

/** node.exe from PATH, or the default install location, whichever exists. */
function resolveNode(): string | null {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  const fallback = process.env.ProgramFiles ? join(process.env.ProgramFiles, 'nodejs', exe) : null;
  return fallback && existsSync(fallback) ? fallback : null;
}

function run(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'schtasks',
      args,
      { windowsHide: true, encoding: 'utf8', timeout: 20_000 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
      },
    );
  });
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The next half-hour mark, formatted the way task XML wants a local time. */
function nextBoundary(): string {
  const next = new Date();
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() < INTERVAL_MINUTES ? INTERVAL_MINUTES : 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}` +
    `T${pad(next.getHours())}:${pad(next.getMinutes())}:00`
  );
}

/**
 * A repeating time trigger: one check every half hour, started at the next
 * half-hour mark, so it outlives both Prime and a reboot. A logon trigger reads
 * better on paper but Windows refuses to register one without elevation, and a
 * laptop on battery skips any task that is still marked "no start on
 * batteries" - which is exactly where the queued install has to run.
 */
function taskXml(nodePath: string, scriptPath: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${nextBoundary()}</StartBoundary>
      <Repetition>
        <Interval>PT${INTERVAL_MINUTES}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(nodePath)}</Command>
      <Arguments>${xmlEscape(`"${scriptPath}" --now`)}</Arguments>
      <WorkingDirectory>${xmlEscape(join(app.getAppPath(), 'tools'))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function field(text: string, label: string): string | null {
  const match = text.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, 'mi'));
  const value = match?.[1]?.trim();
  return value && value !== 'N/A' ? value : null;
}

function lastLogLine(): string | null {
  try {
    const lines = readFileSync(watcherLog(), 'utf8').trimEnd().split(/\r?\n/);
    return lines.length > 0 ? lines[lines.length - 1] : null;
  } catch {
    return null;
  }
}

async function readStatus(overrides: Partial<WatcherStatus> = {}): Promise<WatcherStatus> {
  const scriptPath = watcherScript();
  const base: WatcherStatus = {
    supported: process.platform === 'win32',
    installed: false,
    taskName: TASK_NAME,
    intervalMinutes: INTERVAL_MINUTES,
    scriptPath,
    nodePath: resolveNode(),
    nextRun: null,
    lastRun: null,
    lastResult: null,
    logPath: watcherLog(),
    lastLogLine: lastLogLine(),
    ...overrides,
  };
  if (!base.supported) return { ...base, error: 'Scheduled tasks are Windows-only.' };

  const query = await run(['/query', '/tn', TASK_NAME, '/fo', 'LIST', '/v']);
  if (!query.ok) return base;
  const lastRun = field(query.out, 'Last Run Time');
  const lastResult = field(query.out, 'Last Result');
  // A task that has never run reports 30/11/1999 and 267011 (SCHED_S_TASK_HAS_NOT_RUN).
  const neverRan = !lastRun || lastRun.includes('1999') || lastResult === '267011';
  return {
    ...base,
    installed: true,
    nextRun: field(query.out, 'Next Run Time'),
    lastRun: neverRan ? null : lastRun,
    lastResult: neverRan ? null : lastResult,
  };
}

export async function watcherStatus(): Promise<WatcherStatus> {
  return readStatus();
}

export async function scheduleWatcher(): Promise<WatcherStatus> {
  if (process.platform !== 'win32') return readStatus();
  const scriptPath = watcherScript();
  if (!existsSync(scriptPath)) {
    return readStatus({ error: `Watcher script not found at ${scriptPath}.` });
  }
  const nodePath = resolveNode();
  if (!nodePath) {
    return readStatus({ error: 'Node.js was not found on PATH, so the task has nothing to run.' });
  }

  const dir = mkdtempSync(join(tmpdir(), 'prime-task-'));
  const xmlPath = join(dir, 'watcher.xml');
  try {
    // schtasks wants a Unicode (UTF-16LE) task definition.
    writeFileSync(xmlPath, `\ufeff${taskXml(nodePath, scriptPath)}`, 'utf16le');
    const created = await run(['/create', '/tn', TASK_NAME, '/xml', xmlPath, '/f']);
    if (!created.ok) {
      return readStatus({
        error: created.out || 'Windows rejected the scheduled task definition.',
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return readStatus();
}

export async function unscheduleWatcher(): Promise<WatcherStatus> {
  if (process.platform !== 'win32') return readStatus();
  const removed = await run(['/delete', '/tn', TASK_NAME, '/f']);
  if (!removed.ok && !/cannot find|does not exist|not found/i.test(removed.out)) {
    return readStatus({ error: removed.out || 'Windows would not remove the scheduled task.' });
  }
  return readStatus();
}
