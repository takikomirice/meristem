import { isUtf8 } from 'node:buffer';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AgentChoice, Hash, Id, ModelRoutingClassification } from './contracts.js';
import { MODEL_OUTCOME_LIMIT, requiredChecksHash, summarizeModelOutcomes } from './model-routing.js';
import { fileHash, type PlanSnapshot } from './plan.js';
import { pinRepository, repositoryWorktrees } from './git-evidence.js';

const maxBytes = 512 * 1024;
const Sample = z.object({
  runId: Id, attemptId: Id, recordedAt: z.iso.datetime({ precision: 3 }),
  classification: ModelRoutingClassification, requiredChecksHash: Hash,
  phase: z.enum(['initial', 'handoff']), agent: AgentChoice.nullable(),
  result: z.enum(['accepted', 'failed', 'excluded', 'unrated']),
  comparable: z.boolean()
}).strict().refine(row => !row.comparable || (
  row.phase === 'initial' && row.classification.pin_initial === true && !!row.classification.comparison_key &&
  !!row.agent && ['accepted', 'failed'].includes(row.result)
), 'invalid comparison sample');
type Sample = z.infer<typeof Sample>;
const Summary = z.object({
  version: z.literal(1), repositoryKey: Hash, samples: z.array(Sample).max(MODEL_OUTCOME_LIMIT),
  summary: z.array(z.unknown()).max(MODEL_OUTCOME_LIMIT)
}).strict();
export const RoutingSummaryReference = z.object({ path: z.string().min(1).max(4096), sha256: Hash }).strict();
export type RoutingSummaryReference = z.infer<typeof RoutingSummaryReference>;
export type RoutingHistory = ReturnType<typeof loadRoutingSummary>;

const identity = (row: Sample) => row.runId + '/' + row.attemptId;
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const newestFirst = (a: Sample, b: Sample) =>
  compareText(b.recordedAt, a.recordedAt) || compareText(a.runId, b.runId) || compareText(a.attemptId, b.attemptId);

function aggregate(repositoryKey: string, samples: readonly Sample[]) {
  // The current outcome ledger has no measured duration or usage fields.
  // Count missing measurements per agent alongside the stage-1 totals.
  return summarizeModelOutcomes(samples.map(row => ({ ...row, repositoryKey })), true).map(row => {
    const matching = samples.filter(sample => sample.agent?.model === row.agent.model &&
      sample.agent.effort === row.agent.effort && sample.classification.kind === row.classification.kind &&
      sample.classification.complexity === row.classification.complexity &&
      sample.classification.comparison_key === row.classification.comparison_key &&
      sample.requiredChecksHash === row.requiredChecksHash);
    return { ...row, handoffCount: matching.filter(sample => sample.phase === 'handoff').length,
      durationMs: { total: null, unmeasured: matching.length },
      usageTokens: { total: null, unmeasured: matching.length } };
  });
}

