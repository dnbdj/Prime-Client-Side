#!/usr/bin/env node
/**
 * Cut a release using the project numbering: majors are whole numbers (1, 2),
 * minors add a decimal (1.1, 1.2). npm needs three parts, so the tag drops the
 * trailing .0: 1.0.0 -> v1, 1.1.0 -> v1.1, 2.0.0 -> v2.
 *
 *   npm run release:minor   # 1.0 -> 1.1
 *   npm run release:major   # 1.1 -> 2
 *
 * Bumps package.json + package-lock.json, commits, tags, pushes main and the
 * tag, then creates the GitHub release with notes from commits since the last
 * version tag. Existing milestone-NN tags are left alone.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const mode = args.includes('--major') ? 'major' : args.includes('--minor') ? 'minor' : null;
const notesIndex = args.indexOf('--notes');
const extraNotes = notesIndex >= 0 ? (args[notesIndex + 1] ?? '') : '';

if (!mode) {
  console.error('usage: node tools/release.mjs --major|--minor [--notes "one line about the release"]');
  process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Windows needs a shell to launch npm.cmd; git and gh are real executables.
const npmShell = process.platform === 'win32' ? { shell: true } : {};
const run = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, { stdio: 'inherit', ...options });
const capture = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, { encoding: 'utf8', ...options }).trim();

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [major, minor] = pkg.version.split('.').map(Number);
const nextMajor = mode === 'major' ? major + 1 : major;
const nextMinor = mode === 'major' ? 0 : minor + 1;
const nextVersion = `${nextMajor}.${nextMinor}.0`;
const label = nextMinor === 0 ? `${nextMajor}` : `${nextMajor}.${nextMinor}`;
const tag = `v${label}`;

const existing = capture('git', ['tag', '--list', tag]);
if (existing) {
  console.error(`tag ${tag} already exists; bump the version by hand or delete the tag first`);
  process.exit(1);
}

const versionTags = capture('git', ['tag', '--list', 'v*', '--sort=-v:refname'])
  .split('\n')
  .filter((name) => /^v\d+(\.\d+)?$/.test(name));
const range = versionTags[0] ? `${versionTags[0]}..HEAD` : 'HEAD';
const commits = capture('git', ['log', range, '--format=- %s (%h)']);

console.log(`releasing Prime ${label} (package.json ${nextVersion}, tag ${tag})`);

run(npm, ['version', nextVersion, '--no-git-tag-version', '--allow-same-version'], npmShell);
run('git', ['add', 'package.json', 'package-lock.json']);
run('git', ['commit', '-m', `Release ${tag}: Prime ${label}`]);
run('git', ['tag', '-a', tag, '-m', `Prime ${label}`]);
run('git', ['push', 'origin', 'HEAD:main']);
run('git', ['push', 'origin', tag]);

const notes = [
  extraNotes,
  extraNotes ? '' : null,
  versionTags[0] ? `Changes since ${versionTags[0]}:` : 'First numbered release. Everything below is new since the project started.',
  '',
  commits,
].filter((line) => line !== null).join('\n');

run('gh', ['release', 'create', tag, '--title', `Prime ${label}`, '--notes', notes.trim()]);
console.log(`done: ${capture('gh', ['release', 'view', tag, '--json', 'url', '--jq', '.url'])}`);
