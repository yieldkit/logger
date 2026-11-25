import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * How long `npm install` of the tarball may take: it downloads every dependency on a cold cache.
 */
const INSTALL_TIMEOUT_MS = 300_000;

/**
 * How long one type-check or script run in the consumer may take.
 */
const COMMAND_TIMEOUT_MS = 120_000;

/**
 * TypeScript sources other than declarations, which must not ship: consumers load the built modules
 * from `node_modules`, where Node does not strip types.
 */
const TYPESCRIPT_SOURCE_PATTERN = /(?<!\.d)\.(ts|tsx)$/;

/**
 * The repository the tarball was packed from.
 */
const root = resolve(import.meta.dirname, '..');

/**
 * The tarball supplied by CI or a local `pnpm pack` command.
 */
const tarball = process.argv[2];
assert.ok(tarball, 'Usage: pnpm test:package /absolute/path/to/logger.tgz');

/**
 * The manifest of the checkout, which the packed tarball must match.
 */
const sourceManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/**
 * Reads the version of a dependency installed in this checkout, so the consumer runs the same
 * versions CI tested against.
 */
const installedVersion = (name) =>
  JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

/**
 * An isolated consumer project outside the checkout and its development dependencies, removed when
 * the script exits.
 */
const consumer = mkdtempSync(join(tmpdir(), 'logger-package-'));
process.on('exit', () => rmSync(consumer, { recursive: true, force: true }));

writeFileSync(
  join(consumer, 'package.json'),
  JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2),
);

// Dependencies resolve outside the lockfile here, so install scripts stay off.
execFileSync(
  'npm',
  [
    'install',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    resolve(tarball),
    `effect@${installedVersion('effect')}`,
    `typescript@${installedVersion('typescript')}`,
    `@types/node@${installedVersion('@types/node')}`,
  ],
  { cwd: consumer, stdio: 'inherit', timeout: INSTALL_TIMEOUT_MS },
);

/**
 * Where npm installed the package under test inside the consumer.
 */
const installed = join(consumer, 'node_modules', sourceManifest.name);

/**
 * The manifest npm installed from the tarball.
 */
const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
assert.equal(manifest.version, sourceManifest.version);

for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const version of Object.values(manifest[section] ?? {})) {
    assert.ok(
      !version.startsWith('catalog:') && !version.startsWith('workspace:'),
      'pnpm must resolve catalog and workspace versions before publishing',
    );
  }
}

/**
 * Every path inside the installed package.
 */
const shipped = readdirSync(installed, { recursive: true }).map(String);

/**
 * Shipped TypeScript sources, which must be empty.
 */
const sources = shipped.filter((name) => TYPESCRIPT_SOURCE_PATTERN.test(name));
assert.deepEqual(sources, [], 'The package must not ship TypeScript sources');
assert.ok(!shipped.some((name) => name.includes('.test.')), 'The package must not ship tests');

/**
 * Effect modules only the `otlp` entry point may load: the OTLP exporters and the HTTP client they
 * send with.
 */
const OTLP_ONLY_IMPORT_PATTERN = /from "effect\/(http|observability)"/;

/**
 * Relative module specifiers in a built file, which the walk below follows.
 */
const RELATIVE_IMPORT_PATTERN = /from "(\.{1,2}\/[^"]+)"/g;

/**
 * Returns every built module `entry` loads, itself included, by following relative imports.
 */
const moduleGraph = (entry) => {
  const seen = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!seen.has(file)) {
      seen.add(file);
      for (const [, specifier] of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT_PATTERN)) {
        pending.push(resolve(dirname(file), specifier));
      }
    }
  }

  return [...seen];
};

for (const entry of ['dist/index.js', 'dist/testing/index.js']) {
  const offenders = moduleGraph(join(installed, entry)).filter((file) =>
    OTLP_ONLY_IMPORT_PATTERN.test(readFileSync(file, 'utf8')),
  );
  assert.deepEqual(offenders, [], `${entry} must not load the OTLP exporters or the HTTP client`);
}

// Every entry point must resolve, type-check and run from the built output: a field under a
// sensitive key and a `Redacted` value must come out masked, and the plain field must not.
writeFileSync(
  join(consumer, 'smoke.ts'),
  `import { logInfo, makeCrashHandlersLayer, REDACTED_LOG_VALUE } from '${sourceManifest.name}';
import { flushOtlp, tracingLayer } from '${sourceManifest.name}/otlp';
import { captureLogs } from '${sourceManifest.name}/testing';
import { Effect, Layer, Redacted } from 'effect';

// The \`otlp\` entry point resolves, and its flush plugs into the crash handlers.
export const observability = Layer.mergeAll(
  tracingLayer('smoke'),
  makeCrashHandlersLayer({ flush: flushOtlp }),
);

const { logs } = await Effect.runPromise(
  captureLogs(
    logInfo('smoke', {
      password: 'hunter2',
      apiKey: Redacted.make('sk-live-123'),
      itemId: 'a1',
    }),
  ),
);

const line = JSON.stringify(logs);
if (logs.length !== 1 || line.includes('hunter2') || line.includes('sk-live-123')) {
  throw new Error(\`A secret reached the log record: \${line}\`);
}
if (!line.includes(REDACTED_LOG_VALUE) || !line.includes('"a1"')) {
  throw new Error(\`The record is not redacted as expected: \${line}\`);
}
`,
);

/**
 * Process options shared by the consumer's type-check and run.
 */
const options = {
  /**
   * Run inside the consumer project, so the installed tarball resolves.
   */
  cwd: consumer,

  /**
   * Show compiler and runtime output in the CI log.
   */
  stdio: 'inherit',

  /**
   * Fail instead of hanging on a stuck process.
   */
  timeout: COMMAND_TIMEOUT_MS,
};

execFileSync(
  join(consumer, 'node_modules/.bin/tsc'),
  [
    '--ignoreConfig',
    '--noEmit',
    '--strict',
    '--exactOptionalPropertyTypes',
    '--skipLibCheck',
    '--target',
    'ES2025',
    '--module',
    'nodenext',
    '--moduleResolution',
    'nodenext',
    '--types',
    'node',
    'smoke.ts',
  ],
  options,
);

// Node strips the types of a file outside `node_modules`, so the fixture runs as written.
execFileSync(process.execPath, ['smoke.ts'], options);

console.log(`Package smoke test passed for ${manifest.name}@${manifest.version}.`);
