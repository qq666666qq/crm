import {randomUUID} from 'node:crypto';

// Model output is treated as an untrusted proposal and must still be validated by its caller.
export function createModelGateway(models,modelRef,ready,{onRunDetail=()=>{}}={}){
 async function json(kind,systemPrompt,input,{temperature,maxTokens=4096,signal,source}={}){
  if(!ready())throw Error('MODEL_NOT_CONFIGURED');
  const model=models.getModel(modelRef.provider,modelRef.modelId);if(!model)throw Error('MODEL_NOT_AVAILABLE');
  const startedAt=new Date().toISOString(),messages=[{role:'system',content:systemPrompt},{role:'user',content:input}];
  const detail={id:randomUUID(),kind:'memory.'+kind,sessionId:source?.conversationId,submissionId:source?.submissionId,started_at:startedAt,status:'running',userMessage:input,model:modelRef,generations:[],toolCalls:[]};
  const call={input:messages,startedAt,model:modelRef,parameters:{temperature,maxTokens},status:'running'};detail.generations.push(call);
  try{
   const result=await models.complete(model,{systemPrompt,messages:[{role:'user',content:input,timestamp:Date.now()}]},{temperature,maxTokens,signal,timeoutMs:60000,maxRetries:0});
   call.output=result;call.usage=result.usage;detail.usage=result.usage;
   const text=(result.content||[]).filter(part=>part.type==='text').map(part=>part.text).join('').trim();detail.answer=text;
   if(result.stopReason!=='stop')throw Error('INCOMPLETE_MODEL_OUTPUT');
   let value;try{value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();}catch{throw Error('INVALID_MODEL_JSON');}
   call.status='ok';detail.status='completed';return value;
  }catch(error){call.status='error';detail.status='failed';detail.error=['INCOMPLETE_MODEL_OUTPUT','INVALID_MODEL_JSON'].includes(error?.message)?error.message:'MODEL_REQUEST_FAILED';throw error;}
  finally{detail.finished_at=call.finishedAt=new Date().toISOString();try{onRunDetail(detail);}catch{}}
 }
 return {
  extract:(input,signal,source)=>json('extract','从对话提取可核实、对未来有用的记忆。只输出 JSON：{"items":[{"kind":"project|reference|feedback","content":"...","sourceEntryIds":["..."]}]}。没有依据或没有值得保存的内容时返回空数组。不要编造来源。content 只写来源中的事实，不要把系统记忆的待确认、已确认等审核状态写进事实正文；如果来源本身说客户尚未确认，则保留这一事实。',input,{signal,source}),
  compareMemory:(input,signal,source)=>json('compare','比较新记忆与每条已有记忆，只判断是否描述相同事实、矛盾、不同事实或不确定。只输出 JSON：{"relations":[{"id":"已有记忆编号","relation":"same|conflict|distinct|uncertain","reason":"简短原因"}]}。必须覆盖每个给出的编号；不要将相似词直接当作矛盾。',input,{temperature:0,signal,source}),
  reflect:(input,signal,source)=>json('reflect','复盘本轮任务。只输出 JSON：{"should_reflect":布尔值,"lesson":"最多700字","sourceEntryIds":["..."]}。没有可复用的教训时 should_reflect 为 false。不得编造事实。',input,{signal,source}),
  proposeSkill:(input,signal,source)=>json('propose-skill','根据用户指定的任务轨迹提出技能候选。只输出 JSON：{"operation":"skip|create|replace|delete","name":"...","content":"...","reason":"..."}。replace 的 content 是完整的新内容。不得要求绕过权限或执行未经授权的操作。',input,{signal,source}),
  review:(input,signal,source)=>json('review-skill','审查候选技能是否有事实依据且没有扩大权限。只输出 JSON：{"approved":布尔值,"reason":"..."}。',input,{temperature:0,maxTokens:8192,signal,source}),
 };
}
