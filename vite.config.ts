import { fmtConfig } from '@yieldkit/oxlint-config';
import oxlintConfig from '@yieldkit/oxlint-config/effect';
import { defineConfig } from 'vite-plus';

/**
 * Paths neither the formatter nor the linter touches: build output, packed tarballs and coverage.
 */
const ignoredPatterns = ['coverage/**', '*.tgz', 'pnpm-lock.yaml'];

export default defineConfig({
  pack: {
    entry: ['src/index.ts', 'src/otlp/index.ts', 'src/testing/index.ts'],
    platform: 'neutral',
    format: ['esm'],
    dts: true,
    unbundle: true,
    fixedExtension: false,
  },
  staged: {
    '*': 'effect-tsgo vp check --fix',
  },
  fmt: {
    ...fmtConfig,
    ignorePatterns: [...fmtConfig.ignorePatterns, ...ignoredPatterns],
  },
  lint: {
    ...oxlintConfig,
    ignorePatterns: [...oxlintConfig.ignorePatterns, ...ignoredPatterns],
    rules: {
      ...oxlintConfig.rules,
      // The OTLP exporters and their `HttpClient` live in Effect's unstable modules; this package
      // builds on them by design, so its `effect` peer range (`~4.1.7`) only admits patch releases
      // of the minor version it is tested against.
      'effecttsgo/unstable-api-usage': 'off',
    },
    overrides: [
      ...oxlintConfig.overrides,
      {
        // Tests and fixtures run effects directly.
        files: ['src/**/*.test.ts', 'src/**/*.fixture.ts'],
        rules: {
          'slop/no-effect-run-outside-entry': 'off',
        },
      },
      {
        // Crash listeners are plain process callbacks: this is where they hand a crash to Effect.
        files: ['src/crash.ts'],
        rules: {
          'slop/no-effect-run-outside-entry': 'off',
        },
      },
      {
        // A logger accepts any value as a field, and the redacting fiber and span proxies forward
        // every member they do not replace to the real object.
        files: ['src/types.ts', 'src/redact.ts'],
        rules: {
          'quality/no-reflect-apply': 'off',
          'quality/no-reflect-get': 'off',
          'quality/no-unknown-returns': 'off',
          'quality/no-unsafe-dictionary-type': 'off',
        },
      },
      {
        files: ['src/index.ts', 'src/otlp/index.ts', 'src/testing/index.ts'],
        rules: {
          'oxc/no-barrel-file': 'off',
        },
      },
      {
        files: ['scripts/**/*.mjs'],
        rules: {
          'no-console': 'off',
          // Plain Node scripts without Effect: JSON comes from files this repository controls.
          'slop/no-raw-json-parse': 'off',
        },
      },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
  run: {
    cache: { scripts: false, tasks: true },
  },
});
