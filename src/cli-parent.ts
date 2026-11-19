import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import { Actor, type ActorRef } from './actors.js';
import { cliPlanChoices, cliRepository, listCliRuns, prepareCliRun, type CliRun } from './cli-setup.js';
import { openCliSession } from './cli-session.js';
import { Decision, Id } from './contracts.js';
import { pipeRequest } from './protocol.js';
import { decisionForm, type HumanRequest } from './requests.js';
import { terminalText } from './terminal-events.js';
import type { Store } from './store.js';

const help = `対象リポジトリのPowerShellで meristem.ps1 start を実行します。
  setup    公式CLIの認証と工程表を確認し、新しいrunを準備
  start    準備したrun、または新しいrunで公式TUIを開く
  resume   保存済みのrunと親会話を選んで明示的に再接続
  status   選んだrunの状態とWorkerの終了結果を表示
  usage    公式の利用枠と同時に動かせるWorker数を表示
別のコンソールに公式TUIが開きます。この管理端末で start（開始の確認）、answer（相談・承認への回答）、stop（停止）が使えます。`;
type ConsoleUI = { ask(text: string): Promise<string>; show(text: string): void };
type Request = (method: string, params?: Record<string, unknown>) => Promise<Record<string, any>>;
type ParentControl = { request: Request; parent(threadId: string): Promise<ActorRef> };
const line = (value: string) => terminalText(value, 65536);

async function select<T>(ui: ConsoleUI, title: string, items: T[], label: (item: T) => string): Promise<T | undefined> {
  if (!items.length) { ui.show('選択できる項目がありません。'); return; }
  ui.show(title);
  items.forEach((item, i) => ui.show(`${i + 1}. ${line(label(item))}`));
  const answer = (await ui.ask('番号を入力（Enterで戻る）> ')).trim();
  if (!answer) return;
  const index = /^[1-9]\d*$/.test(answer) ? Number(answer) - 1 : -1;
  if (index < 0 || index >= items.length) throw new Error('表示された番号を選んでください。');
  return items[index];
}

function savedParent(run: CliRun) {
  const file = path.join(run.stateDirectory, 'control.sqlite');
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT parent FROM run_bindings WHERE run_id=?').get(run.runId);
    return row && Actor.parse(JSON.parse(String(row.parent)));
  } finally { db.close(); }
}

function runLabel(run: CliRun) { return `${path.relative(run.repository, run.planPath)}  [${run.runId}]`; }
function showSavedStatus(run: CliRun, ui: ConsoleUI) {
  const db = new DatabaseSync(path.join(run.stateDirectory, 'control.sqlite'), { readOnly: true });
  try {
    const record = db.prepare('SELECT state FROM runs WHERE id=?').get(run.runId);
    if (!record) throw new Error('選んだrunの保存記録を確認できません。');
    ui.show(`管理接続に到達できません。最後に保存されたrunの状態  ${line(String(record.state))}`);
    for (const row of db.prepare('SELECT id, state, stop_result FROM attempts WHERE run_id=?').iterate(run.runId)) {
      const stop = row.stop_result && JSON.parse(String(row.stop_result));
      ui.show(`${line(String(row.id))}  記録 ${line(String(row.state))}  終了結果 ${stop ? line(stop.state) : '確認記録なし'}`);
    }
  } finally { db.close(); }
}
async function prepare(repository: string, ui: ConsoleUI) {
  const plans = cliPlanChoices(repository);
  if (!plans.length) throw new Error('このリポジトリを対象にした版2の工程表が見つかりません。');
  const plan = plans.length === 1 ? plans[0] : await select(ui, 'このrunで使う工程表', plans, file => path.relative(repository, file));
  if (!plan) return;
  const run = prepareCliRun(repository, plan);
  ui.show(`準備したrun  ${line(runLabel(run))}`);
  return run;
}

function capacityText(capacity: ReturnType<Store['capacity']>) {
  const reasons: Record<string,string> = { available: '割当可能', disabled: '残量による制限なし', exhausted: '利用枠を使い切りました', usage_denied: '公式サービスが利用を制限中', low_remaining: '残量低下のため人数を制限中', usage_unknown: '残量を取得できず人数を制限中' };
  return [`Worker 稼働中 ${capacity.activeWorkers}人 ／ 実効上限 ${capacity.effectiveMaximum}人（${reasons[capacity.reason] ?? capacity.reason}）`,
    `最終取得 ${capacity.fetchedAt === null ? '取得記録なし' : new Date(capacity.fetchedAt).toLocaleString()}`,
    ...capacity.windows.map(w => `${w.windowDurationMins === null ? '期間不明' : w.windowDurationMins + '分間'}の枠  残り${w.remainingPercent}％  リセット ${w.resetsAtLocal ?? '不明'}${capacity.usageStatus === 'ok' ? '' : '（前回の値）'}`)].join('\n');
}

