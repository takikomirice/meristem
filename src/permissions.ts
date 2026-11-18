import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Id, READ_ONLY_PROFILE, TaskAgent } from './contracts.js';
export { READ_ONLY_PROFILE };

// MC-02 generated ApprovalsReviewer; guardian_subagent has not been accepted for task execution.
const ApprovalsReviewer = z.enum(['user', 'auto_review', 'guardian_subagent']);
const unique = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(16)
  .refine(values => new Set(values).size === values.length, 'duplicate permission entry');
const AbsoluteRoot = z.string().min(1).max(4096).refine(value =>
  path.isAbsolute(value) && !/[\x00-\x1f\x7f-\x9f]/.test(value) &&
  (process.platform !== 'win32' || path.parse(value).root.length > 1 && !/^\\\\[?.]\\/.test(value)),
  'absolute writable root required');
export const RunPermissionPermit = z.object({
  allowedProfileIds: unique(Id), writableRoots: unique(AbsoluteRoot), allowedReviewers: unique(ApprovalsReviewer)
}).strict();
export type RunPermissionPermit = z.infer<typeof RunPermissionPermit>;
export type ResolvedPermissions = { permissionProfileId: string; approvalsReviewer: 'user' | 'auto_review'; writableRoots: string[] };

export function resolveTaskPermissions(taskAgent: TaskAgent, runPermit: RunPermissionPermit, cwd?: string): ResolvedPermissions {
  const agent = TaskAgent.parse(taskAgent), permit = RunPermissionPermit.parse(runPermit);
  if (!['workspace', 'read-only'].includes(agent.permissionProfileId) || !permit.allowedProfileIds.includes(agent.permissionProfileId)) {
    throw new Error('permission profile is unsupported or outside run permit; human decision required');
  }
  const approvalsReviewer = permit.allowedReviewers.includes('auto_review') ? 'auto_review'
    : permit.allowedReviewers.includes('user') ? 'user' : undefined;
  if (!approvalsReviewer) throw new Error('no supported permitted reviewer; human decision required');

  // These are the caller's authorized roots, not paths requested by a worker or inherited grants.
  const writableRoots = permit.writableRoots.map(root => {
    // Match installation's reparse rejection, including aliases in existing ancestors.
    for (let current = path.resolve(root); ; current = path.dirname(current)) {
      if (lstatSync(current).isSymbolicLink()) throw new Error('writable root alias/reparse path rejected');
      if (path.dirname(current) === current) break;
    }
    const canonical = realpathSync(root);
    if (!statSync(canonical).isDirectory() || path.dirname(canonical) === canonical) {
      throw new Error('writable root must be a scoped directory');
    }
    return canonical;
  });
  const keys = writableRoots.map(root => process.platform === 'win32' ? root.toLowerCase() : root);
  if (new Set(keys).size !== keys.length) throw new Error('duplicate writable root');

  const assigned = cwd === undefined ? undefined : realpathSync(cwd);
  if (assigned && !writableRoots.some(root => {
    const relative = path.relative(root, assigned);
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
  })) throw new Error('task cwd outside run permission permit; human decision required');
  if (agent.permissionProfileId === 'read-only') return { permissionProfileId: READ_ONLY_PROFILE, approvalsReviewer, writableRoots: [] };
  return { permissionProfileId: 'meristem-managed', approvalsReviewer, writableRoots: assigned ? [assigned] : writableRoots };
}
