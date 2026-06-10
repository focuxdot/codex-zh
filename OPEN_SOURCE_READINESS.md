# Open Source Readiness

## Public Positioning

Codex-ZH is for Windows users who want:

- Codex Desktop to start with Simplified Chinese UI defaults.
- A guided way to configure Wokey, OpenRouter, or any OpenAI-compatible relay.
- Browser, Chrome, and Computer Use local capabilities to be visible and usable in domestic API Key workflows without relying on VPN for local capability setup.

## Credential Policy

- Wokey preset: includes an intentional public test key for first-run validation.
- Custom/OpenRouter presets: no bundled private API key.
- User API keys: only written to the user's local Codex config after backup and merge.
- Build hosts: keep IPs, users, SSH aliases, RDP endpoints, passwords, private keys, and private runbooks out of the public repo.
- `docs/` is treated as local/internal material and is ignored by git.

## Release Boundary

Source code can be public. Release artifacts need a separate maintainer decision because the Windows installer is built from a user-supplied official Codex app copy and resource-level patches.

## GitHub Release Packaging

GitHub Actions can build the Windows installer automatically after a version tag is pushed or a GitHub Release is published. The workflow is `.github/workflows/release.yml`.

Repository secrets for automatic release builds:

| Secret | Required | Purpose |
| --- | --- | --- |
| `CODEX_WINDOWS_APP_ZIP_URL` | Optional | Private or public URL to a `.zip` containing the unpacked official Windows Codex app folder. If unset, the workflow installs the official Codex app with `winget install Codex -s msstore`. |
| `CODEX_WINDOWS_APP_ZIP_SHA256` | Recommended | SHA-256 of the source zip. The workflow fails if it does not match. |
| `CODEX_WINDOWS_APP_LABEL` | Recommended | Installer filename label, for example `OpenAI.Codex-26.608.1337.0`. |

If `CODEX_WINDOWS_APP_ZIP_URL` is set, the source zip must contain a folder with:

- `Codex.exe`
- `resources/app.asar`

When `v*` tag is pushed or a release is published, the workflow:

1. Runs `npm test`.
2. Installs Inno Setup on the Windows runner.
3. Downloads and verifies the official Codex app zip, or installs the official Codex app from Microsoft Store with winget.
4. Builds the staged Codex-ZH app.
5. Builds the Inno Setup installer and `.sha256` file.
6. Installs the generated installer silently and runs `codex doctor`.
7. Creates the GitHub Release when the trigger was a version tag push.
8. Uploads the installer and checksum back to the GitHub Release assets.

The workflow can also be run manually with `workflow_dispatch`. Manual URL input should only be used for public URLs; use repository secrets for private signed URLs.

Typical release command:

```bash
git tag v0.1.1
git push origin v0.1.1
```

Before publishing a release:

- Run `npm test`.
- Confirm the release packaging workflow can access the official Codex app, either through the optional source zip secret or through Microsoft Store winget install.
- Verify `codex.exe doctor --summary --ascii --no-color` returns `0 fail`.
- Verify Simplified Chinese defaults.
- Verify Wokey public test key can complete a minimal request.
- Verify custom relay setup with a private test key, without logging the key.
- Verify Browser, Chrome, and Computer Use entries are visible and installable.
- Generate SHA-256 metadata for the installer.

## CodexPlusPlus Comparison Note

CodexPlusPlus describes itself as an external launcher and does not appear to rewrite `app.asar` or official Codex install files in the checked source. It does, however, heavily patch Codex runtime behavior through CDP-injected JavaScript and writes Codex config/state files for relay and plugin workflows. The accurate distinction is file-level patching versus runtime behavior patching, not "patch" versus "no patch".
