import { writeFileSync } from 'node:fs';
import path from 'node:path';

export function reserveTurn(dir,actor,purpose){
  for(let i=1;i<=6;i++){
    try{const file=path.join(dir,`turn-${i}.json`);writeFileSync(file,JSON.stringify({actor,purpose,delivery:'reserved_before_send',at:new Date().toISOString()}),{flag:'wx'});return file;}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  throw Error('authorized six-turn budget exhausted');
}

export function reserveParentTurns(dir){return [reserveTurn(dir,'P','P_UI_first'),reserveTurn(dir,'P','P_relay_resume')];}
export function finalizeOutcome(record,required=['configRestored','ownedHostsAbsent']){
  if(record.result==='passed' && required.some(key=>record[key]!==true)){
    record.result='failed';record.failure='fixture cleanup or configuration restoration was not confirmed';
  }
  return record.result;
}
