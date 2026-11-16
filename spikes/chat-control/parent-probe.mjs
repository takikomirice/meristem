// CC-00R parent UI/wake probe. Exactly one wake send; UI sends need prior reservations.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from './relay-client.mjs';
import { reserveParentTurns, reserveTurn } from './suite-support.mjs';
const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
assert(args.includes('--live')&&args.includes('--session')&&args.includes('--phase'));
const sessionFile=path.resolve(arg('--session')),phase=arg('--phase');
assert(sessionFile.startsWith(path.resolve('.local/chat-control/CC-00R')+path.sep));
const session=JSON.parse(readFileSync(sessionFile,'utf8')),base=path.dirname(sessionFile),suiteRoot=path.dirname(base);
const stateFile=path.join(base,'parent-state.json');
const state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{};
const save=(file,data)=>writeFileSync(file,JSON.stringify(data,null,2)+'\n');
const client=await connect(session.pipeName);
try{
  let status=(await client.call('relay/status')).result;
  assert(status?.managementEnabled&&status.initialized&&status.testProfile==='CC-00R-parent-real-ui','only the prepared real parent profile is allowed');
  if(phase==='prepare'){
    assert(!state.parentReservations,'parent sends already reserved; do not reserve or send again');
    const catalog=(await client.call('model/list')).result?.data??[];
    assert(catalog.some(m=>m.model==='gpt-6-luna'&&m.supportedReasoningEfforts.some(e=>e.reasoningEffort==='low')));
    state.parentReservations=reserveParentTurns(path.join(suiteRoot,'budget'));state.model='gpt-6-luna';state.effort='low';
    state.phase='ready_for_one_UI_send';save(stateFile,state);
    console.log(JSON.stringify({phase:state.phase,parentSlotsReserved:2,model:state.model,effort:state.effort}));
  }else if(phase==='observe-first'){
    assert(state.phase==='ready_for_one_UI_send','first UI turn already observed or not prepared');
    const starts=status.events.filter(e=>e.method==='ui/turn/start'&&status.observedThreads.includes(e.threadId));
    const turns=status.events.filter(e=>e.method==='turn/completed'&&starts.some(s=>s.threadId===e.threadId));
    assert(turns.length>=1&&turns.length<=2&&starts.length===turns.length,'reconcile every UI start before any further send');
    assert(turns.every(t=>t.status==='completed'),'all observed UI turns must have completed');
    const matches=[];
    for(const turn of turns){
      assert((await client.call('relay/register',{threadId:turn.threadId,ownerEpoch:status.ownerEpoch})).result);
      const read=await client.call('thread/read',{threadId:turn.threadId,includeTurns:true});
      const history=read.result?.thread?.turns??[];
      if(history.some(t=>t.id===turn.turnId&&t.items?.some(i=>i.type==='userMessage'&&JSON.stringify(i.content).includes('CC-00R parent fixture.')&&JSON.stringify(i.content).includes('CC00R_PARENT_74'))&&t.items?.some(i=>i.type==='agentMessage'&&i.text==='CC00R_PARENT_READY')))matches.push(turn);
    }
    assert.equal(matches.length,1,'select only the loaded root whose exact test prompt and reply match the visible UI');
    state.threadId=matches[0].threadId;state.firstTurnId=matches[0].turnId;state.ownerEpoch=status.ownerEpoch;
    state.actualUICompletedTurns=turns.length;state.otherObservedRoots=status.observedThreads.length-1;
    save(state.parentReservations[0],{actor:'P',purpose:'P_UI_first',delivery:'completion_observed',status:'completed',threadId:state.threadId,turnId:state.firstTurnId});
    if(turns.length===2){
      const other=turns.find(t=>t.turnId!==state.firstTurnId);
      save(state.parentReservations[1],{actor:'P',purpose:'P_UI_additional_observed',delivery:'completion_observed',status:'completed',threadId:other.threadId,turnId:other.turnId});
      state.wakeReservation=reserveTurn(path.join(suiteRoot,'budget'),'P','P_relay_resume');
    }else state.wakeReservation=state.parentReservations[1];
    state.phase='first_UI_turn_completed';save(stateFile,state);
    console.log(JSON.stringify({phase:state.phase,registeredRoot:true,firstTurnCompleted:true,actualUICompletedTurns:turns.length,wakeReserved:true}));
  }else if(phase==='wake'){
    assert(state.phase==='first_UI_turn_completed'&&state.ownerEpoch===status.ownerEpoch,'do not resend or resume an unknown parent attempt');
    assert(!status.activeTurns[state.threadId],'parent must be idle after its final response');
    const child=JSON.parse(readFileSync(path.resolve('docs/validation/chat-control/CC-00R.live-suite.evidence.json'),'utf8'));
    assert(child.realMcpCorrelation?.threadMatches&&child.realMcpCorrelation?.turnMatches&&child.operationIds.includes('A_first_metadata'));
    const reservation=JSON.parse(readFileSync(state.wakeReservation,'utf8'));assert.equal(reservation.delivery,'reserved_before_send','wake already attempted; do not retry');
    state.phase='wake_sending';save(stateFile,state);save(state.wakeReservation,{actor:'P',purpose:'P_relay_resume',delivery:'sending',threadId:state.threadId});
    const response=await client.call('turn/start',{threadId:state.threadId,model:state.model,effort:state.effort,input:[{type:'text',text:'CC-00R test broker stored child result: child A completed its first read-only MCP metadata turn and its real thread/turn correlation matched. Later shell trials stopped without confirmed completion. Recall the parent token from your previous turn. Reply exactly "CC00R_PARENT_74 CC00R_PARENT_WAKE". Do not use tools or access files.'}]});
    assert(response.result?.turn?.id,'wake result unknown; never resend');state.wakeTurnId=response.result.turn.id;assert.notEqual(state.wakeTurnId,state.firstTurnId);
    save(state.wakeReservation,{actor:'P',purpose:'P_relay_resume',delivery:'accepted',threadId:state.threadId,turnId:state.wakeTurnId});save(stateFile,state);
    const end=Date.now()+120000;let completed;
    while(Date.now()<end){status=(await client.call('relay/status')).result;completed=status.events.find(e=>e.method==='turn/completed'&&e.threadId===state.threadId&&e.turnId===state.wakeTurnId);if(completed)break;await delay(200);}
    assert.equal(completed?.status,'completed','wake completion unknown; do not retry');
    save(state.wakeReservation,{actor:'P',purpose:'P_relay_resume',delivery:'completion_observed',status:'completed',threadId:state.threadId,turnId:state.wakeTurnId});state.phase='wake_completed';save(stateFile,state);
    console.log(JSON.stringify({phase:state.phase,sameRoot:true,newTurn:true,childStoredResultUsed:true,uiVerificationRequired:true}));
  }else throw Error('unknown phase');
}finally{client.socket.end();}
