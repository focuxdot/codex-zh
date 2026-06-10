# Security Policy

## Sensitive Data

Do not submit issues, pull requests, logs, screenshots, or release notes containing:

- Private API keys or bearer tokens
- SSH/RDP/WinRM endpoints for private build hosts
- Passwords, private keys, cookies, or session tokens
- User account identifiers that are not needed for debugging
- Full local `auth.json` or unredacted `config.toml`

The Wokey preset key committed in this repository is an intentional public test key for first-run validation. It should still be easy for users to replace with their own key.

## Reporting Vulnerabilities

Open a private security advisory on GitHub if the repository is public and advisories are enabled. If advisories are not available, contact the maintainers privately before posting details in a public issue.

Include:

- A concise description
- Reproduction steps
- Affected version or commit
- Expected impact
- Sanitized logs or configuration snippets

## Project Boundary

Codex-ZH customizes a user-supplied Codex Desktop app copy at resource level. It must not bypass official authentication, attestation, authorization, or official backend regional restrictions.
