import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {createModels,calculateCost} from '@earendil-works/pi-ai/models';
import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import {Harness,createRegistry,AssistantEntry} from '@earendil-works/pi-durable';
import {openNodeSqliteDatabase} from '@earendil-works/pi-durable/storage/sqlite/node';
import {SqliteStorage} from '@earendil-works/pi-durable/storage/sqlite';
import {openEncryptedDatabase} from './encrypted-sqlite.mjs';
import {createMemoryRepository} from './memory/repository.mjs';
import {createMemoryExtension} from './memory/extension.mjs';
import {createMemoryTasks} from './memory/tasks.mjs';
import {createModelGateway} from './memory/model-gateway.mjs';
import {createTurnCoordinator} from './memory/turn-coordinator.mjs';
import {createMemoryFacade} from './memory/facade.mjs';
import {createIdleWriter} from './memory/idle-writer.mjs';
import {createMemorySearch,createOpenAIEmbedder} from './memory/search.mjs';
import {createSemanticIndex} from './memory/semantic-index.mjs';
import {readConversationEntries} from './conversation-entries.mjs';
import {openConversations} from './conversations.mjs';
import {createEvolutionRunner} from './evolution-runner.mjs';
import {createEvolutionReplay} from './evolution-replay.mjs';
import {createEvolutionStore} from './evolution-store.mjs';
import {createEvolutionTask} from './evolution-task.mjs';
import {createEvolutionLock} from './evolution-lock.mjs';
import {createRunTelemetry} from './run-telemetry.mjs';
import {createTraceStore} from './trace-store.mjs';
import {createTraceFacade} from './trace-facade.mjs';
import {createChatRequests} from './chat-requests.mjs';
import {createTraceHistory} from './trace-history.mjs';
import {PRESETS,createExtensions} from './presets.mjs';
import {crmReadExtension} from './crm-tools.mjs';
import {openHarness2} from './harness2-runtime.mjs';
import {randomUUID} from 'node:crypto';
function emptyUsage(){return {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};}
function addUsage(total,usage){if(!usage)return total;for(const key of ['input','output','cacheRead','cacheWrite','totalTokens'])if(typeof usage[key]==='number')total[key]+=usage[key];if(typeof usage.reasoning==='number')total.reasoning=(total.reasoning||0)+usage.reasoning;if(usage.cost)for(const key of ['input','output','cacheRead','cacheWrite','total'])if(typeof usage.cost[key]==='number')total.cost[key]+=usage.cost[key];return total;}
export async function openRuntime(file,{crmRequest,modelProvider,modelSelection,modelReady,databaseKey,enableMemory=false,memoryScope='local',onMemoryProgress=()=>{},onEvolutionProgress=()=>{},onRunTelemetry=()=>{},onAuxRunDetail=()=>{},onRuntimeReport=()=>{},onRuntimeClosed=()=>{},memoryGateway,embeddingProvider,memoryIdleMs=600000,evolutionWaitModelMs=30000}={}){
 let currentQuery='',currentRun=null;
 const extensions=createExtensions(async()=>'核对每个事实的来源，缺乏依据的内容标记待确认。');
 const registry=createRegistry();const replay=createEvolutionReplay(),traceCapture=createRunTelemetry();registry.install(replay.extension);registry.install(traceCapture.extension);for(const extension of Object.values(extensions))registry.install(extension);const crm=crmRequest?crmReadExtension((operation,args,callId)=>crmRequest(operation,args,callId,currentRun)):null;if(crm)registry.install(crm);
 const models=createModels();models.setProvider(modelProvider||openaiProvider());const model=modelSelection||{provider:'openai',modelId:'gpt-4.1-mini'};const ready=modelReady||(()=>Boolean(process.env.OPENAI_API_KEY));
 const database=databaseKey?await openEncryptedDatabase(file,databaseKey):await openNodeSqliteDatabase(file);
 let storage,harness,memoryCoordinator,storageOpening=false;
 try {
 const memory=enableMemory?await createMemoryRepository(database,{scope:memoryScope,authorize:async(resource,id)=>{if(!crmRequest)return false;await crmRequest('get',{resource,id});return true;}}):null;
 const prefixes=new Map();
 const embedding=embeddingProvider||createOpenAIEmbedder(()=>process.env.OPENAI_API_KEY),getEmbeddingModel=async()=>await memory.metadata('semantic_model')||'text-embedding-3-small';
 const embed=async(texts,modelId,signal)=>{const startedAt=new Date().toISOString(),modelInfo={provider:embeddingProvider?'custom':'openai',modelId};const detail={id:randomUUID(),kind:'memory.embedding',started_at:startedAt,status:'running',userMessage:texts,model:modelInfo,generations:[{type:'embedding',input:texts,startedAt,model:modelInfo,status:'running'}],toolCalls:[]};const call=detail.generations[0];try{const output=await embedding(texts,modelId,signal);call.output=output;detail.answer=output;call.status='ok';detail.status='completed';return output;}catch(error){call.status='error';detail.status='failed';detail.error='EMBEDDING_UNAVAILABLE';throw error;}finally{detail.finished_at=call.finishedAt=new Date().toISOString();try{onAuxRunDetail(detail);}catch{}}};
 const memorySearch=memory?createMemorySearch({repo:memory,enabled:async()=>await memory.metadata('semantic_enabled')==='1',embed,model:getEmbeddingModel}):null;
 const semanticIndex=memory?createSemanticIndex({repo:memory,embed,ready,getModel:getEmbeddingModel,onProgress:onMemoryProgress}):null;
 const memoryExtension=memory?createMemoryExtension({repo:memory,prefixes,currentQuery:()=>currentQuery,memorySearch}):null;
 const memoryTasks=memory?createMemoryTasks({repo:memory,gateway:memoryGateway||createModelGateway(models,model,ready,{onRunDetail:onAuxRunDetail}),ready,prefixes,onProgress:onMemoryProgress}):null;
 const idleWriter=memory?createIdleWriter({repo:memory,delayMs:memoryIdleMs,onProgress:onMemoryProgress}):null;
 const evolutionLock=createEvolutionLock(),evolutionTask=createEvolutionTask({ready,perform:(conversation,traceId,progress,taskId,runId,signal)=>evolutionLock.run(signal,()=>performEvolution(conversation,traceId,progress,taskId,runId)),onProgress:onEvolutionProgress,waitModelMs:evolutionWaitModelMs});registry.install(evolutionTask.extension);
 if(memoryExtension)registry.install(memoryExtension);if(memoryTasks)registry.install(memoryTasks.extension);if(semanticIndex)registry.install(semanticIndex.extension);if(idleWriter)registry.install(idleWriter.extension);
 storageOpening=true;storage=await SqliteStorage.open(database);
 const reportTypes=new Set(['session_failed','task_faulted','task_parked','task_error','migration_failed','task_outdated','extension_error','host_error','listener_error']);
 harness=await Harness.open(storage,{models,registry,onReport:(_error,info)=>{if(reportTypes.has(info?.type))try{onRuntimeReport({type:info.type});}catch{}}},BACKGROUND_CONTEXT);
 void harness.closed.then(end=>{if(end?.reason==='failed')try{onRuntimeClosed({reason:'STORAGE_FAILED'});}catch{}}).catch(()=>{});
 const evolutions=createEvolutionStore(harness,async refs=>memory?memory.checkSources(refs):refs.length===0);
 const performEvolution=createEvolutionRunner({harness,model,memory,traceCapture,replay,evolutions,onAuxRunDetail});
 const selected=id=>[extensions[id],...(crm?[crm]:[]),...(memoryExtension?[memoryExtension]:[]),traceCapture.extension];
 const sessions=await openConversations({harness,model,initialExtensions:selected('lead-opportunity'),isBusy:()=>Boolean(currentQuery)});
 const traceStore=createTraceStore(harness,storage),traceHistory=createTraceHistory({harness,storage,conversations:()=>sessions.known(),traceStore}),chatRequests=createChatRequests(harness,storage);
 const traceFacade=createTraceFacade({traceStore,traceHistory,sessions});
 await sessions.persist();evolutionTask.bind(harness);
 if(semanticIndex&&await memory.metadata('semantic_enabled')==='1')await semanticIndex.ensure(harness,sessions.current.id,{resume:false});
 memoryCoordinator=memory?await createTurnCoordinator({harness,storage,repo:memory,memoryTasks,idleWriter,knownConversations:()=>sessions.known(),onProgress:onMemoryProgress,autoStart:false}):null;
 const memoryFacade=createMemoryFacade({memory,memoryCoordinator,semanticIndex,harness,sessions,getEmbeddingModel,memorySearch,memoryTasks});
 let presetId='lead-opportunity';
 async function getEntries(target=sessions.current){return readConversationEntries(target);}
 const h2=await openHarness2({harness,model,ready,traceCapture,onAuxRunDetail,extensions:crm?[extensions['lead-opportunity'],crm]:[extensions['lead-opportunity']]});
 if(memoryCoordinator)memoryCoordinator.start();else harness.resume();
 return {memory,...traceFacade,get conversationId(){return sessions.current.id;},async listConversations(){return sessions.list();},async newConversation(){return sessions.create(selected(presetId));},async selectConversation(id){return sessions.select(id,selected(presetId));},async evolve(traceId,onProgress=()=>{}){if(!ready())throw Error('MODEL_NOT_CONFIGURED');if(currentQuery)throw Error('BUSY');currentQuery='evolution';try{return await evolutionTask.execute(sessions.current.id,traceId,onProgress);}finally{currentQuery='';}},async evolutionTasks(){return evolutionTask.list(sessions.current.id);},async evolutionHistory(traceId){return evolutions.list(sessions.current.id,traceId);},async evolutionDecide(value){return evolutions.decide(sessions.current.id,value.id,value.expectedVersion,value.decision);},presets:()=>PRESETS.map(x=>({...x})),async history(){const watch=await sessions.current.watch(BACKGROUND_CONTEXT);try{return watch.value.entries.filter(entry=>['pi.user','pi.assistant'].includes(entry.kind)).flatMap(entry=>(entry.model||[]).flatMap(message=>{if(!['user','assistant'].includes(message.role))return [];const content=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):'';return content?[{role:message.role==='user'?'你':'Agent',text:content,traceId:String(entry.id)}]:[];})).slice(-200);}finally{await watch.stop();}},async configurePreset(id){const extension=extensions[id];if(!extension)throw Error('未知预设');await sessions.current.configure({extensions:selected(id)},BACKGROUND_CONTEXT);presetId=id;const agent=await sessions.current.agent(BACKGROUND_CONTEXT);return {sections:agent.sections.map(s=>s.key),tools:agent.tools.map(t=>t.name)};},async chat(message,runId,requestId,onStart){if(currentQuery)throw Error('会话正在处理');currentQuery=message;let tracedConversation,traceFloor=0,tracing=false,tracedSubmissionId;try{tracedConversation=sessions.current;const existing=requestId?await chatRequests.claim(tracedConversation.id,requestId,message):false;currentRun=runId||randomUUID();if(onStart)currentRun=await onStart({existing,conversationId:tracedConversation.id})||currentRun;if(!ready())throw Error('MODEL_NOT_CONFIGURED');await sessions.titleFromMessage(message);if(!existing)try{const beforeTrace=await getEntries(tracedConversation);traceFloor=beforeTrace.reduce((max,entry)=>Math.max(max,Number(entry.id)||0),0);traceCapture.begin(tracedConversation.id,currentRun);tracing=true;}catch{}await sessions.current.configure({model},BACKGROUND_CONTEXT);const submission=await sessions.current.submit({type:'input',content:message,...(requestId?{requestId}:{})},BACKGROUND_CONTEXT);tracedSubmissionId=String(submission.id);const settled=await submission.wait(BACKGROUND_CONTEXT);if(settled.status!=='done'||settled.type!=='input')throw Error('MODEL_REQUEST_FAILED');const entry=await sessions.current.commit(tx=>tx.entry(AssistantEntry,settled.answer),BACKGROUND_CONTEXT);const content=entry?.model?.[0]?.content;const answer=Array.isArray(content)?content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):'';if(!answer)throw Error('EMPTY_RESPONSE');const modelMessages=Array.isArray(entry?.model)?entry.model:[];const usage=modelMessages.reduce((total,message)=>addUsage(total,message?.usage),emptyUsage());let cost=usage.cost;try{if(!cost.total){const fullModel=models.getModel(model.provider,model.modelId);if(fullModel){const calculated=calculateCost(fullModel,usage);if(calculated)cost=calculated;}}}catch{}return {answer,traceId:String(entry.id),model:{provider:model.provider,modelId:model.modelId},usage,cost,modelCalls:modelMessages.length};}finally{if(tracing)try{const entries=(await getEntries(tracedConversation)).filter(entry=>Number(entry.id)>traceFloor);const record=traceCapture.finish(tracedConversation.id,entries);if(record){record.submissionId=tracedSubmissionId;onRunTelemetry(record);}}catch{traceCapture.finish(tracedConversation.id);}currentQuery='';currentRun=null;}},...memoryFacade,async harness2State(){return h2.snapshot();},async harness2History(limit){return h2.history(limit);},async harness2Run(tasks){if(!Array.isArray(tasks))throw Error('任务列表无效');return h2.runSuite(tasks);},async harness2Promote(id){return h2.promote(id);},async harness2Rollback(id){return h2.rollback(id);},close:async()=>{try{if(memoryCoordinator)await memoryCoordinator.close();}finally{await harness.close(BACKGROUND_CONTEXT);}}};
 } catch(error) {
  try{if(memoryCoordinator)await memoryCoordinator.close();}catch{}
  try{if(harness)await harness.close(BACKGROUND_CONTEXT);else if(storage)await storage.close(BACKGROUND_CONTEXT);else if(!storageOpening)await database.close();}catch{}
  throw error;
 }
}
