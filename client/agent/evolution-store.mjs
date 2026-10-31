import {defineDocFamily} from '@earendil-works/pi-durable';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {randomUUID} from 'node:crypto';

const Index=defineDocFamily({kind:'crm.evolution.index',version:1,scope:'session',family:true,initial:()=>({ids:[]}),checkpointWhen:()=>true});
const Record=defineDocFamily({kind:'crm.evolution.record',version:1,scope:'session',family:true,initial:()=>({value:null}),checkpointWhen:()=>true});

export function createEvolutionStore(harness,authorize){
 async function read(conversationId,id){const doc=await harness.snapshot(Record,id,BACKGROUND_CONTEXT),item=doc?.value;if(!item||item.conversationId!==String(conversationId)||!await authorize(item.sourceRefs))return null;const {sourceRefs,...visible}=item;return visible;}
 async function save(conversationId,result,sourceRefs,id=randomUUID()){const value={...result,id,conversationId:String(conversationId),sourceRefs,version:1,decision:null,createdAt:new Date().toISOString(),decidedAt:null};await harness.commit(async tx=>{const record=await tx.doc(Record,id,null);if(record.value){if(record.value.conversationId!==String(conversationId)||record.value.baselineTraceId!==result.baselineTraceId)throw Error('EVOLUTION_ID_CONFLICT');return;}record.value=value;const index=await tx.doc(Index,String(conversationId),null);index.ids.push(id);},BACKGROUND_CONTEXT);const visible=await read(conversationId,id);if(!visible)throw Error('EVOLUTION_PERMISSION_REVOKED');return visible;}
 async function list(conversationId,traceId){const doc=await harness.snapshot(Index,String(conversationId),BACKGROUND_CONTEXT),items=[];for(const id of [...(doc?.ids||[])].reverse()){const item=await read(conversationId,id);if(item&&(!traceId||item.baselineTraceId===String(traceId)))items.push(item);if(items.length>=50)break;}return items;}
 async function decide(conversationId,id,expectedVersion,decision){if(!['baseline','candidate'].includes(decision)||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw Error('INVALID_DECISION');const visible=await read(conversationId,id);if(!visible)throw Error('NOT_FOUND');if(visible.version!==expectedVersion)throw Error('VERSION_CONFLICT');await harness.commit(async tx=>{const doc=await tx.doc(Record,id,null),item=doc.value;if(!item||item.conversationId!==String(conversationId)||item.version!==expectedVersion)throw Error('VERSION_CONFLICT');item.decision=decision;item.version++;item.decidedAt=new Date().toISOString();},BACKGROUND_CONTEXT);const current=await read(conversationId,id);if(!current)throw Error('EVOLUTION_PERMISSION_REVOKED');return current;}
 return {save,get:read,list,decide};
}
