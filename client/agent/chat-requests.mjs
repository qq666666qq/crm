import {createHash} from 'node:crypto';
import {defineDocFamily} from '@earendil-works/pi-durable';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';

// A request is bound to its original conversation and input before Pi admission.
// A digest avoids storing another copy of the user's message.
const ChatRequest=defineDocFamily({kind:'crm.chat.request',version:1,scope:'session',family:true,initial:()=>({conversationId:null,digest:null}),checkpointWhen:()=>true});
const validId=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export function createChatRequests(harness,storage){
 async function claim(conversationId,id,text){
  if(!validId(id)||typeof text!=='string')throw Error('INVALID_CHAT_REQUEST');
  const digest=createHash('sha256').update(text,'utf8').digest('hex'),conversation=String(conversationId);
  await harness.commit(async tx=>{const doc=await tx.doc(ChatRequest,id,null);if(doc.digest!==null&&(doc.digest!==digest||doc.conversationId!==conversation))throw Error('CHAT_REQUEST_CONFLICT');doc.digest=digest;doc.conversationId=conversation;},context);
  return Boolean(await storage.submissionByRequest(conversationId,id,context));
 }
 return {claim};
}
