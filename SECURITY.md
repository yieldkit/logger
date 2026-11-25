# Security policy

## Supported versions

Security fixes go into the latest published version of `@yieldkit/logger`. Upgrade to the newest release before reporting an issue that may already be fixed.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/yieldkit/logger/security/advisories/new) to share the details with the maintainer.

Include the affected version, the `effect` version, reproduction steps and the expected impact. Do not include real secrets or personal data in the report; use made-up values.

## Scope

Most useful are reports where a value the [redaction contract](docs/redaction.md) guarantees to mask reaches an output: a `Redacted` value or a field under a sensitive key name showing up in a console line, a span, an exported log or a test record. Also in scope: input that makes logging throw, hang or take super-linear time. Secrets inside free text are a documented non-goal, not a vulnerability.
