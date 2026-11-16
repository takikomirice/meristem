import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { openWorkerTerminal, sanitize, publishWorkerEvent, stopWorkerTerminal, disposeWorkerTerminal } from '../src/terminal';
import type { ControlConnection, WorkerRef } from '../src/control-client';
import { connect } from '../src/control-client';
import * as controlClient from '../src/control-client';
import { createServer, Socket } from 'node:net';
import { reviewWorkerRequest } from '../src/approval';
test('approval_modal_requires_explicit_human_choice_and_preserves_request_binding', async () => {
  const item = { key: 'key', payloadHash: 'hash', formGeneration: 'generation', worker: { workerId: 'A', attemptId: 'attempt', threadId: 'thread', ownerId: 'owner', ownerEpoch: 'epoch' }, cwd: 'C:\\fixture', turnId: 'turn', requestId: 7, state: 'pending', detail: 'Exact parameters' };
  for (const kind of ['elicitation', 'command', 'permissions']) for (const choice of ['dismiss', 'accept', 'decline', 'cancel']) {
    const request = { ...item, kind };
    const replies: unknown[] = [];
    const session = { requests: async () => [request], answer: async (request: unknown, action: string) => replies.push({ request, action }) } as unknown as import('../src/managed-client').ManagedSession;
    const api = { window: {
      showQuickPick: async (items: any[]) => items[0],
      showInformationMessage: async (_message: string, options: any, ...buttons: unknown[]) => {
        if (!options?.modal) return;
        assert.ok(options.detail.includes('Thread: thread')); assert.ok(options.detail.includes('Request: 7')); assert.ok(options.detail.includes('Exact parameters'));
        assert.match(_message, /担当 A/);
        assert.ok(options.detail.indexOf('Exact parameters') < options.detail.indexOf('照合情報'));
        assert.equal((buttons[0] as { title: string }).title, kind === 'permissions' ? 'このターンだけ許可' : '今回だけ許可');
        return choice === 'dismiss' ? undefined : buttons[['accept', 'decline', 'cancel'].indexOf(choice)];
      }
    } } as unknown as typeof import('vscode');
    await reviewWorkerRequest(api, session);
    assert.deepEqual(replies, choice === 'dismiss' ? [] : [{ request, action: choice }]);
  }
});
test('explicit_stop_close_and_programmatic_dispose_do_not_duplicate_stop', async () => {
  for (const programmatic of [false, true]) {
    let pty: import('vscode').Pseudoterminal | undefined, stops = 0;
    const worker: WorkerRef = { id: 'A', pipeName: 'meristem-cc00r-dedup', cwd: 'fixture', branch: 'fixture', agent: 'mock', state: 'waiting_approval' };
    const connection: ControlConnection = { async readEvents(seq) { return { events: [], lastSeq: seq }; }, async getStatus() { return worker; }, async stop() { stops++; await new Promise(resolve => setTimeout(resolve, 10)); return { ok: true, state: 'stopped' }; }, dispose() {} };
    const api = { window: { createTerminal(options: { pty: import('vscode').Pseudoterminal }) { pty = options.pty; return { show() {}, dispose() { pty!.close?.(); } }; } } } as unknown as typeof import('vscode');
    const terminal = openWorkerTerminal(api, connection, { worker, attemptId: 'attempt' });
    if (programmatic) disposeWorkerTerminal(terminal);
    else { const pending = stopWorkerTerminal(terminal); pty!.close?.(); pty!.close?.(); await pending; }
    await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(stops, programmatic ? 0 : 1);
  }
});

test('control_response_eof_and_oversize_reject_without_hanging',async t=>{
  const pipeName=`meristem-cc00r-response-${process.pid}`;
  const sockets=new Set<Socket>();let oversized=false;
  const servers=Array.from({length:16},(_,slot)=>createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    socket.once('data',()=>socket.end(oversized?'x'.repeat(262145):'{"state":'));
  }).listen('\\\\.\\pipe\\'+pipeName+'-'+slot));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await Promise.all(servers.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});
  await Promise.all(servers.map(server=>new Promise<void>(resolve=>{if(server.listening)resolve();else server.once('listening',resolve);} )));
  const worker:WorkerRef={id:'A',pipeName,cwd:'C:\\fixture',branch:'fixture',agent:'mock',state:'running'};
  const connection=await connect({fixture:true,pipeName,worker,attemptId:'response'});
  for(const big of [false,true]){
    oversized=big;
    await assert.rejects(Promise.race([connection.getStatus(worker),new Promise((_,reject)=>setTimeout(()=>reject(Error('response hung')),500))]),big?/response too large/:/closed before response/);
  }
});

