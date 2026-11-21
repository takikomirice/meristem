import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { readFileSync, realpathSync, writeFileSync, renameSync, unlinkSync, lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseDocument, visit, isAlias } from 'yaml';
import { z } from 'zod';
import { AgentChoice, Hash, Id, ModelId, DisplayName, ExecutionLimits, ModelRoutingClassification, TaskAgent } from './contracts.js';
import { sameAgentChoice } from './model-routing.js';

export const fileHash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const maxPlanBytes = 262144;
const absolute = z.string().min(1).max(4096).refine(p => path.isAbsolute(p) && !/[\x00-\x1f]/.test(p));
const relative = z.string().min(1).max(512).refine(p => !p.includes('\\') && !p.includes(':') && !p.startsWith('/') && p.split('/').every(s => s && s !== '..' && s !== '.' && s.toLowerCase() !== '.git') && !/[\x00-\x1f*?\[\]]/.test(p));
const Task = z.object({ id: Id, depends_on: z.array(Id).max(128), scope: z.array(relative).min(1).max(128), conflicts_with: z.array(Id).max(128), agent: z.object({ model: ModelId, effort: Id }).strict(), continuation: z.discriminatedUnion('mode', [z.object({ mode: z.literal('new') }).strict(), z.object({ mode: z.literal('same'), after: Id }).strict(), z.object({ mode: z.literal('parent_decides') }).strict()]).default({ mode: 'new' }), completion: z.array(z.string().min(1).max(128)).min(1).max(32) }).strict();
const PlanV1 = z.object({ schema_version: z.literal(1), run: z.object({ repository: absolute, worktrees_root: absolute, integration_branch: z.string().min(1).max(180).refine(b => !['main', 'master'].includes(b.toLowerCase()) && /^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(b) && !b.endsWith('/')), max_parallel: z.number().int().min(1).max(2) }).strict(), tasks: z.array(Task).min(1).max(128) }).strict();
const WorkerModelPolicy = z.object({
  mode: z.enum(['rules', 'learned']),
  candidates: z.array(AgentChoice).min(2).max(4).refine(candidates => new Set(candidates.map(({ model, effort }) => JSON.stringify([model, effort]))).size === candidates.length, 'duplicate model choice')
}).strict();
const PlanV2 = PlanV1.extend({
  schema_version: z.literal(2),
  run: PlanV1.shape.run.extend({ max_parallel: z.number().int().min(1).max(128), execution_limits: ExecutionLimits.default({ maxWakeTurns: null, maxCorrectionsPerTask: null }), worker_model_policy: WorkerModelPolicy.optional() }),
  tasks: z.array(Task.extend({ display_name: DisplayName.optional(), agent: TaskAgent, model_routing: ModelRoutingClassification.optional() })).min(1).max(128)
});
const Plan = z.discriminatedUnion('schema_version', [PlanV1, PlanV2]);
type Plan = z.infer<typeof Plan>;
export type PlanSnapshot = { path: string; fileHash: string; planHash: string; plan: Plan; planText?: string; documentHash?: string };
const TaskChange = Task.pick({ depends_on: true, completion: true }).extend({ agent: Task.shape.agent.or(TaskAgent) }).partial().extend({ id: Id }).strict();
const invisible = /[\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]/u;
const proposalText = z.string().trim().min(1).max(512).refine(value => !/[\x00-\x08\x0b-\x1f]/.test(value) && !invisible.test(value));
export const PlanChange = z.object({
  expectedPlanHash: Hash,
  tasks: z.array(TaskChange).min(1).max(128).refine(tasks => new Set(tasks.map(task => task.id)).size === tasks.length),
  reason: proposalText,
  alternatives: z.array(proposalText).min(1).max(4),
  recommendation: proposalText
}).strict();
export type PlanChange = z.infer<typeof PlanChange>;
export function taskAgent(task: PlanSnapshot['plan']['tasks'][number]): TaskAgent {
  return TaskAgent.parse({ permissionProfileId: 'workspace', ...task.agent });
}
export type TaskState = { state: string; integrationSha?: string; blockedByDecision?: boolean; hold?: { releasedExecutionSlot: boolean } };
function region(text: string, name: 'plan' | 'progress') {
  const start = `<!-- chat-control:${name}:start -->`, end = `<!-- chat-control:${name}:end -->`;
  const a = text.indexOf(start), b = text.indexOf(end);
  if (a < 0 || b < a + start.length || text.indexOf(start, a + 1) !== -1 || text.indexOf(end, b + 1) !== -1) throw new Error(`exactly one ${name} region required`);
  return { from: a + start.length, to: b, text: text.slice(a + start.length, b) };
}
function planDocument(text: string) {
  const doc = parseDocument(text, { version: '1.2', strict: true, uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new Error('invalid YAML');
  let nodes = 0;
  visit(doc, (_key, node) => { if (++nodes > 10000 || isAlias(node) || (node && typeof node === 'object' && 'tag' in node && node.tag)) throw new Error('YAML tags, aliases or complexity rejected'); });
  return doc;
}
function parsePlan(text: string): Plan {
  const plan = Plan.parse(planDocument(text).toJS({ maxAliasCount: 0 }));
  if (plan.schema_version === 2 && plan.run.worker_model_policy) {
    const candidates = plan.run.worker_model_policy.candidates;
    if (plan.tasks.some(task => task.model_routing && !candidates.some(candidate => sameAgentChoice(candidate, task.agent)))) throw new Error('task model choice is outside the approved policy');
  }
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
  return plan;
}
function snapshot(planPath: string, bytes: Buffer): PlanSnapshot {
  if (bytes.length > maxPlanBytes) throw new Error('plan file too large');
  if (!isUtf8(bytes)) throw new Error('plan must be UTF-8');
  const text = bytes.toString('utf8'), area = region(text, 'plan');
  const regions = [area];
  if (text.includes('<!-- chat-control:progress:start -->') || text.includes('<!-- chat-control:progress:end -->')) regions.push(region(text, 'progress'));
  regions.sort((a, b) => a.from - b.from);
  if (regions[1] && regions[0].to >= regions[1].from) throw new Error('overlapping generated regions');
  const prose = regions.map((r, i) => text.slice(regions[i - 1]?.to ?? 0, r.from));
  prose.push(text.slice(regions.at(-1)!.to));
  return { path: planPath, fileHash: fileHash(bytes), planHash: fileHash(area.text), plan: parsePlan(area.text), planText: area.text, documentHash: fileHash(JSON.stringify(prose)) };
}
export function readPlan(planPath: string): PlanSnapshot {
  const canonical = realpathSync(planPath);
  if (statSync(canonical).size > maxPlanBytes) throw new Error('plan file too large');
  return snapshot(canonical, readFileSync(canonical));
}
export function samePlanProse(current: PlanSnapshot, observed: PlanSnapshot): boolean {
  return current.path === observed.path && (current.documentHash === undefined ? current.fileHash === observed.fileHash : current.documentHash === observed.documentHash);
}
export function draftPlanChange(current: PlanSnapshot, input: PlanChange) {
  if (current.planText === undefined) throw new Error('plan YAML unavailable');
  const doc = planDocument(current.planText);
  for (const { id, ...fields } of input.tasks) {
    const index = current.plan.tasks.findIndex(task => task.id === id);
    if (index < 0) throw new Error('unknown plan change task');
    for (const [field, value] of Object.entries(fields)) doc.setIn(['tasks', index, field], value);
  }
  const newline = current.planText.startsWith('\r\n') ? '\r\n' : '\n';
  const planText = newline + doc.toString({ lineWidth: 0 }).replaceAll('\n', newline);
  const draft = snapshot(current.path, revisedPlanFile(current, planText));
  const plan = draft.plan;
  const differences: string[] = [], changed = new Set<string>();
  for (const [index, before] of current.plan.tasks.entries()) {
    const after = plan.tasks[index];
    for (const field of ['agent', 'depends_on', 'completion'] as const) {
      const oldValue = JSON.stringify(before[field]), newValue = JSON.stringify(after[field]);
      if (oldValue === newValue) continue;
      changed.add(before.id);
      differences.push(`${before.id} / ${field}: ${oldValue} → ${newValue}`.replace(new RegExp(invisible.source, 'gu'), char => {
        return char.split('').map(unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join('');
      }));
    }
  }
  if (!changed.size) throw new Error('no plan change');
  // Include dependents in either graph, even if their own row has no edits.
  for (const id of changed) {
    for (const [index, task] of plan.tasks.entries()) {
      if (task.depends_on.includes(id) || current.plan.tasks[index].depends_on.includes(id)) changed.add(task.id);
    }
  }
  return { draft, affected: plan.tasks.filter(task => changed.has(task.id)).map(task => task.id), differences };
}
function revisedPlanFile(current: PlanSnapshot, planText: string): Buffer {
  const before = readFileSync(current.path);
  if (fileHash(before) !== current.fileHash) throw new Error('plan file changed');
  const text = before.toString('utf8'), area = region(text, 'plan');
  return Buffer.from(text.slice(0, area.from) + planText + text.slice(area.to));
}
export function writePlanRevision(current: PlanSnapshot, planText: string): PlanSnapshot {
  const next = revisedPlanFile(current, planText);
  const result = snapshot(current.path, next);
  replacePlanFile(current.path, current.fileHash, next);
  return result;
}
export function eligibleTasks(snapshot: PlanSnapshot, state: Record<string, TaskState>, approvedMaximum = 2): string[] {
  const live = snapshot.plan.tasks.filter(t => ['assigned', 'starting', 'running', 'idle', 'waiting_input', 'waiting_approval', 'interrupt_requested', 'stopping', 'unknown'].includes(state[t.id]?.state) || (state[t.id]?.state === 'held' && !state[t.id].hold?.releasedExecutionSlot));
  if (live.length >= Math.min(snapshot.plan.run.max_parallel, approvedMaximum)) return [];
  const reserved = snapshot.plan.tasks.filter(t => state[t.id]?.hold || live.includes(t));
  return snapshot.plan.tasks.filter(t => !state[t.id]?.blockedByDecision && (!state[t.id] || state[t.id].state === 'pending') && t.depends_on.every(d => state[d]?.state === 'integrated' && state[d].integrationSha)
    && !reserved.some(a => a.id !== t.id && (a.conflicts_with.some(r => t.conflicts_with.includes(r)) || a.scope.some(p => t.scope.some(q => overlaps(p, q)))))).map(t => t.id);
}
export function overlaps(a: string, b: string): boolean { a = a.toLowerCase(); b = b.toLowerCase(); return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); }
export async function writeProgress(planPath: string, expectedFileHash: string, projection: string): Promise<void> {
  if (projection.includes('<!-- chat-control:') || Buffer.byteLength(projection) > 65536) throw new Error('invalid projection');
  const before = readFileSync(planPath), text = before.toString('utf8');
  if (fileHash(before) !== expectedFileHash) throw new Error('plan file changed');
  const area = region(text, 'progress'), plan = region(text, 'plan');
  if (!(area.to < plan.from || plan.to < area.from)) throw new Error('overlapping generated regions');
  const newline = area.text.startsWith('\r\n') ? '\r\n' : '\n';
  const next = text.slice(0, area.from) + newline + projection + newline + text.slice(area.to);
  replacePlanFile(planPath, expectedFileHash, next);
}
function replacePlanFile(planPath: string, expectedFileHash: string, next: string | Buffer): void {
  const stat = lstatSync(planPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('plan symlink or non-file rejected');
  const temp = planPath + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, next, { flag: 'wx', mode: stat.mode, flush: true });
  try {
    if (fileHash(readFileSync(planPath)) !== expectedFileHash) throw new Error('plan file changed');
    renameSync(temp, planPath);
  } finally { try { unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
}
