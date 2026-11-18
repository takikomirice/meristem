---
name: codex-chat-coordination
description: Use when coordinating implementation stages through Meristem MCP from a VS Code Codex parent, reporting as an assigned CLI worker, or reconciling a stopped managed run.
---

# Codex chat coordination

Use the installed `meristem` MCP tools and the [plan and report contract](references/plan-and-report.md). A parent is the bound VS Code Codex thread; a worker is its registered CLI root. Metadata and native ownership determine roles. Internal subagents cannot register themselves or report as the root.

## Parent sequence

For a live acceptance run, bind the specific test repository, plan and parent. Reserve each send before dispatch and count an unknown outcome against the trial budget. Use the documented CLI or the dedicated VS Code window to inspect, stop and restore the run. Leave the RunPermit and any human-addressed decisions to the person shown the actual binding or form.

1. Call `start_run` with the bound absolute `planPath` and one `operationId`. If it returns `awaiting_authorization`, present the binding to the human through the documented local `authorize` command. The human confirms the parent, plan hash, repository and branches. Call `start_run` again with the same arguments after confirmation.
2. Read `get_status {runId}`. Follow `nextAttemptOffset` / `nextReportOffset` when present. Use `run.revision` for each new mutation. `scopeValid` must be true. For a frozen plan, restore the approved content and call `reconcile_plan` with the file and observed plan hashes from status.
3. Choose an eligible task whose dependencies have **accepted integration SHAs**. Call `create_worker` and keep the complete returned WorkerRef. Read task-scoped status for that attempt. Use `modelRouting.nextAssignment.agent` for a reserved handoff, `modelRouting.initialRecommendation.selected` for a reserved initial assignment, or the plan agent otherwise. Call `send_instruction` with the exact target, task and agent, and include scope, completion checks and reporting contract in the instruction. The default limit is two concurrent workers. A version 2 plan can request more through a human-approved parallelism decision. Overlapping scopes and shared conflict resources remain serial.
4. After dispatch, finish the parent response and wait. Broker wake must have been explicitly configured; otherwise return when the user requests it. Do not poll with model turns or interpret terminal output/MCP notifications as a parent wake.
5. On wake, read saved reports, requests, turn completion and stop evidence. For questions use `answer_request` with the structured answer map. For human approval omit `answer`: this requests formal elicitation. Unsupported requests stay pending/unsupported. Only the human answers formal elicitation or the helper modal; model text/booleans are not approval.
6. For a `read-only` task, inspect the saved report, the conclusion and the evidence for each required check. When the plan shows `review_ready`, accept it with `record_decision: accept_review`, its single `reportRef` in `evidenceRefs` and its reviewed base in `integrationSha`. This releases dependent tasks. If the findings do not answer the assignment, request a new review.
7. For a `workspace` task, require confirmed completion and cleanup, clean worktree, branch, base, candidate and remote readback. Use `record_decision: accept_candidate` to fix the candidate. Merge in `status.plan.integrationCwd` and run the selected and prior completion checks against the final SHA. In parallel mode, first call `prepare_integration` with all fixed `inputCandidateShas` and also run the `integration` check. Call `accept_integration` with that `integrationSha` and the checks at that SHA to release dependencies.
8. Use `write_progress` with the latest plan `fileHash`. Call `record_decision: finish` only after every task is integrated and every worker cleaned up.

Every mutation after start uses `{runId, operationId, expectedRevision}`. Reuse an operation ID only for the identical payload. On explicit `stale_revision` / `not_applied`, reread status and issue a new operation. On lost/unknown delivery, reconcile the saved operation, process and Git facts before deciding; never blindly resend.

## Correction and handoff

Use `propose_plan_change` for changes to task dependencies, required checks or Worker settings. Present the exact diff through `answer_consultation` for a human response. Park affected active attempts with `hold_task`, apply the approved hashes with `apply_plan_change`, then explicitly `resume_task`, create a new Worker, and dispatch the revised instructions. See the [plan and report contract](references/plan-and-report.md#tool-calls).

For a completed task needing correction, record `retry_same` before `create_worker` to reuse its history with a **new attempt and owner epoch**. Use `handoff_new` for a replacement with a fresh history. `continue_same` additionally names the dependency's `sourceTaskId` when the plan permits continuation. Confirm previous cleanup, clean worktree and accepted Git base first. Copy neither a stale WorkerRef nor a terminal name into a new send. The default is a new assignee; two corrections per task are the initial limit.

For a plan with a human-approved `worker_model_policy`, review the failure report for a task with `model_routing` before adding `modelAssessment` to `handoff_new`. Use `assessmentEvidence.reportRef` for an executed failed required check or a documented stalled investigation. Check `routingBlocked` on the decision and read task-scoped status before creating and sending to the next Worker. Keep environment, specification, and permission issues in their existing recovery paths. If `modelRouting.creationFailure` is present, reconcile the run before taking another action. [Configuration and handoff sequence](../../docs/chat-control-reference.ja.md#承認済みの候補への切り替え)

## Worker contract

Read the assigned scope, task, attempt and Git assignment via `get_status`. A `workspace` task produces a checked commit on its assigned origin branch. A `read-only` task inspects the assigned base SHA and submits its findings through the same structured report. Include the actual command, result, checked SHA and evidence for each required check. A discovered defect belongs in the findings. If a required condition failed or could not be checked, report that result and remaining work. End the turn after the final report so the broker can confirm cleanup. For a question, use a structured `needs_input` report with the exact assignment identities. [Report contract](references/plan-and-report.md#report)

The root may use its usual skills and internal subagents for authorized work. The root alone consolidates their findings and reports. A worker cannot create/stop peers, bind a parent or accept its own result. Never put credentials, raw RPC or conversation transcripts in reports or evidence.

## Stop and recovery

`stop_worker {target}` stops that worker and fences all new delivery/wake; a sibling may finish its current turn and report. `stop_run` and the parent's normal UI stop stop all managed children. A running terminal tab closure has the same fencing effect as child stop. Hiding/switching panels does not stop a worker; closing a completed log tab changes display only. Terminals are read-only: typing, paste and `sendText` do not deliver instructions.

`stopped` needs process confirmation; interrupt acknowledgement or tab disappearance is insufficient. Keep `unknown` stopped and prohibit next work/worktree reuse. A late report never resumes a run. After broker/VS Code restart, read status, bind the current owner through the human again, reconcile unknown operations/processes/Git, and use explicit `resume_run`. If reconciliation fails, keep stopped; do not recreate an existing attempt to bypass it. Extension reload never auto-starts work.

Resume rejects unresolved attempts, `sent_unknown` operations and unknown wake delivery. A stopped run may still present a surviving sibling's pending MCP elicitation; this permits that current turn to finish and does not reopen delivery or wake. Other stale approval requests cannot be used to resume work.

Retain worktrees, branches, uncommitted changes, reports and records when processes/tabs end. Uninstall changes configuration only. Normal-profile installation, public distribution and automatic startup are separate explicit actions. Direct child CLI input, TUI, automatic continuation after VS Code exit and unsupported approval APIs are outside this version.
