#!/usr/bin/env node
/**
 * Headless Minecraft install: the same code path the launcher uses
 * (dist/main/install.js), so files land exactly where Prime expects them.
 *
 *   node tools/queue-install.mjs            # latest release
 *   node tools/queue-install.mjs 1.21.9     # a specific version
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LOG_PATH = join(HERE, 'install.log');
const REPORT_PATH = join(HERE, 'install-report.json');

/** Must match the launcher: app.getPath('userData') for app name prime-client. */
const ROOT_DIR = process.env.APPDATA
  ? join(process.env.APPDATA, 'prime-client', 'minecraft')
  : join(HERE, '..', 'minecraft');

function log(line) {
  const text = `[${new Date().toISOString().slice(0, 19).replace('T', ' ')}Z] ${line}`;
  console.log(text);
  try {
    appendFileSync(LOG_PATH, `${text}\n`);
  } catch {
    // ignore
  }
}

function sha1OfFile(path) {
  return createHash('sha1').update(readFileSync(path)).digest('hex');
}

async function main() {
  const installPath = join(HERE, '..', 'dist', 'main', 'install.js');
  if (!existsSync(installPath)) {
    log('fatal: dist/main/install.js is missing - run "npm run build" first');
    return 1;
  }
  const install = require(installPath);

  const requested = process.argv[2] ?? null;
  log(`root: ${ROOT_DIR}`);

  let versionId = requested;
  if (!versionId) {
    log('resolving latest release from the version manifest');
    const versions = await install.listVersions();
    const latest = versions.find((version) => version.type === 'release');
    if (!latest) throw new Error('no release version in the manifest');
    versionId = latest.id;
  }
  log(`target version: ${versionId}`);

  let lastLabel = '';
  const started = Date.now();
  const prepared = await install.prepare(versionId, ROOT_DIR, (phase, current, total, label) => {
    // Keep the log readable: print when the label changes, plus milestones.
    const milestone = total > 0 && (current === total || current % Math.max(1, Math.ceil(total / 10)) === 0);
    if (label !== lastLabel || milestone) {
      lastLabel = label;
      log(`${phase}: ${label} (${current}/${total})`);
    }
  });

  const clientJar = join(ROOT_DIR, 'versions', versionId, `${versionId}.jar`);
  const clientArtifact = prepared.version.downloads?.client;

  if (!existsSync(clientJar)) {
    log('fatal: client jar missing after install');
    return 1;
  }

  const actualSha1 = sha1OfFile(clientJar);
  const expectedSha1 = clientArtifact?.sha1 ?? null;
  const size = statSync(clientJar).size;
  const shaOk = expectedSha1 ? actualSha1 === expectedSha1 : true;

  log(`client jar: ${clientJar}`);
  log(`  ${size} bytes, sha1 ${actualSha1} ${expectedSha1 ? (shaOk ? 'MATCHES' : 'MISMATCH') : '(no expected hash)'}`);
  log(`main class: ${prepared.version.mainClass}`);
  log(`classpath entries: ${prepared.classpath.split(delimiter).length}`);
  log(`assets index: ${prepared.assetIndexId}`);
  log(`elapsed: ${Math.round((Date.now() - started) / 1000)}s`);

  writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        finishedAt: new Date().toISOString(),
        versionId,
        rootDir: ROOT_DIR,
        clientJarPath: clientJar,
        clientJarBytes: size,
        clientJarSha1: actualSha1,
        sha1Verified: shaOk,
        mainClass: prepared.version.mainClass,
        assetsIndexId: prepared.assetIndexId,
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
      },
      null,
      2,
    ),
    'utf8',
  );
  log(`report written: ${REPORT_PATH}`);

  return shaOk ? 0 : 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
