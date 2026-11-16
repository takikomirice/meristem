import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { connect, OwnerRef, WorkerRef } from './control-client';
import { openWorkerTerminal, stopWorkerTerminal } from './terminal';
import type {ControlConnection, TerminalBinding} from './control-client';
import { connectManaged, ManagedSession } from './managed-client';
import { reviewWorkerRequest } from './approval';

const fixtures=new Map<vscode.Terminal,{connection:ControlConnection,binding:TerminalBinding}>();
let managed: ManagedSession | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('meristem.chatControl.openManaged', async (discoveryUri?: vscode.Uri) => {
    if (managed) { await vscode.window.showInformationMessage('このウィンドウは実行管理に接続済みです。'); return; }
    const files = discoveryUri instanceof vscode.Uri && discoveryUri.scheme === 'file' ? [discoveryUri] : await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: '実行管理に接続', filters: { '管理接続情報': ['json'] } });
    if (!files?.[0]) return;
    try {
      managed = await connectManaged(files[0].fsPath);
      const opened = new Set<string>(); let refreshing = false;
      const refresh = async () => {
        if (!managed || refreshing) return; refreshing = true;
        try {
          await managed.refresh();
          for (const entry of managed.terminals) {
            if (opened.has(entry.binding.attemptId)) continue;
            opened.add(entry.binding.attemptId);
            const terminal = openWorkerTerminal(vscode, entry.connection, entry.binding); fixtures.set(terminal, entry); terminal.show();
          }
        } finally { refreshing = false; }
      };
      await refresh();
      const timer = setInterval(() => { void refresh().catch(() => {}); }, 500);
      context.subscriptions.push({ dispose: () => clearInterval(timer) });
    } catch { await vscode.window.showErrorMessage('実行管理への接続を確認できません。停止状態と接続先を確認してください。'); }
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
