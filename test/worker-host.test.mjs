import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const root = path.resolve('.local/chat-control-build');
const hostExe = path.join(root, 'CodexWorkerHost.exe');
const mockExe = path.join(root, 'MockCodex.exe');
let nextSlot=0;
function pipeName() { return `meristem-cc00r-${process.pid}-${Math.random().toString(16).slice(2)}`; }
function client(name, method, params = {}) {
  return new Promise((resolve, reject) => {
    const slot=nextSlot++%16;
    const socket = net.connect(`\\\\.\\pipe\\${name}-${slot}`); let text = '';
    socket.setEncoding('utf8'); socket.setTimeout(3000); socket.once('timeout',()=>{socket.destroy();reject(new Error(`pipe request timed out: ${method}`));}); socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ method, ...params }) + '\n'));
    socket.on('data', chunk => { text += chunk; const end = text.indexOf('\n'); if (end >= 0) { socket.end(); resolve(JSON.parse(text.slice(0, end))); } });
  });
}
async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch {} await delay(50); }
  throw new Error('timed out waiting for worker host');
}
async function killAndWait(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done=once(child,'close'); child.kill(); await done;
}
function launch(name, cwd, marker, mode='spawn-ticker') {
  return spawn(hostExe, ['--pipe', name, '--exe', mockExe, '--cwd', cwd, '--arg', mode, '--arg', marker], { windowsHide: true, stdio: 'ignore' });
}

test('suspended_child_does_not_run_before_job_assignment_and_explicit_resume',{timeout:10000},async t=>{
  const cwd=mkdtempSync(path.join(os.tmpdir(),'cc00r-suspended-')),marker=path.join(cwd,'first-instruction');
  const probe=spawn(path.join(root,'ProcessTreeProbe.exe'),[mockExe,marker,cwd],{windowsHide:true,stdio:['pipe','pipe','ignore']});
  t.after(async()=>{probe.stdin.end();await killAndWait(probe);rmSync(cwd,{recursive:true,force:true});});
  let output='';probe.stdout.on('data',b=>output+=b);await until(()=>output.includes('assigned'));
  await delay(200);assert.equal(existsSync(marker),false,'child must still be suspended after confirmed job assignment');
  probe.stdin.write('resume\n');await until(()=>existsSync(marker));probe.stdin.end();await until(()=>probe.exitCode!==null);
  const length=readFileSync(marker).length;await delay(200);assert.equal(readFileSync(marker).length,length);
});

