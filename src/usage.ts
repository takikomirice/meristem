import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RequestFailure } from './failures.js';

export const UsagePolicy = z.object({ enabled: z.boolean().default(true), threshold: z.number().int().min(1).max(99).default(20), lowMaximum: z.number().int().positive().safe().default(1) }).strict();
export type UsagePolicy = z.infer<typeof UsagePolicy>;
export const ttl = 60_000;
const wireWindow = z.object({ usedPercent: z.number().finite().min(0).max(100), windowDurationMins: z.number().int().positive().safe().nullable(), resetsAt: z.number().int().nonnegative().max(8640000000000).nullable() });
type Window = z.infer<typeof wireWindow> & { name: 'primary' | 'secondary'; remainingPercent: number };
type Status = 'ok' | 'unsupported' | 'account_mismatch' | 'missing' | 'unavailable' | 'stale';
export type Usage = { status: Status; account: string | null; ordinaryUsageAllowed: boolean | null; windows: Window[]; fetchedAt: number };
export type UsageState = { latest: Usage; deniedAccounts: string[]; exhausted: boolean };
export function unavailable(status: Status, now = Date.now()): Usage {
  return { status, account: null, ordinaryUsageAllowed: null, windows: [], fetchedAt: now };
}
function record(input: unknown): Record<string,unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string,unknown> : {};
}
export function normalizeUsage(input: unknown, account: string, now: number): Usage {
  const wire = record(input), mapped = wire.rateLimitsByLimitId != null;
  const bucket = record(mapped ? record(wire.rateLimitsByLimitId).codex : wire.rateLimits);
  const result: Usage = { ...unavailable('missing', now), account, ordinaryUsageAllowed: typeof wire.ordinaryUsageAllowed === 'boolean' ? wire.ordinaryUsageAllowed : null };
  const matches = bucket.limitId === 'codex' || (mapped && bucket.limitId == null) ||
    (!mapped && bucket.limitId === null && (bucket.limitName == null || bucket.limitName === 'codex') && bucket.normalModelSlug == null);
  if (!matches) return result;
  const windows: Window[] = [];
  for (const name of ['primary','secondary'] as const) {
    if (bucket[name] === null) continue;
    const parsed = wireWindow.safeParse(bucket[name]);
    if (!parsed.success) return result;
    windows.push({ name, ...parsed.data, remainingPercent: 100 - parsed.data.usedPercent });
  }
  return windows.length ? { ...result, status:'ok', windows } : result;
}
const identity = z.object({ account: z.object({ type: z.literal('chatgpt'), workspaceName: z.string().nullable().optional(), email: z.string().nullable().optional() }), userId: z.string().nullable().optional() });
export type UsageContext = { identity: unknown; limits: unknown };
export function verifiedUsage(parent: UsageContext, worker: UsageContext, now: number): Usage {
  const key = (context: UsageContext) => {
    const parsed = identity.safeParse(context.identity);
    if (!parsed.success) return null;
    const { account, userId } = parsed.data, backend = record(context.limits).accountId;
    if (!(userId || account.email) || typeof backend !== 'string' || !backend) return null;
    return createHash('sha256').update(JSON.stringify([userId || account.email,account.workspaceName ?? null, backend ?? null])).digest('hex');
  };
  const account = key(parent);
  if (!account || key(worker) !== account) return unavailable('account_mismatch', now);
  const a = normalizeUsage(parent.limits, account, now), b = normalizeUsage(worker.limits, account, now);
  const permissions = [a.ordinaryUsageAllowed,b.ordinaryUsageAllowed];
  const allowed = permissions.includes(false) ? false : permissions.every(v => v === true) ? true : null;
  // Independent official reads can straddle a reset or another session's consumption.
  // Keep the tighter observed percentage and the earliest reset for matching windows.
  const windows = a.windows.map(w => {
    const other = b.windows.find(x => x.name === w.name && x.windowDurationMins === w.windowDurationMins);
    if (!other) return w;
    const resets = [w.resetsAt,other.resetsAt].filter((v): v is number => v !== null);
    return { ...(w.remainingPercent <= other.remainingPercent ? w : other), resetsAt: resets.length ? Math.min(...resets) : null };
  });
  const sameWindows = a.status === 'ok' && b.status === 'ok' && a.windows.length === b.windows.length && b.windows.every(w => a.windows.some(x => x.name === w.name && x.windowDurationMins === w.windowDurationMins));
  if (!sameWindows) {
    const exhausted = [...a.windows,...b.windows].filter(w => w.remainingPercent === 0);
    return { ...a, ordinaryUsageAllowed:allowed, status:exhausted.length ? 'ok' : 'missing', windows:exhausted.slice(0,2) };
  }
  return { ...a, ordinaryUsageAllowed:allowed, windows };
}
type RelayContext = { accountGeneration: number; usageSequence: number };

