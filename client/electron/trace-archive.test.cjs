const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createTraceArchive,writeTraceExportFile}=require('./trace-archive.cjs');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');

const time={started_at:'2026-01-01T00:00:00Z',finished_at:'2026-01-01T00:00:01Z',status:'completed'};
const detail=(id,extra={})=>({id,...time,kind:'chat',userMessage:'原始问题 '+id,answer:'完整答案',generations:[{input:'模型上下文',output:'模型回答',status:'ok'}],toolCalls:[{name:'crm_search',args:{query:'客户'},output:'工具结果',status:'ok'}],...extra});

function fixture(){
 const records=new Map([['new-1',detail('new-1')],['new-2',detail('new-2')],['history:1:1',detail('history:1:1',{reconstructed:true})]]);
 const states=new Map(),sent=[];let generation=1,upload=async payload=>{sent.push(payload);return {ok:true};};
 const stateKey=(id,target)=>target+':'+id;
 const page=(ids,value)=>{const start=value.cursor||0,subset=ids.slice(start,start+value.limit);return {items:subset.map(id=>({id,...(states.get(stateKey(id,value.target))||{state:'pending',error:null})})),next:start+value.limit<ids.length?start+value.limit:null};};
 async function request(type,payload={}){const v=payload.value||{};if(type==='trace-page')return page(['new-1','new-2'],v);if(type==='trace-conversations')return ['1'];if(type==='trace-history-page')return page(['history:1:1'],v);if(type==='trace-get')return records.has(v.id)?{detail:records.get(v.id),...(states.get(stateKey(v.id,v.target))||{state:'pending',error:null})}:null;if(type==='trace-mark'){states.set(stateKey(v.id,v.target),{state:v.state,error:v.error});return {ok:true};}throw Error('UNEXPECTED_REQUEST');}
 const archive=createTraceArchive({request,upload:(...args)=>upload(...args),context:()=>({generation,config:{baseUrl:'https://langfuse.example',publicKey:'public',secretKey:'secret'},buildOptions:{userId:'user'}}),isCurrent:context=>context.generation===generation,pageSize:1});
 return {archive,sent,states,records,setUpload:value=>{upload=value;},switchSession:()=>generation++};
}

test('上传从数据库分页读取新旧轨迹，成功状态跨重新创建管理器保留',async()=>{
 const f=fixture(),first=await f.archive.uploadAll();assert.deepEqual(first,{uploaded:3,failed:0,total:3,lastError:null});assert.equal(f.sent.length,3);
 assert.match(JSON.stringify(f.sent),/原始问题/);assert.match(JSON.stringify(f.sent),/模型上下文/);assert.match(JSON.stringify(f.sent),/工具结果/);
 assert.equal((await f.archive.uploadAll()).total,0);assert.equal((await f.archive.status()).pending,0);
});

test('自动和手动上传同一记录不会并发发送，失败状态可以重试',async()=>{
 const f=fixture();let release,started;const gate=new Promise(resolve=>{release=resolve;}),begin=new Promise(resolve=>{started=resolve;});let calls=0;
 f.setUpload(async()=>{calls++;started();await gate;return {ok:true};});
 const one=f.archive.uploadOne('new-1'),two=f.archive.uploadOne('new-1');await begin;release();await Promise.all([one,two]);assert.equal(calls,1);
 f.setUpload(async()=>({ok:false,error:'OFFLINE'}));assert.equal((await f.archive.uploadOne('new-2')).error,'OFFLINE');
 f.setUpload(async()=>({ok:true}));assert.equal((await f.archive.uploadOne('new-2')).ok,true);
});

test('部分接收不会自动重复上传，切换账号不会修改新账号的状态',async()=>{
 const f=fixture();let calls=0;f.setUpload(async()=>{calls++;return {ok:false,error:'LANGFUSE_PARTIAL_FAILURE'};});
 assert.equal((await f.archive.uploadOne('new-1')).error,'LANGFUSE_PARTIAL_FAILURE');assert.equal((await f.archive.uploadOne('new-1')).error,'LANGFUSE_PARTIAL_FAILURE');assert.equal(calls,1);
 let release,started;const gate=new Promise(resolve=>{release=resolve;}),begin=new Promise(resolve=>{started=resolve;});f.setUpload(async()=>{started();await gate;return {ok:true};});
 const pending=f.archive.uploadOne('new-2');await begin;f.switchSession();release();assert.equal((await pending).error,'SESSION_CHANGED');
 assert.equal((await f.archive.status()).pending,3);
});

test('文件导出分页读取数据库原文和旧状态记录，不重复导出同一记录',async()=>{
 const f=fixture(),chunks=[],old='12345678-1234-1234-1234-123456789abc';
 const result=await f.archive.writeExport(chunk=>{chunks.push(chunk);},[{...time,id:old},{...time,id:'new-1'}]);
 const output=chunks.join(''),parsed=JSON.parse(output),spans=parsed.resourceSpans.flatMap(item=>item.scopeSpans.flatMap(scope=>scope.spans));
 assert.equal(result.details,3);assert.match(output,/模型上下文/);assert.match(output,/工具结果/);assert.ok(spans.some(span=>span.traceId===old.replaceAll('-','')));
 assert.equal(spans.filter(span=>span.name==='crm.agent.chat'&&JSON.stringify(span).includes('原始问题 new-1')).length,1);
});

test('导出失败时保留原文件并清理临时文件',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'crm-archive-')),file=path.join(dir,'export.json');
 try{await fs.writeFile(file,'原文件');
  const broken={async writeExport(write){await write('部分内容');throw Error('SESSION_CHANGED');}};
  await assert.rejects(writeTraceExportFile(broken,file,[],[]),/SESSION_CHANGED/);
  assert.equal(await fs.readFile(file,'utf8'),'原文件');assert.deepEqual(await fs.readdir(dir),['export.json']);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
