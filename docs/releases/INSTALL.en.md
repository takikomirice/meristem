# Meristem v0.2.0 — Windows x64 package

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

### Read-only diagnostics in the current source version (MC-11a)

This API is available in builds containing MC-11a or later. For the published v0.1.0 ZIP, use the existing installer instructions below.

`inspectEnvironment(installationSpec, environmentInput?)` from `dist/src/install.js` reuses the dedicated development environment inspector and returns `{ tools, blockers, warnings }`. Tools list Codex, Node, VS Code, and the official Codex extension with paths, versions, and SHA-256 values. Unknown values are `null`. `InstallationSpec` is inferred from the existing installer schema. `InstallSpec` remains supported.

Pass all or part of the existing `install-request.json` as the first argument. Explicitly pass the existing DE `environmentInput` as the second argument for the selected VS Code, official extension, and version metadata bound to selected hashes. The helper extension is distinct from the official extension. The inspector does not select targets from PATH, the latest chat, or the normal profile. Omitting the second argument still produces a report, with blockers for missing selections or checks.

Example for built source, reading two explicitly selected files. Continue using the bundled Node when running a package that includes it.

```powershell
$meristemNode = '<absolute path to the selected Node>'
& $meristemNode --input-type=module -e "import {readFileSync} from 'node:fs'; import {inspectEnvironment} from './dist/src/install.js'; const read = p => JSON.parse(readFileSync(p,'utf8')); console.log(JSON.stringify(inspectEnvironment(read(process.argv[1]),read(process.argv[2])),null,2));" '<absolute path to install-request.json>' '<absolute path to DE input.json>'
```

Inspection never executes `--version`, model turns, sandbox setup, or login. Codex and VS Code versions come from handoff metadata bound to selected hashes; the running Node version comes from `process.version`. Authentication checks only whether `auth.json` exists. Sandbox inspection reads only the selection in the dedicated CODEX_HOME's `config.toml`. Login validity, OS sandbox support, effective isolation, process exit, and restoration remain unconfirmed; warnings explain these limits.

A hash mismatch requires compatibility validation. Inspection never adopts a discovered hash, copies credentials, or changes normal settings, normal CODEX_HOME, PATH, registry, or OS policy. Even without blockers, use the existing installer to validate installation, and the owned run's status and receipt to verify exit and restoration. Reuse DE's existing snapshot, new-run preparation, stop, and restore entry points.

