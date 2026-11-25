import { app } from 'electron';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Updates replace the portable app folder in place. Everything the user owns —
 * config, instances, accounts, logs — lives in %APPDATA%/prime-client, outside
 * that folder, so a replacement never touches it.
 *
 * The swap has to happen after this process exits, so a short PowerShell script
 * waits for the launcher's pid, copies the staged files over the install folder
 * and starts Prime.exe again.
 */
export type UpdateInstallResult = { ok: boolean; error?: string };

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}. ${stderr.trim()}`.trim()));
    });
  });
}

/**
 * Windows' own tar handles the zips PowerShell's Compress-Archive writes (their
 * entries use backslashes, which adm-zip cannot map onto a folder). Expand-Archive
 * is the fallback for machines without tar.exe.
 */
async function extract(zipPath: string, staging: string): Promise<void> {
  mkdirSync(staging, { recursive: true });
  const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  try {
    await run(systemTar, ['-xf', zipPath, '-C', staging]);
  } catch {
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(staging)} -Force`,
    ]);
  }
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A plain spawn would put the helper inside Electron's job object, and Windows
 * kills the whole job when the launcher exits — the swap would never happen.
 * Win32_Process.Create starts it under WMI instead, outside that job.
 */
async function launchDetached(
  scriptPath: string,
  options: { processId: number; source: string; target: string; exe: string },
): Promise<void> {
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const commandLine = [
    `"${powershell}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File`,
    psQuote(scriptPath),
    '-ProcessId',
    String(options.processId),
    '-Source',
    psQuote(options.source),
    '-Target',
    psQuote(options.target),
    '-Exe',
    psQuote(options.exe),
  ].join(' ');
  await run(powershell, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)} } | Out-Null`,
  ]);
}

const APPLY_SCRIPT = `param(
  [int]$ProcessId,
  [string]$Source,
  [string]$Target,
  [string]$Exe
)
try { Wait-Process -Id $ProcessId -Timeout 120 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 900
# /E copies over the old files without deleting anything the user put there.
robocopy $Source $Target /E /R:3 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
Start-Process -FilePath $Exe
Remove-Item -Force (Join-Path (Split-Path $Source -Parent) 'update.zip') -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $Source -ErrorAction SilentlyContinue
`;

export async function installUpdate(
  assetUrl: string,
  version: string,
  onProgress: (percent: number) => void,
): Promise<UpdateInstallResult> {
  if (!app.isPackaged) {
    return { ok: false, error: 'Automatic updates only run in a packaged build.' };
  }
  if (!/^https:\/\/github\.com\//i.test(assetUrl)) {
    return { ok: false, error: 'That update link is not a GitHub release asset.' };
  }

  const target = dirname(app.getPath('exe'));
  const work = join(app.getPath('userData'), 'updates', version.trim() || 'latest');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const response = await fetch(assetUrl, {
    headers: { 'User-Agent': `PrimeLauncher/${app.getVersion()}` },
  });
  if (!response.ok || !response.body) {
    return { ok: false, error: `Update download failed (HTTP ${response.status}).` };
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(Buffer.from(value));
    received += value.length;
    if (total > 0) onProgress(Math.min(90, Math.round((received / total) * 90)));
  }
  const zipPath = join(work, 'update.zip');
  writeFileSync(zipPath, Buffer.concat(chunks));
  onProgress(92);

  const staging = join(work, 'staging');
  await extract(zipPath, staging);
  onProgress(97);

  const scriptPath = join(work, 'apply-update.ps1');
  writeFileSync(scriptPath, APPLY_SCRIPT, 'utf8');
  await launchDetached(scriptPath, {
    processId: process.pid,
    source: staging,
    target,
    exe: app.getPath('exe'),
  });
  onProgress(100);

  // Let the renderer paint the finished state before the window closes.
  setTimeout(() => app.quit(), 500);
  return { ok: true };
}
