// Explicit CC-00R test broker. No product scheduler, inference retries or approvals.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from './relay-client.mjs';
import { reserveTurn, reserveParentTurns, finalizeOutcome } from './suite-support.mjs';

const args=process.argv.slice(2), arg=k=>args[args.indexOf(k)+1];
assert(args.includes('--live')&&args.includes('--real-exe')&&args.includes('--root')&&args.includes('--auth-home')&&args.includes('--evidence'),'explicit live paths required');
const root=path.resolve(arg('--root')), authHome=path.resolve(arg('--auth-home')), evidence=path.resolve(arg('--evidence'));
assert(root.startsWith(path.resolve('.local/chat-control/CC-00R')+path.sep));
assert(authHome.startsWith(path.resolve('.local/chat-control/CC-00R')+path.sep));
assert(!existsSync(root)&&!existsSync(evidence),'new test root and evidence path required');
const realExe=path.resolve(arg('--real-exe')), build=path.resolve('.local/chat-control-build');
for(const file of [realExe,path.join(build,'CodexWorkerHost.exe'),path.join(build,'CodexRelay.exe')])assert(existsSync(file));
const version=spawnSync(realExe,['--version'],{encoding:'utf8',windowsHide:true});assert.equal(version.status,0);
mkdirSync(root,{recursive:true}); mkdirSync(path.join(root,'budget'));
const budgetRoot=args.includes('--budget-root')?path.resolve(arg('--budget-root')):root;
assert(budgetRoot.startsWith(path.resolve('.local/chat-control/CC-00R')+path.sep)&&existsSync(path.join(budgetRoot,'budget')),'explicit shared test budget required');
const remainingOnly=args.includes('--remaining-only');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const write=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const state={root,authHome,budgetRoot,model:'gpt-6-luna',effort:'low',workers:{},phase:'preparing'};
const record={planRevision:2,testId:`CC-00R-live-suite-${randomUUID()}`,capturedAt:new Date().toISOString(),versions:{node:process.version,codex:version.stdout.trim()},route:'extension_parent_cli_workers',evidence_kind:'real_codex',actorAliases:['A','B','C','P','D'],workerAttemptIds:['A1','B1','C1'],terminalBindings:['A1','B1'],operationIds:[],eventSeqs:[],requestedAgent:{model:state.model,effort:state.effort,maxAdditionalTurns:6},observedSettings:{},processIdentities:{},stopEvidence:{},artifactHashes:{codex:hash(realExe),relay:hash(path.join(build,'CodexRelay.exe')),host:hash(path.join(build,'CodexWorkerHost.exe'))},result:'unknown',limitations:[],checks:[]};
function persist(){write(path.join(root,'session.json'),state);write(evidence,record);}
async function until(fn,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await delay(100);}throw Error('bounded fixture wait expired');}
let slot=0;
async function owner(pipe,method){return new Promise((resolve,reject)=>{const socket=net.connect(`\\\\.\\pipe\\${pipe}-${slot++%16}`);let text='';socket.setEncoding('utf8');socket.setTimeout(5000,()=>socket.destroy(Error('owner timeout')));socket.once('error',reject);socket.once('connect',()=>socket.write(JSON.stringify({method})+'\n'));socket.on('data',b=>{text+=b;const end=text.indexOf('\n');if(end>=0){resolve(JSON.parse(text.slice(0,end)));socket.end();}});});}
function reserve(actor,purpose){return reserveTurn(path.join(budgetRoot,'budget'),actor,purpose);}
async function startWorker(actor){
  const base=path.join(root,actor),cwd=path.join(base,'work');mkdirSync(cwd,{recursive:true});
  writeFileSync(path.join(cwd,'AGENTS.md'),'# Disposable CC-00R fixture\nOnly execute the explicit test prompt. All writes must stay in this cwd. Never change auth, settings, or files outside this fixture. No network or subagents.\n');
  writeFileSync(path.join(cwd,'leaf-ticker.ps1'),"$until=[DateTime]::UtcNow.AddSeconds(600)\nwhile([DateTime]::UtcNow -lt $until -and -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'stop'))){[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'grandchild.marker'),'.');Start-Sleep -Milliseconds 100}\n");
  writeFileSync(path.join(cwd,'run-tickers.ps1'),"$ErrorActionPreference='Stop'\n$leaf=Join-Path $PSScriptRoot 'leaf-ticker.ps1'\n$exe=(Get-Process -Id $PID).Path\n$p=Start-Process -FilePath $exe -ArgumentList @('-NoProfile','-File', ('\"'+$leaf+'\"')) -WindowStyle Hidden -PassThru\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'shell-pids.json'),(@{shell=$PID;grandchild=$p.Id}|ConvertTo-Json -Compress))\nWrite-Output 'CC00R_SHELL_STARTED'\n$until=[DateTime]::UtcNow.AddSeconds(600)\ntry{while([DateTime]::UtcNow -lt $until -and -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'stop'))){[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'shell.marker'),'.');Start-Sleep -Milliseconds 100}}finally{if(-not $p.HasExited){$p.WaitForExit(2000)|Out-Null}}\n");
  const exe=path.join(base,'CodexRelay.exe');copyFileSync(path.join(build,'CodexRelay.exe'),exe);
  const relayPipe=`meristem-cc00-${randomUUID()}`,ownerPipe=`meristem-cc00r-${randomUUID()}`;
  write(exe+'.json',{realExecutable:realExe,realSha256:hash(realExe),pipeName:relayPipe,allowedCwds:[cwd],testProfile:'CC-00R-suite-'+actor,testPermissions:':workspace'});
  const env={...process.env,CODEX_HOME:authHome};for(const key of Object.keys(env))if(/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|BEARER|CODEX_THREAD_ID|CODEX_TURN_ID/i.test(key))delete env[key];
  const host=spawn(path.join(build,'CodexWorkerHost.exe'),['--mode','codex-relay','--pipe',ownerPipe,'--exe',exe,'--cwd',cwd,'--fixture-root',base,'--broker-stdin','true'],{cwd,env,windowsHide:true,stdio:['pipe','ignore','ignore']});
  const owned={actor,cwd,host,relay:null};workers.push(owned);
  await until(async()=>{try{return (await owner(ownerPipe,'status')).jobAssigned;}catch{return false;}});
  const relay=await connect(relayPipe);owned.relay=relay;const account=await relay.call('account/read',{refreshToken:false});assert(account.result?.account,'dedicated authenticated home required');
  const catalog=await relay.call('model/list');assert(catalog.result?.data.some(m=>m.model===state.model&&m.supportedReasoningEfforts.some(e=>e.reasoningEffort===state.effort)));
  const created=await relay.call('thread/start',{cwd,model:state.model,ephemeral:true,permissions:':workspace'});assert(created.result?.thread?.id);
  assert.equal(created.result.thread.parentThreadId,null);
  const info={actor,cwd,ownerPipe,relayPipe,pid:host.pid,threadId:created.result.thread.id};state.workers[actor]=info;
  record.processIdentities[actor]={owner:'dedicated WorkerHost',worker:'verified CodexRelay and real Codex',jobAssigned:true,rootThread:true};
  record.observedSettings[actor]={returnedModel:created.result.model,returnedEffort:created.result.reasoningEffort,sandbox:created.result.sandbox,approvalPolicy:created.result.approvalPolicy,effectiveSettings:'not independently verified'};
  assert.equal(created.result.sandbox?.type,'workspaceWrite','official workspace-write was not confirmed; do not send a shell turn');
  persist();return {...info,host,relay};
}
async function turn(worker,prompt,purpose){
  const budget=reserve(worker.actor,purpose);
  const reply=await worker.relay.call('turn/start',{threadId:worker.threadId,input:[{type:'text',text:prompt}],model:state.model,effort:state.effort});
  write(budget,{actor:worker.actor,purpose,delivery:reply.result?.turn?.id?'accepted':'unknown_or_rejected',turnId:reply.result?.turn?.id});
  assert(reply.result?.turn?.id,'no turn id; do not resend');const id=reply.result.turn.id;
  // An invalid model guarantees no dispatch even if the real turn already ended.
  const invalid=await worker.relay.call('turn/start',{threadId:worker.threadId,input:[],model:'invalid-cc00r',effort:state.effort});
  assert(invalid.error,'negative probe must never dispatch a model turn');
  record.checks.push({actor:worker.actor,check:'busy_start_rejected',passed:/busy|pending/.test(invalid.error.message),negativeProbeNotDispatched:true});
  const event=await until(async()=>{
    const status=await worker.relay.call('relay/status');assert(!status.result?.disabledReason);
    const display=await owner(worker.ownerPipe,'events');
    if(display.events?.some(e=>e.text==='Codex server request pending; original approval or response required.'))throw Error('unsupported server request pending; no synthetic approval or retry');
    return status.result?.events.find(e=>e.method==='turn/completed'&&e.threadId===worker.threadId&&e.turnId===id);
  },120000);
  write(budget,{actor:worker.actor,purpose,delivery:'completion_observed',turnId:id,status:event.status});assert.equal(event.status,'completed');
  record.operationIds.push(purpose);record.eventSeqs.push(event.seq);persist();
}
function sizes(worker){return ['shell.marker','grandchild.marker'].map(f=>existsSync(path.join(worker.cwd,f))?readFileSync(path.join(worker.cwd,f)).length:0);}
async function markerReady(worker){await until(()=>sizes(worker).every(n=>n>2),25000);}
async function verifyStopped(worker,reason){const first=sizes(worker);await delay(600);const second=sizes(worker);record.stopEvidence[worker.actor]={reason,hadShellAndGrandchild:first.every(n=>n>0),markersStable:JSON.stringify(first)===JSON.stringify(second),hostExited:worker.host.exitCode!==null||worker.host.signalCode!==null};assert(first.every(n=>n>0)&&JSON.stringify(first)===JSON.stringify(second));persist();}
const workers=[];let control;let oldConfig;
const configPath=path.join(authHome,'config.toml');
try{
  oldConfig=existsSync(configPath)?readFileSync(configPath):null;
  assert(!oldConfig?.toString().includes('[mcp_servers.cc00r_caller]'),'preserve existing test MCP configuration');
  const callerFile=path.join(root,'caller-private.jsonl');
  state.installedConfigBlock=`\n[mcp_servers.cc00r_caller]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.resolve('spikes/chat-control/caller-recording-probe.mjs'))}, ${JSON.stringify(callerFile)}]\n`;
  writeFileSync(configPath,(oldConfig?.toString()??'')+state.installedConfigBlock);
  state.installedConfigHash=hash(configPath);persist();
  const d=path.join(root,'D.marker');control=spawn(process.execPath,['-e',`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(d)},'.'),100)`],{windowsHide:true,stdio:'ignore'});
  const a=await startWorker('A');
  const invalid=await a.relay.call('turn/start',{threadId:a.threadId,input:[],model:'invalid-cc00r',effort:'low'});assert(invalid.error);record.checks.push({check:'invalid_model_rejected_before_send',passed:true});
  if(!remainingOnly)await turn(a,'Use the cc00r_caller observe_caller tool exactly once. Remember the token CC00R_RECALL_68. Then reply exactly CC00R_A_READY. Do not use other tools.','A_first_metadata');
  const metadata=existsSync(callerFile)?readFileSync(callerFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  record.checks.push({check:'real_mcp_metadata_correlates_A',observedCalls:metadata.length,matched:metadata.some(m=>Object.values(m.correlation).includes(a.threadId)),keys:metadata.flatMap(m=>m.keys)});persist();
  await turn(a,'Recall the token from this same chat in your final response. Start the already supplied run-tickers.ps1 in this cwd using the ordinary exec_command tool with yield_time_ms 1000. It is a bounded 600-second test with one shell and one child writing markers only in this cwd. Do not modify scripts, request escalation, change sandbox or policy, use network, or launch subagents. After the command reports its running session, end your turn without polling.','A_same_history_shell');
  await markerReady(a);
  const b=await startWorker('B');
  await turn(b,'Start the already supplied run-tickers.ps1 in this cwd using the ordinary exec_command tool with yield_time_ms 1000. It is a bounded 600-second test with one shell and one child writing markers only in this cwd. Do not modify scripts, request escalation, change sandbox or policy, use network, or launch subagents. After the command reports its running session, end your turn without polling.','B_shell');
  await markerReady(b);state.phase='ready_for_A_terminal_close';persist();console.log(JSON.stringify({phase:state.phase,session:path.join(root,'session.json'),A:a.ownerPipe,B:b.ownerPipe}));
  await until(()=>existsSync(path.join(root,'A-terminal-closed')),180000);
  await until(()=>a.host.exitCode!==null||a.host.signalCode!==null);await verifyStopped(a,'real VS Code terminal close');
  const bBefore=sizes(b),dBefore=readFileSync(d).length;await delay(500);assert(sizes(b).every((v,i)=>v>bBefore[i])&&readFileSync(d).length>dBefore);record.checks.push({check:'A_stop_spares_B_and_D',passed:true});persist();
  state.parentReservations=reserveParentTurns(path.join(budgetRoot,'budget'));
  state.phase='waiting_for_parent_two_turns';persist();console.log(JSON.stringify({phase:state.phase}));
  await until(()=>existsSync(path.join(root,'parent-finished')),180000);
  const parentTurns=state.parentReservations.map(f=>JSON.parse(readFileSync(f,'utf8')));
  assert(parentTurns.every(t=>t.actor==='P'&&t.delivery==='completion_observed'&&t.status==='completed'&&t.threadId&&t.turnId),'parent turns need reserved pre-send entries and observed completion');
  assert(parentTurns[0].threadId===parentTurns[1].threadId && parentTurns[0].turnId!==parentTurns[1].turnId,'parent resume needs the same root and a new turn');
  b.host.kill();await until(()=>b.host.signalCode!==null||b.host.exitCode!==null);await verifyStopped(b,'host abnormal termination');
  if(!remainingOnly){const c=await startWorker('C');
  await turn(c,'Start the already supplied run-tickers.ps1 in this cwd using ordinary exec_command with yield_time_ms 1000. It is a bounded 600-second local shell/child marker test. Do not edit files, request escalation, change sandbox, use network, or launch subagents. Finish your turn without polling once the command reports its running session.','C_shell_for_broker_EOF');
  await markerReady(c);c.host.stdin.end();await until(()=>c.host.exitCode!==null||c.host.signalCode!==null);await verifyStopped(c,'broker stdin EOF');}
  else record.limitations.push('Real shell broker EOF was not exercised within the remaining turn budget; fixture regression only');
  record.result='passed';state.phase='completed';
}catch(error){record.result='failed';record.failure=String(error.message);state.phase='failed';process.exitCode=1;}
finally{
  for(const w of workers){
    writeFileSync(path.join(w.cwd,'stop'),'cleanup');w.relay?.socket.destroy();
    if(w.host.exitCode===null&&w.host.signalCode===null){
      w.host.stdin.end();
      await until(()=>w.host.exitCode!==null||w.host.signalCode!==null,10000).catch(async()=>{
        w.host.kill();await until(()=>w.host.exitCode!==null||w.host.signalCode!==null,5000).catch(()=>undefined);
      });
    }
  }
  control?.kill();
  if(state.installedConfigHash&&existsSync(configPath)&&hash(configPath)===state.installedConfigHash){if(oldConfig!==null)writeFileSync(configPath,oldConfig);else {const {unlinkSync}=await import('node:fs');unlinkSync(configPath);}record.configRestored=true;}
  else if(state.installedConfigBlock&&existsSync(configPath)&&readFileSync(configPath,'utf8').includes(state.installedConfigBlock)){writeFileSync(configPath,readFileSync(configPath,'utf8').replace(state.installedConfigBlock,''));record.configRestored=true;}
  else record.configRestored=state.installedConfigBlock?false:'not_changed';
  record.modelTurnBudget=Array.from({length:6},(_,i)=>path.join(budgetRoot,'budget',`turn-${i+1}.json`)).filter(existsSync).map(f=>{const b=JSON.parse(readFileSync(f,'utf8'));return {actor:b.actor,purpose:b.purpose,delivery:b.delivery,status:b.status??'unknown'};});
  record.remainingAuthorizedTurns=6-record.modelTurnBudget.length;
  record.ownedHostsAbsent=workers.every(w=>w.host.exitCode!==null||w.host.signalCode!==null);
  finalizeOutcome(record);
  if(record.result==='failed'){process.exitCode=1;state.phase='failed';}
  persist();console.log(JSON.stringify({result:record.result,phase:state.phase,evidence,failure:record.failure}));
}
