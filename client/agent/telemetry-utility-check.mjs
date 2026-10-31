import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {createRequire} from 'node:module';
import {openRuntime} from './runtime.mjs';

const {buildLangfusePayload}=createRequire(import.meta.url)('../electron/langfuse-export.cjs');
const faux=fauxProvider(),model=faux.getModel(),records=[];
let runtime;
try{
 runtime=await openRuntime(':memory:',{modelProvider:faux.provider,modelSelection:{provider:model.provider,modelId:model.id},modelReady:()=>true,crmRequest:async()=>({items:[{name:'演示客户'}]}),onRunTelemetry:record=>records.push(record)});
 faux.setResponses([fauxAssistantMessage([fauxToolCall('crm_search',{resource:'companies',query:'演示客户'})],{stopReason:'toolUse'}),fauxAssistantMessage('已找到演示客户')]);
 const started=new Date().toISOString(),result=await runtime.chat('查询演示客户','electron-telemetry'),finished=new Date().toISOString(),trace=records[0];
 const payload=buildLangfusePayload({id:trace.runId,started_at:started,finished_at:finished,status:'completed',userMessage:'查询演示客户',answer:result.answer,generations:trace.generations,toolCalls:trace.toolCalls});
 const spans=payload.resourceSpans[0].scopeSpans[0].spans;
 if(spans.filter(item=>item.name==='llm.call').length!==2||!spans.some(item=>item.name==='crm_search'))throw Error('TRACE_INCOMPLETE');
 await runtime.close();runtime=null;process.parentPort.postMessage({ok:true,count:spans.length});
}catch(error){if(runtime)await runtime.close();process.parentPort.postMessage({ok:false,error:String(error.message||error)});}
