import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOfficialUsage, verifiedUsage, normalizeUsage, UsageReader, admission, UsagePolicy, applyUsage } from '../src/usage.js';
const account = 'a'.repeat(64);
const win = (usedPercent: number) => ({ usedPercent, windowDurationMins: null, resetsAt: null });
const bucket = (used: number) => ({ limitId: 'codex', primary: win(used), secondary: null });
const read = (used: number, allowed: boolean | null = null) => normalizeUsage({ rateLimits: bucket(used), ordinaryUsageAllowed: allowed }, account, 1000);
test('selects the Codex bucket and preserves each window and unknown durations', () => {
  const value = normalizeUsage({ rateLimitsByLimitId: { codex: { ...bucket(80), secondary: { ...win(60), resetsAt: 42, windowDurationMins: 300 } }, other: bucket(100) } }, account, 1000);
  assert.deepEqual(value.windows.map(w => [w.remainingPercent,w.windowDurationMins,w.resetsAt]), [[20,null,null],[40,300,42]]);
  assert.equal(read(80).status, 'ok');
  for (const wire of [{ rateLimitsByLimitId: { other: bucket(0) }, rateLimits: bucket(0) }, { rateLimits: { ...bucket(1), primary: null } }, { rateLimits: bucket(101) }, { rateLimits: bucket(-1) }, {rateLimits: { ...bucket(1), secondary: {} }}]) assert.equal(normalizeUsage(wire, account, 1000).status, 'missing');
});
test('thresholds, expiry, exhaustion and explicit refusal survive unavailable reads', () => {
  const policy = UsagePolicy.parse({});
  for (const [remaining, maximum] of [[21,null],[20,1],[1,1],[0,0]] as const) assert.equal(admission(policy, applyUsage(undefined, read(100-remaining)), 2000).maximum, maximum);
  const denied = applyUsage(undefined, read(10,false));
  const disabled = UsagePolicy.parse({ enabled:false });
  assert.equal(admission(disabled, denied, 2000).maximum, 0);
  assert.equal(admission(policy, applyUsage(denied,read(0)), 2000).maximum,0);
  assert.equal(admission(policy, applyUsage(denied,{...read(0,true),account:'b'.repeat(64)}),2000).maximum,0);
  assert.equal(admission(policy, applyUsage(denied,read(0,true)), 2000).maximum,null);
  assert.equal(admission(policy,applyUsage(applyUsage(undefined,read(100)),{...read(0),status:'missing',windows:[]}), 2000).maximum,0);
  assert.equal(admission(policy,applyUsage(undefined,read(0)),62000).maximum,1);
});
test('only matching ChatGPT user and billing workspace can contribute a snapshot', () => {
  const parent = {identity:{account:{type:'chatgpt', workspaceName:'class'},userId:'u'},limits:{accountId:'w',rateLimits:bucket(1)}};
  assert.equal(verifiedUsage(parent,parent,1000).status,'ok');
  const anonymous = {...parent,limits:{rateLimits:bucket(1)}};
  assert.equal(verifiedUsage(anonymous,anonymous,1000).status,'account_mismatch');
  assert.equal(verifiedUsage(parent,{...parent,limits:{...parent.limits,rateLimits:bucket(100)}},1000).windows[0].remainingPercent,0);
  assert.equal(verifiedUsage(parent,{...parent,limits:{...parent.limits,accountId:'v'}},1000).status,'account_mismatch');
  assert.equal(verifiedUsage(parent,{...parent,identity:{account:{type:'apiKey'}}},1000).status,'account_mismatch');
});
test('official reads distinguish missing API, lost transport and changes during acquisition', async () => {
  const ctx = () => Promise.resolve({usageSequence:1,accountGeneration:0});
  for (const [message,status] of [['method unsupported','unsupported'],['pipe closed','unavailable']]) {
    const result = await readOfficialUsage(ctx,async()=>{throw new Error(message);},async()=>({identity:null,limits:null}),()=>{});
    assert.equal(result.status,status);
  }
  for (const field of ['usageSequence','accountGeneration'] as const) {
    let n=0;
    const result=await readOfficialUsage(async()=>({...await ctx(),[field]:n++}),async()=>({}),async()=>({identity:null,limits:null}),()=>{});
    assert.equal(result.status,field==='usageSequence'?'stale':'account_mismatch');
  }
});
test('parallel refresh is shared and a superseded account response cannot publish', async () => {
  const received: string[] = [];
  let release!: () => void, calls = 0;
  const reader = new UsageReader(async () => { if (++calls === 1) await new Promise<void>(r => { release=r; }); return read(calls); }, v=>received.push(v.status));
  const first = reader.refresh(); const same=reader.refresh(); assert.equal(calls,1);
  reader.invalidate(); reader.invalidate(); release(); await Promise.all([first,same]);
  assert.deepEqual(received,['ok']); assert.equal(calls,2);
});