// Both transports are pinned by the caller. No thread is created for either read.
export async function readOfficialUsage(context: () => Promise<RelayContext>, parentCall: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  readWorker: () => Promise<UsageContext>, observed: (before: RelayContext) => void): Promise<Usage> {
  try {
    const before = await context();
    observed(before);
    const identity = await parentCall('account/read', { refreshToken: false });
    const [limits, worker] = await Promise.all([parentCall('account/rateLimits/read'), readWorker()]);
    const after = await context();
    if (before.accountGeneration !== after.accountGeneration) return unavailable('account_mismatch');
    if (before.usageSequence !== after.usageSequence) return unavailable('stale');
    return verifiedUsage({ identity, limits }, worker, Date.now());
  } catch (error) {
    if (error instanceof Error && error.message === 'usage context mismatch') return unavailable('account_mismatch');
    if ((error instanceof Error && error.message === 'method unsupported') || (error instanceof RequestFailure && error.protocolCode === -32601)) return unavailable('unsupported');
    return unavailable('unavailable');
  }
}
export function applyUsage(previous: UsageState | undefined, latest: Usage): UsageState {
  if (previous && latest.fetchedAt < previous.latest.fetchedAt) return previous;
  if (latest.status === 'ok' && expiresAt(latest) <= latest.fetchedAt) latest = { ...latest, status:'stale' };
  const deniedAccounts = new Set(previous?.deniedAccounts ?? []);
  if (latest.ordinaryUsageAllowed === false && latest.account) deniedAccounts.add(latest.account);
  else if (latest.status === 'ok' && latest.account && latest.ordinaryUsageAllowed === true) deniedAccounts.delete(latest.account);
  const exhausted = latest.status === 'ok' ? latest.windows.some(w => w.remainingPercent === 0) : previous?.exhausted ?? false;
  return { latest, deniedAccounts:[...deniedAccounts], exhausted };
}
export function expiresAt(latest: Usage) {
  const resets = latest.windows.flatMap(w => w.resetsAt === null ? [] : [w.resetsAt * 1000]);
  return Math.min(latest.fetchedAt + ttl,...resets);
}
export function admission(policy: UsagePolicy, state: UsageState | undefined, now: number) {
  const latest = state?.latest, status = latest && latest.status === 'ok' && now >= expiresAt(latest) ? 'stale' : latest?.status ?? 'missing';
  if (state?.deniedAccounts.length) return { maximum: 0, reason: 'usage_denied', status };
  if (!policy.enabled) return { maximum: null, reason: 'disabled', status };
  if (state?.exhausted) return { maximum: 0, reason: 'exhausted', status };
  if (status !== 'ok' || !latest) return { maximum: 1, reason: 'usage_unknown', status };
  if (latest.windows.some(w => w.remainingPercent <= policy.threshold)) return { maximum: policy.lowMaximum, reason:'low_remaining', status };
  return { maximum:null, reason:'available', status };
}
// Notifications carry sparse data. Only publish the full read for the newest observed generation.
export class UsageReader {
  private generation = 0;
  private pending?: Promise<void>;
  constructor(private read: () => Promise<Usage>, private publish: (usage: Usage) => void) {}
  invalidate() { this.generation++; }
  refresh(): Promise<void> {
    if (!this.pending) this.pending = this.drain().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async drain() {
    for (;;) {
      const version = this.generation;
      const result = await this.read().catch(() => unavailable('unavailable'));
      if (version === this.generation) { this.publish(result); return; }
    }
  }
}
