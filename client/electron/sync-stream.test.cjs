const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createSyncStream}=require('./sync-stream.cjs');

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function response(parts) {
  return {ok:true,status:200,body:{getReader:()=>({
    read:async()=>parts.length?{done:false,value:parts.shift()}:{done:true},
    cancel:async()=>{},
  })}};
}

test('旧企业连接晚到 401 不会撤销新企业会话',async()=>{
  const old=deferred(),next=deferred(),requests=[],revoked=[];
  const sync=createSyncStream({
    connect:(headers,signal)=>{requests.push({headers,signal});return requests.length===1?old.promise:next.promise;},
    onConnection:()=>{},onSync:()=>{},onRevoked:()=>revoked.push(true),
  });
  sync.start({token:'old',tenant:'A'});
  sync.start({token:'new',tenant:'B'});
  old.resolve({ok:false,status:401});await tick();
  assert.deepEqual(revoked,[]);
  assert.equal(requests[0].signal.aborted,true);
  assert.equal(requests[1].signal.aborted,false);
  assert.equal(requests[1].headers['X-Tenant-ID'],'B');
  sync.stop();next.resolve({ok:false,status:401});await tick();
  assert.deepEqual(revoked,[]);
});

test('停止后的旧事件不会发送给新页面',async()=>{
  const part=deferred(),events=[];let canceled=0;
  const sync=createSyncStream({
    connect:async()=>({ok:true,status:200,body:{getReader:()=>({read:()=>part.promise,cancel:async()=>{canceled++;}})}}),
    onConnection:()=>{},onSync:data=>events.push(data),onRevoked:()=>{},
  });
  sync.start({token:'old',tenant:'A'});await tick();sync.stop();await tick();
  assert.equal(canceled,1);
  part.resolve({done:false,value:new TextEncoder().encode('event: changes\ndata: {"events":[],"cursor":3}\n\n')});
  await tick();assert.deepEqual(events,[]);
});

test('完整解析跨数据块的 CRLF 和中文，并用游标重连',async()=>{
  const events=[],headers=[],encoder=new TextEncoder();let sync;
  const bytes=encoder.encode('id: 9\r\nevent: changes\r\ndata: {"events":[{"name":"客户"}],"cursor":9}\r\n\r\n');
  const chinese=bytes.indexOf(0xe5);
  const boundary=bytes.indexOf(13)+1;
  const parts=[bytes.slice(0,boundary),bytes.slice(boundary,chinese+1),bytes.slice(chinese+1)];
  sync=createSyncStream({
    connect:async requestHeaders=>{
      headers.push(requestHeaders);
      if(headers.length===1)return response(parts);
      sync.stop();return {ok:false,status:503};
    },
    onConnection:()=>{},onSync:data=>events.push(data),onRevoked:()=>{},retryWait:async()=>{},
  });
  sync.start({token:'secret',tenant:'A'});
  for(let i=0;i<10&&headers.length<2;i++)await tick();
  assert.deepEqual(events[0],{events:[{name:'客户'}],cursor:9});
  assert.equal(headers[1]['Last-Event-ID'],'9');
  assert.equal(headers[1]['X-Tenant-ID'],'A');
});

test('损坏的事件要求重新加载且不沿用旧游标',async()=>{
  const events=[],headers=[],encoder=new TextEncoder();let sync;
  const parts=[encoder.encode('id: 9\nevent: changes\ndata: {"events":[],"cursor":9}\n\n'),encoder.encode('event: changes\ndata: invalid\n\n')];
  sync=createSyncStream({
    connect:async requestHeaders=>{headers.push(requestHeaders);if(headers.length===1)return response(parts);sync.stop();return {ok:false,status:503};},
    onConnection:()=>{},onSync:data=>events.push(data),onRevoked:()=>{},retryWait:async()=>{},
  });
  sync.start({token:'secret',tenant:'A'});
  for(let i=0;i<10&&headers.length<2;i++)await tick();
  assert.deepEqual(events[1],{reset:true,events:[]});
  assert.equal(headers[1]['Last-Event-ID'],undefined);
});
