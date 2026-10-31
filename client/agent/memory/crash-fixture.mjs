import {openRuntime} from '../runtime.mjs';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';

// This fixture is used only by crash-recovery.test.mjs with a temporary database.
const [file,phase,cut]=process.argv.slice(2),faux=fauxProvider(),model=faux.getModel(),isEvolution=cut.startsWith('evolution');let modelReady=!(phase==='resume'&&isEvolution),waitingObserved=false,unsafeCalls=false;
let finish;const done=new Promise(resolve=>{finish=resolve;});
const gateway={reflect:async input=>{
 if(phase==='before'&&cut==='model'){process.send?.({event:'interrupt'});return new Promise(()=>{});}
 return {should_reflect:true,lesson:'恢复后核对演示交期',sourceEntryIds:[JSON.parse(input)[0].id]};
},extract:async()=>({items:[]}),proposeSkill:async()=>({operation:'create',name:'核对演示客户',content:'查询后核对客户信息。',reason:'来自演示轨迹'}),review:async()=>{if(phase==='before'&&cut==='skill-review'){process.send?.({event:'interrupt'});return new Promise(()=>{});}return {approved:true,reason:'来源可核对'};}};
const company='f1dd6840-768d-4a20-b951-6c45acdc20c9';
const options={databaseKey:'1'.repeat(64),enableMemory:true,memoryScope:'crash-test',modelProvider:faux.provider,modelSelection:{provider:model.provider,modelId:model.id},modelReady:()=>modelReady,evolutionWaitModelMs:50,memoryGateway:gateway,crmRequest:async(op,args)=>{if(cut==='evolution-revoke'&&phase!=='before'&&op==='get')throw Error('FORBIDDEN');return op==='search'?{items:[{id:company,name:'演示客户'}]}:{id:args.id};},onEvolutionProgress:event=>{if(isEvolution&&phase==='resume'&&event.stage==='waiting_model'){waitingObserved=true;unsafeCalls=faux.state.callCount!==0;faux.setResponses([fauxAssistantMessage('优化后的问题'),fauxAssistantMessage('恢复的候选回答'),fauxAssistantMessage('恢复后的比较')]);modelReady=true;}if(isEvolution&&event.stage===(cut==='evolution-revoke'?'failed':'completed'))finish();},onMemoryProgress:event=>{if(cut==='skill-review'?event.kind==='harvest'&&event.status==='awaiting_confirmation':!isEvolution&&event.kind==='reflection'&&event.status==='completed')finish();}};
let runtime;
try{
 runtime=await openRuntime(file,options);
 if(phase==='before'){
  if(isEvolution){
   const baseline=cut==='evolution-revoke'?[fauxAssistantMessage([fauxToolCall('crm_search',{resource:'companies',query:'演示客户'})],{stopReason:'toolUse'}),fauxAssistantMessage('找到演示客户')]:[fauxAssistantMessage('原始回答')];
   faux.setResponses([...baseline,fauxAssistantMessage('优化后的问题'),()=>{process.send?.({event:'interrupt'});return new Promise(()=>{});}]);const target=await runtime.chat('演示问题');await runtime.evolve(target.traceId);
  }else if(cut==='skill-review'){
   const responses=[];for(let i=0;i<3;i++){const calls=Array.from({length:5},(_,j)=>fauxToolCall('crm_search',{resource:'companies',query:'演示客户'},{id:`call-${i}-${j}`}));responses.push(fauxAssistantMessage(calls,{stopReason:'toolUse'}),fauxAssistantMessage('查询完成'));}faux.setResponses(responses);
   for(let i=0;i<3;i++){await runtime.chat('查询演示客户 '+i);await runtime.memoryStatus();}const status=await runtime.memoryStatus();if(status.recommendations.length!==1)throw Error('RECOMMENDATION_MISSING');await runtime.memoryHarvest(status.recommendations[0].submission_id);
  }else{
  if(cut==='saved'){const save=runtime.memory.save;runtime.memory.save=async input=>{const result=await save(input);if(input.kind==='reflection'){process.send?.({event:'interrupt'});return new Promise(()=>{});}return result;};}
  faux.setResponses([fauxAssistantMessage('收到演示交期')]);await runtime.chat('请核对演示交期');
  }
 }else if(phase==='resume'){
  await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(Error('RECOVERY_TIMEOUT')),12000))]);
  if(isEvolution){const tasks=await runtime.evolutionTasks(),revoked=cut==='evolution-revoke';if(tasks[0]?.stage!==(revoked?'failed':'completed')||!waitingObserved||unsafeCalls||(revoked&&faux.state.callCount!==0)||(await runtime.evolutionHistory(tasks[0].traceId)).length!==(revoked?0:1))throw Error('EVOLUTION_RESTART_UNSAFE');process.send?.({event:'result',count:tasks.length});await runtime.close();process.exit(0);}
  const status=await runtime.memoryStatus(),memories=(await runtime.memory.search('恢复后核对演示交期')).items;
  if(cut==='skill-review'&&(status.skills.length!==0||status.candidates[0]?.status!=='reviewed'))throw Error('SKILL_APPROVAL_BYPASS');
  process.send?.({event:'result',count:cut==='skill-review'?status.candidates.length:memories.length});await runtime.close();process.exit(0);
 }else{
  if(isEvolution){const tasks=await runtime.evolutionTasks(),revoked=cut==='evolution-revoke';if(tasks[0]?.stage!==(revoked?'failed':'completed')||faux.state.callCount!==0||(await runtime.evolutionHistory(tasks[0].traceId)).length!==(revoked?0:1))throw Error('EVOLUTION_RESTART_UNSAFE');process.send?.({event:'result',count:tasks.length});await runtime.close();process.exit(0);}
  const status=await runtime.memoryStatus(),memories=(await runtime.memory.search('恢复后核对演示交期')).items;
  if(cut==='skill-review'&&(status.skills.length!==0||status.candidates[0]?.status!=='reviewed'))throw Error('SKILL_APPROVAL_BYPASS');
  process.send?.({event:'result',count:cut==='skill-review'?status.candidates.length:memories.length});await runtime.close();process.exit(0);
 }
}catch(error){process.send?.({event:'error',message:String(error?.message||error)});if(runtime)await runtime.close();process.exit(1);}
