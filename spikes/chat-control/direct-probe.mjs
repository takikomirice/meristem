// Explicit real test entry. Preflight never sends a model turn.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {directClient} from './direct-client.mjs';
import {finalizeOutcome} from './suite-support.mjs';

const args=process.argv.slice(2),arg=key=>args[args.indexOf(key)+1];
assert(args.includes('--live')&&['preflight','shell'].includes(arg('--case'))&&['--root','--real-exe','--auth-home','--evidence'].every(k=>args.includes(k)),'explicit live case and paths required');
const root=path.resolve(arg('--root')),real=path.resolve(arg('--real-exe')),auth=path.resolve(arg('--auth-home')),evidence=path.resolve(arg('--evidence'));
const scope=path.resolve('.local/chat-control/CC-00R')+path.sep;
assert(root.startsWith(scope)&&auth.startsWith(scope)&&!existsSync(root)&&!existsSync(evidence));
const shell=args.includes('--case')&&arg('--case')==='shell';
const budget=shell?path.resolve(arg('--budget-root')):null;
if(shell){assert(args.includes('--budget-root')&&budget.startsWith(scope));const permission=JSON.parse(readFileSync(path.join(budget,'authorization.json'),'utf8'));assert.equal(permission.maxTurns,12);assert.equal(permission.scope,'CC-00R continuation');}
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const save=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const model='gpt-6-luna',effort='low',cwd=path.join(root,'work'),pipe=`meristem-cc00r-${randomUUID()}`;
mkdirSync(cwd,{recursive:true});
save(path.join(root,'worker.json'),{realExecutable:real,realSha256:hash(real),cwd,testProfile:'CC-00R-direct',requestedAgent:{model,effort}});
writeFileSync(path.join(cwd,'AGENTS.md'),'# CC-00R disposable fixture\nOnly follow the explicit fixture prompt. No subagents, network, settings changes, or writes outside this cwd.\n');
const env={...process.env,CODEX_HOME:auth};for(const key of Object.keys(env))if(/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|BEARER|CODEX_THREAD_ID|CODEX_TURN_ID/i.test(key))delete env[key];
const version=spawnSync(real,['--version'],{encoding:'utf8',windowsHide:true});assert.equal(version.status,0);
const host=spawn(path.resolve('.local/chat-control-build/CodexWorkerHost.exe'),['--mode','codex-stdio','--pipe',pipe,'--exe',real,'--cwd',cwd,'--fixture-root',root,'--broker-stdin','true'],{cwd,env,windowsHide:true,stdio:['pipe','pipe','ignore']});
const rpc=directClient(host),record={testId:'CC-00R-direct-'+randomUUID(),capturedAt:new Date().toISOString(),case:arg('--case'),result:'unknown',versions:{codex:version.stdout.trim(),node:process.version},artifactHashes:{codex:hash(real),host:hash(path.resolve('.local/chat-control-build/CodexWorkerHost.exe'))},requestedAgent:{model,effort},turnsSent:0};
let turnFile,slot=0;
async function owner(method){return new Promise((resolve,reject)=>{const s=net.connect(`\\\\.\\pipe\\${pipe}-${slot++%16}`);let b='';s.setEncoding('utf8');s.setTimeout(5000,()=>s.destroy(Error('owner timeout')));s.on('error',reject);s.on('connect',()=>s.write(JSON.stringify({method})+'\n'));s.on('data',chunk=>{b+=chunk;if(b.includes('\n')){resolve(JSON.parse(b.split('\n')[0]));s.end();}});});}
async function until(fn,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await delay(100);}throw Error('bounded observation timeout');}
try{
  assert((await rpc.call('initialize',{clientInfo:{name:'meristem-cc00r-direct',version:'0.0.0'},capabilities:{experimentalApi:true}})).result);rpc.notify('initialized');
  const account=await rpc.call('account/read',{refreshToken:false});record.authenticated=Boolean(account.result?.account);assert(record.authenticated);
  const catalog=await rpc.call('model/list');assert(catalog.result?.data.some(m=>m.model===model&&m.supportedReasoningEfforts.some(e=>e.reasoningEffort===effort)));
  const created=await rpc.call('thread/start',{cwd,model,ephemeral:true,permissions:':workspace'});assert(created.result?.thread?.id);
  record.observedSettings={model:created.result.model,effort:created.result.reasoningEffort,sandbox:created.result.sandbox,approvalPolicy:created.result.approvalPolicy,independentEffectiveModelVerified:false};
  assert.equal(created.result.sandbox?.type,'workspaceWrite');
  const status=await owner('status');record.jobAssigned=status.jobAssigned;assert(record.jobAssigned);
  save(path.join(root,'session.json'),{pipe,hostPid:host.pid,childPid:status.pid,cwd,threadId:created.result.thread.id});
  if(shell){
    for(const f of ['fixture-shell.ps1','fixture-ticker.ps1'])copyFileSync(path.resolve('spikes/chat-control',f),path.join(cwd,f));
    for(let i=1;i<=12;i++){try{turnFile=path.join(budget,`turn-${i}.json`);writeFileSync(turnFile,JSON.stringify({purpose:'direct-shell',delivery:'reserved_before_send',root}),{flag:'wx'});break;}catch(e){if(e.code!=='EEXIST')throw e;turnFile=null;}}
    assert(turnFile,'authorized 12-turn limit exhausted');
    const prompt='Run the supplied ./fixture-shell.ps1 with the ordinary exec_command tool in this cwd, yield_time_ms 1000. It is an authorized bounded 600-second test: one shell and one child write local markers every 500 ms. Use the current official sandbox, without escalation, bypass, policy changes, edits, network or subagents. After the command returns a running session, reply exactly CC00R_SHELL_READY and end your turn. Do not poll or stop the session; the test broker owns cleanup. If execution is blocked, explain the exact reason and stop.';
    record.turnsSent=1;save(evidence,record);
    const response=await rpc.call('turn/start',{threadId:created.result.thread.id,input:[{type:'text',text:prompt}],model,effort});
    save(turnFile,{purpose:'direct-shell',delivery:response.result?.turn?.id?'accepted':'unknown',root,threadId:created.result.thread.id,turnId:response.result?.turn?.id});
    assert(response.result?.turn?.id,'no confirmed turn ID; do not resend');
    await until(()=>{
      if(rpc.requests.length){record.pendingRequestMethods=rpc.requests.map(r=>String(r.method).slice(0,100));throw Error('formal server request pending; no synthetic response');}
      return rpc.events.some(e=>e.method==='turn/completed'&&e.params?.turn?.id===response.result.turn.id);
    },120000);
    const done=rpc.events.find(e=>e.method==='turn/completed'&&e.params?.turn?.id===response.result.turn.id);record.turnStatus=done.params.turn.status;
    save(turnFile,{purpose:'direct-shell',delivery:'completion_observed',status:record.turnStatus,root});assert.equal(record.turnStatus,'completed');
    record.reply=(done.params.turn.items??[]).filter(i=>i.type==='agentMessage').map(i=>i.text).join('\n').slice(0,300);
    await until(()=>['shell.marker','grandchild.marker'].every(f=>existsSync(path.join(cwd,f))&&readFileSync(path.join(cwd,f)).length>=3),10000);
    record.shellAndGrandchildStarted=true;
  }
  record.result='passed';
}catch(error){record.result='failed';record.failure=error.message;process.exitCode=1;}
finally{
  rpc.close();await until(()=>host.exitCode!==null||host.signalCode!==null,5000).catch(async()=>{host.kill();await until(()=>host.exitCode!==null||host.signalCode!==null,5000);});
  record.hostAbsent=host.exitCode!==null||host.signalCode!==null;
  if(shell&&record.shellAndGrandchildStarted){
    const files=['shell.marker','grandchild.marker'].map(f=>path.join(cwd,f));const before=files.map(f=>readFileSync(f).length);await delay(2000);
    const pids=JSON.parse(readFileSync(path.join(cwd,'processes.json'),'utf8').replace(/^\uFEFF/,''));
    record.stopEvidence={reason:'broker EOF',markersStable:files.every((f,i)=>readFileSync(f).length===before[i]),processesAbsent:[pids.shell,pids.grandchild].every(pid=>{try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}})};
    if(!record.stopEvidence.markersStable||!record.stopEvidence.processesAbsent){record.result='failed';writeFileSync(path.join(cwd,'stop'),'cleanup');}
  }
  finalizeOutcome(record,['hostAbsent']);if(record.result!=='passed')process.exitCode=1;
  save(evidence,record);console.log(JSON.stringify(record));
}