async function status(request: Request, ui: ConsoleUI) {
  let page = await request('status');
  ui.show(`run ${line(page.run.id)}  ${line(page.run.state)}  ／  ${page.binding?.state === 'consumed' ? '開始許可を記録済み' : '開始許可を待っています'}`);
  ui.show(capacityText(page.capacity));
  for (;;) {
    for (const item of page.attempts) ui.show(`${line(item.registration.taskId)}  ${line(item.state)}${item.stopResult ? '  終了結果 ' + line(item.stopResult.state) : ''}`);
    if (page.nextAttemptOffset == null) return;
    page = await request('status', { attemptOffset: page.nextAttemptOffset });
  }
}

export async function confirmCliParent(control: ParentControl, ui: ConsoleUI) {
  const snapshot = await control.request('status');
  if (!snapshot.binding) { ui.show('公式TUIの親にする会話で「Meristemを開始して」と指示してください。開始要求が届いたら、この端末で start を入力します。'); return; }
  const parent = await control.parent(Actor.parse(JSON.parse(snapshot.binding.parent)).threadId);
  const preview = await control.request('preview_parent_start', { parent });
  if (preview.state === 'active' && snapshot.binding.state === 'consumed' && snapshot.binding.scope_hash === preview.scopeHash) {
    ui.show('この親と範囲には開始許可が記録されています。'); return;
  }
  const resume = preview.state === 'stopped' || preview.state === 'needs_reconcile';
  ui.show(`run ${line(preview.runId)}  親の会話 ${line(parent.threadId)}`);
  // Render the broker's preview; the confirmation below carries the hash of that exact scope.
  const scope = preview.scope, plan = scope.planScope;
  if (plan) {
    ui.show([`リポジトリ  ${line(scope.repositoryPath)}`, `工程表  ${line(scope.planPath)}（版${plan.planVersion}）`,
      `工程表のハッシュ  ${line(scope.planHash)}`, `統合ブランチ  ${line(plan.integrationBranch)}`,
      `Git送信先  ${line(plan.gitDestination)}`, `Workerの作業場所  ${line(plan.worktreesRoot)}`,
      `Worker数  希望${plan.requestedMaximum}人 ／ 開始時の承認上限${plan.approvedMaximum}人`].join('\n'));
    if (plan.scopedGitSave) ui.show('Workerの割当ブランチへのコミットと、表示された送信先へのpushを許可します。');
    if (scope.permissionPermit) ui.show(`許可する権限  ${line(scope.permissionPermit.allowedProfileIds.join(', '))}  ／  承認担当  ${line(scope.permissionPermit.allowedReviewers.join(', '))}\n書き込み先  ${line(scope.permissionPermit.writableRoots.join(', '))}`);
    if (scope.modelRouting) ui.show('モデルの選択範囲\n' + line(JSON.stringify(scope.modelRouting)));
  } else ui.show(JSON.stringify(scope, null, 2).split('\n').map(line).join('\n'));
  if ((await ui.ask(resume ? 'この範囲で再開しますか [y/N] ' : 'この範囲で開始しますか [y/N] ')).trim().toLowerCase() !== 'y') return;
  const result = await control.request(resume ? 'resume_parent' : 'start_parent', { parent, scopeHash: preview.scopeHash, operationId: randomUUID(), ...(resume && { stopGeneration: preview.stopGeneration }) });
  ui.show(`親の会話を確認しました。runの状態  ${line(result.state)}`);
}

async function answerPending(request: Request, ui: ConsoleUI) {
  type Choice = { kind: 'decision'; id: string; label: string } | { kind: 'request'; item: HumanRequest; label: string };
  const choices: Choice[] = [];
  let afterDecisionId: string | undefined, requestOffset = 0;
  do {
    const page = await request('status', { pendingDecisions: true, afterDecisionId });
    for (const d of page.decisions) if (d.recipient === 'human') choices.push({ kind: 'decision', id: Id.parse(d.id), label: d.question });
    afterDecisionId = page.nextAfterId;
  } while (afterDecisionId);
  for (;;) {
    const page = await request('requests', { requestOffset });
    for (const item of page.requests as HumanRequest[]) {
      if (item.state === 'pending' && ['command','permissions','elicitation'].includes(item.kind)) choices.push({ kind: 'request', item, label: `${item.worker.workerId}  ${item.detail}` });
    }
    if (page.nextRequestOffset == null) break;
    requestOffset = page.nextRequestOffset;
  }
  const choice = await select(ui, '回答する相談・追加権限の要求', choices, item => item.label);
  if (!choice) return;
  if (choice.kind === 'request') {
    const { worker, key, payloadHash, formGeneration, cwd, detail } = choice.item;
    ui.show(line(cwd)); ui.show(line(detail));
    const action = await select(ui, '要求への回答', ['accept', 'decline'] as const, value => value === 'accept' ? '許可する' : '拒否する');
    if (!action) return;
    await request('answer_request', { answer: { worker, key, payloadHash, formGeneration, action } });
  } else {
    const presented = await request('present_decision', { decisionId: choice.id });
    const decision = Decision.parse(presented.decision);
    ui.show(line(decisionForm(decision).message));
    const options = decision.options.map(option => ({ label: option.label, id: option.id }));
    if (decision.allowFreeText) options.push({ label: decision.options.length ? '修正案を入力する' : '回答を入力する', id: '' });
    const selected = await select(ui, '回答の選択', options, o => o.label);
    if (!selected) return;
    const answer = selected.id ? { optionId: selected.id } : { text: (await ui.ask('回答（Enterで戻る）> ')).trim() };
    if (!answer.optionId && !answer.text) return;
    await request('answer_decision', { form: presented.form, answer });
  }
  ui.show('回答を送信しました。');
}

