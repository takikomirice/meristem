// CC-00R disposable acceptance broker. Explicit paths and a separately authorized ledger.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {directClient} from './direct-client.mjs';
import {connect} from './relay-client.mjs';
import {finalizeOutcome} from './suite-support.mjs';

const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
assert(args.includes('--live')&&args.includes('--case')&&arg('--case')==='acceptance'&&['--root','--real-exe','--auth-home','--budget-root','--code-exe','--extension-dir','--evidence'].every(k=>args.includes(k)));
const root=path.resolve(arg('--root')),real=path.resolve(arg('--real-exe')),auth=path.resolve(arg('--auth-home')),budget=path.resolve(arg('--budget-root')),evidence=path.resolve(arg('--evidence'));
const scope=path.resolve('.local/chat-control/CC-00R')+path.sep;
assert([root,auth,budget].every(p=>p.startsWith(scope))&&!existsSync(root)&&!existsSync(evidence));
assert.equal(JSON.parse(readFileSync(path.join(budget,'authorization.json'),'utf8')).maxTurns,12);
assert.equal(JSON.parse(readFileSync(path.join(budget,'authorization.json'),'utf8')).scope,'CC-00R continuation');
mkdirSync(root,{recursive:true});
const save=(f,v)=>writeFileSync(f,JSON.stringify(v,null,2)+'\n'),hash=f=>createHash('sha256').update(readFileSync(f)).digest('hex');
const model='gpt-6-luna',effort='low',workers=[],record={testId:'CC-00R-direct-suite',capturedAt:new Date().toISOString(),result:'unknown',checks:[],stops:{},turns:[],requestedAgent:{model,effort},artifactHashes:{codex:hash(real),host:hash(path.resolve('.local/chat-control-build/CodexWorkerHost.exe')),relay:hash(path.resolve('.local/chat-control-build/CodexRelay.exe'))}};
const state={root,phase:'preparing',workers:{}};
const persist=()=>{save(path.join(root,'session.json'),state);save(evidence,record);};
function phase(name){state.phase=name;persist();console.log(JSON.stringify({phase:name,session:path.join(root,'session.json')}));}
function reserve(actor,purpose){for(let i=1;i<=12;i++){const f=path.join(budget,`turn-${i}.json`);try{writeFileSync(f,JSON.stringify({actor,purpose,delivery:'reserved_before_send'}),{flag:'wx'});return f;}catch(e){if(e.code!=='EEXIST')throw e;}}throw Error('authorized 12-turn budget exhausted');}
async function until(fn,ms=30000){const deadline=Date.now()+ms;while(Date.now()<deadline){const value=await fn();if(value)return value;await delay(100);}throw Error('bounded acceptance wait expired: '+state.phase);}
let slot=0;
function owner(pipe,method){return new Promise((resolve,reject)=>{const s=net.connect(`\\\\.\\pipe\\${pipe}-${slot++%16}`);let b='';s.setEncoding('utf8');s.setTimeout(5000,()=>s.destroy(Error('owner timeout')));s.on('error',reject);s.on('connect',()=>s.write(JSON.stringify({method})+'\n'));s.on('data',data=>{b+=data;if(b.includes('\n')){resolve(JSON.parse(b.split('\n')[0]));s.end();}});});}
const env={...process.env,CODEX_HOME:auth};for(const key of Object.keys(env))if(/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|BEARER|CODEX_THREAD_ID|CODEX_TURN_ID/i.test(key))delete env[key];
const config=path.join(auth,'config.toml'),original=readFileSync(config,'utf8'),caller=path.join(root,'caller-private.jsonl');
assert(!original.includes('[mcp_servers.cc00r_caller]'));
const block=`\n[mcp_servers.cc00r_caller]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.resolve('spikes/chat-control/caller-recording-probe.mjs'))}, ${JSON.stringify(caller)}]\n`;
let parent,control,code;
const exited=w=>w.host.exitCode!==null||w.host.signalCode!==null;
async function start(actor){
  const base=path.join(root,actor),cwd=path.join(base,'work'),pipe=`meristem-cc00r-${randomUUID()}`;mkdirSync(cwd,{recursive:true});
  save(path.join(base,'worker.json'),{realExecutable:real,realSha256:hash(real),cwd,testProfile:'CC-00R-direct-'+actor,requestedAgent:{model,effort}});
  for(const f of ['fixture-shell.ps1','fixture-ticker.ps1'])copyFileSync(path.resolve('spikes/chat-control',f),path.join(cwd,f));
  writeFileSync(path.join(cwd,'AGENTS.md'),'# CC-00R fixture\nFollow only the explicit local test prompt. No subagents, network, settings changes or writes outside this cwd.\n');
  const host=spawn(path.resolve('.local/chat-control-build/CodexWorkerHost.exe'),['--mode','codex-stdio','--pipe',pipe,'--exe',real,'--cwd',cwd,'--fixture-root',base,'--broker-stdin','true'],{cwd,env,windowsHide:true,stdio:['pipe','pipe','ignore']});
  const w={actor,cwd,pipe,host,rpc:directClient(host)};workers.push(w);
  assert((await w.rpc.call('initialize',{clientInfo:{name:'cc00r-direct-suite',version:'0'},capabilities:{experimentalApi:true}})).result);w.rpc.notify('initialized');
  const catalog=await w.rpc.call('model/list');assert(catalog.result?.data.some(m=>m.model===model&&m.supportedReasoningEfforts.some(e=>e.reasoningEffort===effort)));
  const created=await w.rpc.call('thread/start',{cwd,model,ephemeral:true,permissions:':workspace'});assert(created.result?.thread?.id&&created.result.thread.parentThreadId===null);assert.equal(created.result.sandbox.type,'workspaceWrite');
  w.thread=created.result.thread.id;
  state.workers[actor]={pipe,cwd,hostPid:host.pid,threadId:w.thread};persist();return w;
}
async function turn(w,prompt,purpose){
  const file=reserve(w.actor,purpose);const response=await w.rpc.call('turn/start',{threadId:w.thread,input:[{type:'text',text:prompt}],model,effort});
  save(file,{actor:w.actor,purpose,delivery:response.result?.turn?.id?'accepted':'unknown',threadId:w.thread,turnId:response.result?.turn?.id});assert(response.result?.turn?.id,'unknown delivery; no retry');
  const id=response.result.turn.id;
  const done=await until(()=>{if(w.rpc.requests.length){record.pendingRequests=w.rpc.requests.map(r=>r.method);throw Error('formal request needs original human response');}return w.rpc.events.find(e=>e.method==='turn/completed'&&e.params?.turn?.id===id);},120000);
  assert.equal(done.params.turn.status,'completed');save(file,{actor:w.actor,purpose,delivery:'completion_observed',threadId:w.thread,turnId:id,status:'completed'});
  record.turns.push({actor:w.actor,purpose,status:'completed'});persist();
  const messages=w.rpc.events.filter(e=>e.method==='item/completed'&&e.params?.turnId===id&&e.params.item?.type==='agentMessage').map(e=>e.params.item.text);
  return {id,text:messages.at(-1)||(done.params.turn.items??[]).filter(i=>i.type==='agentMessage').at(-1)?.text||''};
}
function markerSizes(w){return ['shell.marker','grandchild.marker'].map(f=>existsSync(path.join(w.cwd,f))?readFileSync(path.join(w.cwd,f)).length:0);}
async function stopped(w,reason){await until(()=>exited(w),8000);const before=markerSizes(w);await delay(2000);const pids=JSON.parse(readFileSync(path.join(w.cwd,'processes.json'),'utf8').replace(/^\uFEFF/,''));const result={reason,markersExisted:before.every(n=>n>=3),markersStable:markerSizes(w).every((n,i)=>n===before[i]),processesAbsent:[pids.shell,pids.grandchild].every(pid=>{try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}})};record.stops[w.actor]=result;persist();assert(Object.values(result).slice(1).every(Boolean));}
async function ready(w){await until(()=>markerSizes(w).every(n=>n>=3),15000);}
const shellPrompt='Run the supplied ./fixture-shell.ps1 using ordinary exec_command, yield_time_ms 1000. It is an authorized bounded 600-second local shell/child marker test. Do not escalate, bypass, modify scripts or policy, use network or subagents. Once it returns a running session, end your turn without polling or stopping. The broker owns cleanup. Reply exactly CC00R_SHELL_READY.';
function correlate(thread,turnId,pids){const calls=existsSync(caller)?readFileSync(caller,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];return calls.some(c=>Object.values(c.correlation).includes(thread)&&Object.values(c.correlation).includes(turnId)&&pids.includes(c.process.pid));}
try{
  writeFileSync(config,original+block);
  const reuse=args.includes('--reuse-parent')?JSON.parse(readFileSync(arg('--reuse-parent'),'utf8')):null;
  const pbase=reuse?path.dirname(reuse.profile):path.join(root,'P'),profile=path.join(pbase,'profile'),work=path.join(pbase,'work'),extensions=path.join(pbase,'extensions');mkdirSync(path.join(profile,'User'),{recursive:true});mkdirSync(work,{recursive:true});mkdirSync(extensions,{recursive:true});
  if(!reuse)symlinkSync(path.resolve(arg('--extension-dir')),path.join(extensions,path.basename(arg('--extension-dir'))),'junction');
  const relay=path.join(pbase,'CodexRelay.exe'),pipe=reuse?reuse.pipe:`meristem-cc00-${randomUUID()}`;
  if(!reuse){copyFileSync(path.resolve('.local/chat-control-build/CodexRelay.exe'),relay);save(relay+'.json',{realExecutable:real,realSha256:hash(real),pipeName:pipe,allowedCwds:[work],testProfile:'CC-00R-parent-direct-suite'});}
  const settings={'workbench.startupEditor':'none','chatgpt.cliExecutable':relay,'window.title':'CC-00R continuation fixture - ${rootName}','chatgpt.runCodexInWindowsSubsystemForLinux':false};save(path.join(profile,'User','settings.json'),settings);
  const reservation=reuse?null:reserve('P','parent_UI_metadata'),extraReservation=reuse?null:reserve('P','possible_UI_auxiliary_turn');state.parent={profile,work,pipe,relay,reservation,extraReservation,settings};
  phase('waiting_parent_UI');
  const codeEnv={...env};delete codeEnv.ELECTRON_RUN_AS_NODE;
  code=spawn(path.resolve(arg('--code-exe')),['--user-data-dir',profile,'--extensions-dir',extensions,'--extensionDevelopmentPath',path.resolve('extension'),'--new-window',work],{env:codeEnv,windowsHide:false,stdio:'ignore'});
  code.unref();
  parent=await until(async()=>{try{return await connect(pipe);}catch{return null;}},180000);
  let first;
  if(reuse){
    assert(reuse.mcpJobThreadTurnVerified===true&&reuse.threadId&&reuse.firstTurn);
    const ps=await until(async()=>{const s=(await parent.call('relay/status')).result;return s?.observedThreads.includes(reuse.threadId)?s:null;},180000);
    assert((await parent.call('relay/register',{threadId:reuse.threadId,ownerEpoch:ps.ownerEpoch})).result);
    const read=await parent.call('thread/read',{threadId:reuse.threadId,includeTurns:true});
    assert(read.result?.thread?.turns?.some(t=>t.id===reuse.firstTurn&&t.items?.some(i=>i.type==='userMessage'&&JSON.stringify(i.content).includes('CC00R_PARENT_TOKEN_86'))));
    first={threadId:reuse.threadId,turnId:reuse.firstTurn};state.parent.threadId=first.threadId;state.parent.firstTurn=first.turnId;
    record.checks.push({check:'parent_MCP_job_thread_turn_correlation',passed:true,evidence:reuse.evidence});
  }else{
  const ps=await until(async()=>{const s=(await parent.call('relay/status')).result;return s?.events.some(e=>e.method==='turn/completed'&&e.status==='completed')&&Object.keys(s.activeTurns).length===0?s:null;},300000);
  save(path.join(root,'parent-observed.json'),ps);
  const starts=ps.events.filter(e=>e.method==='ui/turn/start'),completed=ps.events.filter(e=>e.method==='turn/completed'&&e.status==='completed');
  assert(starts.length<=2,'more UI starts than the two pre-reserved slots');
  record.parentUIStarts=starts.length;
  const reservations=[reservation,extraReservation];
  for(let i=0;i<starts.length;i++){const done=completed.find(e=>e.threadId===starts[i].threadId);save(reservations[i],{actor:'P',purpose:'UI_observed',delivery:done?'completion_observed':'accepted_completion_unknown',threadId:starts[i].threadId,turnId:done?.turnId,status:done?.status});}
  if(starts.length===1)save(extraReservation,{actor:'P',purpose:'possible_UI_auxiliary_turn',delivery:'not_sent'});
  const matches=[];
  for(const done of completed){
    await parent.call('relay/register',{threadId:done.threadId,ownerEpoch:ps.ownerEpoch});
    const read=await parent.call('thread/read',{threadId:done.threadId,includeTurns:true});
    if(read.result?.thread?.turns?.some(t=>t.id===done.turnId&&t.items?.some(i=>i.type==='userMessage'&&JSON.stringify(i.content).includes('CC00R_PARENT_TOKEN_86'))&&t.items?.some(i=>i.type==='agentMessage'&&i.text==='CC00R_PARENT_DIRECT_READY')))matches.push(done);
  }
  assert.equal(matches.length,1,'unique loaded parent with exact prompt/reply required');first=matches[0];
  state.parent.threadId=first.threadId;state.parent.firstTurn=first.turnId;
  assert((await parent.call('relay/register',{threadId:first.threadId,ownerEpoch:ps.ownerEpoch})).result);const history=await parent.call('thread/read',{threadId:first.threadId,includeTurns:true});
  assert(JSON.stringify(history.result).includes('CC00R_PARENT_DIRECT_READY'));assert(correlate(first.threadId,first.turnId,ps.jobProcessIds),'parent MCP process/thread/turn not correlated');
  record.checks.push({check:'parent_MCP_job_thread_turn_correlation',passed:true});
  }
  const d=path.join(root,'D.marker');control=spawn(process.execPath,['-e',`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(d)},'.'),500)`],{windowsHide:true,stdio:'ignore'});
  const a=await start('A');
  if(args.includes('--remaining-only')){
    await turn(a,'Remember the token CC00R_CHILD_TOKEN_93 for the next turn. '+shellPrompt,'A_shell_remember');await ready(a);
    const recall=await turn(a,'What exact token did I ask you to remember in my previous instruction? Reply only with that token. Do not use any tools.','A_history_recall');
    record.checks.push({check:'child_same_history_recall',passed:recall.text.trim()==='CC00R_CHILD_TOKEN_93'});assert.equal(recall.text.trim(),'CC00R_CHILD_TOKEN_93');
  }else{
  const aFirst=await turn(a,'Call cc00r_caller observe_caller exactly once. Remember CC00R_CHILD_TOKEN_93. Reply exactly CC00R_A_READY. No other tools.','A_metadata');
  assert(correlate(a.thread,aFirst.id,(await owner(a.pipe,'status')).jobProcessIds));record.checks.push({check:'child_MCP_job_thread_turn_correlation',passed:true});
  const recall=await turn(a,'What exact token did I ask you to remember in my previous instruction? Reply only with that token. Do not use any tools.','A_history_recall');assert.equal(recall.text.trim(),'CC00R_CHILD_TOKEN_93');record.checks.push({check:'child_same_history_recall',passed:true});
  await turn(a,shellPrompt,'A_shell');await ready(a);
  }
  const b=await start('B');await turn(b,shellPrompt,'B_shell');await ready(b);
  phase('close_A_terminal');await until(()=>exited(a),180000);await stopped(a,'real integrated terminal close');
  const bBefore=markerSizes(b),dBefore=readFileSync(d).length;await delay(2000);assert(markerSizes(b).every((n,i)=>n>bBefore[i])&&readFileSync(d).length>dBefore);assert((await parent.call('relay/status')).result.initialized);record.checks.push({check:'A_stop_spares_P_B_D',passed:true});
  b.host.kill();await stopped(b,'host force termination');
  const c=await start('C');await turn(c,shellPrompt,'C_explicit_stop');await ready(c);phase('explicit_stop_C');await until(()=>exited(c),180000);await stopped(c,'real terminal stop command');
  if(!args.includes('--remaining-only')){
  const pWake=reserve('P','parent_relay_wake');await parent.call('model/list');const wake=await parent.call('turn/start',{threadId:first.threadId,input:[{type:'text',text:'Stored child result: child A recalled CC00R_CHILD_TOKEN_93 and its shell and child stopped after terminal close. B stopped on host death; C stopped by explicit command. Recall your initial parent token and reply exactly CC00R_PARENT_TOKEN_86 CC00R_WAKE_DONE. Do not use tools.'}],model,effort});assert(wake.result?.turn?.id);save(pWake,{actor:'P',purpose:'parent_relay_wake',delivery:'accepted',threadId:first.threadId,turnId:wake.result.turn.id});
  await until(async()=>{const s=(await parent.call('relay/status')).result;return s.events.some(e=>e.method==='turn/completed'&&e.turnId===wake.result.turn.id&&e.status==='completed');},120000);save(pWake,{actor:'P',purpose:'parent_relay_wake',delivery:'completion_observed',status:'completed'});record.checks.push({check:'parent_same_root_wake_after_stored_child_result',passed:true});
  }
  const e=await start('E');await turn(e,shellPrompt,'E_VSCode_exit');await ready(e);phase('close_VSCode_with_E_terminal');await until(()=>exited(e),180000);await stopped(e,'normal VS Code window exit');
  record.result='passed';phase('completed');
}catch(error){record.result='failed';record.failure=error.message;process.exitCode=1;phase('failed');}
finally{
  for(const w of workers){writeFileSync(path.join(w.cwd,'stop'),'cleanup');w.rpc.close();await until(()=>exited(w),5000).catch(async()=>{w.host.kill();await until(()=>exited(w),5000);});}
  if(control){control.kill();await until(()=>control.exitCode!==null||control.signalCode!==null,5000);}
  if(parent){try{save(path.join(root,'parent-final-status.json'),(await parent.call('relay/status')).result);}catch{}parent.socket.destroy();}
  const current=readFileSync(config,'utf8');if(current.includes(block)){writeFileSync(config,current.replace(block,''));record.configRestored=true;}else record.configRestored=false;
  if(state.parent&&code?.exitCode!==null){const f=path.join(state.parent.profile,'User','settings.json'),settings=JSON.parse(readFileSync(f,'utf8'));for(const [key,value]of Object.entries(state.parent.settings))if(settings[key]===value)delete settings[key];save(f,settings);record.profileSettingsRestored=true;}else record.profileSettingsRestored=false;
  record.ownedHostsAbsent=workers.every(exited);finalizeOutcome(record,['configRestored','ownedHostsAbsent','profileSettingsRestored']);if(record.result!=='passed')process.exitCode=1;persist();console.log(JSON.stringify({result:record.result,failure:record.failure,evidence}));
}
