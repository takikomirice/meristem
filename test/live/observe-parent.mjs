// Read-only live evidence through the owning broker. Never poll live SQLite:
// rollback-journal readers can block the writer and change the test's outcome.
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { relayRequest, pipeRequest } from '../../dist/src/protocol.js';

const session = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert(session.stage === 'CC-03' && path.resolve(session.root).startsWith(path.resolve('.local/chat-control/CC-03') + path.sep));
const output = path.join(session.root, 'observations.jsonl');
let last = '';
for (let i = 0; i < 7200 && !existsSync(path.join(session.root, 'observer.stop')); i++) {
  let parent, state;
  try {
    const p = await relayRequest(session.parentPipe, 'relay/status');
    parent = { ownerId: p.ownerId, ownerEpoch: p.ownerEpoch, active: p.activeTurns[session.parentThreadId] ?? null, events: p.events, ownedPid: p.ownedPid, wakeGate: p.wakeGate, controlHost: p.controlHost, wakePeerAccepted: p.wakePeerAccepted, wakePeerRejected: p.wakePeerRejected };
  } catch { parent = { disconnected: true }; }
  try {
    const file = path.join(session.stateDirectory, 'discovery.json');
    if (existsSync(file)) {
      const discovery = JSON.parse(readFileSync(file, 'utf8'));
      const status = await pipeRequest(session.pipeName, { ...discovery, method: 'status' });
      const events = await pipeRequest(session.pipeName, { ...discovery, method: 'events', afterSeq: 0, limit: 100 });
      state = { run: status.run, events: events.events, attempts: status.attempts?.map(r => ({ id: r.registration.worker.attemptId, state: r.state, worker: r.registration.worker, hostPid: r.registration.hostPid, childPid: r.registration.childPid, stop: r.stopResult })) };
    }
  } catch { state = { unavailable: true }; }
  const next = JSON.stringify({ parent, state });
  if (next !== last) {
    appendFileSync(output, JSON.stringify({ at: new Date().toISOString(), parent, state }) + '\n');
    last = next;
  }
  await delay(500);
}
