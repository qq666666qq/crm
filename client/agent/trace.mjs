import {appendFile,readFile,mkdir,truncate} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// The log intentionally excludes input, output, model keys, and tool arguments.
export async function openTrace(dir){
 await mkdir(dir,{recursive:true});const file=path.join(dir,'runs.jsonl');let tail=Promise.resolve();
 async function rows(){try{const data=await readFile(file,'utf8');const complete=data.slice(0,data.lastIndexOf('\n')+1);return complete.split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
 async function append(row){const work=tail.then(()=>appendFile(file,JSON.stringify(row)+'\n',{encoding:'utf8',mode:0o600}));tail=work.catch(()=>{});await work;}
 try{const data=await readFile(file);if(data.length&&data[data.length-1]!==10)await truncate(file,data.lastIndexOf(10)+1);}catch(e){if(e.code!=='ENOENT')throw e;}
 const prior=await rows(),open=new Map();for(const r of prior){if(r.event==='started')open.set(r.id,r);else if(r.event==='finished')open.delete(r.id);}
 for(const r of open.values())await append({event:'finished',id:r.id,at:new Date().toISOString(),status:'interrupted'});
 return {async start(){const id=randomUUID();await append({event:'started',id,at:new Date().toISOString(),kind:'chat'});return id;},async finish(id,status){if(!['completed','failed'].includes(status))throw Error('无效状态');await append({event:'finished',id,at:new Date().toISOString(),status});},async list({limit=100}={}){await tail;const records=await rows(),runs=new Map();for(const row of records){if(row.event==='started')runs.set(row.id,{id:row.id,kind:row.kind,started_at:row.at,status:'running'});else if(row.event==='finished'&&runs.has(row.id))Object.assign(runs.get(row.id),{finished_at:row.at,status:row.status});}const values=[...runs.values()];return (limit===null?values:values.slice(-limit)).reverse();}};
}