For missing tools, use the official [VS Code Windows installation guide](https://code.visualstudio.com/docs/setup/windows), [Git for Windows distribution](https://git-scm.com/install/win), and [Codex Windows guide](https://developers.openai.com/codex/windows). The agent handles authorized preparation, launch, inspection, exit checks, and restoration. User input is reserved for identity-bound authentication, formal consent, or decisions introducing significant new effects. Administrator, network, and organizational restrictions remain in force.

### Generate a dedicated version-2 configuration (MC-11b)

Use a build or ZIP that includes MC-11b. For the published v0.1.0 ZIP, use the existing installer instructions below.

Select dedicated VS Code user-data and extensions directories and a dedicated `CODEX_HOME`. Create the dedicated `User/settings.json` and `CODEX_HOME/config.toml` first. Prepare and install before exporting the dedicated `CODEX_HOME` in the launch shell. The installer also protects the active home of its own shell. Use the official VS Code CLI with both dedicated directories to install the official Codex extension and helper VSIX. Follow the official login and Windows sandbox setup flows if live-model use is needed.

Replace the paths and IDs in this preparation request with the selected values. Place the parent directory of `controlConfig` inside the existing dedicated environment. Choose new paths for `controlConfig`, `installDirectory`, and `stateDirectory`.

```json
{
  "implementationRoot": "C:/meristem/build",
  "realExe": "C:/tools/codex.exe",
  "nodeExe": "C:/meristem/build/node/node.exe",
  "helperExtension": "C:/meristem/build/extension",
  "settings": "C:/meristem-dedicated/profile/User/settings.json",
  "codexConfig": "C:/meristem-auth/config.toml",
  "controlConfig": "C:/meristem-dedicated/control.json",
  "installDirectory": "C:/meristem-dedicated/installation",
  "parentCwd": "C:/work/repository",
  "prepare": {
    "environmentRoot": "C:/meristem-dedicated",
    "stateDirectory": "C:/meristem-dedicated/state",
    "parentThreadId": "REPLACE_WITH_VERIFIED_PARENT_THREAD_ID",
    "planPath": "C:/work/repository/plan.md",
    "repositoryPath": "C:/work/repository",
    "repositoryId": "repository",
    "branchScope": ["meristem-integration"],
    "coordinator": { "model": "REPLACE_WITH_VERIFIED_MODEL_ID", "effort": "medium" }
  }
}
```

- Set `prepare.parentThreadId` as shown above to keep the existing fixed-parent behavior. An entry point that supports the v0.3.0 development control protocol can omit it. `prepare.parentSessionKind` defaults to `vscode`. With `cli`, the control host also verifies the owned TUI process, creation time and executable, and detects its exit. The process that launched the relay holds the control connection and starts the run for the verified conversation, plan, Git target, and permissions. A tool-initiated request requires human confirmation of that scope. After disconnecting, revalidate the permit in the same conversation and explicitly resume. Automatic wake in this mode remains deferred until draft safety can be verified.
- Select a plan with `schema_version: 2`. Its repository and integration branch must match `repositoryPath` and `branchScope`. Installation verifies the plan and generated configuration by SHA-256 and checks the selected installation paths. Later plan revisions follow the existing agreement process.
- `prepare.permissionPermit` defaults to `workspace`, the plan's `worktrees_root`, and the `user` reviewer. For a validated environment using `auto_review`, explicitly specify `allowedProfileIds: ["workspace"]`, `writableRoots: ["<absolute worktrees_root>"]`, and `allowedReviewers: ["auto_review"]`. Each Worker receives writes only for its assigned worktree.
- New plan runs default to `prepare.usagePolicy` of `{ "enabled": true, "threshold": 20, "lowMaximum": 1 }`. At 20% remaining the run admits one concurrent Worker, and at zero it waits. Set the threshold (1–99) and a positive Worker ceiling before starting. An explicit denial of ordinary usage pauses new assignments even when automatic limits are disabled.
- Run `node dist/src/cli.js usage --run <run ID> --state <state directory>` to refresh the official windows and effective capacity without a model turn. The same data is available in `status` and the Coordinator's `get_status`. The broker refreshes after 60 seconds or at the next reset. An unverified billing context or missing measurement caps capacity at one by default. Confirmed exhaustion or denial stays in effect until reconciled.
- For routine saves the Coordinator calls `save_worker_changes` with the assigned Worker, current HEAD and commit message. The broker commits scoped changes to the assigned branch and pushes to the destination in the start permit. A different scope, branch or destination requires separate authorization.
- Opening a state database upgrades it to schema 7. Existing runs retain their previous concurrency policy. To downgrade, restore a pre-upgrade copy of the state directory taken with the host stopped.
- In `prepare.executionLimits`, set `maxWakeTurns` and `maxCorrectionsPerTask` to positive integers or `null`. Omission and `null` mean unlimited. The runtime applies the stricter of finite configuration and plan limits in `run.execution_limits`. The development runner continues to use its finite test budget.
- In the environment selection JSON, provide `codeExe`, `extensionDirectory` (the official extension directory), and `selectedTools`. Provide the verified `sha256` and `version` for each of `codex`, `node`, and `code` under `selectedTools`. Revalidate compatibility before updating the selected Codex version.

The scripts use `node/node.exe` from the ZIP by default. When running from source, add `-NodeExe` with the absolute path of the selected Node executable to each script invocation.

```powershell
$preparePath = '<absolute path to the preparation request>'
$selectionPath = '<absolute path to the environment selection>'
$installPath = '<absolute path for the new installation request>'
if (Test-Path -LiteralPath $installPath) { throw 'Select a new installation request file' }
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$prepared = & '.\scripts\install.ps1' -Prepare -ConfigPath $preparePath -EnvironmentPath $selectionPath
if ($LASTEXITCODE -ne 0) { throw 'Configuration preparation failed' }
$prepared | Set-Content -LiteralPath $installPath -Encoding UTF8
& '.\scripts\install.ps1' -ConfigPath $installPath
```

Preparation creates `control.json` exclusively at the selected path and returns the installation request on standard output. From Node, use `prepareInstallation(input, inspectEnvironment(input, selection))` for the same operation. Installation applies the dedicated settings and MCP configuration and returns the path to `installation.json`. Starting Workers requires opening the dedicated environment and having a human confirm the RunPermit.

### Installation with the existing installer

Install the helper VSIX through the official VS Code CLI with explicit test `--user-data-dir` and `--extensions-dir` paths. The VSIX alone does not replace the application runtime.

Confirm the intended runtime and official authentication, then prepare `install-request.json` and `control.json` using the [operational reference](https://github.com/takikomirice/meristem/blob/v0.2.0/docs/chat-control-reference.ja.md) (Japanese). Set `implementationRoot` to this extracted folder. Node is in `node/node.exe`, the application in `dist/src/`, and native hosts in `.local/chat-control-build/`. This `.local` contains only three distribution executables, not the developer's management state.

```powershell
$meristemNode = (Resolve-Path -LiteralPath '.\node\node.exe').Path
powershell.exe -NoProfile -File '.\scripts\install.ps1' -NodeExe $meristemNode -ConfigPath '<absolute path to the prepared install-request.json>'
```

Installation does not start Workers. Open the selected dedicated environment and have a human check the scope and authorize the RunPermit. See the [coordination skill](https://github.com/takikomirice/meristem/blob/v0.2.0/skills/codex-chat-coordination/SKILL.md) for questions, approvals, stop, and recovery. Unsupported requests are not automatically approved, and the package does not switch to API-key billing.

## Stop and restore

Worker terminals are read-only. The Coordinator's normal stop control or `stop_run` stops all managed Workers. Reload or restart does not automatically resume work; reconciliation and renewed human confirmation are required.

After confirming the run has stopped and the dedicated window has closed, select the installation's `installation.json`. Use the following command with a ZIP that includes MC-11b. With the published v0.1.0 ZIP, pass `-ConfigPath` and the bundled Node path as `-NodeExe`.

```powershell
& '.\scripts\uninstall.ps1' -ReceiptPath '<absolute path to installation.json>'
```

Restoration uses the settings recorded in the receipt. Later user settings and MCP table edits, Git results, uncommitted files, the state database, and generated files are retained. Check the result's `retained` field for user settings left in place.

## Licenses and validation scope

See [MIT License](../../LICENSE) for original project code, [Third-party notices](../../THIRD_PARTY_NOTICES.md) for npm dependencies, and `node/LICENSE.txt` inside the ZIP for the bundled Node.js license and notices.

Tests check package contents, licenses, hashes, and application imports with the extracted bundled Node. MC-11b also exercises configuration generation, installation, and restoration with the bundled Node against a test profile. Live-model acceptance on a new PC and compatibility with other Codex versions need separate checks. [Features and limitations](https://github.com/takikomirice/meristem/blob/v0.2.0/README.en.md)
