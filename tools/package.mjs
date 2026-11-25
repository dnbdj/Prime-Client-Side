#!/usr/bin/env node
/**
 * Builds the app and packages a portable Windows x64 folder, then zips it so the
 * release has a downloadable asset:
 *
 *   node tools/package.mjs
 *
 * Output: release/Prime-<version>-win32-x64/ and release/Prime-<version>-win32-x64.zip
 */
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const out = 'release';

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options });

run('npm', ['run', 'build'], process.platform === 'win32' ? { shell: true } : {});

const [appDir] = await packager({
  dir: '.',
  out,
  name: 'Prime',
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  prune: true,
  ignore: [/^\/release($|\/)/, /^\/\.git($|\/)/, /^\/\.prime-cache($|\/)/],
});

const zip = join(out, `Prime-${version}-win32-x64.zip`);
if (existsSync(zip)) rmSync(zip);

if (process.platform === 'win32') {
  run('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${appDir}\\*' -DestinationPath '${zip}' -Force`,
  ]);
} else {
  run('zip', ['-rq', zip, '.'], { cwd: appDir });
}

console.log(`packaged ${appDir}`);
console.log(`zip      ${zip}`);