async function stopWorkers(request: Request) {
  const stopped = await request('stop');
  const unknown = stopped.results.filter((r: {state: string}) => r.state !== 'stopped');
  if (unknown.length) process.exitCode = 2;
  return unknown.length ? `停止を要求しました。終了を照合できないWorkerが${unknown.length}件あります。` : 'runを停止し、稼働中のWorkerが残っていないことを確認しました。';
}

export async function terminalMain(args: string[]) {
  const command = args[0] ?? 'help';
  if (args.length > 1 || !['setup','start','resume','status','usage','help','--help'].includes(command)) throw new Error(help);
  if (command === 'help' || command === '--help') { console.log(help); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('人が操作しているPowerShellの対話端末から実行してください。');
  const repository = cliRepository();
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const cancel = new AbortController();
  const endInput = () => cancel.abort();
  input.once('SIGINT', endInput);
  input.once('close', endInput);
  const ui: ConsoleUI = { show: text => console.log(text), ask: prompt => input.question(prompt, { signal: cancel.signal }) };
  let session: Awaited<ReturnType<typeof openCliSession>> | undefined, stopMessage: string | undefined, disconnected = false;
  try {
    if (command === 'setup') { await prepare(repository, ui); return; }
    const runs = listCliRuns(repository);
    let run: CliRun | undefined;
    if (command === 'start') {
      const prepared = runs.filter(r => !savedParent(r));
      const selected = prepared.length ? await select(ui, '開始するrun', [...prepared, 'new' as const], r => r === 'new' ? '新しいrunを準備する' : runLabel(r)) : 'new';
      run = selected === 'new' ? await prepare(repository, ui) : selected;
    } else {
      run = await select(ui, '対象のrun', command === 'resume' ? runs.filter(r => savedParent(r)) : runs, runLabel);
    }
    if (!run) return;
    if (command === 'status' || command === 'usage') {
      if (!existsSync(run.discoveryPath)) { ui.show('このrunの管理接続はまだ開かれていません。'); return; }
      const d = JSON.parse(readFileSync(run.discoveryPath, 'utf8'));
      if (d.runId !== run.runId) throw new Error('管理接続と選んだrunが一致しません。');
      const read: Request = async (method, params) => {
        const reply = await pipeRequest(d.pipeName, { ...d, ...params, method }, method === 'usage' ? 50000 : 10000);
        if (!reply.ok) throw new Error('管理端末との接続を確認できません。');
        return reply;
      };
      if (command === 'usage') ui.show(capacityText((await read('usage')).capacity));
      else {
        try { await status(read, ui); }
        catch { showSavedStatus(run, ui); }
      }
      return;
    }
    const threadId = command === 'resume' ? savedParent(run)?.threadId : undefined;
    if (command === 'resume' && !threadId) throw new Error('保存済みの親を照合できません。');
    ui.show(`管理対象  ${line(runLabel(run))}`);
    ui.show(threadId ? '別のコンソールに保存済みの親会話が開いたら、この管理端末で start を入力して再開を確認してください。' : '別のコンソールに開く公式TUIで「Meristemを開始して」と指示し、この管理端末で start を入力して範囲を確認してください。');
    if (cancel.signal.aborted) return;
    session = await openCliSession(run, threadId);
    const owner = session;
    void owner.closed.then(() => { disconnected = true; cancel.abort(); });
    if (!owner.humanControlVerified) throw new Error('人が開いたPowerShellの起動元を確認できません。Windowsの「ファイル名を指定して実行」から powershell.exe を開き、対象フォルダーで実行してください。');
    while (!cancel.signal.aborted && !stopMessage) {
      try {
        const action = (await ui.ask('Meristem [start / status / usage / answer / stop] > ')).trim();
        if (action === 'start') await confirmCliParent(owner, ui);
        else if (action === 'status') await status(owner.request, ui);
        else if (action === 'usage') ui.show(capacityText((await owner.request('usage')).capacity));
        else if (action === 'answer') await answerPending(owner.request, ui);
        else if (action === 'stop') stopMessage = await stopWorkers(owner.request);
        else if (action) ui.show('start、status、usage、answer、stop から選んでください。');
      } catch (error) {
        if (!cancel.signal.aborted) ui.show(line(error instanceof Error ? error.message : '結果を確認できません。状態を照合してください。'));
      }
    }
    if (!disconnected && !stopMessage) stopMessage = await stopWorkers(owner.request);
    await owner.close();
    if (stopMessage) ui.show(stopMessage);
    else showSavedStatus(run, ui);
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError' && cancel.signal.aborted)) throw error;
  } finally {
    input.close();
    if (session) await session.close();
  }
}
