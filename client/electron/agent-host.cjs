const {randomUUID}=require('node:crypto');

// Owns one Agent process at a time. Session identity remains with the caller.
function createAgentHost({session,launch,onMessage=()=>{},onStatus=()=>{},setTimer=setTimeout,clearTimer=clearTimeout,retryDelays=[1000,2000,4000],makeId=randomUUID}) {
  let child=null,stopping=Promise.resolve(),epoch=0,retryTimer=null,stopWatch=null,readyTimer=null,stableTimer=null,retries=0;
  const publish=(state,details={})=>{try{onStatus({state,...details});}catch{}};
  const valid=ticket=>{const current=session();return current.authenticated&&current.generation===ticket.generation&&Boolean(current.privateMode)===ticket.privateMode&&epoch===ticket.epoch;};
  const isCurrent=(candidate,generation)=>{const current=session();return child===candidate&&current.authenticated&&current.generation===generation;};
  function clearReady(){if(readyTimer!==null){clearTimer(readyTimer);readyTimer=null;}}
  function clearStable(){if(stableTimer!==null){clearTimer(stableTimer);stableTimer=null;}}
  function cancelTimers(){if(retryTimer!==null){clearTimer(retryTimer);retryTimer=null;}if(stopWatch!==null){clearTimer(stopWatch);stopWatch=null;}clearReady();clearStable();}
  function retire(candidate){
    if(child===candidate)child=null;
    const stopped=new Promise(resolve=>{
      let done=false;
      const finish=()=>{if(done)return;done=true;clearTimer(timer);resolve();};
      const timer=setTimer(()=>{try{candidate.kill();}catch{}},10000);
      candidate.once('exit',finish);
      try{candidate.postMessage({type:'close'});}catch{try{candidate.kill();}catch{}}
    });
    stopping=Promise.all([stopping,stopped]).then(()=>{});
    return stopping;
  }
  function stop(){
    epoch++;retries=0;cancelTimers();
    const previous=child;child=null;
    if(previous)retire(previous);
    return stopping;
  }
  function scheduleRecovery(ticket,reason){
    if(!valid(ticket))return;
    if(ticket.privateMode){publish('failed',{reason:'PRIVATE_SESSION_LOST',privateMode:true});return;}
    if(retryTimer!==null)return;
    if(retries>=retryDelays.length){publish('failed',{reason:'RETRY_EXHAUSTED',privateMode:false});return;}
    const delay=retryDelays[retries++];publish('recovering',{reason,attempt:retries,privateMode:false});
    retryTimer=setTimer(()=>{
      retryTimer=null;
      if(!valid(ticket))return;
      void start().catch(()=>{if(valid(ticket))scheduleRecovery(ticket,'START_FAILED');});
    },delay);
  }
  function retireFailed(candidate,ticket){
    clearReady();clearStable();const wait=retire(candidate);let timedOut=false;
    const watch=setTimer(()=>{if(stopWatch===watch)stopWatch=null;timedOut=true;if(valid(ticket))publish('failed',{reason:'STOP_TIMEOUT',privateMode:ticket.privateMode});},15000);stopWatch=watch;
    void wait.then(()=>{if(stopWatch===watch){clearTimer(watch);stopWatch=null;}if(!timedOut)scheduleRecovery(ticket,'RUNTIME_FAILED');});
  }
  async function start(){
    const current=session(),ticket={generation:current.generation,privateMode:Boolean(current.privateMode),epoch};
    if(!current.authenticated)throw Error('Authentication required');
    if(retryTimer!==null){clearTimer(retryTimer);retryTimer=null;}
    let timer;
    try{await Promise.race([stopping,new Promise((_,reject)=>{timer=setTimer(()=>reject(Error('AGENT_STOP_TIMEOUT')),15000);})]);}
    finally{clearTimer(timer);}
    if(!valid(ticket))throw Error('Session changed');
    if(child)return child;
    const created=launch(ticket),candidate=created.child;child=candidate;let ready=false,startupFailed=false;
    readyTimer=setTimer(()=>{if(child!==candidate||!valid(ticket))return;readyTimer=null;startupFailed=true;publish('failed',{reason:'STARTUP_TIMEOUT',privateMode:ticket.privateMode});retire(candidate);},20000);
    candidate.on('error',()=>{});
    candidate.on('message',message=>{
      if(!isCurrent(candidate,ticket.generation)||!valid(ticket))return;
      if(message?.type==='ready'){ready=true;clearReady();clearStable();if(retries){publish('ready',{recovered:true,privateMode:ticket.privateMode});stableTimer=setTimer(()=>{stableTimer=null;if(isCurrent(candidate,ticket.generation)&&valid(ticket))retries=0;},60000);}return;}
      if(message?.type==='startup-error'){startupFailed=true;clearReady();publish('failed',{reason:'STARTUP_FAILED',privateMode:ticket.privateMode});return;}
      if(message?.type==='runtime-failed'){if(!ready){startupFailed=true;clearReady();publish('failed',{reason:'STARTUP_FAILED',privateMode:ticket.privateMode});retire(candidate);}else retireFailed(candidate,ticket);return;}
      try{Promise.resolve(onMessage(candidate,message,ticket.generation)).catch(()=>{});}catch{}
    });
    candidate.once('exit',()=>{
      if(child!==candidate)return;
      child=null;clearReady();clearStable();
      if(!valid(ticket))return;
      if(!ready||startupFailed){publish('failed',{reason:'STARTUP_FAILED',privateMode:ticket.privateMode});return;}
      scheduleRecovery(ticket,'PROCESS_EXIT');
    });
    try{if(created.initialize)created.initialize();}catch(error){clearReady();retire(candidate);throw error;}
    return candidate;
  }
  async function request(type,payload={}){
    const generation=session().generation,candidate=await start(),id=makeId();
    if(!isCurrent(candidate,generation))throw Error('Session changed');
    return new Promise((resolve,reject)=>{
      const timeout=type==='harness2-run'?600000:['chat','evolve'].includes(type)?120000:15000;
      const timer=setTimer(()=>finish(Error('Agent 暂时不可用')),timeout);
      function finish(error,data){clearTimer(timer);candidate.off('message',onMessageReply);candidate.off('exit',onExit);error?reject(error):resolve(data);}
      function onExit(){finish(Error('Agent 已停止'));}
      function onMessageReply(message){
        if(message?.type==='startup-error'){finish(Error('会话存储无法打开，请检查本机加密设置'));return;}
        if(message?.type==='runtime-failed'){finish(Error('Agent 存储异常，正在恢复'));return;}
        if(message?.id!==id)return;
        if(!isCurrent(candidate,generation)){finish(Error('Session changed'));return;}
        if(message.type==='evolution-progress')return;
        if(message.error)finish(Error('Agent 请求失败'));else finish(null,message.data);
      }
      candidate.on('message',onMessageReply);candidate.on('exit',onExit);
      try{candidate.postMessage({type,id,...payload});}catch(error){finish(error);}
    });
  }
  return {start,request,stop,isCurrent,stopped:()=>stopping};
}

module.exports={createAgentHost};
