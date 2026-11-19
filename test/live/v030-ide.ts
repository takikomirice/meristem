import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pipeRequest, relayRequest } from '../../src/protocol.js';

// Passive readback of an already running test window. This probe never opens a chat.
const [configFile, expectedThread] = process.argv.slice(2);
if (!configFile || !path.isAbsolute(configFile) || !expectedThread) throw new Error('Supply the test control config and the independently recorded thread ID');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
if (config.mcp.parentRelay.mode !== 'verified-start' || (config.mcp.parentRelay.sessionKind ?? 'vscode') !== 'vscode') throw new Error('Expected a verified VS Code session');
const discovery = JSON.parse(readFileSync(path.join(config.stateDirectory, 'discovery.json'), 'utf8'));
if (discovery.runId !== config.runId || discovery.pipeName !== config.pipeName) throw new Error('Discovery changed');
const relay = await relayRequest(config.mcp.parentRelay.pipeName, 'relay/status');
const status = await pipeRequest(config.pipeName, { ...discovery, method: 'status', registrationOnly: true });
const binding = status.binding as { parent: string; state: string } | undefined;
const parent = binding && JSON.parse(binding.parent);
const starts = relay.events.filter((event: { method: string }) => event.method === 'ui/turn/start');
const acknowledgements = relay.events.filter((event: { method: string }) => event.method === 'turn/start/acked');
console.log(JSON.stringify({
  managementEnabled: relay.managementEnabled,
  expectedConversationObserved: relay.observedThreads.includes(expectedThread),
  observedConversationCount: relay.observedThreads.length,
  bindingState: binding?.state ?? 'none',
  expectedConversationBound: !!parent && parent.threadId === expectedThread && parent.ownerId === relay.ownerId && parent.ownerEpoch === relay.ownerEpoch,
  runState: (status.run as { state: string }).state,
  visibleUiTurnStarts: starts.length,
  visibleStartsInOtherThreads: starts.filter((event: { threadId: string }) => event.threadId !== expectedThread).length,
  acknowledgedStartsInOtherThreads: acknowledgements.filter((event: {threadId:string}) => event.threadId !== expectedThread).length,
  firstRetainedEventSequence: relay.events[0]?.seq ?? null
}, null, 2));
