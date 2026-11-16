// Requires explicit --live even though this runner only accepts disposable fixtures.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { connect as connectRelay } from './relay-client.mjs';

const args = process.argv.slice(2), value = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const caseName=value('--case');
assert(args.includes('--live') && ['fixture-stop','real-child'].includes(caseName) && value('--host-exe') && value('--fixture-root') && value('--evidence'), 'Requires --live, explicit case, host exe, fixture root, and evidence path');
const root = path.resolve(value('--fixture-root')), evidence = path.resolve(value('--evidence'));
assert(root.startsWith(path.resolve('.local/chat-control') + path.sep), 'fixture root must stay below .local/chat-control');
assert(!existsSync(evidence), 'evidence path already exists; choose a new evidence file');
for (const file of [value('--host-exe')]) assert(path.isAbsolute(file) && existsSync(file), 'explicit existing executable paths required');
mkdirSync(root, { recursive: true });
const sha256=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
async function waitForHostExit(host, timeoutMs, message) {
  if(host.exitCode!==null || host.signalCode!==null)return;
  let timer;
  try { await Promise.race([once(host,'close'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),timeoutMs);})]); }
  finally { clearTimeout(timer); }
}
let pipeSlot=0;
function ownerRequest(pipeName,method,params={}) { return new Promise((resolve,reject)=>{
  const slot=pipeSlot++%16, socket=net.connect(`\\\\.\\pipe\\${pipeName}-${slot}`); let data='', settled=false;
  const timer=setTimeout(()=>finish(Error(`worker control request timed out (${method}, slot ${slot})`)),8000);
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)socket.destroy();else socket.end();error?reject(error):resolve(value)};
  socket.setEncoding('utf8'); socket.once('error',error=>finish(error));
  socket.once('connect',()=>socket.write(JSON.stringify({method,...params})+'\n'));
  socket.on('data',chunk=>{data+=chunk;const end=data.indexOf('\n');if(end>=0){try{finish(null,JSON.parse(data.slice(0,end)))}catch(error){finish(error)}}});
  socket.once('close',()=>{if(!settled)finish(Error(`worker control pipe closed without a reply (${method}, slot ${slot})`))});
}); }