test('dedicated_child_stdio_has_one_broker_and_no_extension_id_multiplexing', {timeout:15000}, async t=>{
  const base=mkdtempSync(path.join(os.tmpdir(),'cc00r-stdio-')), cwd=path.join(base,'work');mkdirSync(cwd);
  writeFileSync(path.join(base,'worker.json'),JSON.stringify({realExecutable:mockExe,realSha256:createHash('sha256').update(readFileSync(mockExe)).digest('hex'),cwd,testProfile:'CC-00R-direct-fixture',requestedAgent:{model:'mock',effort:'low'}}));
  const owner=pipeName();
  const host=spawn(hostExe,['--mode','codex-stdio','--pipe',owner,'--exe',mockExe,'--cwd',cwd,'--fixture-root',base,'--broker-stdin','true'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  t.after(async()=>{await killAndWait(host);rmSync(base,{recursive:true,force:true});});
  let output='';host.stdout.setEncoding('utf8');host.stdout.on('data',data=>output+=data);
  host.stdin.write(JSON.stringify({id:'cc00:exact-id',method:'initialize',params:{clientInfo:{name:'fixture',version:'0'}}})+'\n');
  await until(()=>output.includes('\n'),3000);
  assert.equal(JSON.parse(output.trim()).id,'cc00:exact-id');
  const status=await client(owner,'status');assert(status.jobProcessIds?.includes(status.pid));assert.equal(status.agent,'mock / low (requested)');
  host.stdin.write(JSON.stringify({id:45,method:'fixture/events',params:{}})+'\n');
  await until(()=>output.includes('"id":45'));
  const page=await until(async()=>{const p=await client(owner,'events',{afterSeq:0,limit:100});return p.events.length===100&&p.events[0].seq===46?p:null;});
  assert.equal(page.lastSeq,page.events.at(-1).seq,'pagination must not skip undisplayed events');assert.equal(page.omittedCount,45);
  assert(!JSON.stringify(page).includes('must-never-appear'));
  const page2=await client(owner,'events',{afterSeq:page.lastSeq,limit:100});assert.equal(page2.events[0].seq,page.lastSeq+1);
  output='';const marker=path.join(cwd,'descendant.marker');
  host.stdin.write(JSON.stringify({id:44,method:'spawn',params:{marker}})+'\n');
  await until(()=>existsSync(marker)&&output.includes('\n'));
  const descendant=JSON.parse(output.trim()).result.pid;
  host.stdin.end();await until(()=>host.exitCode!==null||host.signalCode!==null,5000);
  assert.throws(()=>process.kill(descendant,0),/ESRCH/);
  const size=readFileSync(marker).length;await delay(200);assert.equal(readFileSync(marker).length,size);
});
test('dedicated_worker_stop_spares_parent_peer_and_control', { timeout: 20000 }, async t => {
  assert(existsSync(hostExe) && existsSync(mockExe), 'run build:native first');
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'cc00r-'));
  t.after(() => { try { rmSync(cwd, { recursive: true, force: true }); } catch (error) { if (error?.code !== 'EPERM') throw error; } });
  const workerMark = path.join(cwd, 'worker.marker'), peerMark = path.join(cwd, 'peer.marker'), controlMark = path.join(cwd, 'control.marker'),parentMark=path.join(cwd,'parent.marker');
  const workerName = pipeName(), peerName = pipeName(),parentName=pipeName();
  const worker = launch(workerName, cwd, workerMark), peer = launch(peerName, cwd, peerMark),parent=launch(parentName,cwd,parentMark);
  const control = spawn(process.execPath, ['-e', `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(controlMark)},'.'),30)`], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => {
    await Promise.all([workerName,peerName,parentName].map(name=>until(()=>client(name,'stop'),3000).catch(()=>undefined)));
    await Promise.all([killAndWait(worker),killAndWait(peer),killAndWait(parent),killAndWait(control)]);
  });
  const status = await until(async () => { const s = await client(workerName, 'status'); return s.jobAssigned ? s : null; });
  assert.equal(status.cwd.toLowerCase(), cwd.toLowerCase());
  const concurrent=await Promise.all(Array.from({length:16},()=>client(workerName,'status')));
  assert(concurrent.every(result=>result.jobAssigned&&result.state==='running'));
  const page = await until(() => client(workerName, 'events', { afterSeq:0, limit:100 }));
  assert.equal(page.events.length,1); assert.match(page.events[0].text,/dedicated job/);
  await until(() => existsSync(workerMark) && existsSync(peerMark) && existsSync(controlMark)&&existsSync(parentMark));
  const stopped = await until(() => client(workerName, 'stop'), 5000);
  assert.deepEqual({ ok: stopped.ok, state: stopped.state, jobClosed: stopped.jobClosed, processExited: stopped.processExited }, { ok: true, state: 'stopped', jobClosed: true, processExited: true }, JSON.stringify(stopped));
  const workerSize = readFileSync(workerMark).length, peerSize = readFileSync(peerMark).length, controlSize = readFileSync(controlMark).length,parentSize=readFileSync(parentMark).length;
  await delay(2000);
  assert.equal(readFileSync(workerMark).length, workerSize);
  assert(readFileSync(peerMark).length > peerSize);
  assert(readFileSync(controlMark).length > controlSize);
  assert(readFileSync(parentMark).length>parentSize);
  assert(peer.exitCode === null, 'peer worker host remains alive after the other worker stops');
});
test('completed_worker_closes_job_descendants_before_display_only_close', { timeout: 20000 }, async t => {
  const cwd=mkdtempSync(path.join(os.tmpdir(),'cc00r-complete-'));
  t.after(()=>{try{rmSync(cwd,{recursive:true,force:true});}catch(error){if(error?.code!=='EPERM')throw error;}});
  const marker=path.join(cwd,'child.marker'), name=pipeName(), host=launch(name,cwd,marker,'spawn-and-exit');
  t.after(async()=>{await until(()=>client(name,'stop'),3000).catch(()=>undefined);await killAndWait(host);});
  const status=await until(async()=>{const s=await client(name,'status');return s.state==='completed'&&existsSync(marker)?s:null;});
  const size=readFileSync(marker).length; await delay(250);
  assert.equal(readFileSync(marker).length,size,'natural completion released the worker job and its grandchild');
  assert.equal(status.jobAssigned,true);
});