test('terminal display sanitizer strips control sequences and secrets', () => {
  assert.equal(sanitize('\u001b[31mred\u001b[0m Bearer abc123 api_key=secret'), 'red [redacted] [redacted]');
});

test('terminal input never dispatches and a running terminal close stops its bound worker', async () => {
  let pty: import('vscode').Pseudoterminal | undefined, stops=0, reads=0;
  const worker: WorkerRef = { id:'A', pipeName:'meristem-cc00r-fixture', cwd:'C:\\fixture', branch:'fixture', agent:'mock', state:'running' };
  const connection: ControlConnection = {
    async readEvents(afterSeq) { reads++; return { events:[], lastSeq:afterSeq }; },
    async getStatus() { return { cwd:worker.cwd, branch:worker.branch, agent:worker.agent, state:'running' }; },
    async stop(binding) { assert.equal(binding.worker.id,'A'); stops++; return { ok:true,state:'stopped' }; },
    dispose() {}
  };
  const api = { window:{ createTerminal(options: { pty: import('vscode').Pseudoterminal }) { pty=options.pty; return { show() {} }; } } } as unknown as typeof import('vscode');
  openWorkerTerminal(api,connection,{worker,attemptId:'attempt-1',fixture:true});
  pty!.open(undefined);
  pty!.handleInput?.('pasted private input');
  pty!.close?.();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(stops,1);
  assert.equal(reads,1);
});

test('completed terminal close is display only', async () => {
  let pty: import('vscode').Pseudoterminal | undefined, stops=0;
  const worker: WorkerRef = { id:'A', pipeName:'meristem-cc00r-fixture', cwd:'C:\\fixture', branch:'fixture', agent:'mock', state:'completed' };
  const connection: ControlConnection = {
    async readEvents(afterSeq) { return {events:[],lastSeq:afterSeq}; },
    async getStatus() { return {cwd:worker.cwd,branch:worker.branch,agent:worker.agent,state:'completed'}; },
    async stop() { stops++; return {ok:true,state:'stopped'}; }, dispose() {}
  };
  const api = { window:{ createTerminal(options: { pty: import('vscode').Pseudoterminal }) { pty=options.pty; return {show(){}}; } } } as unknown as typeof import('vscode');
  openWorkerTerminal(api,connection,{worker,attemptId:'attempt-1',fixture:true}); pty!.close?.();
  await new Promise(resolve=>setTimeout(resolve,0)); assert.equal(stops,0);
});

test('stale_terminal_binding_cannot_stop_new_attempt', async () => {
  const worker: WorkerRef={id:'A',pipeName:'meristem-cc00r-stale-binding',cwd:'C:\\fixture',branch:'fixture',agent:'mock',state:'running'};
  const connection=await connect({fixture:true,pipeName:worker.pipeName,worker,attemptId:'current-attempt'} as Parameters<typeof connect>[0]);
  await assert.rejects(()=>connection.stop({fixture:true,worker,attemptId:'old-attempt'}),/stale terminal binding/);
});

test('terminal_logs_strip_control_sequences_and_secrets', () => {
  assert.equal(sanitize('safe\u001b]52;c;clipboard\u0007\b\u0000\rsuffix'), 'safesuffix');
  assert.equal(sanitize('safe\u001b]52;c;unfinished'), 'safe');
});

test('large_or_slow_terminal_output_does_not_block_rpc', async () => {
  let pty: import('vscode').Pseudoterminal | undefined, statusRead=false, displayBeforeStatus=false;
  const output: string[]=[];
  const worker: WorkerRef={id:'A',pipeName:'meristem-cc00r-bounds',cwd:'C:\\fixture',branch:'fixture',agent:'mock',state:'completed'};
  const connection: ControlConnection={
    async readEvents() { return {events:Array.from({length:20},(_,i)=>({seq:i+1,worker,text:'あ'.repeat(23000)})),lastSeq:20}; },
    async getStatus() { statusRead=true; return worker; },
    async stop() { assert.fail('completed worker must not stop'); }, dispose() {}
  };
  const api={window:{createTerminal(options:{pty:import('vscode').Pseudoterminal,isTransient:boolean}) {assert.equal(options.isTransient,true);pty=options.pty;return {show(){}};}}} as unknown as typeof import('vscode');
  openWorkerTerminal(api,connection,{worker,attemptId:'bounded',fixture:true});
  pty!.onDidWrite(value=>{ if(value.includes('あ')&&!statusRead) displayBeforeStatus=true; output.push(value); });
  pty!.open(undefined);
  await new Promise(resolve=>setTimeout(resolve,100));
  pty!.close?.();
  assert.equal(displayBeforeStatus,false,'display must not delay status RPC');
  assert.ok(output.some(v=>/events omitted/.test(v)),'queue overflow must be visible');
  assert.ok(output.some(v=>v.includes('あ')));
  assert.ok(output.every(v=>Buffer.byteLength(v)<=65536),'each rendered event must fit 64 KiB including omission text');
  assert.ok(output.filter(v=>v.includes('あ')).reduce((n,v)=>n+Buffer.byteLength(v),0)<=1048576);
  assert.ok(!output.join('').includes('\uFFFD'),'UTF-8 truncation must preserve character boundaries');
});

