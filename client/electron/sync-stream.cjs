// Own one authenticated SSE connection, its cursor, and its retry lifecycle.
function waitForRetry(milliseconds,signal) {
  return new Promise(resolve=>{
    if(signal.aborted)return resolve();
    const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};
    const timer=setTimeout(finish,milliseconds);
    signal.addEventListener('abort',finish,{once:true});
  });
}

function createSyncStream({connect,onConnection,onSync,onRevoked,retryWait=waitForRetry}) {
  let current=null;
  const isCurrent=run=>current===run&&!run.controller.signal.aborted;

  function stop() {
    const run=current;
    current=null;
    if(run)run.controller.abort();
  }

  async function consume(run) {
    let cursor=null,retry=1000;
    while(isCurrent(run)) {
      const attempt=new AbortController();
      const abortAttempt=()=>attempt.abort();
      run.controller.signal.addEventListener('abort',abortAttempt,{once:true});
      let reader=null;
      try {
        const headers={Authorization:`Bearer ${run.token}`,'X-Tenant-ID':run.tenant,Accept:'text/event-stream'};
        if(cursor!==null)headers['Last-Event-ID']=String(cursor);
        const response=await connect(headers,attempt.signal);
        if(!isCurrent(run))return;
        if(response.status===401||response.status===403){onRevoked();return;}
        if(!response.ok||!response.body)throw new Error('Sync unavailable');
        onConnection('connected');retry=1000;
        reader=response.body.getReader();
        const decoder=new TextDecoder();let buffer='';
        while(isCurrent(run)) {
          let timer,abortRead;
          const part=await Promise.race([
            reader.read(),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Sync heartbeat timed out')),45000);}),
            new Promise((_,reject)=>{
              abortRead=()=>reject(new Error('Sync stopped'));
              if(run.controller.signal.aborted)abortRead();
              else run.controller.signal.addEventListener('abort',abortRead,{once:true});
            }),
          ]).finally(()=>{clearTimeout(timer);run.controller.signal.removeEventListener('abort',abortRead);});
          if(!isCurrent(run))return;
          if(part.done)break;
          // Normalize after appending so CRLF split across two chunks is preserved.
          buffer=(buffer+decoder.decode(part.value,{stream:true})).replace(/\r\n/g,'\n');
          if(buffer.length>1024*1024)throw new Error('Sync buffer limit exceeded');
          let boundary;
          while(isCurrent(run)&&(boundary=buffer.indexOf('\n\n'))>=0) {
            const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
            let event='message',id=null,payload='';
            for(const line of block.split('\n')) {
              if(line.startsWith('event:'))event=line.slice(6).trim();
              else if(line.startsWith('id:'))id=line.slice(3).trim();
              else if(line.startsWith('data:'))payload+=line.slice(5).trimStart();
            }
            if(event==='revoked'){onRevoked();return;}
            if(event==='changes') {
              try {
                const data=JSON.parse(payload);
                if(!Array.isArray(data.events)||!Number.isSafeInteger(data.cursor))throw new Error('Invalid event');
                onSync(data);
                if(id&&/^\d+$/.test(id))cursor=Number(id);
              } catch {
                cursor=null;
                onSync({reset:true,events:[]});
              }
            }
          }
        }
        if(isCurrent(run))throw new Error('Connection closed');
      } catch {
        if(!isCurrent(run))return;
        onConnection('reconnecting');
        onSync({reset:false,events:[{action:'resync'}]});
      } finally {
        attempt.abort();
        run.controller.signal.removeEventListener('abort',abortAttempt);
        if(reader){try{void reader.cancel().catch(()=>{});}catch{}}
      }
      if(!isCurrent(run))return;
      await retryWait(retry,run.controller.signal);
      retry=Math.min(retry*2,15000);
    }
  }

  function start({token,tenant}) {
    stop();
    if(!token||!tenant)return;
    const run={token,tenant,controller:new AbortController()};
    current=run;
    void consume(run).finally(()=>{if(current===run)current=null;});
  }
  return {start,stop};
}
module.exports={createSyncStream};
