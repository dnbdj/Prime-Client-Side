import { app } from 'electron';
import AdmZip from 'adm-zip';
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
  new AdmZip(zipPath).extractAllTo(staging, true);
  onProgress(97);

  const scriptPath = join(work, 'apply-update.ps1');
  writeFileSync(scriptPath, APPLY_SCRIPT, 'utf8');
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-ProcessId',
      String(process.pid),
      '-Source',
      staging,
      '-Target',
      target,
      '-Exe',
      app.getPath('exe'),
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  onProgress(100);

  // Let the renderer paint the finished state before the window closes.
  setTimeout(() => app.quit(), 500);
  return { ok: true };
}
