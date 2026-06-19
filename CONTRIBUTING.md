# Contributing to Codex-ZH

Codex-ZH is a Windows x64 customization and relay-configuration project for Codex Desktop.

## Development Setup

Requirements:

- Node.js 20 or newer
- PowerShell 5 or newer for Windows launcher/build scripts
- Inno Setup 6 for Windows installer builds
- A locally supplied official Codex Windows app directory for full staging builds

Run tests:

```bash
npm test
```

Generate a relay config:

```bash
npm run config -- --preset openrouter --model openai/gpt-4.1 --api-key-env OPENROUTER_API_KEY
```

## Project Boundaries

- Do not commit official Codex binaries, `app.asar`, installer outputs, archives, or generated release artifacts.
- Do not commit private API keys, SSH/RDP endpoints, passwords, private runbooks, or host-specific build paths.
- The Wokey preset key in source is an intentional public test key. Treat all other keys as private unless the maintainer explicitly documents them as public.
- Keep user configuration writes backed up and merged. Do not overwrite unrelated `config.toml` fields.
- Keep `wire_api = "responses"` as the only supported Codex Desktop provider wire API.

## Pull Requests

1. Keep changes focused on one behavior or documentation area.
2. Add or update tests when changing config generation, profile storage, launcher flow, ASAR patching, or installer behavior.
3. Run `npm test` before opening a PR.
4. Update README or docs when changing user-visible behavior.

## Chinese Logs

Codex-ZH faces Chinese-speaking users, so future logs and release-facing copy should use Simplified Chinese by default.

- Commit subjects should keep technical prefixes when useful, but the description must be Chinese, for example `feat: 启动弹窗支持跳过` or `fix: 修复配置向导按钮布局`.
- CHANGELOG entries, GitHub Release notes, README release sections, and new-feature descriptions must be Chinese.
- GitHub Release notes are generated from the matching `CHANGELOG.md` version section, so add user-facing bullets under `## vX.Y.Z` before tagging a release.
- Technical identifiers such as file names, commands, API names, model names, versions, and provider IDs can remain English.
- Run `npm run logs:check` before publishing user-facing changes.
- Run `npm run hooks:install` once per checkout to enable the local `commit-msg` hook.

## Maintainer Pushes

Maintainers pushing directly to `focuxdot/codex-zh` must use the mandatory push wrapper in [OPEN_SOURCE_READINESS.md](OPEN_SOURCE_READINESS.md#mandatory-maintainer-push-identity): run `npm run push:check`, then push with `npm run push:focuxdot -- origin main` or `npm run push:focuxdot -- origin <tag>`. Do not use plain `git push` from a workstation. The push wrapper also rejects locally authored commit subjects that do not contain Chinese text.

## Reporting Issues

Use GitHub Issues and include:

- Codex-ZH version or commit
- Windows version
- Install path
- Sanitized `config.toml` snippets when relevant
- Exact error text or launcher/test output

Remove API keys, access tokens, private hostnames, private IPs, account IDs, and screenshots containing secrets before posting.
