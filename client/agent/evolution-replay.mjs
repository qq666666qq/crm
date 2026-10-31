import {Type} from '@earendil-works/pi-ai';
import {defineExtension,defineTool} from '@earendil-works/pi-durable';

// Replay only exact, previously recorded reads. No real business operation is called.
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
const key=(name,args)=>JSON.stringify([name,canonical(args)]);
// Tool output is untrusted data. Keep the comparison input bounded and mark omitted results.
export function boundComparisonTrace(items,maxCharacters=12000){let remaining=maxCharacters;return items.map(item=>{const {result,...rest}=item;if(typeof result!=='string')return rest;if(result.length>remaining)return {...rest,resultStatus:'omitted_for_length'};remaining-=result.length;return {...rest,result,resultStatus:'included'};});}
export function createEvolutionReplay(){
 let records=new Map(),calls=[],authorize=async()=>false;
 const run=async(name,args)=>{const found=records.get(key(name,args));const allowed=found&&await authorize(found.sources);calls.push({name,arguments:args,status:allowed?'replayed':'unavailable',...(allowed?{result:found.result}:{})});return {output:[{type:'text',text:allowed?found.result:'没有可用的历史查询结果；不能推断数据，也不能执行真实查询。'}]};};
 const search=defineTool({name:'replay_crm_search',description:'仅回放原任务中参数完全相同的客户查询结果，不访问真实 CRM。',parameters:Type.Object({resource:Type.Union(['companies','leads','opportunities','follow-up-tasks','activities'].map(x=>Type.Literal(x))),query:Type.Optional(Type.String({maxLength:200}))}),execute:async args=>run('crm_search',args)});
 const get=defineTool({name:'replay_crm_get',description:'仅回放原任务中参数完全相同的客户详情结果，不访问真实 CRM。',parameters:Type.Object({resource:Type.Union(['companies','contacts','leads','opportunities','follow-up-tasks','activities','company-contacts'].map(x=>Type.Literal(x))),id:Type.String({format:'uuid'})}),execute:async args=>run('crm_get',args)});
 const memorySearch=defineTool({name:'replay_memory_search',description:'仅回放原任务中参数完全相同的个人记忆搜索结果。',parameters:Type.Object({query:Type.String({minLength:1,maxLength:200})}),execute:async args=>run('memory_search',args)});
 const memoryGet=defineTool({name:'replay_memory_get',description:'仅回放原任务中参数完全相同的个人记忆读取结果。',parameters:Type.Object({id:Type.String({minLength:1,maxLength:100})}),execute:async args=>run('memory_get',args)});
 const tools=[search,get,memorySearch,memoryGet],names=new Set(['crm_search','crm_get','memory_search','memory_get']);
 return {extension:defineExtension({name:'crm.evolution.replay',tools}),tools,set(trace,check){records=new Map();calls=[];authorize=check;for(const item of trace)if(names.has(item.name)){const k=key(item.name,item.arguments);if(records.has(k)&&records.get(k)?.result!==item.result)records.set(k,null);else if(!records.has(k))records.set(k,item);}},calls:()=>calls.map(({result,...item})=>({...item})),comparisonCalls:()=>boundComparisonTrace(calls),clear(){records.clear();calls=[];authorize=async()=>false;}};
}
