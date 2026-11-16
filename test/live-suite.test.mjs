import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reserveTurn, reserveParentTurns, finalizeOutcome } from '../spikes/chat-control/suite-support.mjs';
import { removeFixtureMcp } from '../dist/test/live/cc02-restore.js';

test('CC02_cleanup_removes_test_tool_approvals_and_preserves_unrelated_edits', () => {
  const original = 'model="fixture"\n';
  const current = original + '[mcp_servers.meristem]\ncommand="node"\n\n[mcp_servers.meristem.tools.report]\napproval_mode="approve"\n\n[projects."user-new-project"]\ntrust_level="trusted"\n';
  assert.equal(removeFixtureMcp(current, original), 'model="fixture"\n[projects."user-new-project"]\ntrust_level="trusted"\n');
  assert.throws(() => removeFixtureMcp(current, '[mcp_servers.meristem.tools.report]\napproval_mode="prompt"\n'), /did not own/);
});

test('shared_six_turn_budget_reserves_parent_before_any_parent_send', t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'cc00r-budget-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  reserveTurn(dir,'A','first');reserveTurn(dir,'A','followup');
  reserveTurn(dir,'A','new-attempt');reserveTurn(dir,'B','peer');
  const parent=reserveParentTurns(dir);
  assert.equal(parent.length,2);
  assert(parent.every(f=>JSON.parse(readFileSync(f,'utf8')).actor==='P'));
  assert.equal(readdirSync(dir).length,6);
  assert.throws(()=>reserveTurn(dir,'C','extra'),/budget exhausted/);
});

test('cleanup_or_restoration_failure_cannot_be_reported_as_passed', ()=>{
  for(const incomplete of [{configRestored:false,ownedHostsAbsent:true},{configRestored:true,ownedHostsAbsent:false}]){
    const record={result:'passed',...incomplete};assert.equal(finalizeOutcome(record),'failed');
  }
  assert.equal(finalizeOutcome({result:'passed',configRestored:true,ownedHostsAbsent:true}),'passed');
  assert.equal(finalizeOutcome({result:'failed',configRestored:true,ownedHostsAbsent:true}),'failed');
});

test('direct_trials_require_all_declared_cleanup_checks',()=>{
  const required=['configRestored','ownedHostsAbsent','profileSettingsRestored'];
  assert.equal(finalizeOutcome({result:'passed',configRestored:true,ownedHostsAbsent:true,profileSettingsRestored:false},required),'failed');
  assert.equal(finalizeOutcome({result:'passed',hostAbsent:true,stopped:false},['hostAbsent','stopped']),'failed');
  assert.equal(finalizeOutcome({result:'passed',hostAbsent:true,stopped:true},['hostAbsent','stopped']),'passed');
});
