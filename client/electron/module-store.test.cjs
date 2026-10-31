const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {moduleStore}=require('./module-store.cjs');
const sample={id:'customer-notes',label:'客户笔记',title:'客户笔记',description:'记录客户信息',cards:[{title:'会议信息',text:'填写会议记录'}]};
test('模块预览不写入、安装后可恢复并按版本检查更新',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crm-modules-'));try{const store=moduleStore(dir),preview=store.preview(sample);assert.deepEqual(fs.readdirSync(dir),[]);assert.equal(preview.action,'create');store.install(preview.candidate,preview.revision);assert.deepEqual(moduleStore(dir).list(),[sample]);const stale=store.preview(sample),next=store.preview({...sample,title:'新标题'});store.install(next.candidate,next.revision);assert.throws(()=>store.install(stale.candidate,stale.revision),/重新预览/);assert.equal(store.list()[0].title,'新标题');}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('阻止保留名称、路径和可执行或非预期字段',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crm-modules-'));try{const s=moduleStore(dir);for(const x of [{...sample,id:'agent'},{...sample,label:'人员管理'},{...sample,id:'../escape'},{...sample,script:'alert(1)'},{...sample,cards:[{title:'x',text:'x',html:'<script>'}]}])assert.throws(()=>s.preview(x));assert.deepEqual(fs.readdirSync(dir),[]);const preview=s.preview(sample);s.install(preview.candidate,preview.revision);assert.throws(()=>s.preview({...sample,id:'another'}),/名称已存在/);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
