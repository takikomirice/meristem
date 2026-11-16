# Meristem v0.1.0 — Windows x64 package

[日本語](INSTALL.ja.md) | **English**

An experimental developer tool that assigns work from a VS Code parent chat (Coordinator) to independent child chats (Workers). The terms Coordinator and Worker are used below. A Worker is a Codex CLI chat, distinct from an internal subagent.

## Contents and requirements

This ZIP includes the compiled application, Windows executables, helper-extension VSIX, Node.js, npm dependencies, and their license files. Running the package does not require a separate Node.js installation, `npm ci`, or compilation of TypeScript or C#.

You still need Windows x64, Git, VS Code 1.90 or later with the official Codex extension, the .NET Framework runtime, and a PowerShell environment permitted to run scripts. Live-model use requires a dedicated Codex home authenticated through the official ChatGPT login flow. Codex, VS Code, Git, credentials, and personal configuration are not included.

This is not a preconfigured one-click installer. Prepare a dedicated profile and configuration binding this PC's executables, Coordinator thread, plan, and Git scope. Live acceptance used Codex `0.169.0-alpha.11.1`; check the release manifest for the bundled Node.js version.

## Extract and check startup

1. Compare the downloaded ZIP's `Get-FileHash -Algorithm SHA256` with the release's `SHA256SUMS.txt`.
2. Extract to a new local folder and open PowerShell in the folder containing `release-manifest.json`. If you later move it, regenerate runtime configuration containing absolute paths and hashes.
3. The following command loads the application using the bundled Node and libraries. It makes no model calls or configuration changes.

```powershell
.\node\node.exe --input-type=module -e "await import('./dist/src/install.js'); console.log('Meristem runtime ready')"
```

## Install into a dedicated profile

Install the helper VSIX through the official VS Code CLI with explicit test `--user-data-dir` and `--extensions-dir` paths. The VSIX alone does not replace the application runtime.

Confirm the intended runtime and official authentication, then prepare `install-request.json` and `control.json` using the [operational reference](https://github.com/takikomirice/meristem/blob/v0.1.0/docs/chat-control-reference.ja.md) (Japanese). Set `implementationRoot` to this extracted folder. Node is in `node/node.exe`, the application in `dist/src/`, and native hosts in `.local/chat-control-build/`. This `.local` contains only three distribution executables, not the developer's management state.

```powershell
$meristemNode = (Resolve-Path -LiteralPath '.\node\node.exe').Path
powershell.exe -NoProfile -File '.\scripts\install.ps1' -NodeExe $meristemNode -ConfigPath '<absolute path to the prepared install-request.json>'
```

Installation does not start Workers. Open the selected dedicated environment and have a human check the scope and authorize the RunPermit. See the [coordination skill](https://github.com/takikomirice/meristem/blob/v0.1.0/skills/codex-chat-coordination/SKILL.md) for questions, approvals, stop, and recovery. Unsupported requests are not automatically approved, and the package does not switch to API-key billing.

## Stop and restore

Worker terminals are read-only. The Coordinator's normal stop control or `stop_run` stops all managed Workers. Reload or restart does not automatically resume work; reconciliation and renewed human confirmation are required.

After confirming the run has stopped and the dedicated window has closed, run `scripts/uninstall.ps1` with the bundled Node and the installation's `installation.json`. Settings subsequently changed by the user, Git results, uncommitted files, and the state database are retained.

## Licenses and validation scope

See [MIT License](../../LICENSE) for original project code, [Third-party notices](../../THIRD_PARTY_NOTICES.md) for npm dependencies, and `node/LICENSE.txt` inside the ZIP for the bundled Node.js license and notices.

Package contents, licenses, hashes, and application imports with the extracted bundled Node are checked. This does not establish live-model acceptance on a new PC, normal-profile suitability, or compatibility with arbitrary Codex versions. Read the [features and limitations](https://github.com/takikomirice/meristem/blob/v0.1.0/README.en.md) as well.
