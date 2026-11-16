import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WorkerRef } from './contracts.js';

export type RequestKind = 'question' | 'command' | 'file' | 'permissions' | 'connector' | 'elicitation' | 'authentication' | 'unknown';
export type HumanRequest = { delivery?: 'next_turn'; key: string; kind: RequestKind; payloadHash: string; formGeneration: string; worker: WorkerRef; cwd: string; turnId: string | null; requestId: string | number; state: 'pending' | 'unsupported' | 'replied' | 'resolved' | 'cancelled'; detail: string; expiresAt: number | null };
export type HumanResponseRef = Pick<HumanRequest, 'key' | 'payloadHash' | 'formGeneration'>;
export type HumanAction = 'accept' | 'decline' | 'cancel';
const absolutePath = z.string().min(1).max(4096).refine(p => path.isAbsolute(p) && !/[\x00-\x1f]/.test(p));
const filePermissions = z.object({ read: z.array(absolutePath).max(16).nullable(), write: z.array(absolutePath).max(16).nullable(), entries: z.array(z.object({ path: z.object({ type: z.literal('path'), path: absolutePath }).strict(), access: z.enum(['read', 'write']) }).strict()).max(16).optional() }).strict();

function approvalDetail(kind: RequestKind, p: any, grant?: z.infer<typeof filePermissions>): string {
  // Display the validated grant; the original payload remains bound by its hash.
  const line = (value: unknown) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (grant) {
    const paths = (access: 'read' | 'write') => [...new Set([...(grant[access] ?? []), ...(grant.entries ?? []).filter(e => e.access === access).map(e => e.path.path)])];
    return [
      'Git管理領域へのアクセスを許可する要求です。',
      `有効期間: ${kind === 'permissions' ? 'このターンの終了まで（同じターン内の後続コマンドにも適用）' : '今回のコマンド1回'}`,
      `依頼理由（担当の説明）: ${line(p.reason) || '説明なし'}`,
      ...(paths('write').length ? ['書き込み許可は、対象パス内のファイルの作成・変更・削除に適用されます。'] : []),
      ...(kind === 'command' ? [`実行コマンド:\n${p.command}`] : []),
      ...(['write', 'read'] as const).flatMap(access => {
        const values = paths(access);
        return values.length ? [`${access === 'write' ? '書き込み' : '読み取り'}対象:\n${values.map(v => `・${v}`).join('\n')}`] : [];
      }),
      'この要求によるネットワーク権限の追加: なし',
    ].join('\n\n');
  }
  if (kind === 'elicitation') {
    const report = p._meta.tool_name === 'report';
    return [report ? '作業結果を親へ報告する要求です。' : '管理システムから作業状況を取得する要求です。',
      `呼び出す機能: meristem.${p._meta.tool_name}`, '有効期間: 今回の要求1回',
      ...(report ? [`報告内容（担当の説明）: ${line(p._meta.tool_params?.report?.summary) || '要約なし'}`,
        '許可すると報告が記録されます。成果物の採用・Git操作の許可は別の判断です。'] : ['許可すると状態を読み取ります。Git操作の権限は追加されません。']),
    ].join('\n\n');
  }
  return JSON.stringify(p);
}
// Scoped Git grants require human consent. Broad sandbox escape, network,
// session grants, connector consent and arbitrary file-change forms stay unsupported.
export class WorkerRequests {
  private records = new Map<string, HumanRequest>();
  private questions = new Map<string, string[]>();
  private gitGrants = new Map<string, z.infer<typeof filePermissions>>();
  private readonly gitApprovalRoots: string[];
  constructor(private worker: WorkerRef, private cwd: string, private changed: (item: HumanRequest) => void = () => {}, gitApprovalRoots: string[] = [], private environmentId: string | null = null) {
    this.gitApprovalRoots = gitApprovalRoots.map(p => realpathSync(p));
  }
  private scopedGitGrant(input: unknown, canonicalOnly = false): z.infer<typeof filePermissions> | undefined {
    try {
      const grant = z.object({ network: z.null().optional(), fileSystem: filePermissions }).strict().parse(input);
      const requested = [...(grant.fileSystem.read ?? []), ...(grant.fileSystem.write ?? []), ...(grant.fileSystem.entries ?? []).map(e => e.path.path)];
      const normalize = (p: string) => {
        const resolved = realpathSync(p), root = this.gitApprovalRoots.find(r => r.toLowerCase() === resolved.toLowerCase());
        if (!root || canonicalOnly && path.resolve(p).toLowerCase() !== root.toLowerCase()) throw new Error('untrusted Git permission path');
        return root;
      };
      if (!requested.length) return;
      const fs = grant.fileSystem;
      return { read: fs.read?.map(normalize) ?? null, write: fs.write?.map(normalize) ?? null, ...(fs.entries ? { entries: fs.entries.map(e => ({ ...e, path: { ...e.path, path: normalize(e.path.path) } })) } : {}) };
    } catch { return; }
  }
  add(message: any, activeTurn?: string): HumanRequest {
    if (!(typeof message.id === 'string' && message.id.length <= 128 || Number.isSafeInteger(message.id))) throw new Error('invalid server request id');
    const key = JSON.stringify([this.worker.ownerId, this.worker.ownerEpoch, message.id]);
    if (this.records.has(key) || this.records.size >= 32) throw new Error('duplicate or excessive server request');
    const raw = JSON.stringify(message), p = message.params, meta = p?._meta;
    // Local MCP approvals omit connector_id; Codex Apps add it for connectors.
    const checks = {
      method: message.method === 'mcpServer/elicitation/request',
      thread: p?.threadId === this.worker.threadId,
      turn: typeof activeTurn === 'string' && p?.turnId === activeTurn,
      server: p?.serverName === 'meristem', mode: p?.mode === 'form',
      kind: meta?.codex_approval_kind === 'mcp_tool_call',
      connector: meta?.connector_id === undefined || meta.connector_id === 'meristem',
      tool: ['report', 'get_status'].includes(meta?.tool_name),
      confirmation: !meta?.['openai/confirmation'],
      schema: !p?.requestedSchema?.required?.length && p?.requestedSchema?.type === 'object' && p.requestedSchema.properties && !Array.isArray(p.requestedSchema.properties) && Object.keys(p.requestedSchema.properties).length === 0,
      size: Buffer.byteLength(raw) <= 24000,
    };
    const kind: RequestKind = message.method === 'tool/requestUserInput' || meta?.connector_id && meta.connector_id !== 'meristem' ? 'connector'
      : p?.mode === 'openai/userVerification' || /auth|login/i.test(message.method) ? 'authentication'
      : message.method === 'item/commandExecution/requestApproval' ? 'command'
      : message.method === 'item/fileChange/requestApproval' ? 'file'
      : message.method === 'item/permissions/requestApproval' ? 'permissions'
      : message.method === 'item/tool/requestUserInput' && !meta ? 'question'
      : message.method === 'mcpServer/elicitation/request' ? 'elicitation' : 'unknown';
    const question = kind === 'question' && checks.thread && checks.turn && checks.size && typeof p.itemId === 'string'
      && Array.isArray(p.questions) && p.questions.length > 0 && p.questions.length <= 3
      && p.questions.every((q: any) => typeof q.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(q.id) && typeof q.question === 'string' && q.isSecret !== true)
      && new Set(p.questions.map((q: any) => q.id)).size === p.questions.length;
    const grant = ['command', 'permissions'].includes(kind) ? this.scopedGitGrant(kind === 'command' ? p?.additionalPermissions : p?.permissions, kind === 'command') : undefined;
    let sameCwd = false;
    try { sameCwd = typeof p?.cwd === 'string' && realpathSync(p.cwd).toLowerCase() === realpathSync(this.cwd).toLowerCase(); } catch { /* unverified cwd stays unsupported */ }
    const gitChecks = { gitPaths: !!grant, cwd: sameCwd, environment: p?.environmentId == null || this.environmentId !== null && p.environmentId === this.environmentId };
    const gitApproval = Object.values(gitChecks).every(Boolean) && checks.thread && checks.turn && checks.size && typeof p.itemId === 'string' && !!p.itemId && !meta
      && (kind === 'permissions' || (p.kind === undefined || p.kind === 'command') && p.networkApprovalContext == null && (p.proposedNetworkPolicyAmendments == null || Array.isArray(p.proposedNetworkPolicyAmendments) && p.proposedNetworkPolicyAmendments.length === 0) && typeof p.command === 'string' && p.command.trim().length > 0 && (p.availableDecisions == null || Array.isArray(p.availableDecisions) && ['accept', 'decline', 'cancel'].every(d => p.availableDecisions.includes(d))));
    const supported = Object.values(checks).every(Boolean) || question || gitApproval;
    const label = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_\/-]{1,128}$/.test(value) ? value : 'unknown';
    const diagnostic = JSON.stringify({ method: label(message.method), mode: label(p?.mode), failedChecks: Object.entries(['command', 'permissions'].includes(kind) ? { ...checks, ...gitChecks } : checks).filter(([, ok]) => !ok).map(([name]) => name) });
    const item: HumanRequest = { key, kind, expiresAt: Number.isSafeInteger(p?.autoResolutionMs) && p.autoResolutionMs >= 0 ? Date.now() + p.autoResolutionMs : null, payloadHash: createHash('sha256').update(raw).digest('hex'), formGeneration: randomUUID(), worker: { ...this.worker }, cwd: this.cwd, turnId: typeof p?.turnId === 'string' && p.turnId.length <= 128 ? p.turnId : null, requestId: message.id, state: supported ? 'pending' : 'unsupported', detail: supported ? approvalDetail(kind, p, gitApproval ? grant : undefined) : `未対応の要求です。元の要求は保留されています。\n${diagnostic}` };
    if (question) this.questions.set(key, p.questions.map((q: any) => q.id));
    if (gitApproval) this.gitGrants.set(key, grant!);
    this.records.set(key, item); this.changed(structuredClone(item)); return structuredClone(item);
  }
  get blocking(): boolean { return [...this.records.values()].some(r => ['pending', 'unsupported', 'replied'].includes(r.state)); }
  addFollowup(text: string, turnId: string): HumanRequest {
    if (this.blocking || !text.trim() || text.length > 8192 || Buffer.byteLength(JSON.stringify(text)) > 20000) throw new Error('question already pending or invalid');
    const item = this.add({ id: `followup-${randomUUID()}`, method: 'item/tool/requestUserInput', params: { threadId: this.worker.threadId, turnId, itemId: 'reported-question', questions: [{ id: 'reply', question: text }] } }, turnId);
    const stored = this.records.get(item.key)!; stored.delivery = 'next_turn'; this.changed(structuredClone(stored)); return structuredClone(stored);
  }
  retryFollowup(key: string): void {
    const item = this.records.get(key);
    if (!item || item.delivery !== 'next_turn' || item.state !== 'replied') throw new Error('not a retryable followup');
    item.state = 'pending'; this.changed(structuredClone(item));
  }
  list(): HumanRequest[] { return [...this.records.values()].filter(r => !['resolved', 'cancelled'].includes(r.state)).map(r => structuredClone(r)); }
  private pending(key: string): HumanRequest {
    const item = this.records.get(key);
    if (!item || item.state !== 'pending' || item.expiresAt !== null && Date.now() >= item.expiresAt) throw new Error('stale or unsupported request');
    return item;
  }
  present(key: string): HumanRequest {
    const expired = this.records.get(key);
    if (expired?.state === 'pending' && expired.expiresAt !== null && Date.now() >= expired.expiresAt) return { ...structuredClone(expired), state: 'unsupported', detail: '期限切れです。元要求の解決通知を待っています。' };
    const item = this.pending(key); item.formGeneration = randomUUID(); this.changed(structuredClone(item)); return structuredClone(item);
  }
  answerQuestion(key: string, answers: Record<string, { answers: string[] }>, send: (id: string | number, response: unknown) => void): void {
    const item = this.pending(key), ids = this.questions.get(key);
    if (item.kind !== 'question' || !ids || !answers || Object.keys(answers).length !== ids.length || !ids.every(id => Object.hasOwn(answers, id) && Array.isArray(answers[id]?.answers) && answers[id].answers.length > 0 && answers[id].answers.length <= 10 && answers[id].answers.every(a => typeof a === 'string' && a.length <= 8192))) throw new Error('invalid question answer');
    item.state = 'replied'; this.changed(structuredClone(item)); send(item.requestId, { answers });
  }
  answer(ref: HumanResponseRef, action: HumanAction, send: (id: string | number, response: unknown) => void): void {
    const item = this.pending(ref.key);
    if (!['elicitation', 'command', 'permissions'].includes(item.kind) || ref.payloadHash !== item.payloadHash || ref.formGeneration !== item.formGeneration || !['accept', 'decline', 'cancel'].includes(action)) throw new Error('stale or unsupported human response');
    // Consume before I/O. A disconnected response is unknown, never eligible for replay.
    const grant = this.gitGrants.get(item.key);
    if (item.kind !== 'elicitation' && !grant) throw new Error('Git permission scope unavailable');
    // Resolve paths again at consent time, so a replaced directory cannot broaden a grant.
    if (grant && !this.scopedGitGrant({ network: null, fileSystem: grant })) throw new Error('Git permission scope changed');
    item.state = 'replied'; this.changed(structuredClone(item));
    send(item.requestId, item.kind === 'command' ? { decision: action } : item.kind === 'permissions' ? { permissions: action === 'accept' ? { fileSystem: grant } : {}, scope: 'turn' } : { action, content: action === 'accept' ? {} : null, _meta: null });
  }
  resolved(threadId: string, requestId: unknown): void {
    if (threadId !== this.worker.threadId) return;
    const item = this.records.get(JSON.stringify([this.worker.ownerId, this.worker.ownerEpoch, requestId]));
    if (item && item.state !== 'cancelled') { item.state = 'resolved'; this.changed(structuredClone(item)); }
  }
  cancel(): void { for (const item of this.records.values()) if (item.state !== 'resolved') { item.state = 'cancelled'; this.changed(structuredClone(item)); } }
  cancelTurn(turnId: string): void { for (const item of this.records.values()) if (item.turnId === turnId && item.state !== 'resolved') { item.state = 'cancelled'; this.changed(structuredClone(item)); } }
}