test('hidden_panel_does_not_stop_worker_or_end_polling_after_100_batches', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let pty: import('vscode').Pseudoterminal | undefined, reads=0,stops=0;
  const worker: WorkerRef={id:'A',pipeName:'meristem-cc00r-hidden',cwd:'C:\\fixture',branch:'fixture',agent:'mock',state:'running'};
  const connection:ControlConnection={async readEvents(afterSeq,limit){assert.equal(limit,100);reads++;return {events:[],lastSeq:afterSeq};},async getStatus(){return worker;},async stop(){stops++;return {ok:true,state:'stopped'};},dispose(){}};
  const api={window:{createTerminal(options:{pty:import('vscode').Pseudoterminal}){pty=options.pty;return {show(){},hide(){}};}}} as unknown as typeof import('vscode');
  const terminal=openWorkerTerminal(api,connection,{worker,attemptId:'hidden',fixture:true});
  pty!.open(undefined);terminal.hide();
  for(let i=0;i<105;i++){for(let j=0;j<5;j++) await Promise.resolve();t.mock.timers.tick(500);}
  assert.ok(reads>100,'100 is a batch size, not a lifetime limit');assert.equal(stops,0);
  pty!.close?.();await Promise.resolve();await Promise.resolve();assert.equal(stops,1);
});

test('unknown_stop_result_keeps_polling_until_confirmed',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let pty:import('vscode').Pseudoterminal|undefined,reads=0;
  const worker:WorkerRef={id:'A',pipeName:'meristem-cc00r-unknown-stop',cwd:'C:\\fixture',branch:'fixture',agent:'mock',state:'running'};
  const connection:ControlConnection={async readEvents(afterSeq){reads++;return {events:[],lastSeq:afterSeq};},async getStatus(){return worker;},async stop(){return {ok:false,state:'unknown'};},dispose(){}};
  const api={window:{createTerminal(options:{pty:import('vscode').Pseudoterminal}){pty=options.pty;return {show(){}};}}} as unknown as typeof import('vscode');
  const terminal=openWorkerTerminal(api,connection,{worker,attemptId:'unknown-stop',fixture:true});
  t.after(()=>pty!.close?.());pty!.open(undefined);await Promise.resolve();await Promise.resolve();
  await stopWorkerTerminal(terminal);const before=reads;
  t.mock.timers.tick(500);await Promise.resolve();await Promise.resolve();
  assert.ok(reads>before,'unknown stop must continue reconciliation');
});

test('display_accepts_exact_64KiB_and_1MiB_and_counts_only_overflow',async()=>{
  for(const count of [16,17]){
    let pty:import('vscode').Pseudoterminal|undefined;
    const output:string[]=[],worker:WorkerRef={id:'A',pipeName:'meristem-cc00r-exact',cwd:'fixture',branch:'fixture',agent:'mock',state:'completed'};
    const connection:ControlConnection={async readEvents(){return {events:Array.from({length:count},(_,i)=>({seq:i+1,worker,text:'x'.repeat(65534)+'\n'})),lastSeq:count};},async getStatus(){return worker;},async stop(){assert.fail('completed');},dispose(){}};
    const api={window:{createTerminal(options:{pty:import('vscode').Pseudoterminal}){pty=options.pty;return {show(){}};}}} as unknown as typeof import('vscode');
    openWorkerTerminal(api,connection,{worker,attemptId:'boundary',fixture:true});pty!.onDidWrite(v=>output.push(v));pty!.open(undefined);
    await new Promise(resolve=>setTimeout(resolve,80));pty!.close?.();
    const logs=output.filter(v=>v.startsWith('x'));assert.equal(logs.length,16);assert.equal(logs.reduce((n,v)=>n+Buffer.byteLength(v),0),1048576);
    assert.ok(logs.every(v=>v.length===65536&&!v.includes('oversized')));
    // The queued header is the first omitted event; a 17th event drops one more.
    assert.ok(output.some(v=>v.includes(`[${count-15} events omitted;`)));
  }
});

