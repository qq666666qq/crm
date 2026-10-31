// Explicit, isolated smoke test against a user-supplied OpenAI-compatible endpoint.
// No CRM production data, saved credentials, or real write operations are used.
import {createProvider,createModels} from '@earendil-works/pi-ai/models';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {Harness,MemoryStorage,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteDatabase} from '@earendil-works/pi-durable/storage/sqlite/node';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {openRuntime} from '../agent/runtime.mjs';
import {createMemoryRepository} from '../agent/memory/repository.mjs';
import {createMemoryTasks} from '../agent/memory/tasks.mjs';
import {createModelGateway} from '../agent/memory/model-gateway.mjs';
import {createRequire} from 'node:module';
const {buildLangfusePayload,uploadLangfuse}=createRequire(import.meta.url)('../electron/langfuse-export.cjs');

const baseUrl=process.env.CRM_PI_SMOKE_URL,apiKey=process.env.CRM_PI_SMOKE_KEY,modelId=process.env.CRM_PI_SMOKE_MODEL;
if(!baseUrl||!apiKey||!modelId)throw Error('Set CRM_PI_SMOKE_URL, CRM_PI_SMOKE_KEY and CRM_PI_SMOKE_MODEL');
const url=new URL(baseUrl);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]','::1'].includes(url.hostname)||url.username||url.password)throw Error('Smoke test endpoint must be local HTTP');
const providerId='crm-local-smoke',model={provider:providerId,modelId};
const provider=createProvider({id:providerId,baseUrl,auth:{apiKey:{name:'test',resolve:async()=>({auth:{apiKey},source:'local-test'})}},models:[{id:modelId,name:'Local smoke model',api:'openai-completions',provider:providerId,baseUrl,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:2048,compat:{supportsStore:false,supportsDeveloperRole:false,maxTokensField:'max_tokens'}}],api:openAICompletionsApi()});
const options={modelProvider:provider,modelSelection:model,modelReady:()=>true};
const within=(promise,ms)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('TEST_TIMEOUT')),ms);})]).finally(()=>clearTimeout(timer));};

async function toolChat(){
 const calls=[],company='f1dd6840-768d-4a20-b951-6c45acdc20c9';
 const runtime=await openRuntime(':memory:',{...options,crmRequest:async(op,args)=>{calls.push(op);if(op==='search')return {items:[{id:company,name:'测试样品公司'}]};if(op==='get')return {id:args.id,name:'测试样品公司'};throw Error('WRITE_NOT_ALLOWED');}});
 try{const result=await runtime.chat('请使用 crm_search 工具搜索公司“测试样品公司”，然后用一句话告诉我查询结果。不要申请创建或修改任何数据。');return {ok:calls.includes('search')&&result.answer.length>0,readCalls:calls.filter(x=>x==='search').length,answer:result.answer.slice(0,200)};}finally{await runtime.close();}
}
async function memory(){
 let finish;const done=new Promise(resolve=>{finish=resolve;});const progress=[];
 const runtime=await openRuntime(':memory:',{...options,enableMemory:true,memoryScope:'local-smoke',onMemoryProgress:event=>{progress.push(`${event.kind}:${event.status}`);if(event.kind==='writer'&&['completed','skipped','failed','blocked_permission'].includes(event.status))finish(event.status);}});
 try{await runtime.chat('请记住一条演示偏好：测试项目青鸟需要 25 台样品，计划两周后交货。请简短回答。');const writer=await within(done,75000),status=await runtime.memoryStatus();const memories=[...status.items,...status.pending];return {ok:writer==='completed'&&memories.length>0,writer,active:status.items.length,pending:status.pending.length,reflection:progress.filter(x=>x.startsWith('reflection:')).at(-1)||'未完成',...(process.env.CRM_PI_SMOKE_VERBOSE==='1'?{sampleMemories:memories.map(item=>({status:item.status,kind:item.kind,content:item.content,conflictCount:item.conflictCount}))}:{})};}finally{await runtime.close();}
}
async function skill(){
 const db=await openNodeSqliteDatabase(':memory:'),repo=await createMemoryRepository(db,{scope:'local-smoke'}),models=createModels();models.setProvider(provider);
 const gateway=createModelGateway(models,model,()=>true),events=[],memoryTasks=createMemoryTasks({repo,gateway,ready:()=>true,prefixes:new Map(),onProgress:event=>events.push(event.status)}),registry=createRegistry();registry.install(memoryTasks.extension);const harness=await Harness.open(new MemoryStorage(),{models,registry},context);
 try{const conversation=await harness.root(context),ref={conversationId:String(conversation.id),piConversationId:conversation.id,submissionId:'1',answerEntryId:'6',completedRuns:3,messageCount:6,toolCallCount:15};await repo.recordTurn(ref);const source={conversationId:ref.conversationId,entryId:'1'},snapshot={entries:Array.from({length:6},(_,i)=>({id:String(i+1),role:i%2?'assistant':'user',text:i%2?'查询结果需要核对客户名称和交期。':'查询示例客户并核对采购交期。',sources:[source]})),trace:Array.from({length:15},(_,i)=>({name:'crm_search',arguments:{resource:'companies',query:`示例${i}`},result:'{"items":[]}',sources:[source]}))};const id=await memoryTasks.schedule(harness,ref,snapshot,'harvest');await within(harness.waitForTask(id,context),75000);const candidates=await repo.listSkillCandidates(ref.conversationId),status=(await repo.tasks(ref.conversationId)).find(item=>item.kind==='harvest');return {ok:['awaiting_confirmation','review_rejected','skipped'].includes(status?.status),status:status?.status,candidates:candidates.length,reviewed:candidates[0]?.review?.approved??null,events};}finally{await harness.close(context);await db.close();}
}
async function evolution(){
 const runtime=await openRuntime(':memory:',options),stages=[];
 try{const baseline=await runtime.chat('请写一句礼貌的中文，向客户询问样品进度。只输出正文。');const result=await runtime.evolve(baseline.traceId,stage=>stages.push(stage));const decided=await runtime.evolutionDecide({id:result.id,expectedVersion:result.version,decision:'baseline'});return {ok:Boolean(result.optimized&&result.candidate&&result.assessment&&decided.decision==='baseline'),stages,baseline:result.baseline.slice(0,160),candidate:result.candidate.slice(0,160),assessment:result.assessment.slice(0,240)};}finally{await runtime.close();}
}
async function evolutionReplay(){
 const company='f1dd6840-768d-4a20-b951-6c45acdc20c9',calls=[],runtime=await openRuntime(':memory:',{...options,enableMemory:true,memoryScope:'local-smoke-replay',memoryGateway:{reflect:async()=>({should_reflect:false})},crmRequest:async(op,args)=>{calls.push(op);if(op==='search')return {items:[{id:company,name:'测试样品公司'}]};if(op==='get')return {id:args.id,name:'测试样品公司'};throw Error('WRITE_NOT_ALLOWED');}});
 try{const baseline=await runtime.chat('请必须调用 crm_search 查询公司“测试样品公司”，再简短说明查询结果。');await runtime.memoryStatus();const result=await runtime.evolve(baseline.traceId);const replayed=result.replayCalls.filter(item=>item.status==='replayed').length;return {ok:result.baselineTrace.length>0&&replayed>0&&calls.filter(op=>op==='search').length===1,baselineCalls:result.baselineTrace.length,replayed,readCalls:calls.filter(op=>op==='search').length,assessment:result.assessment.slice(0,240)};}finally{await runtime.close();}
}