export function exportRoutingSummary(directories: readonly string[]) {
  if (!directories.length) throw new Error('routing summary requires a state directory');
  let repositoryKey: string | undefined;
  const recent = new Map<string, Sample>();
  for (const directory of new Set(directories.map(dir => realpathSync(dir)))) {
    const file = path.join(directory, 'control.sqlite');
    if (!lstatSync(file).isFile()) throw new Error('routing state database must be a regular file');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('BEGIN');
      const pins = db.prepare("SELECT DISTINCT json_extract(pin,'$.commonDir') AS commonDir FROM plans").all();
      for (const pin of pins) {
        if (typeof pin.commonDir !== 'string' || !path.isAbsolute(pin.commonDir)) throw new Error('routing repository pin invalid');
        const key = fileHash(pin.commonDir.toLowerCase());
        if (repositoryKey && repositoryKey !== key) throw new Error('routing source repository mismatch');
        repositoryKey = key;
      }
      // Read only confirmed, finalized runs. Plans retain the immutable snapshot
      // for each decision so a later edit cannot turn it into a comparison trial.
      const rows = db.prepare(`
        WITH finalized AS (
          SELECT r.id FROM runs AS r WHERE r.state IN ('completed','stopped')
            AND NOT EXISTS (SELECT 1 FROM operations WHERE run_id=r.id AND state='sent_unknown')
            AND NOT EXISTS (SELECT 1 FROM wake_deliveries WHERE run_id=r.id AND state='sent_unknown')
            AND NOT EXISTS (SELECT 1 FROM requests WHERE run_id=r.id AND state IN ('pending','unsupported','replied'))
            AND NOT EXISTS (SELECT 1 FROM attempts AS a WHERE a.run_id=r.id AND (
              a.state NOT IN ('completed','stopped') OR
              json_extract(a.stop_result,'$.state') IS NOT 'stopped' OR
              COALESCE(json_array_length(a.stop_result,'$.evidenceRefs'),0) = 0 OR
              json_extract(a.registration,'$.worker.attemptId') IS NOT a.id OR
              EXISTS (SELECT 1 FROM json_each(a.registration,'$.worker') AS actor
                WHERE actor.value IS NOT json_extract(a.stop_result,'$.worker.' || actor.key))
            ))
        ), outcomes AS (
          SELECT d.run_id, a.id AS attempt_id, outcome.value
          FROM decisions AS d
          JOIN finalized AS f ON f.id=d.run_id
          JOIN plans AS p ON p.run_id=d.run_id
          JOIN json_each(d.payload,'$.modelOutcomes') AS outcome
          JOIN attempts AS a ON a.run_id=d.run_id AND a.id=json_extract(outcome.value,'$.attemptId')
        )
        SELECT MIN(o.value) AS value, COUNT(DISTINCT o.value) AS versions,
          EXISTS (SELECT 1 FROM plan_revisions AS r, json_each(r.snapshot,'$.plan.tasks') AS task
            WHERE r.run_id=o.run_id AND r.plan_hash=json_extract(o.value,'$.planHash')
              AND json_extract(r.snapshot,'$.plan.schema_version')=2
              AND json_extract(task.value,'$.id')=json_extract(o.value,'$.taskId')
              AND json_extract(task.value,'$.continuation.mode')='new'
              AND json_extract(task.value,'$.model_routing.pin_initial')=1
              AND json_extract(task.value,'$.agent.model')=json_extract(o.value,'$.agent.model')
              AND json_extract(task.value,'$.agent.effort')=json_extract(o.value,'$.agent.effort')) AS ordinary,
          o.run_id, o.attempt_id
        FROM outcomes AS o GROUP BY o.run_id,o.attempt_id
        ORDER BY json_extract(MIN(o.value),'$.recordedAt') DESC,o.run_id,o.attempt_id LIMIT ?
      `).all(MODEL_OUTCOME_LIMIT);
      for (const row of rows) {
        if (row.versions !== 1) throw new Error('conflicting routing outcomes');
        const outcome = JSON.parse(row.value as string);
        if (outcome.repositoryKey !== repositoryKey || outcome.runId !== row.run_id || outcome.attemptId !== row.attempt_id) throw new Error('routing outcome pin mismatch');
        const { runId, attemptId, recordedAt, classification, phase, agent, result } = outcome;
        const names = z.array(z.string().min(1).max(128)).min(1).max(32).parse(outcome.requiredChecks);
        const sample = Sample.parse({ runId, attemptId, recordedAt, classification, phase, agent, result,
          requiredChecksHash: requiredChecksHash(names),
          comparable: !!row.ordinary && phase === 'initial' && !!classification.comparison_key && !!agent && ['accepted','failed'].includes(result) });
        const previous = recent.get(identity(sample));
        if (previous && !isDeepStrictEqual(previous, sample)) throw new Error('conflicting routing outcomes');
        recent.set(identity(sample), sample);
      }
      for (const sample of [...recent.values()].sort(newestFirst).slice(MODEL_OUTCOME_LIMIT)) recent.delete(identity(sample));
    } finally { db.close(); }
  }
  if (!repositoryKey) throw new Error('routing source repository unavailable');
  const samples = [...recent.values()].sort(newestFirst);
  const bytes = Buffer.from(JSON.stringify({ version: 1, repositoryKey, samples, summary: aggregate(repositoryKey, samples) }) + '\n');
  if (bytes.length > maxBytes) throw new Error('routing summary exceeds byte limit');
  return bytes;
}

export function loadRoutingSummary(input: RoutingSummaryReference, repositoryKey: string, protectedRoots: readonly string[]) {
  const reference = RoutingSummaryReference.parse(input);
  // Windows device paths, UNC paths and alternate data streams are outside the
  // local trusted-file contract. Resolve aliases before comparing boundaries.
  const local = (file: string) => path.isAbsolute(file) && !/[\x00-\x1f]/.test(file)
    && (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(file) && !file.slice(2).includes(':') &&
      !file.slice(3).split(/[\\/]/).some(part => /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:[ .]|$)/i.test(part)));
  if (!local(reference.path)) throw new Error('routing summary requires a local absolute path');
  const file = realpathSync.native(reference.path);
  if (!local(file) || protectedRoots.some(root => {
    const relative = path.relative(realpathSync.native(root).toLowerCase(), file.toLowerCase());
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
  })) throw new Error('routing summary path is inside a protected root');
  if (!lstatSync(file).isFile()) throw new Error('routing summary must be a regular file');
  const fd = openSync(file, 'r');
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('routing summary exceeds byte limit');
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    bytes = buffer.subarray(0, offset);
    if (bytes.length > maxBytes || bytes.length !== stat.size) throw new Error('routing summary exceeds byte limit or changed while reading');
  } finally { closeSync(fd); }
  if (fileHash(bytes) !== reference.sha256) throw new Error('routing summary hash mismatch');
  if (!isUtf8(bytes)) throw new Error('invalid routing summary encoding');
  const data = Summary.parse(JSON.parse(bytes.toString('utf8')));
  if (data.repositoryKey !== repositoryKey) throw new Error('routing summary repository mismatch');
  if (new Set(data.samples.map(identity)).size !== data.samples.length) throw new Error('duplicate routing summary sample');
  if (!isDeepStrictEqual(data.summary, aggregate(repositoryKey, data.samples))) throw new Error('routing summary totals mismatch');
  const stats = summarizeModelOutcomes(data.samples.filter(row => row.comparable).map(row => ({ ...row, repositoryKey })));
  return { reference: { path: file, sha256: reference.sha256 }, repositoryKey, stats };
}

export function loadPlanRoutingSummary(reference: RoutingSummaryReference, snapshot: PlanSnapshot, runId: string, authHome: string) {
  if (snapshot.plan.schema_version !== 2 || !snapshot.plan.run.worker_model_policy) throw new Error('routing summary requires a worker model policy');
  const pin = pinRepository(snapshot, runId);
  return loadRoutingSummary(reference, fileHash(pin.commonDir.toLowerCase()), [
    pin.repository, pin.root, pin.commonDir, authHome, ...repositoryWorktrees(pin)
  ]);
}
