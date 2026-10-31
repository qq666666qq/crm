// Host-owned adapter registry. No third-party credentials or network calls are accepted here.
const adapters=Object.freeze({
 'notion-demo':Object.freeze({id:'notion-demo',name:'Notion 演示',demo:true,apply(state,job){if(!state.destination.some(x=>x.job_id===job.id))state.destination.push({job_id:job.id,title:'演示客户资料',demo:true});}}),
 'feishu-demo':Object.freeze({id:'feishu-demo',name:'飞书演示',demo:true,apply(state,job){if(!state.destination.some(x=>x.job_id===job.id))state.destination.push({job_id:job.id,title:'演示客户资料',demo:true});}}),
});
function getAdapter(id){if(typeof id!=='string'||!Object.hasOwn(adapters,id))throw Error('同步目标不可用');return adapters[id];}
function listAdapters(){return Object.values(adapters).map(({id,name,demo})=>({id,name,demo}));}
module.exports={getAdapter,listAdapters};
