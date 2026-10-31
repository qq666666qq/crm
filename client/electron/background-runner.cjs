const {randomUUID}=require('node:crypto');
// This scheduler only invokes the host's fixed, local mock adapter.
function backgroundRunner({run,intervalMs=60000,setTimer=setInterval,clearTimer=clearInterval}){
 let timer=null,destination=null,last=null,generation=0;
 function stop(){generation++;if(timer!==null)clearTimer(timer);timer=null;destination=null;}
 function status(){return {running:timer!==null,destination,last};}
 function start(target){if(!['notion-demo','feishu-demo'].includes(target))throw Error('目标不可用');if(timer!==null)throw Error('后台模拟已运行');destination=target;const current=++generation;timer=setTimer(()=>{if(current!==generation)return;try{const job=run(target,randomUUID());last={status:job.status,at:job.at};}catch{last={status:'failed',at:new Date().toISOString()};}},intervalMs);timer?.unref?.();return status();}
 return {start,stop,status};
}
module.exports={backgroundRunner};