if(caseName==='fixture-stop') {
  assert(value('--fixture-exe'),'fixture executable required');
  const fixtureExe=path.resolve(value('--fixture-exe')); assert(existsSync(fixtureExe));
  const runRoot=path.join(root,`fixture-${randomUUID()}`), cwd=path.join(runRoot,'worker'), marker=path.join(cwd,'marker.txt');
  mkdirSync(cwd,{recursive:true}); const pipeName=`meristem-cc00r-${randomUUID()}`;
  const host=spawn(path.resolve(value('--host-exe')),['--mode','fixture','--pipe',pipeName,'--exe',fixtureExe,'--cwd',cwd,'--arg','spawn-ticker','--arg',marker],{windowsHide:true,stdio:'ignore'});
  let result='failed';
  try {
    let status; const until=Date.now()+8000;
    while(Date.now()<until){try{status=await ownerRequest(pipeName,'status');if(status.jobAssigned&&existsSync(marker))break}catch{}await new Promise(r=>setTimeout(r,50));}
    assert(status?.jobAssigned&&existsSync(marker),'worker did not enter its assigned job');
    const stopped=await ownerRequest(pipeName,'stop');assert(stopped.ok&&stopped.processExited,'host acknowledged before process exit');
    result='passed';
  } finally {
    if(host.exitCode===null){const closed=once(host,'close');host.kill();await closed;}
    rmSync(runRoot,{recursive:true,force:true});
    writeFileSync(evidence,JSON.stringify({planRevision:2,testId:'CC-00R-fixture-stop',capturedAt:new Date().toISOString(),evidence_kind:'fixture',route:'extension_parent_cli_workers',result,limitations:['mock Codex fixture only'],artifactHashes:{}},null,2)+'\n');
  }
  console.log(JSON.stringify({result,evidence}));
} else {
  const hostExe=path.resolve(value('--host-exe')), realExe=value('--real-exe'), relaySource=value('--relay-exe');
  assert(realExe&&path.isAbsolute(realExe)&&existsSync(realExe),'explicit installed Codex --real-exe required');
  assert(relaySource&&path.isAbsolute(relaySource)&&existsSync(relaySource),'explicit built CodexRelay.exe required');
  const version=spawnSync(realExe,['--version'],{encoding:'utf8',windowsHide:true});assert.equal(version.status,0,'Codex --version must succeed');
  const oneTurn=args.includes('--one-turn'), authHomeArg=value('--auth-home');
  assert(!oneTurn || (authHomeArg && path.isAbsolute(authHomeArg)), '--one-turn requires an explicit absolute --auth-home');
  assert(!authHomeArg || path.resolve(authHomeArg).startsWith(path.resolve('.local/chat-control/CC-00R')+path.sep), '--auth-home must stay below the CC-00R test root');
  const requestedModel=value('--model'), requestedEffort=value('--effort');
  assert(!oneTurn || (requestedModel && requestedEffort), '--one-turn requires explicit --model and --effort from model/list');
  const runRoot=path.join(root,`real-child-${randomUUID()}`), workerRoot=path.join(runRoot,'worker-A'), cwd=path.join(workerRoot,'work'), home=authHomeArg ? path.resolve(authHomeArg) : path.join(workerRoot,'home');
  mkdirSync(cwd,{recursive:true});mkdirSync(home,{recursive:true});const relayExe=path.join(workerRoot,'CodexRelay.exe');copyFileSync(relaySource,relayExe);
  const childPipe=`meristem-cc00-${randomUUID()}`, ownerPipe=value('--owner-pipe')??`meristem-cc00r-${randomUUID()}`;
  assert(/^meristem-cc00r-[a-zA-Z0-9-]{1,90}$/.test(ownerPipe),'valid explicit owner pipe required');
  writeFileSync(relayExe+'.json',JSON.stringify({realExecutable:realExe,realSha256:sha256(realExe),pipeName:childPipe,allowedCwds:[cwd],testProfile:`CC-00R-${randomUUID()}`},null,2)+'\n');
  const env={...process.env,CODEX_HOME:home};for(const key of Object.keys(env))if(/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|BEARER|CODEX_THREAD_ID|CODEX_TURN_ID/i.test(key))delete env[key];
  const host=spawn(hostExe,['--mode','codex-relay','--pipe',ownerPipe,'--exe',relayExe,'--cwd',cwd,'--fixture-root',workerRoot],{cwd,env,windowsHide:true,stdio:'ignore'});
  const artifactHashes={codex:sha256(realExe),relay:sha256(relayExe),host:sha256(hostExe)};
  let relay, result='failed', account='unknown', threadCreated=false, workerStop=false, detail='';
  let turnEvidence={requested:false,accepted:false,completed:false,delivery:'not_sent'};
  try {
    let status;const until=Date.now()+30000;
    while(Date.now()<until){try{status=await ownerRequest(ownerPipe,'status');if(status.jobAssigned&&status.state==='running')break;}catch{if(host.exitCode!==null)throw Error(`worker host exited early: ${host.exitCode}`);}await new Promise(r=>setTimeout(r,100));}
    assert(status?.jobAssigned&&status.state==='running','real Codex worker did not initialize');
    relay=await connectRelay(childPipe);
    const accountReply=await relay.call('account/read',{refreshToken:false});account=accountReply.result?.account??'unauthenticated';
    assert(!oneTurn || account!=='unauthenticated','refusing model turn: isolated CODEX_HOME is not authenticated');
    const models=await relay.call('model/list');
    const catalog=Array.isArray(models.result?.data)?models.result.data:[];
    const selectedModel=catalog.find(model=>model.model===requestedModel);
    const supportedEfforts=selectedModel?.supportedReasoningEfforts?.map(entry=>entry.reasoningEffort)??[];
    assert(!oneTurn || supportedEfforts.includes(requestedEffort),'refusing model turn: model/effort is not supported by the live catalog');
    const started=await relay.call('thread/start',{cwd,ephemeral:true});
    assert(started.result?.thread?.id,'real Codex did not create a root thread');
    assert.equal(started.result.thread.parentThreadId,null);assert.equal(path.resolve(started.result.thread.cwd).toLowerCase(),cwd.toLowerCase());threadCreated=true;
    const relayStatus=await relay.call('relay/status');assert(relayStatus.result.jobAssigned);assert.equal(relayStatus.result.registeredThreads.length,1);
    if(oneTurn){
      turnEvidence.requested=true;turnEvidence.delivery='sending';
      const turnReply=await relay.call('turn/start',{threadId:started.result.thread.id,input:[{type:'text',text:'Reply exactly "CC-00R ping". Do not use tools or access files.'}],model:requestedModel,effort:requestedEffort});
      assert(turnReply.result?.turn?.id,'turn/start did not return a turn id');
      turnEvidence.accepted=true;turnEvidence.delivery='accepted';
      const turnId=turnReply.result.turn.id, deadline=Date.now()+120000;
      while(Date.now()<deadline){
        const live=await relay.call('relay/status');
        const events=live.result.events??[];
        const completed=events.find(event=>event.method==='turn/completed'&&event.threadId===started.result.thread.id&&event.turnId===turnId);
        if(completed){turnEvidence.completionObserved=true;turnEvidence.completedStatus=completed.status??'unknown';turnEvidence.completed=completed.status==='completed';turnEvidence.delivery=turnEvidence.completed?'completed':'completed_with_failure';break;}
        if(live.result.disabledReason)throw Error('relay disabled while the single authorized model turn was in flight');
        await new Promise(r=>setTimeout(r,250));
      }
      assert(turnEvidence.completed,'single model turn did not reach a confirmed completion; no retry was sent');
    }
    const heldForTerminal=args.includes('--hold-for-terminal');
    if(heldForTerminal){
      console.log(JSON.stringify({readyForTerminal:true,ownerPipe,cwd,workerHostPid:host.pid,threadId:started.result.thread.id,account:account==='unauthenticated'?'unauthenticated':'authenticated',modelCount:Array.isArray(models.result?.data)?models.result.data.length:null}));
      await waitForHostExit(host,10*60*1000,'worker host did not exit after terminal close');
      assert.equal(host.exitCode,0,'worker host must exit cleanly after terminal close');
      workerStop=true;
    } else {
      const stopped=await ownerRequest(ownerPipe,'stop');assert(stopped.ok&&stopped.processExited);workerStop=true;
      await waitForHostExit(host,10000,'worker host did not exit after stop');
    }
    result='passed';
    detail=JSON.stringify({account:account==='unauthenticated'?'unauthenticated':'authenticated',models:catalog.map(model=>({model:model.model,efforts:model.supportedReasoningEfforts?.map(entry=>entry.reasoningEffort)??[]})),selectedModel:oneTurn?requestedModel:'not requested',selectedEffort:oneTurn?requestedEffort:'not requested',turn:turnEvidence,rootThread:true,cwdMatched:true,childJobAssigned:relayStatus.result.jobAssigned,terminalClose:heldForTerminal?'observed':'not exercised'});
  } catch(error) { detail=String(error?.message??error);process.exitCode=1; }
  finally {
    relay?.socket.destroy();
    if(host.exitCode===null){const closed=once(host,'close');host.kill();await closed;}
    const record={planRevision:2,testId:`CC-00R-real-child-${randomUUID()}`,capturedAt:new Date().toISOString(),versions:{node:process.version,codex:version.stdout.trim()},route:'extension_parent_cli_workers',evidence_kind:'real_codex',actorAliases:['worker_A'],workerAttemptIds:['attempt_A'],terminalBindings:['ownerPipe_A'],operationIds:['initialize_A','thread_start_A',...(oneTurn?['turn_start_A']:[]),'stop_A'],eventSeqs:[],requestedAgent:oneTurn?'one explicitly authorized minimal turn':'no inference requested',observedSettings:{model:oneTurn?requestedModel:'not requested',effort:oneTurn?requestedEffort:'not requested',authHome:authHomeArg?'dedicated isolated authenticated test home':'isolated empty fixture home',turn:oneTurn?turnEvidence:{requested:false,accepted:false,completed:false,delivery:'not_sent'}},processIdentities:{owner:'WorkerHost fixture runner',worker:'CodexRelay.exe with verified Codex executable hash'},stopEvidence:{threadCreated,workerStop,workerHostExitCode:host.exitCode},artifactHashes,result,limitations:[...(oneTurn?[]:['No model turn was sent']),(args.includes('--hold-for-terminal')?'Terminal close was externally driven; see companion UI observations':'Dedicated VS Code terminal adapter not exercised by this probe'),'Parent P/B and MCP metadata correlation not exercised'],detail};
    writeFileSync(evidence,JSON.stringify(record,null,2)+'\n');
    if(result==='passed')try{rmSync(runRoot,{recursive:true,force:true})}catch(error){record.cleanup=`scratch cleanup deferred: ${error.code??error.message}`;writeFileSync(evidence,JSON.stringify(record,null,2)+'\n')}
  }
  console.log(JSON.stringify({result,evidence,detail}));
}
