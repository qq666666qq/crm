import {defineDocFamily} from '@earendil-works/pi-durable';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';

// One immutable trace and separate delivery state per Langfuse project.
// Both use Pi's existing document tables and its single owning connection.
const Trace=defineDocFamily({kind:'crm.telemetry.trace',version:1,scope:'session',family:true,initial:()=>({detail:null}),checkpointWhen:()=>true});
const Delivery=defineDocFamily({kind:'crm.telemetry.delivery',version:1,scope:'session',family:true,initial:()=>({state:'pending',error:null}),checkpointWhen:()=>true});
const SubmissionIndex=defineDocFamily({kind:'crm.telemetry.submission',version:1,scope:'session',family:true,initial:()=>({id:null}),checkpointWhen:()=>true});
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9._:-]{1,128}$/.test(id);
const validTarget=target=>typeof target==='string'&&/^[0-9a-f]{64}$/.test(target);
const key=(id,target)=>target+':'+id;

export function createTraceStore(harness,storage){
 let historicalLookup=async()=>null;
 async function save(detail){
  if(!detail||!validId(detail.id))throw Error('INVALID_TRACE');
  const clean=JSON.parse(JSON.stringify(detail));
  await harness.commit(async tx=>{const doc=await tx.doc(Trace,clean.id,null);if(doc.detail){if(JSON.stringify(doc.detail)!==JSON.stringify(clean))throw Error('TRACE_ID_CONFLICT');return;}doc.detail=clean;if(clean.kind==='chat'&&clean.sessionId!=null&&clean.submissionId!=null){const source=String(clean.sessionId)+':'+String(clean.submissionId);if(!validId(source))throw Error('INVALID_TRACE_SOURCE');const index=await tx.doc(SubmissionIndex,source,null);if(index.id&&index.id!==clean.id)throw Error('TRACE_SUBMISSION_CONFLICT');index.id=clean.id;}},context);
 }
 async function get(id,target){
  if(!validId(id)||!validTarget(target))throw Error('INVALID_TRACE_QUERY');
  const doc=await harness.snapshot(Trace,id,context);if(!doc?.detail)return null;
  return {detail:doc.detail,...await delivery(id,target)};
 }
 async function delivery(id,target){if(!validId(id)||!validTarget(target))throw Error('INVALID_TRACE_QUERY');const doc=await harness.snapshot(Delivery,key(id,target),context);return {state:doc?.state||'pending',error:doc?.error||null};}
 async function mark(id,target,state,error=null){
  if(!validId(id)||!validTarget(target)||!['pending','uploaded','partial'].includes(state)||!(error===null||typeof error==='string'&&error.length<=100))throw Error('INVALID_TRACE_STATE');
  if(!await harness.snapshot(Trace,id,context)&&!await historicalLookup(id))throw Error('TRACE_NOT_FOUND');
  await harness.commit(async tx=>{const doc=await tx.doc(Delivery,key(id,target),null);doc.state=state;doc.error=error;},context);
 }
 async function page({target,limit=20,cursor}={}){
  if(!validTarget(target)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('INVALID_TRACE_QUERY');
  const result=await storage.scanDocuments({scope:{kind:'session'},at:'current',kind:Trace.definition.kind},limit,cursor,context),items=[];
  for(const record of result.items){const stored=await storage.document(record.id,'current',context),detail=stored?.value?.detail;if(!detail)continue;const delivery=await harness.snapshot(Delivery,key(detail.id,target),context);items.push({detail,state:delivery?.state||'pending',error:delivery?.error||null});}
  return {items,next:result.next||null};
 }
 async function hasSubmission(conversationId,submissionId){const source=String(conversationId)+':'+String(submissionId);if(!validId(source))return false;return Boolean((await harness.snapshot(SubmissionIndex,source,context))?.id);}
 function setHistoricalLookup(lookup){if(typeof lookup!=='function')throw Error('INVALID_TRACE_QUERY');historicalLookup=lookup;}
 return {save,get,mark,page,hasSubmission,delivery,setHistoricalLookup};
}
