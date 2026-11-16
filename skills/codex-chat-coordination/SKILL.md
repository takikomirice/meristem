---
name: codex-chat-coordination
description: Use when coordinating implementation stages through Meristem MCP from a VS Code Codex parent, reporting as an assigned CLI worker, or reconciling a stopped managed run.
---

# Codex chat coordination

Use the installed `meristem` MCP tools and the [plan and report contract](references/plan-and-report.md). A parent is the bound VS Code Codex thread; a worker is its registered CLI root. Metadata and native ownership determine roles. Internal subagents cannot register themselves or report as the root.

## Parent sequence

1. Call `start_run` with the bound absolute `planPath` and one `operationId`. If it returns `awaiting_authorization`, present the binding to the human through the documented local `authorize` command. The human confirms the parent, plan hash, repository and branches. Call `start_run` again with the same arguments after confirmation.
2. Read `get_status {runId}`. Follow `nextAttemptOffset` / `nextReportOffset` when present. Use `run.revision` for each new mutation. `scopeValid` must be true; resolve frozen plan changes with `reconcile_plan`, mapping `expectedFileHash = status.plan.fileHash` and `expectedPlanHash = status.plan.observedPlanHash` before delivery.
3. Choose an eligible task whose dependencies have **accepted integration SHAs**. Call `create_worker`; keep the complete returned WorkerRef. New tasks use a new worker by default. Call `send_instruction` with that exact target, task, plan agent, scope, completion checks and reporting contract. At most two workers run concurrently; overlapping scope or shared conflict resources remain serial.
4. After dispatch, finish the parent response and wait. Broker wake must have been explicitly configured; otherwise return when the user requests it. Do not poll with model turns or interpret terminal output/MCP notifications as a parent wake.
5. On wake, read saved reports, requests, turn completion and stop evidence. For questions use `answer_request` with the structured answer map. For human approval omit `answer`: this requests formal elicitation. Unsupported requests stay pending/unsupported. Only the human answers formal elicitation or the helper modal; model text/booleans are not approval.
6. A completed report alone is insufficient. Require normal completion of its reporting turn, no unresolved requests, confirmed process cleanup, exact clean worktree/branch/base/candidate and remote readback. Use `record_decision: accept_candidate` to fix that candidate; this does not release dependencies.
7. For every plan, merge only in `status.plan.integrationCwd`, resolve conflicts, commit and run the selected and prior completion checks against the final SHA. In parallel mode, first call `record_decision` with `decision: prepare_integration` and all fixed `inputCandidateShas`; also run the `integration` check. Report each check's `checked_sha`. Call `record_decision` with `decision: accept_integration`, that `integrationSha` and `checks`. Only this releases dependent tasks. Keep candidate and integration SHA distinct even when a fast-forward makes them equal.
8. Use `write_progress` with the latest plan `fileHash`. Call `record_decision: finish` only after every task is integrated and every worker cleaned up.

Every mutation after start uses `{runId, operationId, expectedRevision}`. Reuse an operation ID only for the identical payload. On explicit `stale_revision` / `not_applied`, reread status and issue a new operation. On lost/unknown delivery, reconcile the saved operation, process and Git facts before deciding; never blindly resend.

## Correction and handoff

For a completed task needing correction, record `retry_same` before `create_worker` to reuse its history with a **new attempt and owner epoch**. Use `handoff_new` for a replacement with a fresh history. `continue_same` additionally names the dependency's `sourceTaskId` when the plan permits continuation. Confirm previous cleanup, clean worktree and accepted Git base first. Copy neither a stale WorkerRef nor a terminal name into a new send. The default is a new assignee; two corrections per task are the initial limit.

## Worker contract

Read the assigned plan scope, current task, attempt and Git assignment via `get_status`. Work only in that worktree, run required checks, commit and push to its assigned origin branch, then call `report` with the structured [report](references/plan-and-report.md#report). Describe failed/not-run checks and remaining work honestly. End the turn after the final report so the broker can confirm cleanup. For a question, use a structured `needs_input` report with `question`; retain the exact assignment identities.

The root may use its usual skills and internal subagents for authorized work. The root alone consolidates their findings and reports. A worker cannot create/stop peers, bind a parent or accept its own result. Never put credentials, raw RPC or conversation transcripts in reports or evidence.

## Stop and recovery

`stop_worker {target}` stops that worker and fences all new delivery/wake; a sibling may finish its current turn and report. `stop_run` and the parent's normal UI stop stop all managed children. A running terminal tab closure has the same fencing effect as child stop. Hiding/switching panels does not stop a worker; closing a completed log tab changes display only. Terminals are read-only: typing, paste and `sendText` do not deliver instructions.

`stopped` needs process confirmation; interrupt acknowledgement or tab disappearance is insufficient. Keep `unknown` stopped and prohibit next work/worktree reuse. A late report never resumes a run. After broker/VS Code restart, read status, bind the current owner through the human again, reconcile unknown operations/processes/Git, and use explicit `resume_run`. If reconciliation fails, keep stopped; do not recreate an existing attempt to bypass it. Extension reload never auto-starts work.

Resume rejects unresolved attempts, `sent_unknown` operations and unknown wake delivery. A stopped run may still present a surviving sibling's pending MCP elicitation; this permits that current turn to finish and does not reopen delivery or wake. Other stale approval requests cannot be used to resume work.

Retain worktrees, branches, uncommitted changes, reports and records when processes/tabs end. Uninstall changes configuration only. Normal-profile installation, public distribution and automatic startup are separate explicit actions. Direct child CLI input, TUI, automatic continuation after VS Code exit and unsupported approval APIs are outside this version.
