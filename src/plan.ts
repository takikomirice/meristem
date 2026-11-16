import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { parseDocument, visit, isAlias } from 'yaml';
import { z } from 'zod';
import { Id, ModelId } from './contracts.js';

export const fileHash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const absolute = z.string().min(1).max(4096).refine(p => path.isAbsolute(p) && !/[\x00-\x1f]/.test(p));
const relative = z.string().min(1).max(512).refine(p => !p.includes('\\') && !p.includes(':') && !p.startsWith('/') && p.split('/').every(s => s && s !== '..' && s !== '.' && s.toLowerCase() !== '.git') && !/[\x00-\x1f*?\[\]]/.test(p));
const Task = z.object({ id: Id, depends_on: z.array(Id).max(128), scope: z.array(relative).min(1).max(128), conflicts_with: z.array(Id).max(128), agent: z.object({ model: ModelId, effort: Id }).strict(), continuation: z.discriminatedUnion('mode', [z.object({ mode: z.literal('new') }).strict(), z.object({ mode: z.literal('same'), after: Id }).strict(), z.object({ mode: z.literal('parent_decides') }).strict()]).default({ mode: 'new' }), completion: z.array(z.string().min(1).max(128)).min(1).max(32) }).strict();
const Plan = z.object({ schema_version: z.literal(1), run: z.object({ repository: absolute, worktrees_root: absolute, integration_branch: z.string().min(1).max(180).refine(b => !['main', 'master'].includes(b.toLowerCase()) && /^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(b) && !b.endsWith('/')), max_parallel: z.number().int().min(1).max(2) }).strict(), tasks: z.array(Task).min(1).max(128) }).strict();
export type PlanSnapshot = { path: string; fileHash: string; planHash: string; plan: z.infer<typeof Plan> };
export type TaskState = { state: string; integrationSha?: string };
function region(text: string, name: 'plan' | 'progress') {
  const start = `<!-- chat-control:${name}:start -->`, end = `<!-- chat-control:${name}:end -->`;
  const a = text.indexOf(start), b = text.indexOf(end);
  if (a < 0 || b < a + start.length || text.indexOf(start, a + 1) !== -1 || text.indexOf(end, b + 1) !== -1) throw new Error(`exactly one ${name} region required`);
  return { from: a + start.length, to: b, text: text.slice(a + start.length, b) };
}
export function readPlan(planPath: string): PlanSnapshot {
  const bytes = readFileSync(planPath); if (bytes.length > 262144) throw new Error('plan file too large');
  const text = bytes.toString('utf8'), area = region(text, 'plan');
  const doc = parseDocument(area.text, { version: '1.2', strict: true, uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new Error('invalid YAML');
  let nodes = 0;
  visit(doc, (_key, node) => { if (++nodes > 10000 || isAlias(node) || (node && typeof node === 'object' && 'tag' in node && node.tag)) throw new Error('YAML tags, aliases or complexity rejected'); });
  const plan = Plan.parse(doc.toJS({ maxAliasCount: 0 }));
  const tasks = new Map(plan.tasks.map(task => [task.id, task]));
  if (tasks.size !== plan.tasks.length) throw new Error('duplicate task ID');
  const done = new Set<string>(), visiting = new Set<string>();
  const check = (id: string) => {
    const task = tasks.get(id); if (!task) throw new Error('missing dependency');
    if (visiting.has(id)) throw new Error('dependency cycle'); if (done.has(id)) return;
    visiting.add(id); task.depends_on.forEach(check); visiting.delete(id); done.add(id);
    if (new Set(task.depends_on).size !== task.depends_on.length || new Set(task.completion).size !== task.completion.length) throw new Error('duplicate requirement');
    if (task.continuation.mode === 'same' && (!tasks.has(task.continuation.after) || task.continuation.after === id || !task.depends_on.includes(task.continuation.after))) throw new Error('history source must be a dependency');
  };
  plan.tasks.forEach(task => check(task.id));
  return { path: realpathSync(planPath), fileHash: fileHash(bytes), planHash: fileHash(area.text), plan };
}
export function eligibleTasks(snapshot: PlanSnapshot, state: Record<string, TaskState>): string[] {
  const live = snapshot.plan.tasks.filter(t => ['assigned', 'starting', 'running', 'idle', 'waiting_input', 'waiting_approval', 'interrupt_requested', 'stopping', 'unknown'].includes(state[t.id]?.state));
  if (live.length >= snapshot.plan.run.max_parallel) return [];
  return snapshot.plan.tasks.filter(t => (!state[t.id] || state[t.id].state === 'pending') && t.depends_on.every(d => state[d]?.state === 'integrated' && state[d].integrationSha)
    && !live.some(a => a.conflicts_with.some(r => t.conflicts_with.includes(r)) || a.scope.some(p => t.scope.some(q => overlaps(p, q))))).map(t => t.id);
}
export function overlaps(a: string, b: string): boolean { a = a.toLowerCase(); b = b.toLowerCase(); return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); }
export async function writeProgress(planPath: string, expectedFileHash: string, projection: string): Promise<void> {
  if (projection.includes('<!-- chat-control:') || Buffer.byteLength(projection) > 65536) throw new Error('invalid projection');
  if (lstatSync(planPath).isSymbolicLink()) throw new Error('plan symlink rejected');
  const before = readFileSync(planPath), text = before.toString('utf8');
  if (fileHash(before) !== expectedFileHash) throw new Error('plan file changed');
  const area = region(text, 'progress'), plan = region(text, 'plan');
  if (!(area.to < plan.from || plan.to < area.from)) throw new Error('overlapping generated regions');
  const newline = area.text.startsWith('\r\n') ? '\r\n' : '\n';
  const next = text.slice(0, area.from) + newline + projection + newline + text.slice(area.to);
  const temp = planPath + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, next, { flag: 'wx', mode: lstatSync(planPath).mode });
  try {
    if (fileHash(readFileSync(planPath)) !== expectedFileHash) throw new Error('plan file changed');
    renameSync(temp, planPath);
  } finally { try { unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
}