test('terminal_client_does_not_exclude_mcp_or_stop_client',{timeout:10000},async t=>{
  const cwd=mkdtempSync(path.join(os.tmpdir(),'cc00r-held-display-')),name=pipeName(),marker=path.join(cwd,'marker');
  const host=launch(name,cwd,marker);let held;
  t.after(async()=>{held?.destroy();await killAndWait(host);rmSync(cwd,{recursive:true,force:true});});
  await until(()=>client(name,'status'));
  held=net.connect(`\\\\.\\pipe\\${name}-${nextSlot++%16}`);held.on('error',()=>{});await once(held,'connect');
  let replies='';
  held.setEncoding('utf8'); held.on('data', chunk => { replies += chunk; });
  held.write('{"method":"events","afterSeq":0,"limit":100}\n{"method":"status"}\n');
  await until(() => replies.split('\n').length >= 3);
  assert.equal(JSON.parse(replies.split('\n')[1]).state,'running');
  assert.equal((await client(name,'status')).state,'running');
  assert.equal((await client(name,'stop')).state,'stopped');await until(()=>host.exitCode!==null);
});

test('malformed_or_disconnected_display_client_does_not_stop_worker',{timeout:15000},async t=>{
  const cwd=mkdtempSync(path.join(os.tmpdir(),'cc00r-display-loss-')),name=pipeName(),marker=path.join(cwd,'marker');
  const host=spawn(hostExe,['--pipe',name,'--exe',mockExe,'--cwd',cwd,'--arg','spawn-ticker','--arg',marker],{windowsHide:true,stdio:['ignore','ignore','pipe']});const sockets=[];
  let stderr='';host.stderr.on('data',data=>stderr+=data);
  t.after(async()=>{for(const socket of sockets)socket.destroy();await killAndWait(host);rmSync(cwd,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  await until(()=>existsSync(marker));
  for(const payload of [Buffer.alloc(65537,120),Buffer.from([0xff,10]),Buffer.from('{"method":"events"}\n')]){
    const socket=net.connect(`\\\\.\\pipe\\${name}-${nextSlot++%16}`);sockets.push(socket);socket.on('error',()=>{});
    await once(socket,'connect');socket.write(payload);
    if(payload[0]===123)socket.destroy();
    else await until(()=>socket.destroyed,3000);
    const size=readFileSync(marker).length;await delay(100);
    assert(host.exitCode===null&&host.signalCode===null,`display transport does not own worker lifetime: ${stderr}`);
    assert(readFileSync(marker).length>size);assert.equal((await client(name,'status')).state,'running');
  }
});

test('stop_reply_survives_other_clients_and_held_stop_client_has_bounded_cleanup',{timeout:15000},async t=>{
  const cwd=mkdtempSync(path.join(os.tmpdir(),'cc00r-stop-ack-')),name=pipeName(),marker=path.join(cwd,'marker');
  const host=launch(name,cwd,marker);const sockets=[];
  t.after(async()=>{for(const socket of sockets)socket.destroy();await killAndWait(host);rmSync(cwd,{recursive:true,force:true});});
  await until(()=>existsSync(marker));
  const observer=net.connect(`\\\\.\\pipe\\${name}-${nextSlot++%16}`);sockets.push(observer);observer.on('error',()=>{});await once(observer,'connect');
  const observed=once(observer,'data');observer.write('{"method":"status"}\n');await observed;
  const stop=net.connect(`\\\\.\\pipe\\${name}-${nextSlot++%16}`);sockets.push(stop);stop.on('error',()=>{});await once(stop,'connect');
  let reply='';stop.on('data',data=>reply+=data);stop.write('{"method":"stop"}\n');
  // Keep the stop client open even after consuming the acknowledgement.
  await until(()=>reply.includes('\n'),3000);assert.equal(JSON.parse(reply.trim()).state,'stopped');
  await until(()=>host.exitCode!==null,3000);
  observer.destroy();assert.throws(()=>process.kill(host.pid,0),/ESRCH/);
});

test('worker_host_rejects_nonfixture_executables_and_markers_outside_cwd', () => {
  const cwd=mkdtempSync(path.join(os.tmpdir(),'cc00r-reject-'));
  const name=pipeName(), outside=path.join(os.tmpdir(),`${name}.marker`);
  const run=extra=>spawnSync(hostExe,['--pipe',name,'--exe',mockExe,'--cwd',cwd,...extra],{encoding:'utf8',windowsHide:true,timeout:5000});
  assert.equal(run(['--arg','ticker','--arg',outside]).status,125);
  assert.equal(run(['--arg','unknown','--arg',path.join(cwd,'marker')]).status,125);
  assert.equal(spawnSync(hostExe,['--pipe',name,'--exe',process.execPath,'--cwd',cwd,'--arg','spawn-ticker','--arg',path.join(cwd,'marker')],{encoding:'utf8',windowsHide:true,timeout:5000}).status,125);
  rmSync(cwd,{recursive:true,force:true});
});

test('broker_eof_and_host_death_stop_owned_descendants', { timeout: 20000 }, async t => {
  const cwd=mkdtempSync(path.join(os.tmpdir(),'cc00r-owner-loss-'));
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  for(const loss of ['eof','host-death']) {
    const marker=path.join(cwd,`${loss}.marker`), name=pipeName();
    const host=spawn(hostExe,['--pipe',name,'--exe',mockExe,'--cwd',cwd,'--arg','spawn-ticker','--arg',marker,'--broker-stdin','true'],{windowsHide:true,stdio:['pipe','ignore','ignore']});
    t.after(()=>killAndWait(host));
    await until(()=>existsSync(marker));
    const closed=once(host,'close');
    if(loss==='eof')host.stdin.end();else host.kill();
    await closed;
    const size=readFileSync(marker).length; await delay(250);
    assert.equal(readFileSync(marker).length,size,`${loss} left a descendant writing`);
  }
});

test('broker_eof_during_initialize_closes_the_owned_job', { timeout: 12000 }, async t => {
  const base=mkdtempSync(path.join(os.tmpdir(),'cc00r-stalled-init-')),cwd=path.join(base,'work');mkdirSync(cwd);
  const exe=path.join(base,'CodexRelay.exe'), marker=path.join(cwd,'init-entered.txt');
  copyFileSync(path.join(root,'CodexRelay.exe'),exe);
  writeFileSync(exe+'.json',JSON.stringify({realExecutable:mockExe,realSha256:createHash('sha256').update(readFileSync(mockExe)).digest('hex'),pipeName:`meristem-cc00-${process.pid}-stalled`,allowedCwds:[cwd],testProfile:'CC-00R-stalled-init'}));
  const host=spawn(hostExe,['--mode','codex-relay','--pipe',pipeName(),'--exe',exe,'--cwd',cwd,'--fixture-root',base,'--broker-stdin','true'],{cwd,windowsHide:true,stdio:['pipe','ignore','ignore'],env:{...process.env,CC00_MOCK_INIT:'silent',CC00_MOCK_INIT_MARKER:marker}});
  t.after(async()=>{await killAndWait(host);rmSync(base,{recursive:true,force:true});});
  await until(()=>existsSync(marker));
  const mockPid=Number(readFileSync(marker,'utf8'));
  host.stdin.end();
  await until(()=>host.exitCode!==null||host.signalCode!==null,3000);
  assert.throws(()=>process.kill(mockPid,0),/ESRCH/);
});
