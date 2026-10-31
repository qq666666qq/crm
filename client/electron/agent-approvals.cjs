const fs=require('node:fs');const path=require('node:path');const {randomUUID,createHash}=require('node:crypto');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function text(value,max){if(typeof value!=='string'||!value.trim()||value.length>max)throw Error('请求内容无效');return value.trim();}
function proposal(type,input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('请求内容无效');
 if(type==='create_company'){
  if(Object.keys(input).some(k=>!['name','country','industry','website'].includes(k)))throw Error('字段不允许');
  const body={name:text(input.name,255)};for(const key of ['country','industry','website'])if(input[key]!==undefined&&input[key]!=='')body[key]=text(input[key],key==='website'?2048:100);
  if(body.website){let url;try{url=new URL(body.website);}catch{throw Error('网址无效');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('网址无效');}
  return {method:'POST',path:'/api/v1/companies',body};
 }
 if(type==='create_contact'){
  if(Object.keys(input).some(k=>!['company_id','name','job_title','email','phone','whatsapp_id'].includes(k))||typeof input.company_id!=='string'||!uuid.test(input.company_id))throw Error('字段不允许');
  const body={name:text(input.name,100)};for(const key of ['job_title','email','phone','whatsapp_id'])if(input[key]!==undefined&&input[key]!=='')body[key]=text(input[key],key==='email'?255:key==='phone'?50:100);
  if(!body.email&&!body.phone&&!body.whatsapp_id)throw Error('至少需要一种联系方式');return {method:'POST',path:`/api/v1/companies/${input.company_id}/contacts`,body};
 }
 if(type==='create_opportunity'){
  if(Object.keys(input).some(k=>!['company_id','name','product_summary','requirement_notes'].includes(k))||typeof input.company_id!=='string'||!uuid.test(input.company_id))throw Error('字段不允许');
  const body={company_id:input.company_id,name:text(input.name,255)};for(const key of ['product_summary','requirement_notes'])if(input[key]!==undefined&&input[key]!=='')body[key]=text(input[key],4000);return {method:'POST',path:'/api/v1/opportunities',body};
 }
 if(type==='create_task'){
  if(Object.keys(input).some(k=>!['company_id','lead_id','opportunity_id','title','description','due_at','priority'].includes(k)))throw Error('字段不允许');
  const body={title:text(input.title,255),due_at:text(input.due_at,50)};if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/i.test(body.due_at)||!Number.isFinite(Date.parse(body.due_at)))throw Error('时间须包含时区');
  for(const key of ['company_id','lead_id','opportunity_id'])if(input[key]!==undefined){if(typeof input[key]!=='string'||!uuid.test(input[key]))throw Error('关联无效');body[key]=input[key];}if(!body.company_id&&!body.lead_id&&!body.opportunity_id)throw Error('缺少关联对象');
  if(input.description!==undefined&&input.description!=='')body.description=text(input.description,4000);if(input.priority!==undefined){if(!['low','normal','high'].includes(input.priority))throw Error('优先级无效');body.priority=input.priority;}return {method:'POST',path:'/api/v1/follow-up-tasks',body};
 }
 if(type==='create_activity'){
  const relations=['company_id','contact_id','lead_id','opportunity_id','follow_up_task_id'];
  if(Object.keys(input).some(k=>![...relations,'activity_type','direction','subject','summary','outcome','occurred_at'].includes(k)))throw Error('字段不允许');
  if(!['email','phone','whatsapp','meeting','note'].includes(input.activity_type))throw Error('沟通类型无效');
  const body={activity_type:input.activity_type,summary:text(input.summary,4000),occurred_at:text(input.occurred_at,50)};
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/i.test(body.occurred_at)||!Number.isFinite(Date.parse(body.occurred_at)))throw Error('时间须包含时区');
  for(const key of relations)if(input[key]!==undefined){if(typeof input[key]!=='string'||!uuid.test(input[key]))throw Error('关联无效');body[key]=input[key];}if(!relations.some(key=>body[key]))throw Error('缺少关联对象');
  if(input.direction!==undefined){if(!['inbound','outbound'].includes(input.direction))throw Error('方向无效');body.direction=input.direction;}
  for(const key of ['subject','outcome'])if(input[key]!==undefined&&input[key]!=='')body[key]=text(input[key],key==='subject'?255:4000);
  return {method:'POST',path:'/api/v1/activities',body};
 }
 if(type==='update_company'||type==='update_contact'){
  const fields=type==='update_company'?['name','country','industry','business_summary']:['name','job_title','email','phone','whatsapp_id'];
  if(Object.keys(input).some(k=>!['id','expected_version',...fields].includes(k))||typeof input.id!=='string'||!uuid.test(input.id)||!Number.isSafeInteger(input.expected_version)||input.expected_version<1)throw Error('字段不允许');
  const body={expected_version:input.expected_version};for(const key of fields)if(input[key]!==undefined)body[key]=text(input[key],key==='business_summary'?4000:key==='email'?255:key==='phone'?50:type==='update_company'&&key==='name'?255:100);
  if(Object.keys(body).length===1)throw Error('没有需要修改的字段');return {method:'PATCH',path:`/api/v1/${type==='update_company'?'companies':'contacts'}/${input.id}`,body};
 }
 if(type==='complete_task'){
  if(Object.keys(input).some(k=>!['id','expected_version','note'].includes(k))||typeof input.id!=='string'||!uuid.test(input.id)||!Number.isSafeInteger(input.expected_version)||input.expected_version<1)throw Error('字段不允许');
  const body={expected_version:input.expected_version};if(input.note!==undefined&&input.note!=='')body.note=text(input.note,4000);return {method:'POST',path:`/api/v1/follow-up-tasks/${input.id}/complete`,body};
 }
 if(type==='create_lead'){
  if(Object.keys(input).some(k=>!['title','company_name_raw','product_interest','manual_note'].includes(k)))throw Error('字段不允许');
  const body={title:text(input.title,255),source:'manual',evidence:[{evidence_type:'manual',source_type:'manual',manual_note:text(input.manual_note,4000)}]};
  for(const key of ['company_name_raw','product_interest'])if(input[key]!==undefined&&input[key]!=='')body[key]=text(input[key],key==='company_name_raw'?255:4000);
  return {method:'POST',path:'/api/v1/leads',body};
 }
 if(type==='convert_lead'){
  if(Object.keys(input).some(k=>!['lead_id','expected_version','name','company_id'].includes(k))||!uuid.test(input.lead_id)||!Number.isSafeInteger(input.expected_version)||input.expected_version<1||!uuid.test(input.company_id))throw Error('字段不允许');
  return {method:'POST',path:`/api/v1/leads/${input.lead_id}/convert`,body:{expected_version:input.expected_version,name:text(input.name,255),company_id:input.company_id}};
 }
 if(type==='update_lead'||type==='update_opportunity'){
  const fields=type==='update_lead'?['title','product_interest','requirement_notes']:['name','product_summary','requirement_notes'];
  if(Object.keys(input).some(k=>!['id','expected_version',...fields].includes(k))||!uuid.test(input.id)||!Number.isSafeInteger(input.expected_version)||input.expected_version<1)throw Error('字段不允许');
  const body={expected_version:input.expected_version};for(const field of fields)if(input[field]!==undefined)body[field]=text(input[field],field==='title'||field==='name'?255:4000);
  if(Object.keys(body).length===1)throw Error('没有需要修改的字段');
  return {method:'PATCH',path:`/api/v1/${type==='update_lead'?'leads':'opportunities'}/${input.id}`,body};
 }
 throw Error('操作不允许');
}
function approvalStore(dir,safeStorage,scope){const file=path.join(dir,'approvals.bin'),legacy=path.join(dir,'approvals.json');
 function available(){if(!safeStorage?.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==='basic_text'||typeof scope!=='string'||!scope)throw Error('系统加密不可用，无法访问审批记录');}
 function validateRows(rows){if(!Array.isArray(rows)||rows.length>500)throw Error('审批记录无效');for(const row of rows){if(!row||typeof row.id!=='string'||!uuid.test(row.id)||!['pending','submitting','retry','succeeded','failed','rejected'].includes(row.status))throw Error('审批记录无效');proposal(row.type,row.input);}return rows;}
 function save(rows){available();validateRows(rows);fs.mkdirSync(dir,{recursive:true});const tmp=path.join(dir,`approvals-${randomUUID()}.tmp`);try{const cipher=safeStorage.encryptString(JSON.stringify({version:1,scope,rows}));fs.writeFileSync(tmp,cipher,{mode:0o600});fs.renameSync(tmp,file);}catch(e){try{fs.unlinkSync(tmp);}catch{}throw e;}}
 function read(){available();let data;try{data=fs.readFileSync(file);}catch(e){if(e.code!=='ENOENT')throw e;let old;try{old=fs.readFileSync(legacy,'utf8');}catch(missing){if(missing.code==='ENOENT')return [];throw missing;}const rows=validateRows(JSON.parse(old));save(rows);const check=JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));if(check?.version!==1||check.scope!==scope||JSON.stringify(check.rows)!==JSON.stringify(rows))throw Error('审批记录迁移校验失败');fs.unlinkSync(legacy);return rows;}let envelope;try{envelope=JSON.parse(safeStorage.decryptString(data));}catch{throw Error('无法解密审批记录');}if(envelope?.version!==1||envelope.scope!==scope)throw Error('审批记录不属于当前账号');const rows=validateRows(envelope.rows);try{fs.unlinkSync(legacy);}catch(e){if(e.code!=='ENOENT')throw e;}return rows;}
 function view(item){const request=proposal(item.type,item.input);return {...item,request,digest:createHash('sha256').update(JSON.stringify({id:item.id,type:item.type,runId:item.runId||null,request})).digest('hex')};}
 return {list:()=>read().map(view),create(type,input,callId,runId){const request=proposal(type,input);if(typeof callId!=='string'||!callId||callId.length>256||runId!==undefined&&(typeof runId!=='string'||!uuid.test(runId)))throw Error('工具调用标识无效');const rows=read(),prior=rows.find(x=>x.callId===callId);if(prior){if(prior.type!==type||prior.runId!==runId||JSON.stringify(proposal(prior.type,prior.input))!==JSON.stringify(request))throw Error('工具调用内容冲突');return view(prior);}if(rows.length>=500)throw Error('审批记录已满');const item={id:randomUUID(),type,callId,...(runId?{runId}:{}),input:JSON.parse(JSON.stringify(input)),status:'pending',created_at:new Date().toISOString()};rows.push(item);save(rows);return view(item);},transition(id,allowed,status,extra={},expectedDigest){const rows=read(),item=rows.find(x=>x.id===id);if(!item||!allowed.includes(item.status))throw Error('审批状态无效');if(expectedDigest&&view(item).digest!==expectedDigest)throw Error('审批内容已更改');Object.assign(item,extra,{status});save(rows);return view(item);},get(id){const item=read().find(x=>x.id===id);if(!item)throw Error('审批不存在');return view(item);}};
}
module.exports={approvalStore,proposal};
