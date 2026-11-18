# Plan and report contract

The Markdown plan is authoritative for scope; SQLite is authoritative for execution. The implementation guide is the [operational reference](../../../docs/chat-control-reference.ja.md) (Japanese). Use the current MCP schemas when constructing calls; identity is never supplied as a caller role argument.

Terminology: the parent chat is the **Coordinator** (コーディネーター); a child chat is a **Worker** (ワーカー). A Worker is an independently managed Codex CLI chat with its own conversation history, not an internal subagent. The Coordinator and each Worker may use their own internal subagents.

## Plan

Keep prose outside these unique machine regions. Use absolute paths for repository and worktrees. `worktrees_root` is an existing directory; the integration branch must be new and non-protected. Existing dirty source files are preserved.

```markdown
# Example project
Implement A then B. Keep all unrelated files.
<!-- chat-control:plan:start -->
schema_version: 1
run:
  repository: 'C:/work/example'
  worktrees_root: 'C:/work/example-worktrees'
  integration_branch: cc07-example
  max_parallel: 1
tasks:
  - id: A
    depends_on: []
    scope: [src/a.ts]
    conflicts_with: [package-lock]
    agent: {model: model-from-current-catalog, effort: low}
    continuation: {mode: new}
    completion: [test]
  - id: B
    depends_on: [A]
    scope: [src/b.ts]
    conflicts_with: [package-lock]
    agent: {model: model-from-current-catalog, effort: low}
    continuation: {mode: new}
    completion: [test]
<!-- chat-control:plan:end -->
<!-- chat-control:progress:start -->
<!-- chat-control:progress:end -->
```

Select model/effort from the live catalog. Completion strings name required checks. For parallel plans use `max_parallel: 2`, disjoint scope/resources, and include an `integration` check when accepting the merged result. A scope directory covers its descendants. Edit the prose before binding the run. Use the plan change tools for active revisions and `write_progress` for status projection.

## Tool calls

To migrate the example above, set `schema_version: 2` and give each task an `agent.permissionProfileId` of `workspace`. Keep the existing branches, scopes and completion checks. For a higher ceiling, set the requested `run.max_parallel`, propose the increase and wait for the bound human form before starting the additional Workers. Optional `run.execution_limits` can cap wakes or corrections for a trial. Set the dedicated instruction budget separately. An omitted wake or correction limit leaves that counter unlimited.

| Tool | Additional arguments after the operation reference |
|---|---|
| `create_worker` | `taskId` |
| `send_instruction` | `taskId`, `target`, `agent: {model, effort}`, `text` |
| `report` | `taskId`, `report` below |
| `answer_request` | `requestKey`; questions: `answer: {questionId: {answers: ["text"]}}`; human approval: omit `answer` |
| `record_decision` | `taskId`, `decision`, `evidenceRefs` (1–128 alphanumeric, underscore or hyphen characters per reference). Candidate acceptance takes `candidateSha`. Preparation takes `inputCandidateShas`. Integration takes `integrationSha` and `checks`. Review acceptance takes one `reportRef` in `evidenceRefs` and the reviewed SHA in `integrationSha`. Continuation can name `sourceTaskId`. |
| `propose_plan_change` | `expectedPlanHash`, `tasks: [{id, depends_on?, completion?, agent?}]`, `reason`, `alternatives`, `recommendation` |
| `answer_consultation` | `decisionId` to present the human form |
| `hold_task` | `taskId`, `decisionId`, `replacesDecisionId?` for a stale hold reason |
| `apply_plan_change` | `decisionId`, `expectedPlanHash`, `proposedPlanHash` |
| `resume_task` | `taskId`, `resolvedDecisionId` |
| `reconcile_plan` | `expectedFileHash`, `expectedPlanHash` after restoring approved content |
| `write_progress` | `expectedFileHash` |
| `stop_worker` | full `target` |
| `stop_run`, `resume_run` | no additional fields |