async function telemetry(){
 const records=[],company='f1dd6840-768d-4a20-b951-6c45acdc20c9',runtime=await openRuntime(':memory:',{...options,crmRequest:async(op)=>op==='search'?{items:[{id:company,name:'测试样品公司'}]}:Promise.reject(Error('WRITE_NOT_ALLOWED')),onRunTelemetry:record=>records.push(record)});
 try{
  const started=new Date().toISOString(),question='请使用 crm_search 查询公司“测试样品公司”，然后简短说明结果。不要写入数据。';
  const answer=await runtime.chat(question,'local-smoke-trace'),finished=new Date().toISOString(),trace=records[0];
  if(!trace)return {ok:false,error:'TRACE_UNAVAILABLE'};
  const payload=buildLangfusePayload({id:trace.runId,kind:'chat',started_at:started,finished_at:finished,status:'completed',userMessage:question,answer:answer.answer,model,generations:trace.generations,toolCalls:trace.toolCalls});
  let received;const result=await uploadLangfuse(payload,{baseUrl:'http://127.0.0.1:3000',publicKey:'demo-public',secretKey:'demo-secret'},{fetchImpl:async(_url,options)=>{received=JSON.parse(options.body);return {ok:true,status:200,text:async()=>''};}});
  const spans=received?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans||[];
  const modelCount=spans.filter(item=>item.name==='llm.call').length,toolCount=spans.filter(item=>item.name==='crm_search').length;
  return {ok:result.ok&&modelCount>=2&&toolCount>=1&&JSON.stringify(received).includes('测试样品公司'),modelCalls:modelCount,toolCalls:toolCount,spans:spans.length};
 }finally{await runtime.close();}
}

const selected=process.env.CRM_PI_SMOKE_CASES?.split(',').map(item=>item.trim()).filter(Boolean);
const cases=[['CRM 工具查询',toolChat],['记忆提取与反思',memory],['Skill 生成与复审',skill],['自进化比较',evolution],['自进化轨迹回放',evolutionReplay],['轨迹导出',telemetry]].filter(([name])=>!selected?.length||selected.includes(name));
if(!cases.length)throw Error('No smoke test selected');
const results=await Promise.all(cases.map(async([name,run])=>{const start=Date.now();try{const result=await within(run(),120000);return {name,elapsedMs:Date.now()-start,...result};}catch(error){return {name,elapsedMs:Date.now()-start,ok:false,error:String(error?.message||error).replaceAll(apiKey,'[redacted]').slice(0,200)};}}));
for(const result of results)console.log(JSON.stringify(result));
if(results.some(result=>!result.ok))process.exitCode=1;
