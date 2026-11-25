# Contributing

Thanks for helping improve `@yieldkit/logger`.

## Setup

Use Node.js 22.18+, 24.11+ or 26+ and the pnpm version declared in `package.json` (`devEngines`).

```bash
pnpm install
pnpm check
pnpm test
```

`pnpm check` formats, lints and type-checks through `effect-tsgo`, which adds Effect's type-aware rules to `vp check`. The lint preset is [`@yieldkit/oxlint-config`](https://github.com/yieldkit/oxlint-config).

## Layout

- `src/index.ts`: the public API. Anything not exported here is internal.
- `src/testing/`: the `@yieldkit/logger/testing` entry point.
- `src/<module>.ts`: one concern per file, with `<module>.test.ts` next to it.
- `docs/`: one page per topic, linked from `README.md`.

## Changing redaction

`docs/redaction.md` is the contract. Masking is decided from a value's type and its key name, never from the content of a string. A change that scans strings for new secret shapes belongs in a `scrubText` hook, not in the package. Every redaction change needs a test that fails without it. A change to the per-line path should say in the pull request how it affects the cost of a line.

## Before opening a pull request

```bash
pnpm check
pnpm test
pnpm pack --out /tmp/logger.tgz
pnpm test:package /tmp/logger.tgz
```

`test:package` installs the packed tarball into a temporary project, type-checks a consumer against all three entry points and checks that a secret logged through the built output comes out masked.

## Commits and releases

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`).

To release, bump `version` in `package.json` on `main`, wait for CI to pass, then publish a GitHub release tagged `v<version>`. The publish workflow checks the tag matches `package.json` and CI passed for that commit, then publishes to npm with trusted publishing and provenance.
