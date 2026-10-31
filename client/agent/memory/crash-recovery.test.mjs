import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(file,phase,cut){return new Promise((resolve,reject)=>{
 const child=fork(new URL('./crash-fixture.mjs',import.meta.url),[file,phase,cut],{stdio:['ignore','ignore','ignore','ipc']});let value,interrupt=false,settled=false;
 const timer=setTimeout(()=>{child.kill();finish(Error('CHILD_TIMEOUT'));},20000);
 function finish(error){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);}
 child.on('message',message=>{if(message.event==='interrupt'){interrupt=true;child.kill();}else if(message.event==='result')value=message.count;else if(message.event==='error'){child.kill();finish(Error(message.message));}});
 child.on('error',finish);child.on('exit',code=>{if(phase==='before')finish(interrupt?null:Error('INTERRUPT_NOT_REACHED'));else finish(code===0&&value!==undefined?null:Error('CHILD_FAILED'));});
});}

for(const cut of ['model','saved','skill-review','evolution','evolution-revoke'])test(`Pi ${cut==='evolution-revoke'?'自进化且重启后权限撤销':cut==='evolution'?'自进化':cut==='skill-review'?'Skill 复审':`反思任务在${cut==='model'?'模型调用':'写入记忆'}`}时突然退出后恢复状态且不重复`,async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'crm-memory-crash-')),file=path.join(dir,'session.sqlite');
 try{await run(file,'before',cut);assert.equal(await run(file,'resume',cut),1);assert.equal(await run(file,'verify',cut),1);}finally{await rm(dir,{recursive:true,force:true});}
});
