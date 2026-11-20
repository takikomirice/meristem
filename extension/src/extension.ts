import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { connect, OwnerRef, WorkerRef } from './control-client';
import { openWorkerTerminal, refreshWorkerTerminal, showWorkerTerminalDetails, stopWorkerTerminal, workerTerminalFinished } from './terminal';
import type {ControlConnection, TerminalBinding} from './control-client';
import { connectManaged, type HistoryTarget, type ManagedSession } from './managed-client';
import { sidebarTarget, confirmStart, usageText } from './run-window';
import { openManagedTerminal } from './managed-tui';
import { reviewWorkerRequest } from './approval';

const fixtures=new Map<vscode.Terminal,{connection:ControlConnection,binding:TerminalBinding}>();
let managed: ManagedSession | undefined;

async function selectHistory(session: ManagedSession, title: string) {
  let offset: number | null = 0;
  do {
    const page = await session.historyTargets(offset);
    if (!page.targets.length) { await vscode.window.showInformationMessage('この実行に保存されたワーカーの履歴がありません。'); return; }
    const choices: (vscode.QuickPickItem & { target?: HistoryTarget })[] = page.targets.map(target => ({
      label: target.displayName ?? target.worker.workerId, description: `${target.taskId} / ${target.branch}`, detail: `Codex スレッド ${target.worker.threadId} / attempt ${target.worker.attemptId.slice(-8)}`, target
    }));
    if (page.nextOffset !== null) choices.push({ label: 'さらに前のワーカーを表示' });
    const selection = await vscode.window.showQuickPick(choices, { title, matchOnDescription: true, matchOnDetail: true });
    if (!selection || managed !== session) return;
    if (selection.target) return { target: selection.target, revision: page.revision };
    offset = page.nextOffset;
  } while (offset !== null);
}
function historyReason(reason: string) {
  if (reason === 'history_provider_unrecorded') return '以前の記録に Codex のプロバイダー情報がありません。';
  if (reason === 'history_identity_mismatch') return '保存済みのスレッド、プロバイダー、作業場所の照合に失敗しました。';
  if (reason === 'history_execution_mismatch') return 'Codex のターン状態と実行記録の照合に失敗しました。';
  return '保存済みのスレッドを Codex から読み取れませんでした。';
}