Operation reference: `{runId, operationId, expectedRevision}`. Read-only `get_status` takes `{runId, taskId?, afterEventSeq?, attemptOffset?, reportOffset?}` without an operation reference. `start_run` takes only `{planPath, operationId}`.

WorkerRef has five fields: `{ownerId, ownerEpoch, threadId, workerId, attemptId}`. Preserve them exactly as returned. Do not construct them from PIDs or display names.

## Report

Copy each required check name from the task's `completion` list into the instruction and the corresponding `checks[].name`. For example, if `completion` is `["ready"]` and the command is `node checks.mjs A`, report `name: "ready"` and `command: "node checks.mjs A"`. Use the tested commit ID in `checked_sha`.

A version 2 task with `agent.permissionProfileId: read-only` requires a RunPermit that explicitly lists `read-only` in `allowedProfileIds`. Copy the assigned identities, branch and base into the report below. For a completed review set `candidate_sha: null`, `push_result.status: not_attempted`, and `remaining: []`. In `summary` state what you found. For each planned completion check, give the command you used, its result and exit code, the assigned base in `checked_sha`, and a concrete evidence reference such as a repository path and line at that SHA. If the requirement is “identify differences”, finding a difference can satisfy it. If the requirement is “verify the outputs agree”, a difference is a failed check. Report incomplete work as `failed` or ask for missing input with `needs_input`.

```json
{
  "task_id": "A",
  "worker_id": "returned-worker",
  "attempt_id": "returned-attempt",
  "actor_id": "worker.threadId from the reporting attempt",
  "status": "completed",
  "base_sha": "exact assigned Git SHA",
  "candidate_sha": "exact committed Git SHA",
  "branch": "assigned branch",
  "push_result": {"status": "pushed", "remote": "origin", "branch": "assigned branch"},
  "summary": "What changed and why; concise factual result.",
  "checks": [{"name": "test", "command": "npm test", "result": "passed", "exit_code": 0, "evidence_refs": ["local-test-log"], "checked_sha": "exact tested Git SHA"}],
  "remaining": []
}
```

Replace every placeholder with observed data (SHA is 40 or 64 lowercase hex characters). Copy `worker.threadId` from the reporting attempt in `get_status` into `actor_id`. Supply at least one observed evidence reference for each check. On failure use `status: failed`, `candidate_sha: null` when absent, and actual `push_result.status: pushed|failed|not_attempted`; each check retains its actual `passed|failed|not_run` result and exit code or null, even if another step failed. For a question use `status: needs_input` and a nonempty `question`. A successful summary, pushed branch or completed terminal is not acceptance. Coordinator integration checks use the final integration SHA, not the Worker's candidate check records.

Before any check has been attempted, a question report can use `checks: []`. If a check entry is supplied, its `evidence_refs` must contain at least one real reference, including for `not_run`; an empty `evidence_refs: []` is invalid. Plan mode always requires the full structured report. Do not replace a rejected structured report with a summary-only report; inspect the schema and saved operation outcome first.

Use the returned local state/discovery paths for status/stop; never paste the discovery token into a model prompt. Human `authorize` is not a Worker terminal command. Unsupported approvals remain stopped or waiting for their official UI.

For scoped Git permissions, use the exact existing Git paths: `git rev-parse --path-format=absolute --git-common-dir`, `git rev-parse --absolute-git-dir`, and the assigned local bare origin. Request only the paths the operation needs. The worktree directory itself, arbitrary parent directories and network access are outside this approval adapter; do not add them to a Git permission request. The worktree already has its assigned workspace permissions. An unsupported request remains pending and cannot be approved through this adapter.

The pinned Windows MXC acceptance environment has a separate MSYS `sh.exe` limitation for local pushes. See the [CC-06 transport observation](../../../docs/validation/chat-control/CC-06.md): its trial used Git's standard native `receive-pack` through a command-scoped `remote-ext` endpoint to the same approved local bare repository. This is a fixed trial procedure, not a generic transport fallback. Do not change origin, broaden permissions, enable the protocol globally, or interpret a failed push as success.
