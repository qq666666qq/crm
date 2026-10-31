const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCrmTransport}=require('./crm-transport.cjs');

function setup(fetch) {
  let state={token:'secret',tenant:'A',generation:0},revoked=0,forbidden=0;
  const transport=createCrmTransport({api:new URL('http://127.0.0.1:8000'),session:()=>state,fetch,onRevoked:()=>revoked++,onPermission:()=>forbidden++});
  return {transport,setState:value=>{state=value;},revoked:()=>revoked,forbidden:()=>forbidden};
}
function result(status,data={}){return {ok:status>=200&&status<300,status,json:async()=>data};}

test('只允许目标服务的 API 路径',async()=>{
  const requests=[];const {transport}=setup(async(url,options)=>{requests.push({url,options});return result(200,{items:[]});});
  for(const path of ['https://evil.test/api/v1/companies','/api/v1//companies','/api/v1/../auth','/api/v1/companies\\other'])await assert.rejects(transport.call(path),/Invalid API/);
  assert.equal(requests.length,0);
  assert.deepEqual(await transport.call('/api/v1/companies'),{ok:true,data:{items:[]}});
  assert.equal(requests[0].url.origin,'http://127.0.0.1:8000');
  assert.equal(requests[0].options.headers['X-Tenant-ID'],'A');
});

test('未知结果重试复用标识，确定成功后使用新标识',async()=>{
  const keys=[];
  const {transport}=setup(async(_url,options)=>{keys.push(options.headers['Idempotency-Key']);if(keys.length===1)throw Error('timeout');return result(201,{id:'created'});});
  await assert.rejects(transport.call('/api/v1/companies','POST',{name:'buyer'}),/timeout/);
  assert.equal((await transport.call('/api/v1/companies','POST',{name:'buyer'})).ok,true);
  await transport.call('/api/v1/companies','POST',{name:'buyer'});
  assert.equal(keys[0],keys[1]);assert.notEqual(keys[1],keys[2]);
});

test('切换账号后旧请求晚到 401 不影响新会话',async()=>{
  let finish,signal;
  const response=new Promise(resolve=>{finish=resolve;});
  const h=setup(async(_url,options)=>{signal=options.signal;return response;});
  const pending=h.transport.call('/api/v1/companies');
  h.setState({token:'new',tenant:'B',generation:1});h.transport.reset();
  assert.equal(signal.aborted,true);
  finish(result(401));await assert.rejects(pending,/Session changed/);
  assert.equal(h.revoked(),0);
});

test('当前会话失效和无权访问分别通知调用方',async()=>{
  let status=401;
  const h=setup(async()=>result(status));
  await h.transport.call('/api/v1/companies');assert.equal(h.revoked(),1);
  status=403;await h.transport.call('/api/v1/companies');assert.equal(h.forbidden(),1);
  await h.transport.call('/api/v1/auth/me');assert.equal(h.forbidden(),1);
});
