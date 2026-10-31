import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
const run=promisify(execFile);

test('真实 Pi 数据库重启后导出历史和新轨迹，上传状态再次重启后保留',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'crm-archive-restart-')),file=path.join(dir,'session.sqlite'),script=new URL('./trace-archive-restart-fixture.mjs',import.meta.url);
 try{for(const phase of ['create','upload','verify']){const result=await run(process.execPath,[fileURLToPath(script),phase,file],{timeout:30000});assert.match(result.stdout,/ok/);}}
 finally{await rm(dir,{recursive:true,force:true});}
});
