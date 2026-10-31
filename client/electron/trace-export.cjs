const {createHash}=require('node:crypto');
const {buildLangfusePayload}=require('./langfuse-export.cjs');
function toOtlp(records,{details=[],buildOptions={}}={}){
 if(!Array.isArray(records))throw Error('记录无效');
 if(!Array.isArray(details))throw Error('记录无效');
 const detailedIds=new Set(details.map(item=>item.id));
 const spans=records.filter(r=>r.status!=='running'&&!detailedIds.has(r.id)).map(r=>{
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(r.id)||!['completed','failed','interrupted'].includes(r.status))throw Error('记录无效');
  const start=Date.parse(r.started_at),end=Date.parse(r.finished_at);if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start)throw Error('记录时间无效');
  return {traceId:r.id.replaceAll('-','').toLowerCase(),spanId:createHash('sha256').update(r.id).digest('hex').slice(0,16),name:'agent.chat',kind:1,startTimeUnixNano:(BigInt(start)*1000000n).toString(),endTimeUnixNano:(BigInt(end)*1000000n).toString(),attributes:[{key:'crm.run.status',value:{stringValue:r.status}}],status:{code:r.status==='completed'?1:2}};
 });
 const resourceSpans=[{resource:{attributes:[{key:'service.name',value:{stringValue:'crm-desktop-agent'}}]},scopeSpans:[{scope:{name:'crm.agent'},spans}]}];
 for(const detail of details)resourceSpans.push(...buildLangfusePayload(detail,buildOptions).resourceSpans);
 return {resourceSpans};
}
module.exports={toOtlp};