test('explicit_stop_and_extension_deactivation_stop_bound_fixture_workers',async t=>{
  const loader=require('node:module');const original=loader._load;
  const commands=new Map<string,()=>Promise<void>>();let stops=0;
  const terminal={show(){}};
  const api={commands:{registerCommand(name:string,handler:()=>Promise<void>){commands.set(name,handler);return {dispose(){}};}},workspace:{workspaceFolders:[]},window:{activeTerminal:terminal,async showInputBox(){return 'meristem-cc00r-lifecycle';},createTerminal(){return terminal;},onDidCloseTerminal(){return {dispose(){}};},async showErrorMessage(){assert.fail('unexpected error');}}};
  t.mock.method(loader,'_load',function(name:string,...args:unknown[]){return name==='vscode'?api:original.call(loader,name,...args);});
  t.mock.method(controlClient,'connect',async()=>({async readEvents(){return {events:[],lastSeq:0};},async getStatus(){return {cwd:'fixture',branch:'fixture',agent:'mock / low (requested)',state:'running'};},async stop(){stops++;return {ok:true,state:'stopped'};},dispose(){}}));
  const extension=require('../src/extension');extension.activate({subscriptions:[]});
  await commands.get('meristem.chatControl.openFixture')!();
  assert.ok(commands.has('meristem.chatControl.stopFixture'));
  await commands.get('meristem.chatControl.stopFixture')!();assert.equal(stops,1);
  await extension.deactivate();assert.equal(stops,2);
  await extension.deactivate();assert.equal(stops,2);
});

test('confirmed_stop_and_published_events_update_the_remaining_terminal',async t=>{
  const loader=require('node:module'),original=loader._load,commands=new Map<string,()=>Promise<void>>(),output:string[]=[];
  let pty:import('vscode').Pseudoterminal|undefined;
  const terminal={show(){}};
  const api={commands:{registerCommand(name:string,handler:()=>Promise<void>){commands.set(name,handler);return {dispose(){}};}},workspace:{workspaceFolders:[]},window:{activeTerminal:terminal,async showInputBox(){return 'meristem-cc00r-state';},createTerminal(options:{pty:import('vscode').Pseudoterminal}){pty=options.pty;return terminal;},onDidCloseTerminal(){return {dispose(){}};},async showErrorMessage(){assert.fail('unexpected error');}}};
  t.mock.method(loader,'_load',function(name:string,...args:unknown[]){return name==='vscode'?api:original.call(loader,name,...args);});
  t.mock.method(controlClient,'connect',async()=>({async readEvents(){return {events:[],lastSeq:0};},async getStatus(){return {cwd:'fixture',branch:'fixture',agent:'mock',state:'running'};},async stop(){return {ok:true,state:'stopped'};},dispose(){}}));
  delete require.cache[require.resolve('../src/extension')];const extension=require('../src/extension');extension.activate({subscriptions:[]});await commands.get('meristem.chatControl.openFixture')!();
  t.after(async()=>{pty?.close?.();await extension.deactivate();});
  let displayed!:()=>void;
  const stoppedDisplayed=new Promise<void>(resolve=>{displayed=resolve;});
  pty!.onDidWrite(text=>{output.push(text);if(text.includes('Worker state: stopped'))displayed();});pty!.open(undefined);await Promise.resolve();await Promise.resolve();
  publishWorkerEvent({seq:1,worker:{id:'fixture',pipeName:'meristem-cc00r-state',cwd:'fixture',branch:'fixture',agent:'mock',state:'running'},text:'safe event'});
  await commands.get('meristem.chatControl.stopFixture')!();
  let deadline:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([stoppedDisplayed,new Promise<void>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('stop state was not rendered')),2000);})]);}
  finally{clearTimeout(deadline);}
  assert.ok(output.some(v=>v.includes('Worker state: stopped')),'confirmed stop must update the visible state even after the host pipe closes');
  assert.ok(output.some(v=>v==='safe event\r\n'),'published events need their own line');
  pty!.close?.();await extension.deactivate();
});
