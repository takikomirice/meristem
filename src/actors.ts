import { z } from 'zod';
import { Owner, Id } from './contracts.js';

export const Actor = Owner.extend({ threadId: Id }).strict();
export type ActorRef = z.infer<typeof Actor>;
export type CallerIdentity = { actor: ActorRef; turnId: string };
export type CallContext = CallerIdentity & { role: 'parent' | 'worker'; runId: string };
const Peer = z.object({ pid: z.number().int().positive(), created: z.string().regex(/^\d+$/) }).strict();
export type VerifiedPeer = z.infer<typeof Peer>;
export type OwnerBinding = CallerIdentity & { peer: VerifiedPeer };
export type RunBinding = { runId: string; parent: ActorRef; workers: ActorRef[] };
export function callerMetadata(metadata: unknown): { threadId: string; turnId: string } {
  const meta = z.object({ 'x-codex-turn-metadata': z.object({ thread_id: Id, turn_id: Id }).passthrough() }).passthrough().safeParse(metadata);
  if (!meta.success) throw new Error('caller identity metadata unavailable');
  return { threadId: meta.data['x-codex-turn-metadata'].thread_id, turnId: meta.data['x-codex-turn-metadata'].turn_id };
}
export function sameActor(a: ActorRef, b: ActorRef): boolean {
  return a.ownerId === b.ownerId && a.ownerEpoch === b.ownerEpoch && a.threadId === b.threadId;
}
export function resolveCallerIdentity(metadata: unknown, verifiedPeer: unknown, ownerBinding: unknown): CallerIdentity {
  const meta = callerMetadata(metadata);
  const peer = Peer.safeParse(verifiedPeer);
  const proof = z.object({ actor: Actor, turnId: Id, peer: Peer }).strict().safeParse(ownerBinding);
  if (!peer.success || !proof.success || peer.data.pid !== proof.data.peer.pid || peer.data.created !== proof.data.peer.created || meta.threadId !== proof.data.actor.threadId || meta.turnId !== proof.data.turnId) throw new Error('caller identity is not verified');
  return { actor: proof.data.actor, turnId: proof.data.turnId };
}
export function resolveCallContext(identity: CallerIdentity, binding: RunBinding): CallContext {
  const role = sameActor(identity.actor, binding.parent) ? 'parent' : binding.workers.some(actor => sameActor(actor, identity.actor)) ? 'worker' : undefined;
  if (!role) throw new Error('caller is not registered in this run');
  return { ...identity, role, runId: binding.runId };
}
