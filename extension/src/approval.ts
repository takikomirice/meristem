import type * as vscode from 'vscode';
import type { ManagedSession } from './managed-client';

export async function reviewWorkerRequest(api: typeof vscode, session: ManagedSession): Promise<void> {
  const requests = await session.requests();
  if (!requests.length) { await api.window.showInformationMessage('回答待ちの子の要求はありません。'); return; }
  const selected = await api.window.showQuickPick(requests.map(request => ({ label: `担当 ${request.worker.workerId}`, description: request.detail.split('\n')[0], request })), { title: '子の承認要求を確認', ignoreFocusOut: true });
  if (!selected) return;
  const item = selected.request;
  if (item.kind === 'question') { await api.window.showInformationMessage('この質問は親の answer_request から回答してください。'); return; }
  if (item.state !== 'pending') { await api.window.showInformationMessage('この要求には回答できません。未対応または元の解決通知待ちです。', { modal: true, detail: item.detail }); return; }
  const detail = `${item.detail}\n\n作業場所: ${item.cwd}\n\n照合情報（通常は確認不要）\nThread: ${item.worker.threadId}\nTurn: ${item.turnId}\nAttempt: ${item.worker.attemptId}\nRequest: ${item.requestId}\nSHA-256: ${item.payloadHash}\nForm: ${item.formGeneration}`.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  const allow = { title: item.kind === 'permissions' ? 'このターンだけ許可' : '今回だけ許可' }, decline = { title: '拒否' }, cancel = { title: item.kind === 'permissions' ? '付与せず終了' : '要求を取消' };
  const answer = await api.window.showInformationMessage(`担当 ${item.worker.workerId} の要求を許可しますか？`, { modal: true, detail }, allow, decline, cancel);
  // Dismissing the form is not a decision and does not resolve the original request.
  if (!answer) return;
  await session.answer(item, answer === allow ? 'accept' : answer === decline ? 'decline' : 'cancel');
  await api.window.showInformationMessage('回答を送信しました。元の要求の解決通知を待っています。');
}
