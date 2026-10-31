const {randomUUID}=require('node:crypto');

// All requests share cancellation and idempotency state for the current session.
function createCrmTransport({api,session,fetch,onRevoked,onPermission}) {
  const pending=new Set(),retryKeys=new Map();

  function endpoint(pathname) {
    if(typeof pathname!=='string'||!pathname.startsWith('/api/v1/')||pathname.startsWith('/api/v1//')||pathname.includes('\\'))throw new Error('Invalid API path');
    const url=new URL(pathname,api);
    if(url.origin!==api.origin||!url.pathname.startsWith('/api/v1/'))throw new Error('Invalid API destination');
    return url;
  }

  function reset() {
    for(const controller of pending)controller.abort();
    pending.clear();
    retryKeys.clear();
  }

  async function call(pathname,method='GET',body,activeToken=session().token,activeTenant=session().tenant,agentWrite=null) {
    if(!['GET','POST','PATCH','DELETE'].includes(method))throw new Error('Invalid HTTP method');
    const controller=new AbortController();pending.add(controller);
    const current=session().generation,timer=setTimeout(()=>controller.abort(),15000);
    try {
      const headers={Accept:'application/json'};
      if(activeToken)headers.Authorization=`Bearer ${activeToken}`;
      if(activeTenant)headers['X-Tenant-ID']=activeTenant;
      if(body!==undefined)headers['Content-Type']='application/json';
      let retryKey;
      if(method!=='GET'&&!pathname.startsWith('/api/v1/auth/')) {
        if(agentWrite){headers['Idempotency-Key']=agentWrite.id;headers['X-Operation-Source']='agent';if(agentWrite.runId)headers['X-Agent-Run-ID']=agentWrite.runId;}
        else {
          retryKey=JSON.stringify([activeTenant,method,pathname,body]);
          if(!retryKeys.has(retryKey)) {
            if(retryKeys.size>=100)throw new Error('Too many unresolved requests; reconnect before retrying');
            retryKeys.set(retryKey,randomUUID());
          }
          headers['Idempotency-Key']=retryKeys.get(retryKey);
        }
      }
      const result=await fetch(endpoint(pathname),{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,redirect:'error'});
      const data=await result.json().catch(()=>({}));
      if(current!==session().generation)throw new Error('Session changed');
      if(retryKey&&result.status<500)retryKeys.delete(retryKey);
      if(!result.ok) {
        if(result.status===401&&!pathname.endsWith('/auth/login'))onRevoked();
        if(result.status===403&&!pathname.endsWith('/auth/me'))onPermission();
        return {ok:false,status:result.status,error:data.error||{code:'INTERNAL_ERROR',message:'请求失败'}};
      }
      return {ok:true,data};
    } finally {clearTimeout(timer);pending.delete(controller);}
  }

  function openSync(headers,signal) {
    return fetch(endpoint('/api/v1/sync/events'),{headers,signal,redirect:'error'});
  }
  return {call,openSync,reset};
}
module.exports={createCrmTransport};
