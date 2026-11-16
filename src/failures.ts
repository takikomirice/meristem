export type FailureKind = 'authentication_required' | 'limit_reached' | 'failed';
export class RevisionConflict extends Error {
  constructor() { super('stale revision'); }
}
export class RequestFailure extends Error {
  constructor(readonly kind: FailureKind, readonly delivery: 'rejected' | 'not_sent', readonly method?: string, readonly protocolCode?: number, readonly reason?: string) { super(`${kind}: ${delivery}${method ? ` (${method}, ${protocolCode ?? 'unknown'}, ${reason ?? 'unclassified'})` : ''}`); }
}
export function protocolReason(error: unknown): string | undefined {
  const message = String((error as { message?: unknown })?.message ?? '').toLowerCase();
  // Fixed labels only. Never propagate server text, paths, or credentials.
  if (/thread.*(?:not found|not loaded|not running|does not exist)/.test(message)) return 'thread_runtime_unavailable';
  if (/mcp/.test(message) && /(?:timeout|timed out|starting|initializ)/.test(message)) return 'mcp_startup_pending';
  if (/experimental/.test(message)) return 'experimental_api_required';
  if (/default_permissions/.test(message)) return 'permission_default_required';
  if (/mcp/.test(message)) return 'mcp_inventory_failed';
  return undefined;
}
export function failureKind(error: unknown): FailureKind {
  const value = error as { codexErrorInfo?: unknown; data?: { codexErrorInfo?: unknown } } | undefined;
  const code = value?.codexErrorInfo ?? value?.data?.codexErrorInfo;
  if (code === 'unauthorized') return 'authentication_required';
  if (['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded'].includes(String(code))) return 'limit_reached';
  return 'failed';
}
