// CC-00R test broker only: one owner of the dedicated App Server stdio.
import { createInterface } from 'node:readline';

export function directClient(host) {
  let seq=0,closed=false;
  const pending=new Map(),events=[],requests=[];
  const lines=createInterface({input:host.stdout,crlfDelay:Infinity});
  function fail(){closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('dedicated transport closed; delivery unknown; do not resend'));}pending.clear();}
  lines.on('line',line=>{
    if(Buffer.byteLength(line)>8*1024*1024){fail();host.stdin.end();return;}
    let message;try{message=JSON.parse(line);}catch{fail();host.stdin.end();return;}
    if(message.method){
      const target=message.id===undefined?events:requests;target.push(message);if(target.length>512)target.shift();
      return;
    }
    const p=pending.get(message.id);if(!p)return;pending.delete(message.id);clearTimeout(p.timer);p.resolve(message);
  });
  host.once('close',fail);host.once('error',fail);
  host.stdin.on('error',fail);
  return {events,requests,
    call(method,params={}){
      if(closed)return Promise.reject(Error('dedicated transport closed'));
      return new Promise((resolve,reject)=>{
        const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('dedicated reply timeout; delivery unknown; do not resend'));},15000);
        pending.set(id,{resolve,reject,timer});host.stdin.write(JSON.stringify({id,method,params})+'\n');
      });
    },
    notify(method,params={}){if(closed)throw Error('dedicated transport closed');host.stdin.write(JSON.stringify({method,params})+'\n');},
    close(){host.stdin.end();}
  };
}
