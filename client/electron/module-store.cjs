const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const reserved = new Set(['dashboard','companies','leads','opportunities','follow-up','activities','agent','notion-demo','settings','members','approvals','account']);
const reservedLabels = new Set(['工作台','客户管理','销售线索','商机管理','跟进任务','沟通记录','Agent 中心','Notion 演示','系统设置','人员管理','成员审批','账号设置']);
function clean(value, max, field) { if(typeof value!=='string'||!value.trim()||value.length>max) throw new Error(`${field}无效`); return value.trim(); }
function validate(input) {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw new Error('模块格式无效');
  if (Object.keys(input).some(k=>!['id','label','title','description','cards','fields'].includes(k))) throw new Error('包含不支持的字段');
  const id=clean(input.id,48,'标识'); if(!/^[a-z][a-z0-9-]*$/.test(id)||reserved.has(id)) throw new Error('模块标识无效或与系统冲突');
  if(!Array.isArray(input.cards)||input.cards.length<1||input.cards.length>12) throw new Error('请提供 1 至 12 张卡片');
  const label=clean(input.label,24,'侧边栏名称');if(reservedLabels.has(label))throw new Error('侧边栏名称与系统模块冲突');
  let fields;if(input.fields!==undefined){if(!Array.isArray(input.fields)||input.fields.length<1||input.fields.length>8)throw Error('字段数量无效');fields=input.fields.map(field=>{if(!field||typeof field!=='object'||Array.isArray(field)||Object.keys(field).some(k=>!['id','label'].includes(k))||!/^[_a-z][_a-z0-9]{0,31}$/.test(field.id))throw Error('字段无效');return {id:field.id,label:clean(field.label,40,'字段名称')};});if(new Set(fields.map(x=>x.id)).size!==fields.length)throw Error('字段标识重复');}
  return {id,label,title:clean(input.title,80,'页面标题'),description:clean(input.description,400,'页面说明'),cards:input.cards.map(card=>{if(!card||typeof card!=='object'||Array.isArray(card)||Object.keys(card).some(k=>!['title','text'].includes(k)))throw new Error('卡片格式无效');return {title:clean(card.title,80,'卡片标题'),text:clean(card.text,1000,'卡片内容')};}),...(fields?{fields}:{})};
}
function moduleStore(directory){
  const file=path.join(directory,'modules.json');
  function read(){try{const data=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(data)||data.length>100)throw Error('模块记录无效');const values=data.map(validate);if(new Set(values.map(x=>x.id)).size!==values.length)throw Error('模块标识重复');return values;}catch(e){if(e.code==='ENOENT')return [];throw e;}}
  function revision(list){return crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex');}
  function unique(candidate,list){if(list.some(item=>item.id!==candidate.id&&item.label.toLocaleLowerCase()===candidate.label.toLocaleLowerCase()))throw Error('侧边栏名称已存在');}
  return {list:read,preview(input){const candidate=validate(input),list=read();unique(candidate,list);return {candidate,action:list.some(x=>x.id===candidate.id)?'update':'create',revision:revision(list)};},install(input,expected){const candidate=validate(input),list=read();if(revision(list)!==expected)throw Error('模块已变更，请重新预览');unique(candidate,list);const index=list.findIndex(x=>x.id===candidate.id);if(index<0){if(list.length>=100)throw Error('模块数量已达上限');list.push(candidate);}else list[index]=candidate;fs.mkdirSync(directory,{recursive:true});const tmp=path.join(directory,`modules-${crypto.randomUUID()}.tmp`);try{fs.writeFileSync(tmp,JSON.stringify(list,null,2),{mode:0o600});fs.renameSync(tmp,file);}catch(e){try{fs.unlinkSync(tmp);}catch{}throw e;}return candidate;}};
}
module.exports={moduleStore,validate};