export function activate(context: vscode.ExtensionContext): void {
  const historyDocuments = new Map<string, string>();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('meristem-history', {
    provideTextDocumentContent: uri => historyDocuments.get(uri.toString()) ?? ''
  }));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.listPendingDecisions', async () => {
    const session = managed;
    if (!session) { await vscode.window.showInformationMessage('先に実行管理へ接続してください。'); return; }
    try {
      let cursor: string | undefined;
      do {
        const page = await session.pendingDecisions(cursor);
        if (!page.decisions.length) { await vscode.window.showInformationMessage('回答待ちの相談はありません。'); return; }
        const kinds = { consultation: '相談', plan_change: '計画の改訂', parallelism: 'ワーカーの増員' };
        const choices: (vscode.QuickPickItem & { question?: string })[] = page.decisions.map(decision => ({
          label: kinds[decision.kind], description: `${decision.taskIds.join(', ') || '実行全体'} / ${decision.recipient === 'human' ? '人の回答待ち' : 'コーディネーターの回答待ち'}`, detail: decision.question, question: decision.question
        }));
        if (page.nextAfterId !== null) choices.push({ label: '残りの相談を表示' });
        const selection = await vscode.window.showQuickPick(choices, { title: '回答待ちの相談', matchOnDetail: true });
        if (!selection || managed !== session) return;
        if (selection.question !== undefined) {
          await vscode.window.showInformationMessage('回答待ちの相談', { modal: true, detail: selection.question }); return;
        }
        cursor = page.nextAfterId ?? undefined;
      } while (cursor);
    } catch { await vscode.window.showErrorMessage('回答待ちの相談を読み取れません。管理接続を確認してください。'); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.viewWorkerHistory', async () => {
    const session = managed;
    if (!session) { await vscode.window.showInformationMessage('先に実行管理へ接続してください。'); return; }
    try {
      const selected = await selectHistory(session, '閲覧する Codex スレッドを選択');
      if (!selected) return;
      let cursor: string | undefined;
      do {
        const result = await session.history(selected.target.worker, cursor);
        if (result.state === 'history_unavailable') {
          await vscode.window.showWarningMessage(historyReason(result.reason)); return;
        }
        const { threadId, modelProvider, turns, nextCursor } = result.history;
        const uri = vscode.Uri.from({ scheme: 'meristem-history', path: `/${threadId}・${randomUUID().slice(0, 8)}.txt` });
        const statuses: Record<string, string> = { completed: '回答終了', interrupted: '中断', failed: '失敗', inProgress: '進行中の記録' };
        const text = [`Codex スレッド ${threadId}`, `プロバイダー ${modelProvider}`,
          ...turns.flatMap(turn => ['', `${statuses[turn.status] ?? turn.status}（${turn.id}）`, ...turn.messages.map(message => `${message.role === 'user' ? '指示' : 'Codex'}  ${message.text}`)]),
          ...(turns.length ? [] : ['保存済みのターンはありません。'])].join('\n');
        historyDocuments.set(uri.toString(), text);
        try { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true }); }
        finally { historyDocuments.delete(uri.toString()); }
        const older = 'さらに前の履歴を読む';
        cursor = nextCursor && await vscode.window.showInformationMessage('このスレッドには以前の履歴があります。', older) === older ? nextCursor : undefined;
      } while (cursor && managed === session);
    } catch { await vscode.window.showErrorMessage('履歴を読み取れません。管理接続と選択したスレッドを確認してください。'); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.prepareWorkerHistoryResume', async () => {
    const session = managed;
    if (!session) { await vscode.window.showInformationMessage('先に実行管理へ接続してください。'); return; }
    try {
      const selected = await selectHistory(session, '再開元の Codex スレッドを選択');
      if (!selected) return;
      const { target, revision } = selected, confirm = '照合して準備';
      const choice = await vscode.window.showInformationMessage(`工程 ${target.taskId} を再開する準備をしますか？`, { modal: true,
        detail: `Codex スレッド ${target.worker.threadId}\nGit ブランチ ${target.branch}\n\n停止結果と Git を照合し、確認できた作業場所を新しいスレッドへ引き継ぐ準備をします。` }, confirm);
      if (choice !== confirm || managed !== session) return;
      const result = await session.prepareHistoryResume(target.worker, revision);
      if (result.state === 'history_unavailable') {
        await vscode.window.showWarningMessage(`${historyReason(result.reason)} コーディネーターと作業記録を確認し、新しいワーカーへの引継ぎを検討してください。`);
        return;
      }
      await vscode.window.showInformationMessage(`工程 ${result.taskId} の再開を準備しました。コーディネーターがワーカーを作成して指示を送ると作業を開始します。`);
    } catch {
      await vscode.window.showErrorMessage('再開準備を確認できません。コーディネーターで実行の許可、未解決の相談、停止・配送記録と Git の状態を確認してください。');
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.showWorkerDetails', async () => {
    const terminal = vscode.window.activeTerminal;
    if (terminal && fixtures.has(terminal)) {
      showWorkerTerminalDetails(terminal);
      if (workerTerminalFinished(terminal)) await refreshWorkerTerminal(terminal).catch(() => {});
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.listWorkers', async () => {
    const choices = [...fixtures].filter(([, entry]) => !entry.binding.fixture).map(([terminal, { binding }]) => ({
      label: terminal.name, description: binding.presentation?.taskId ?? binding.worker.id,
      detail: `Attempt: ${binding.attemptId.slice(-8)}`, terminal
    }));
    if (!choices.length) { await vscode.window.showInformationMessage('表示できる管理対象ワーカーのターミナルがありません。'); return; }
    const selected = await vscode.window.showQuickPick(choices, { placeHolder: '表示するワーカーを選択' });
    if (selected && fixtures.has(selected.terminal)) selected.terminal.show();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.renameWorker', async () => {
    const terminal = vscode.window.activeTerminal, entry = terminal && fixtures.get(terminal);
    if (!terminal || !entry?.connection.rename) { await vscode.window.showInformationMessage('名前を変更する管理対象ワーカーのターミナルを選択してください。'); return; }
    const displayName = await vscode.window.showInputBox({
      prompt: 'ワーカーの表示名', value: terminal.name,
      validateInput: value => !value.trim() || value.trim().length > 128 || /[\x00-\x1f\x7f-\x9f]/.test(value) ? '表示名は制御文字を含まない1〜128文字で入力してください。' : undefined
    });
    if (displayName === undefined || fixtures.get(terminal) !== entry) return;
    try {
      await entry.connection.rename(entry.binding, displayName);
      await refreshWorkerTerminal(terminal);
    } catch { await vscode.window.showErrorMessage('表示名の変更結果を確認できません。現在の表示名を確認してください。'); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.retireWorker', async () => {
    const entry = vscode.window.activeTerminal && fixtures.get(vscode.window.activeTerminal);
    if (!entry?.connection.retire) { await vscode.window.showInformationMessage('退役する管理対象ワーカーのターミナルを選択してください。'); return; }
    try {
      const result = await entry.connection.retire(entry.binding);
      if (!result.ok) await vscode.window.showErrorMessage('ワーカーの退役を確認できません。停止状態を確認してください。');
    } catch { await vscode.window.showErrorMessage('退役結果が不明です。再送せず停止状態を確認してください。'); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.stopRun', async () => {
    if (!managed) { await vscode.window.showInformationMessage('先に実行管理へ接続してください。ローカルCLIのstopも使用できます。'); return; }
    try {
      const result = await managed.stopRun();
      if (result.run.state !== 'stopped' || result.results.some(item => item.state !== 'stopped')) await vscode.window.showErrorMessage('実行の停止を確認できません。進捗から現在の状態を確認してください。');
      else {
        terminalOwner?.dispose();
        terminalOwner = undefined;
        await vscode.window.showInformationMessage('実行を停止しました。');
      }
    } catch { await vscode.window.showErrorMessage('全体停止を確認できません。ローカルCLIで停止状態を確認してください。'); }
  }));
  let connecting = false, preparingTerminal = false, reviewingStart = false;
  let selectedRepository: string | undefined;
  let terminalOwner: vscode.Disposable | undefined;
  const progress = vscode.window.createStatusBarItem?.();
  if (progress) { progress.command = 'meristem.chatControl.progress'; progress.tooltip = '進捗と承認要求を確認'; context.subscriptions.push(progress); }
  async function reviewStart(session: ManagedSession) {
    if (reviewingStart) return;
    reviewingStart = true;
    try {
      const preview = await session.preview();
      const repository = realpathSync.native(preview.scope.repositoryPath).toLowerCase();
      const stillCurrent = () => managed === session && !session.closed && vscode.workspace.isTrusted
        && (!selectedRepository || repository === selectedRepository)
        && !!vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === 'file' && realpathSync.native(folder.uri.fsPath).toLowerCase() === repository);
      if (!stillCurrent()) throw new Error('start workspace changed');
      await confirmStart(vscode, session, preview, stillCurrent);
    } catch { await vscode.window.showErrorMessage('開始を確認できません。進捗から現在の状態と開始範囲を確認してください。'); }
    finally { reviewingStart = false; }
  }
  async function attach(file: string, expected?: { runId: string; pipeName: string; repository: string; terminalPid?:number }) {
    if (managed || connecting) throw new Error('このウィンドウで実行管理に接続中です。');
    connecting = true;
    let acquired: ManagedSession | undefined;
    try {
      const session = acquired = await connectManaged(file, expected);
      managed = session;
      selectedRepository = expected?.repository;
      let announcedStart: string | undefined, announcedRequests = new Set<string>();
      const opened = new Set<string>(); let refreshing = false;
      const refresh = async () => {
        if (managed !== session || refreshing) return; refreshing = true;
        try {
          const changed = await session.refresh();
          if (managed !== session) return;
          if (selectedRepository && session.pendingStart && session.pendingStart !== announcedStart) {
            announcedStart = session.pendingStart;
            void reviewStart(session);
          }
          const keys = session.approvalKeys ?? [];
          if (expected?.terminalPid === undefined && keys.some(key => !announcedRequests.has(key))) {
            void vscode.window.showInformationMessage('Worker から承認要求が届きました。', '要求を確認').then(choice => {
              if (choice && managed === session) void vscode.commands.executeCommand('meristem.chatControl.reviewRequest');
            });
          }
          announcedRequests = new Set(keys);
          if (progress) {
            progress.text = keys.length ? `$(bell) Meristem 承認待ち ${keys.length}件` : '$(list-tree) Meristem 進捗';
            progress.show();
          }
          for (const entry of session.terminals) {
            if (opened.has(entry.binding.attemptId)) continue;
            opened.add(entry.binding.attemptId);
            const terminal = openWorkerTerminal(vscode, entry.connection, entry.binding);
            fixtures.set(terminal, entry);
            terminal.show(true);
          }
          if (changed) {
            for (const [terminal, { binding }] of fixtures) {
              if (binding.managed && workerTerminalFinished(terminal)) await refreshWorkerTerminal(terminal);
            }
          }
        } finally { refreshing = false; }
      };
      await refresh();
      const timer = setInterval(() => {
        if (session.closed) {
          clearInterval(timer);
          if (managed === session) { managed = undefined; progress?.hide(); }
        } else void refresh().catch(() => {});
      }, 500);
      context.subscriptions.push({ dispose: () => clearInterval(timer) });
      return session;
    } catch (error) {
      acquired?.dispose();
      if (managed === acquired) managed = undefined;
      throw error;
    } finally { connecting = false; }
  }
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.openManaged', async (discoveryUri?: vscode.Uri) => {
    if (managed || connecting || preparingTerminal) { await vscode.window.showInformationMessage('このウィンドウは実行管理に接続済みか、接続中です。'); return; }
    const files = discoveryUri instanceof vscode.Uri && discoveryUri.scheme === 'file' ? [discoveryUri] : await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: '実行管理に接続', filters: { '管理接続情報': ['json'] } });
    if (files?.[0]) try { await attach(files[0].fsPath); }
    catch { await vscode.window.showErrorMessage('実行管理への接続を確認できません。停止状態と接続先を確認してください。'); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.startRun', async () => {
    if (!vscode.workspace.isTrusted) { await vscode.window.showWarningMessage('開始には信頼済みのワークスペースが必要です。'); return; }
    if (managed) {
      if (managed.pendingStart) await reviewStart(managed);
      else await vscode.commands.executeCommand('meristem.chatControl.progress');
      return;
    }
    const roots = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file');
    if (!roots?.length) { await vscode.window.showWarningMessage('開始するリポジトリのフォルダーを開いてください。'); return; }
    const root = roots.length === 1 ? roots[0] : (await vscode.window.showQuickPick(roots.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { title: '開始するリポジトリを選択' }))?.folder;
    if (!root || connecting || preparingTerminal || managed) return;
    const relay = vscode.workspace.getConfiguration('chatgpt').inspect<string>('cliExecutable')?.globalValue;
    if (!relay) {
      const open = '新しい親チャットを開く';
      if (await vscode.window.showWarningMessage('このサイドバーの会話を親として確認できません。同じウィンドウのターミナルで新しい Codex 会話を開始できます。', open) === open)
        await vscode.commands.executeCommand('meristem.chatControl.newTerminalRun');
      return;
    }
    try {
      const target = sidebarTarget(relay, root.uri.fsPath);
      await attach(target.file, target);
      const session = managed as ManagedSession | undefined;
      if (session && !session.pendingStart && !session.started) await vscode.window.showInformationMessage('制御接続を確認しました。親にする Codex 会話から Meristem の開始を指示してください。');
    } catch { await vscode.window.showWarningMessage('このリポジトリと開始元ウィンドウに対応する制御接続を確認できません。'); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.newTerminalRun', async (planUri?:vscode.Uri) => {
    if (!vscode.workspace.isTrusted) { await vscode.window.showWarningMessage('信頼済みのフォルダーを開いてください。'); return; }
    if (managed || connecting || preparingTerminal) { await vscode.window.showInformationMessage('このウィンドウには接続中の実行があります。'); return; }
    const roots = vscode.workspace.workspaceFolders?.filter(f=>f.uri.scheme==='file');
    if (!roots?.length) { await vscode.window.showWarningMessage('作業するフォルダーを開いてください。'); return; }
    preparingTerminal = true;
    try {
      const root = roots.length===1 ? roots[0] : (await vscode.window.showQuickPick(roots.map(folder=>({label:folder.name,description:folder.uri.fsPath,folder})),{title:'作業するフォルダーを選択'}))?.folder;
      if (!root) return;
      const files=planUri instanceof vscode.Uri && planUri.scheme==='file' ? [planUri] : await vscode.window.showOpenDialog({defaultUri:root.uri,canSelectMany:false,filters:{'Meristem の工程表':['md','markdown']},openLabel:'この工程表で新しい親チャットを開く'});
      if (files?.[0]?.scheme!=='file') return;
      terminalOwner = await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Codex のログインとワーカーの作業範囲を確認しています'},()=>
        openManagedTerminal(vscode,context,root.uri.fsPath,files[0].fsPath,target=>attach(target.file,{...target,repository:realpathSync.native(target.repository).toLowerCase()})));
      if (!(managed as ManagedSession | undefined)?.pendingStart) void vscode.window.showInformationMessage('画面下の「Meristem 親チャット」を開きました。開始画面で工程表と作業内容を確認してください。');
    } catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : '新しい親チャットの開始に失敗しました。'); }
    finally { preparingTerminal=false; }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.usage', async () => {
    const session = managed;
    if (!session) { await vscode.window.showInformationMessage('使用状況を表示するには Meristem の実行に接続してください。'); return; }
    try {
      const capacity = await session.usage();
      if (managed === session) await vscode.window.showInformationMessage('Codex の使用状況', { modal: true, detail: usageText(capacity, session.started || !!session.pendingStart) });
    } catch { await vscode.window.showWarningMessage('利用枠を取得できません。実行管理への接続を確認してください。'); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.progress', async () => {
    const session = managed;
    if (!session) { await vscode.window.showInformationMessage('このウィンドウで接続中の実行はありません。'); return; }
    const states: Record<string, string> = { active: session.started ? '実行中' : '開始指示待ち', stopped: '停止済み', needs_reconcile: '停止結果の照合待ち', stopping: '停止中' };
    const choices = [
      ...(session.pendingStart ? [{ label: '開始範囲を確認', command: 'startRun' }] : []),
      { label: 'Worker の承認要求を確認', command: 'reviewRequest' }, { label: 'Worker の一覧', command: 'listWorkers' },
      { label: '回答待ちの相談', command: 'listPendingDecisions' }, { label: 'Codex の使用状況', command: 'usage' }, { label: '実行を停止', command: 'stopRun' }
    ];
    const item = await vscode.window.showQuickPick(choices, { title: `Meristem の進捗　${session.pendingStart ? '開始範囲の確認待ち' : states[session.runState ?? ''] ?? '状態を取得中'}` });
    if (item && managed === session) await vscode.commands.executeCommand('meristem.chatControl.' + item.command);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.reviewRequest', async () => {
    if (!managed) { await vscode.window.showInformationMessage('先に実行管理へ接続してください。'); return; }
    try { await reviewWorkerRequest(vscode, managed); }
    catch { await vscode.window.showErrorMessage('回答を確認できません。要求が古いか、停止済み、または配送結果が不明です。再送せず現在の状態を確認してください。'); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.openFixture', async () => {
    const pipeName = await vscode.window.showInputBox({ prompt: 'CC-00R fixture pipe name', validateInput: value => /^meristem-cc00r-[a-zA-Z0-9-]{1,90}$/.test(value) ? null : 'Fixture pipe required' });
    if (!pipeName) return;
    const worker: WorkerRef = { id: 'fixture', pipeName, cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', branch: 'fixture', agent: 'fixture', state: 'running' };
    const attemptId=randomUUID();
    const owner: OwnerRef = { fixture: true, pipeName, worker, attemptId };
    let connection;
    try {
      connection = await connect(owner);
      const status = await connection.getStatus(worker);
      worker.cwd = status.cwd;
      worker.state = status.state;
      worker.agent=status.agent;worker.branch=status.branch;
      const binding:TerminalBinding={worker,attemptId,fixture:true};
      const terminal = openWorkerTerminal(vscode, connection, binding);
      fixtures.set(terminal,{connection,binding});
      terminal.show();
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : 'unknown';
      await vscode.window.showErrorMessage(`CC-00R fixture control connection failed (${code})`);
      connection?.dispose();
    }
  }));
  context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal=>fixtures.delete(terminal)));
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.stopFixture',async()=>{
    const fixture=vscode.window.activeTerminal&&fixtures.get(vscode.window.activeTerminal);
    if(!fixture)return;
    const result=await stopWorkerTerminal(vscode.window.activeTerminal!);
    if(!result.ok)await vscode.window.showErrorMessage('Worker stop could not be confirmed.');
  }));
}
export async function deactivate(): Promise<void> {
  managed?.dispose(); managed=undefined;
  await Promise.allSettled([...fixtures.values()].filter(entry=>entry.binding.fixture).map(async({connection,binding})=>{await connection.stop(binding);connection.dispose();}));
  fixtures.clear();
}
