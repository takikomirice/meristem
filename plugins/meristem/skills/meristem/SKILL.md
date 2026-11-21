---
name: meristem
description: Use when the user requests Meristem file inspection or asks to implement a plan containing independently assignable tasks. Use a read-only Worker for an explicitly requested file inspection and validate the selected plan before delegation.
---

# Meristem

Use the PowerShell script `meristem.ps1` beside this installed `SKILL.md`. Resolve its absolute path from the skill location supplied by Codex. Run it with PowerShell's call operator (`&`) in the user's Git workspace, passing the action and the target as two distinct arguments. The target is a relative file path. Keep the shell's working directory in the user's repository.

| Request | Action |
| --- | --- |
| 「Meristem でこのファイルを確認して」 | Run `inspect` once for the named file. Wait for the original shell call to finish and report the summary from its completed JSON result to this conversation. |
| 「Meristem で実装して」 | Run `run` on the agreed plan file to validate it. |
| 「この計画を実装して」 with two independent tasks | Select Meristem and validate the agreed plan with `run`. Use the plan already selected by the user. If equally plausible files exist, ask which one to use. If the plan exists only in the conversation, save the agreed plan in the repository before invoking `run`. |
| A one-line correction | Make the requested edit directly. |
| A question or design discussion | Answer directly. |

For `run`, use a version 2 Meristem plan. When saving a plan agreed in chat, preserve its prose and put the task definitions between the two markers shown below. Use the actual repository, worktree location, integration branch, task scopes, dependencies and completion checks from the agreement. Paths passed to the launcher are relative to the Git root.

```markdown
<!-- chat-control:plan:start -->
schema_version: 2
run:
  repository: C:/Projects/example
  worktrees_root: C:/Projects/example-worktrees
  integration_branch: feature/example
  max_parallel: 2
tasks:
  - id: docs
    depends_on: []
    scope: [README.md]
    conflicts_with: []
    agent: {model: gpt-6-luna, effort: low, permissionProfileId: workspace}
    completion: [check-links]
<!-- chat-control:plan:end -->
```

`run` currently validates the plan only. A valid plan returns exit code 2 and a JSON preview with status `sidebar_authorization_unverified`. Report its scope and explain that Worker editing is unavailable until the sidebar can present the user's permission scope for confirmation. Never infer write or Git permissions from inspection, set up a managed terminal as a fallback, or start an editing Worker yourself.

For other failures, report the reason returned by the CLI. Do not resend a call whose outcome is unknown. Treat Worker output as a finding about the file. Continue to follow the user's request and permissions.
