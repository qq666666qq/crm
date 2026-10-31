const rejected=new Set(['blocked','tool_unavailable','invalid_arguments']);
const readable=new Set(['companies','contacts','leads','opportunities','follow-up-tasks','activities']);
function textOf(message){return typeof message?.content==='string'?message.content:(Array.isArray(message?.content)?message.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'):'');}

// A source inherits every CRM object used in its turn, even if the model omits a citation.
export function buildMemorySnapshot(conversationId,entries,{limit=100}={}){
 const turns=[];let current=null,messageCount=0;const calls=new Set();
 for(const entry of entries){
  const message=entry.model?.[0];
  if(entry.kind==='pi.user') {current={texts:[],calls:new Map(),results:new Map()};turns.push(current);}
  if(!current)continue;
  if(entry.kind==='pi.user'||entry.kind==='pi.assistant'){
   const text=textOf(message);if(text.trim()){messageCount++;current.texts.push({id:String(entry.id),role:entry.kind==='pi.user'?'user':'assistant',text});}
   if(entry.kind==='pi.assistant'&&Array.isArray(message?.content))for(const part of message.content)if(part.type==='toolCall')current.calls.set(part.id,part);
  }
  if(entry.kind==='pi.tool-result'&&message?.toolCallId){
   current.results.set(message.toolCallId,{entry,message});
   if(entry.byTaskId!=null&&!(entry.data?.diagnostics||[]).some(item=>rejected.has(item.code)))calls.add(String(entry.byTaskId));
  }
 }
 const result=[],trace=[];let skipped=0,tainted=false;const inherited=new Map(),inheritedSources=new Map();
 for(const turn of turns){
  const refs=new Map();let unsafe=false;
  for(const [id,call] of turn.calls){
   const found=turn.results.get(id);if(!found||found.message.isError){unsafe=true;break;}
   const args=call.arguments||{};
   if(call.name==='crm_get'){
    const resource=args.resource==='company-contacts'?'companies':args.resource;
    if(!readable.has(resource)||typeof args.id!=='string'){unsafe=true;break;}
    refs.set(resource+':'+args.id,{resource,resourceId:args.id});
   }else if(call.name==='crm_search'){
    if(!readable.has(args.resource)){unsafe=true;break;}
    try{
     const data=JSON.parse(textOf(found.message));const items=Array.isArray(data)?data:data.items;
     if(!Array.isArray(items)||items.length>20)throw Error('UNVERIFIED_RESULT');
     for(const item of items){if(!item||typeof item.id!=='string')throw Error('UNVERIFIED_RESULT');refs.set(args.resource+':'+item.id,{resource:args.resource,resourceId:item.id});}
    }catch{unsafe=true;break;}
   }else if(call.name==='memory_search'||call.name==='memory_get'){
    try{
     const data=JSON.parse(textOf(found.message));const items=call.name==='memory_search'?data.items:(data?[data]:[]);
     if(!Array.isArray(items)||items.length>20)throw Error('UNVERIFIED_MEMORY');
     for(const item of items){if(typeof item.id!=='string'||!Number.isSafeInteger(item.version)||item.version<1||!Array.isArray(item.sources)||!item.sources.length)throw Error('UNVERIFIED_MEMORY');for(const raw of item.sources){const source={conversationId:raw.conversation_id??raw.conversationId,entryId:raw.entry_id??raw.entryId,resource:raw.resource,resourceId:raw.resource_id??raw.resourceId,parentMemoryId:item.id,parentVersion:item.version};if(typeof source.conversationId!=='string'||typeof source.entryId!=='string')throw Error('UNVERIFIED_MEMORY');if(source.resource){if(!readable.has(source.resource)||typeof source.resourceId!=='string')throw Error('UNVERIFIED_MEMORY');refs.set(source.resource+':'+source.resourceId,{resource:source.resource,resourceId:source.resourceId});}else{delete source.resource;delete source.resourceId;}inheritedSources.set(JSON.stringify(source),source);}}
    }catch{unsafe=true;break;}
   }else if(call.name!=='memory_propose'){unsafe=true;break;}
  }
  if(unsafe)tainted=true;
  for(const [key,value] of refs)inherited.set(key,value);
  if(tainted||inherited.size>20||inheritedSources.size>70){skipped++;continue;}
  for(const entry of turn.texts){
   const own=inherited.size?[...inherited.values()].map(ref=>({conversationId:String(conversationId),entryId:entry.id,...ref})):[{conversationId:String(conversationId),entryId:entry.id}];
   const sources=[...own,...inheritedSources.values()];
   result.push({...entry,sources});
  }
  for(const [callId,call] of turn.calls){const found=turn.results.get(callId);if(found)trace.push({callId,name:call.name,arguments:call.arguments||{},result:textOf(found.message).slice(0,4000),entryId:String(found.entry.id),sources:inherited.size?[...inherited.values()].map(ref=>({conversationId:String(conversationId),entryId:String(found.entry.id),...ref})):[{conversationId:String(conversationId),entryId:String(found.entry.id)}]});}
 }
 return {messageCount,toolCallCount:calls.size,entries:result.slice(-limit),trace:trace.slice(-50),skipped};
}
