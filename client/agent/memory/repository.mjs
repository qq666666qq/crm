import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';

const kinds=new Set(['feedback','project','reference','diary','long_term','reflection']);
const resourceTypes=new Set(['companies','contacts','leads','opportunities','follow-up-tasks','activities']);
const schema=`
CREATE TABLE IF NOT EXISTS crm_memory_schema(version INTEGER NOT NULL);
INSERT INTO crm_memory_schema(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM crm_memory_schema);
CREATE TABLE IF NOT EXISTS memory_items(id TEXT PRIMARY KEY,scope TEXT NOT NULL,operation_key TEXT NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(scope,operation_key));
CREATE INDEX IF NOT EXISTS memory_items_scope ON memory_items(scope,status,updated_at);
CREATE TABLE IF NOT EXISTS memory_sources(id TEXT PRIMARY KEY,memory_id TEXT NOT NULL REFERENCES memory_items(id),conversation_id TEXT NOT NULL,submission_id TEXT,entry_id TEXT NOT NULL,resource TEXT,resource_id TEXT,CHECK((resource IS NULL)=(resource_id IS NULL)));
CREATE INDEX IF NOT EXISTS memory_sources_item ON memory_sources(memory_id);
CREATE TABLE IF NOT EXISTS memory_chunks(id INTEGER PRIMARY KEY,memory_id TEXT NOT NULL REFERENCES memory_items(id),version INTEGER NOT NULL,content TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memory_chunks_item ON memory_chunks(memory_id);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content,tokenize='trigram');
CREATE TABLE IF NOT EXISTS memory_embeddings(chunk_id INTEGER NOT NULL REFERENCES memory_chunks(id),model TEXT NOT NULL,dimensions INTEGER NOT NULL,vector TEXT NOT NULL,PRIMARY KEY(chunk_id,model));
CREATE TABLE IF NOT EXISTS memory_changes(id TEXT PRIMARY KEY,memory_id TEXT NOT NULL,action TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_conflicts(memory_id TEXT NOT NULL REFERENCES memory_items(id),related_id TEXT NOT NULL REFERENCES memory_items(id),related_version INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(memory_id,related_id));
CREATE TABLE IF NOT EXISTS memory_operation_aliases(scope TEXT NOT NULL,operation_key TEXT NOT NULL,memory_id TEXT NOT NULL REFERENCES memory_items(id),PRIMARY KEY(scope,operation_key));
CREATE TABLE IF NOT EXISTS memory_turn_state(scope TEXT NOT NULL,conversation_id TEXT NOT NULL,submission_id TEXT NOT NULL,answer_entry_id TEXT NOT NULL,completed_runs INTEGER NOT NULL,message_count INTEGER NOT NULL,tool_call_count INTEGER NOT NULL,harvest_status TEXT NOT NULL,expires_at TEXT,created_at TEXT NOT NULL,PRIMARY KEY(scope,conversation_id,submission_id));
CREATE INDEX IF NOT EXISTS memory_turn_recommendations ON memory_turn_state(scope,harvest_status,expires_at);
CREATE TABLE IF NOT EXISTS memory_task_runs(scope TEXT NOT NULL,conversation_id TEXT NOT NULL,submission_id TEXT NOT NULL,kind TEXT NOT NULL,task_id TEXT,status TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,error_code TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(scope,conversation_id,submission_id,kind));
CREATE TABLE IF NOT EXISTS memory_metadata(scope TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,key));
CREATE TABLE IF NOT EXISTS skill_candidates(id TEXT PRIMARY KEY,scope TEXT NOT NULL,conversation_id TEXT NOT NULL,submission_id TEXT NOT NULL,name TEXT NOT NULL,content TEXT NOT NULL,reason TEXT NOT NULL,review TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,base_version INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS skill_candidates_scope ON skill_candidates(scope,status,created_at);
CREATE TABLE IF NOT EXISTS skill_versions(id TEXT PRIMARY KEY,scope TEXT NOT NULL,name TEXT NOT NULL,version INTEGER NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,status TEXT NOT NULL,source_candidate_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(scope,name,version));
CREATE UNIQUE INDEX IF NOT EXISTS skill_one_active ON skill_versions(scope,name) WHERE status='active';
`;
function validateSource(source){
 if(!source||typeof source.conversationId!=='string'||!source.conversationId||typeof source.entryId!=='string'||!source.entryId)throw Error('INVALID_SOURCE');
 if(Boolean(source.resource)!==Boolean(source.resourceId)||(source.resource&&!resourceTypes.has(source.resource)))throw Error('INVALID_SOURCE');
 if(Boolean(source.parentMemoryId)!==Boolean(source.parentVersion)||(source.parentMemoryId&&(typeof source.parentMemoryId!=='string'||!Number.isSafeInteger(source.parentVersion)||source.parentVersion<1)))throw Error('INVALID_SOURCE');
}
function validateContent(content){if(typeof content!=='string'||!content.trim()||content.length>4000)throw Error('INVALID_MEMORY');return content.trim();}

export async function createMemoryRepository(db,{scope,authorize=async()=>false}){
 if(typeof scope!=='string'||!scope)throw Error('INVALID_SCOPE');
 const versionTable=await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_memory_schema'");
 if(versionTable){const versions=await db.all('SELECT version FROM crm_memory_schema');if(versions.length!==1||!Number.isSafeInteger(versions[0].version)||versions[0].version<1||versions[0].version>3)throw Error('MEMORY_SCHEMA_UNSUPPORTED');}
 await db.exec(schema);
 for(const [table,column,definition] of [['memory_sources','parent_memory_id','TEXT'],['memory_sources','parent_version','INTEGER'],['skill_candidates','source_refs',"TEXT NOT NULL DEFAULT '[]'"],['skill_candidates','operation',"TEXT NOT NULL DEFAULT 'create'"],['skill_candidates','digest',"TEXT NOT NULL DEFAULT ''"],['skill_versions','source_refs',"TEXT NOT NULL DEFAULT '[]'"],['skill_versions','operation',"TEXT NOT NULL DEFAULT 'create'"]]){
  const columns=await db.all(`PRAGMA table_info(${table})`);if(!columns.some(item=>item.name===column))await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
 }
 await db.run('UPDATE crm_memory_schema SET version=3 WHERE version<3');
 async function sources(id){return db.all('SELECT conversation_id,submission_id,entry_id,resource,resource_id,parent_memory_id,parent_version FROM memory_sources WHERE memory_id=? ORDER BY id',id);}
 function sourceChecker(){const permissions=new Map(),parents=new Set();async function verify(items,stack){for(const source of items){const resource=source.resource,id=source.resourceId??source.resource_id,parent=source.parentMemoryId??source.parent_memory_id,version=source.parentVersion??source.parent_version;if(resource){const key=resource+':'+id;if(!permissions.has(key)){try{permissions.set(key,Boolean(await authorize(resource,id)));}catch{permissions.set(key,false);}}if(!permissions.get(key))return false;}if(parent){const key=parent+':'+version;if(stack.has(parent))return false;if(!parents.has(key)){const item=await db.get("SELECT id FROM memory_items WHERE id=? AND scope=? AND status='active' AND version=?",parent,scope,version);if(!item)return false;const next=new Set(stack);next.add(parent);if(!await verify(await sources(parent),next))return false;parents.add(key);}}}return true;}return list=>verify(list,new Set());}
 async function checkSources(list){return sourceChecker()(list);}
 async function canRead(item,check=checkSources){return check(await sources(item.id));}
 async function conflictsFor(id,check=checkSources){const rows=await db.all("SELECT m.*,c.related_version,c.reason FROM memory_conflicts c JOIN memory_items m ON m.id=c.related_id WHERE c.memory_id=? AND m.scope=? AND m.status IN ('active','pending')",id,scope);const result=[];for(const item of rows)if(await canRead(item,check))result.push({id:item.id,content:item.content,status:item.status,version:item.version,comparedVersion:item.related_version,reason:item.reason});return result;}
 async function present(item,check=checkSources){const conflicts=item.status==='pending'?await conflictsFor(item.id,check):[];const count=item.status==='pending'?(await db.get('SELECT COUNT(*) AS n FROM memory_conflicts WHERE memory_id=?',item.id)).n:0;return {...item,sources:await sources(item.id),conflicts,conflictCount:count};}
 async function get(id){const item=await db.get("SELECT * FROM memory_items WHERE id=? AND scope=? AND status!='deleted'",id,scope);if(!item||!await canRead(item))return null;return present(item);}
 async function listPage({status='active',limit=30,cursor=null}={}){
  if(!['active','pending'].includes(status)||!Number.isInteger(limit)||limit<1||limit>100||cursor!==null&&(typeof cursor!=='string'||cursor.length>512))throw Error('INVALID_QUERY');
  let after=null;if(cursor!==null){try{after=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(after.status!==status||typeof after.createdAt!=='string'||after.createdAt.length>40||!Number.isFinite(Date.parse(after.createdAt))||typeof after.id!=='string'||!/^[0-9a-f-]{36}$/i.test(after.id))throw Error();}catch{throw Error('INVALID_QUERY');}}
  const items=[],check=sourceChecker();let end=false;
  while(!end&&items.length<=limit){
   const rows=after?await db.all('SELECT * FROM memory_items WHERE scope=? AND status=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 100',scope,status,after.createdAt,after.createdAt,after.id):await db.all('SELECT * FROM memory_items WHERE scope=? AND status=? ORDER BY created_at DESC,id DESC LIMIT 100',scope,status);
   if(!rows.length)break;end=rows.length<100;for(const item of rows){if(await canRead(item,check)){items.push(await present(item,check));if(items.length>limit)break;}}
   const last=rows.at(-1);after={status,createdAt:last.created_at,id:last.id};
  }
  const more=items.length>limit;const result=items.slice(0,limit);const last=result.at(-1);return {items:result,nextCursor:more&&last?Buffer.from(JSON.stringify({status,createdAt:last.created_at,id:last.id})).toString('base64url'):null};
 }
 async function list({status='active',limit=50}={}){return (await listPage({status,limit})).items;}
 // Trigrams find candidate overlaps; they are not proof that two claims conflict.
 async function related(content,{limit=10}={}){
  const text=validateContent(content),chars=Array.from(text),terms=new Set();for(let i=0;i+2<chars.length&&terms.size<24;i+=Math.max(1,Math.floor(chars.length/24))){const term=chars.slice(i,i+3).join('');if(/[\p{L}\p{N}]{3}/u.test(term))terms.add(term);}
  const exact=await db.all("SELECT * FROM memory_items WHERE scope=? AND status IN ('active','pending') AND content=? ORDER BY updated_at DESC LIMIT 100",scope,text);let rows=[];
  if(terms.size){const query=[...terms].map(term=>'"'+term.replaceAll('"','""')+'"').join(' OR ');rows=await db.all("SELECT DISTINCT m.* FROM memory_fts f JOIN memory_chunks c ON c.id=f.rowid JOIN memory_items m ON m.id=c.memory_id WHERE memory_fts MATCH ? AND m.scope=? AND m.status IN ('active','pending') ORDER BY m.updated_at DESC LIMIT 100",query,scope);}
  const result=[],seen=new Set(),check=sourceChecker();for(const row of [...exact,...rows]){if(!seen.has(row.id)&&await canRead(row,check)){seen.add(row.id);result.push({id:row.id,status:row.status,version:row.version,kind:row.kind,content:row.content});if(result.length>=limit)break;}}return result;
 }
 async function operationExists(key){const row=await db.get('SELECT id FROM memory_items WHERE scope=? AND operation_key=? UNION ALL SELECT memory_id AS id FROM memory_operation_aliases WHERE scope=? AND operation_key=? LIMIT 1',scope,key,scope,key);return Boolean(row);}
 async function index(tx,id,version,content){
  const old=await tx.all('SELECT id FROM memory_chunks WHERE memory_id=?',id);
  for(const row of old){await tx.run('DELETE FROM memory_fts WHERE rowid=?',row.id);await tx.run('DELETE FROM memory_embeddings WHERE chunk_id=?',row.id);}
  await tx.run('DELETE FROM memory_chunks WHERE memory_id=?',id);
  await tx.run('INSERT INTO memory_chunks(memory_id,version,content) VALUES(?,?,?)',id,version,content);
  const chunk=await tx.get('SELECT id FROM memory_chunks WHERE memory_id=?',id);
  await tx.run('INSERT INTO memory_fts(rowid,content) VALUES(?,?)',chunk.id,content);
 }
 // Only byte-identical pending content of the same kind is combined automatically.
 // The user still reviews the combined item; new sources never approve a memory.
 async function mergeExactPending(input){
  const content=validateContent(input.content),sourceList=input.sources;
  if(typeof input.id!=='string'||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1||!kinds.has(input.kind)||typeof input.operationKey!=='string'||!input.operationKey||input.operationKey.length>255)throw Error('INVALID_MEMORY');
  if(!Array.isArray(sourceList)||!sourceList.length||sourceList.length>100)throw Error('INVALID_SOURCE');sourceList.forEach(validateSource);
  if(!await checkSources(sourceList))throw Error('FORBIDDEN');
  const item=await get(input.id);if(!item)throw Error('FORBIDDEN');
  return db.transaction(async tx=>{
   const alias=await tx.get('SELECT memory_id FROM memory_operation_aliases WHERE scope=? AND operation_key=?',scope,input.operationKey);if(alias){if(alias.memory_id!==input.id)throw Error('VERSION_CONFLICT');return {id:alias.memory_id};}
   const operation=await tx.get('SELECT id FROM memory_items WHERE scope=? AND operation_key=?',scope,input.operationKey);if(operation){if(operation.id!==input.id)throw Error('VERSION_CONFLICT');return {id:operation.id};}
   const current=await tx.get('SELECT * FROM memory_items WHERE id=? AND scope=?',input.id,scope);
   if(!current||current.status!=='pending'||current.version!==input.expectedVersion||current.kind!==input.kind||current.content!==content)throw Error('VERSION_CONFLICT');
   const existing=await tx.all('SELECT conversation_id,submission_id,entry_id,resource,resource_id,parent_memory_id,parent_version FROM memory_sources WHERE memory_id=?',input.id);
   const key=source=>JSON.stringify([source.conversation_id??source.conversationId,source.submission_id??source.submissionId??null,source.entry_id??source.entryId,source.resource??null,source.resource_id??source.resourceId??null,source.parent_memory_id??source.parentMemoryId??null,source.parent_version??source.parentVersion??null]);
   const seen=new Set(existing.map(key)),add=[];for(const source of sourceList){const k=key(source);if(!seen.has(k)){seen.add(k);add.push(source);}}
   if(existing.length+add.length>100)throw Error('INVALID_SOURCE');
   for(const source of add)await tx.run('INSERT INTO memory_sources(id,memory_id,conversation_id,submission_id,entry_id,resource,resource_id,parent_memory_id,parent_version) VALUES(?,?,?,?,?,?,?,?,?)',randomUUID(),input.id,source.conversationId,source.submissionId||null,source.entryId,source.resource||null,source.resourceId||null,source.parentMemoryId||null,source.parentVersion||null);
   if(add.length){const now=new Date().toISOString(),version=current.version+1;await tx.run('UPDATE memory_items SET version=?,updated_at=? WHERE id=? AND scope=?',version,now,input.id,scope);await index(tx,input.id,version,current.content);await tx.run('INSERT INTO memory_changes VALUES(?,?,?,?,?)',randomUUID(),input.id,'sources_added',version,now);}
   await tx.run('INSERT INTO memory_operation_aliases(scope,operation_key,memory_id) VALUES(?,?,?)',scope,input.operationKey,input.id);return {id:input.id};
  });
 }
 async function save(input){
  const content=validateContent(input.content);if(!kinds.has(input.kind)||typeof input.operationKey!=='string'||!input.operationKey||input.operationKey.length>255)throw Error('INVALID_MEMORY');
  const sourceList=input.sources||[];if(!Array.isArray(sourceList)||sourceList.length>100)throw Error('INVALID_SOURCE');sourceList.forEach(validateSource);
  const conflicts=input.conflicts||[];if(!Array.isArray(conflicts)||conflicts.length>10||conflicts.some(item=>!item||typeof item.id!=='string'||!Number.isSafeInteger(item.version)||item.version<1||typeof item.reason!=='string'||item.reason.length>500))throw Error('INVALID_MEMORY_CONFLICT');
  if(!await checkSources(sourceList))throw Error('FORBIDDEN');
  for(const conflict of conflicts){const item=await get(conflict.id);if(!item||!['active','pending'].includes(item.status)||item.version!==conflict.version)throw Error('VERSION_CONFLICT');}
  const id=randomUUID(),now=new Date().toISOString();
  const item=await db.transaction(async tx=>{
   const existing=await tx.get('SELECT id FROM memory_items WHERE scope=? AND operation_key=?',scope,input.operationKey);if(existing)return existing;
   const alias=await tx.get('SELECT memory_id AS id FROM memory_operation_aliases WHERE scope=? AND operation_key=?',scope,input.operationKey);if(alias)return alias;
   for(const conflict of conflicts){const current=await tx.get("SELECT version FROM memory_items WHERE id=? AND scope=? AND status IN ('active','pending')",conflict.id,scope);if(!current||current.version!==conflict.version)throw Error('VERSION_CONFLICT');}
   await tx.run('INSERT INTO memory_items VALUES(?,?,?,?,?,?,?,?,?)',id,scope,input.operationKey,input.kind,content,input.status==='pending'||conflicts.length?'pending':'active',1,now,now);
   for(const source of sourceList)await tx.run('INSERT INTO memory_sources(id,memory_id,conversation_id,submission_id,entry_id,resource,resource_id,parent_memory_id,parent_version) VALUES(?,?,?,?,?,?,?,?,?)',randomUUID(),id,source.conversationId,source.submissionId||null,source.entryId,source.resource||null,source.resourceId||null,source.parentMemoryId||null,source.parentVersion||null);
   for(const conflict of conflicts)await tx.run('INSERT INTO memory_conflicts(memory_id,related_id,related_version,reason) VALUES(?,?,?,?)',id,conflict.id,conflict.version,conflict.reason);
   await index(tx,id,1,content);await tx.run('INSERT INTO memory_changes VALUES(?,?,?,?,?)',randomUUID(),id,'created',1,now);return {id};
  });
  return item;
 }
 async function update(id,expectedVersion,changes){
  const item=await get(id);if(!item)throw Error('NOT_FOUND');if(item.version!==expectedVersion)throw Error('VERSION_CONFLICT');
  const content=changes.content===undefined?item.content:validateContent(changes.content);const status=changes.status??item.status;
  if(!['active','pending','deleted'].includes(status))throw Error('INVALID_MEMORY');
  await db.transaction(async tx=>{
   const latest=await tx.get('SELECT version FROM memory_items WHERE id=? AND scope=?',id,scope);if(!latest||latest.version!==expectedVersion)throw Error('VERSION_CONFLICT');
   if(changes.confirmedConflicts){const actual=await tx.all("SELECT c.related_id,m.version,m.status FROM memory_conflicts c JOIN memory_items m ON m.id=c.related_id WHERE c.memory_id=? AND m.scope=?",id,scope);if(actual.length!==changes.confirmedConflicts.length||actual.some(row=>!['active','pending'].includes(row.status)||!changes.confirmedConflicts.some(confirmed=>confirmed.id===row.related_id&&confirmed.version===row.version&&confirmed.status===row.status)))throw Error('VERSION_CONFLICT');}
   await tx.run('UPDATE memory_items SET content=?,status=?,version=version+1,updated_at=? WHERE id=? AND scope=?',content,status,new Date().toISOString(),id,scope);
   if(status==='deleted'){
    const chunks=await tx.all('SELECT id FROM memory_chunks WHERE memory_id=?',id);for(const chunk of chunks){await tx.run('DELETE FROM memory_fts WHERE rowid=?',chunk.id);await tx.run('DELETE FROM memory_embeddings WHERE chunk_id=?',chunk.id);}await tx.run('DELETE FROM memory_chunks WHERE memory_id=?',id);
   }else await index(tx,id,expectedVersion+1,content);
   const affected=await tx.all("WITH RECURSIVE descendants(id) AS (SELECT memory_id FROM memory_sources WHERE parent_memory_id=? UNION SELECT s.memory_id FROM memory_sources s JOIN descendants d ON s.parent_memory_id=d.id) SELECT m.id,m.version FROM memory_items m JOIN descendants d ON d.id=m.id WHERE m.scope=? AND m.id!=? AND m.status IN ('active','pending')",id,scope,id);
   for(const descendant of affected){const chunks=await tx.all('SELECT id FROM memory_chunks WHERE memory_id=?',descendant.id);for(const chunk of chunks){await tx.run('DELETE FROM memory_fts WHERE rowid=?',chunk.id);await tx.run('DELETE FROM memory_embeddings WHERE chunk_id=?',chunk.id);}await tx.run('DELETE FROM memory_chunks WHERE memory_id=?',descendant.id);await tx.run("UPDATE memory_items SET status='invalidated',version=version+1,updated_at=? WHERE id=? AND scope=?",new Date().toISOString(),descendant.id,scope);await tx.run('INSERT INTO memory_changes VALUES(?,?,?,?,?)',randomUUID(),descendant.id,'source_invalidated',descendant.version+1,new Date().toISOString());}
   await tx.run('INSERT INTO memory_changes VALUES(?,?,?,?,?)',randomUUID(),id,status==='deleted'?'deleted':'updated',expectedVersion+1,new Date().toISOString());
  });return status==='deleted'?null:get(id);
 }
 async function review(id,expectedVersion,decision,confirmedConflicts=[]){
  if(!['accept','reject'].includes(decision)||!Array.isArray(confirmedConflicts)||confirmedConflicts.length>10||confirmedConflicts.some(item=>!item||typeof item.id!=='string'||!Number.isSafeInteger(item.version)||item.version<1||!['active','pending'].includes(item.status))||new Set(confirmedConflicts.map(x=>x.id)).size!==confirmedConflicts.length)throw Error('INVALID_MEMORY_REVIEW');
  const item=await get(id);if(!item||item.status!=='pending')throw Error('NOT_FOUND');
  if(decision==='reject')return update(id,expectedVersion,{status:'deleted'});
  if(item.conflictCount!==item.conflicts.length||item.conflicts.length!==confirmedConflicts.length||item.conflicts.some(conflict=>!confirmedConflicts.some(x=>x.id===conflict.id&&x.version===conflict.version&&x.status===conflict.status)))throw Error('VERSION_CONFLICT');
  return update(id,expectedVersion,{status:'active',confirmedConflicts});
 }
 async function search(query,{limit=20}={}){
  if(typeof query!=='string'||!query.trim()||query.length>200||!Number.isInteger(limit)||limit<1||limit>100)throw Error('INVALID_QUERY');
  const term=query.trim();let rows;
  if([...term].length<3){const escaped=term.replace(/[\\%_]/g,'\\$&');rows=await db.all("SELECT DISTINCT m.* FROM memory_items m JOIN memory_chunks c ON c.memory_id=m.id WHERE m.scope=? AND m.status='active' AND c.content LIKE ? ESCAPE '\\' ORDER BY m.updated_at DESC LIMIT 200",scope,`%${escaped}%`);}
  else{const phrase='"'+term.replaceAll('"','""')+'"';rows=await db.all("SELECT DISTINCT m.* FROM memory_fts f JOIN memory_chunks c ON c.id=f.rowid JOIN memory_items m ON m.id=c.memory_id WHERE memory_fts MATCH ? AND m.scope=? AND m.status='active' ORDER BY m.updated_at DESC LIMIT 200",phrase,scope);}
  const items=[],seen=new Set(),check=sourceChecker();async function collect(candidates,match){for(const item of candidates){if(!seen.has(item.id)&&await canRead(item,check)){seen.add(item.id);const {keyword_matches,...visible}=item;items.push({...visible,match_type:match,sources:await sources(item.id)});if(items.length>=limit)break;}}}
  await collect(rows,'exact');
  // If the full question is not a substring, rank bounded two-character matches.
  // They are search hints only and never establish that a memory is true.
  if(items.length<limit){
   const grams=new Set();for(const block of term.toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]){const chars=Array.from(block);for(let i=0;i+1<chars.length;i++)grams.add(chars.slice(i,i+2).join(''));}
   const all=[...grams],selected=all.length<=24?all:Array.from({length:24},(_,i)=>all[Math.floor(i*(all.length-1)/23)]);
   if(selected.length){const score=selected.map(()=>'(CASE WHEN instr(lower(c.content),?)>0 THEN 1 ELSE 0 END)').join('+'),where=selected.map(()=>'instr(lower(c.content),?)>0').join(' OR ');
    const matches=await db.all(`SELECT m.*,(${score}) AS keyword_matches FROM memory_items m JOIN memory_chunks c ON c.memory_id=m.id WHERE m.scope=? AND m.status='active' AND (${where}) ORDER BY keyword_matches DESC,m.updated_at DESC LIMIT 200`,...selected,scope,...selected);
    const threshold=selected.length===1?1:2;await collect(matches.filter(item=>item.keyword_matches>=threshold),'partial');
   }
  }
  return {items,mode:'keyword'};
 }
 async function embeddingItems(model){
  const rows=await db.all("SELECT m.*,c.id AS chunk_id,c.version AS chunk_version,e.vector,e.dimensions FROM memory_items m JOIN memory_chunks c ON c.memory_id=m.id LEFT JOIN memory_embeddings e ON e.chunk_id=c.id AND e.model=? WHERE m.scope=? AND m.status='active' ORDER BY m.updated_at DESC LIMIT 2000",model,scope);
  const items=[],check=sourceChecker();
  for(const row of rows){const itemSources=await sources(row.id);if(await check(itemSources))items.push({...row,sources:itemSources});}
  return items;
 }
 async function embeddingPage(model,{after=0,limit=20}={}){
  if(typeof model!=='string'||!model||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('INVALID_QUERY');
  const rows=await db.all("SELECT m.*,c.id AS chunk_id,c.version AS chunk_version,e.vector,e.dimensions FROM memory_items m JOIN memory_chunks c ON c.memory_id=m.id LEFT JOIN memory_embeddings e ON e.chunk_id=c.id AND e.model=? WHERE m.scope=? AND m.status='active' AND c.id>? ORDER BY c.id LIMIT ?",model,scope,after,limit);
  const items=[],check=sourceChecker();for(const row of rows){const itemSources=await sources(row.id);if(await check(itemSources))items.push({...row,sources:itemSources});}
  return {items,next:rows.length?rows[rows.length-1].chunk_id:after,end:rows.length<limit};
 }
 async function saveEmbedding(item,model,vector){
  if(!Array.isArray(vector)||!vector.length||vector.length>8192||vector.some(value=>typeof value!=='number'||!Number.isFinite(value)))throw Error('INVALID_EMBEDDING');
  await db.transaction(async tx=>{const current=await tx.get("SELECT c.id FROM memory_chunks c JOIN memory_items m ON m.id=c.memory_id WHERE c.id=? AND c.version=? AND m.id=? AND m.scope=? AND m.status='active'",item.chunk_id,item.chunk_version,item.id,scope);if(!current)return;await tx.run('INSERT INTO memory_embeddings(chunk_id,model,dimensions,vector) VALUES(?,?,?,?) ON CONFLICT(chunk_id,model) DO UPDATE SET dimensions=excluded.dimensions,vector=excluded.vector',item.chunk_id,model,vector.length,JSON.stringify(vector));});
 }
 async function metadata(key,value){if(value===undefined)return (await db.get('SELECT value FROM memory_metadata WHERE scope=? AND key=?',scope,key))?.value;await db.run('INSERT INTO memory_metadata(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value',scope,key,String(value));}
 async function recordTurn(ref){
  return db.transaction(async tx=>{
   const prior=await tx.get('SELECT * FROM memory_turn_state WHERE scope=? AND conversation_id=? AND submission_id=?',scope,ref.conversationId,ref.submissionId);if(prior)return prior;
   const last=await tx.get("SELECT MAX(tool_call_count) AS count FROM memory_turn_state WHERE scope=? AND conversation_id=? AND harvest_status!='none'",scope,ref.conversationId);
   const eligible=ref.messageCount>5&&ref.toolCallCount>=15&&(last?.count==null||ref.toolCallCount-last.count>=15);
   const now=new Date(),expires=eligible?new Date(now.getTime()+7200000).toISOString():null;
   await tx.run('INSERT INTO memory_turn_state VALUES(?,?,?,?,?,?,?,?,?,?)',scope,ref.conversationId,ref.submissionId,ref.answerEntryId,ref.completedRuns,ref.messageCount,ref.toolCallCount,eligible?'eligible':'none',expires,now.toISOString());
   return tx.get('SELECT * FROM memory_turn_state WHERE scope=? AND conversation_id=? AND submission_id=?',scope,ref.conversationId,ref.submissionId);
  });
 }
 async function recommendations(conversationId){return db.all("SELECT conversation_id,submission_id,answer_entry_id,message_count,tool_call_count,expires_at FROM memory_turn_state WHERE scope=? AND conversation_id=? AND harvest_status='eligible' AND expires_at>? ORDER BY created_at DESC",scope,conversationId,new Date().toISOString());}
 async function taskStatus(ref,kind,status,{taskId=null,attempt=0,errorCode=null}={}){await db.run('INSERT INTO memory_task_runs(scope,conversation_id,submission_id,kind,task_id,status,attempt,error_code,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,conversation_id,submission_id,kind) DO UPDATE SET task_id=COALESCE(excluded.task_id,memory_task_runs.task_id),status=excluded.status,attempt=excluded.attempt,error_code=excluded.error_code,updated_at=excluded.updated_at',scope,ref.conversationId,ref.submissionId,kind,taskId,status,attempt,errorCode,new Date().toISOString());}
 async function queueTask(ref,kind){await db.run("INSERT OR IGNORE INTO memory_task_runs(scope,conversation_id,submission_id,kind,status,updated_at) VALUES(?,?,?,?,'queued',?)",scope,ref.conversationId,ref.submissionId,kind,new Date().toISOString());}
 async function finishSkipped(ref,kind){await db.run("UPDATE memory_task_runs SET status='skipped',updated_at=? WHERE scope=? AND conversation_id=? AND submission_id=? AND kind=? AND status='queued' AND task_id IS NULL",new Date().toISOString(),scope,ref.conversationId,ref.submissionId,kind);}
 async function linkTask(ref,kind,taskId){await db.run('UPDATE memory_task_runs SET task_id=? WHERE scope=? AND conversation_id=? AND submission_id=? AND kind=?',String(taskId),scope,ref.conversationId,ref.submissionId,kind);}
 async function tasks(conversationId){return db.all('SELECT conversation_id,submission_id,kind,task_id,status,attempt,error_code,updated_at FROM memory_task_runs WHERE scope=? AND conversation_id=? ORDER BY updated_at DESC LIMIT 100',scope,conversationId);}
 async function turnsSinceWriter(conversationId){const result=await db.get("SELECT COUNT(*) AS n FROM memory_turn_state t WHERE t.scope=? AND t.conversation_id=? AND t.completed_runs > COALESCE((SELECT MAX(previous.completed_runs) FROM memory_turn_state previous JOIN memory_task_runs job ON job.scope=previous.scope AND job.conversation_id=previous.conversation_id AND job.submission_id=previous.submission_id WHERE previous.scope=t.scope AND previous.conversation_id=t.conversation_id AND job.kind='writer' AND job.task_id IS NOT NULL AND job.status IN ('completed','skipped')),0)",scope,conversationId);return result.n;}
 async function skillCandidate(row){if(!row)return null;let sourceList,review;try{sourceList=JSON.parse(row.source_refs);review=JSON.parse(row.review);}catch{return null;}if(!await checkSources(sourceList))return null;return {...row,sources:sourceList,review};}
 async function createSkillCandidate(ref,input){
  if(!['create','replace','delete'].includes(input.operation)||typeof input.name!=='string'||!input.name.trim()||input.name.length>100||typeof input.content!=='string'||Buffer.byteLength(input.content)>32768||(input.operation!=='delete'&&!input.content.trim())||typeof input.reason!=='string'||input.reason.length>4000||typeof input.review?.approved!=='boolean'||typeof input.review.reason!=='string'||input.review.reason.length>4000||!Array.isArray(input.sources)||!input.sources.length||input.sources.length>100)throw Error('INVALID_SKILL_CANDIDATE');
  input.sources.forEach(validateSource);if(!await checkSources(input.sources))throw Error('FORBIDDEN');
  const id=randomUUID(),now=new Date().toISOString(),name=input.name.trim();
  const row=await db.transaction(async tx=>{
   const existing=await tx.get('SELECT * FROM skill_candidates WHERE scope=? AND conversation_id=? AND submission_id=? ORDER BY created_at DESC LIMIT 1',scope,ref.conversationId,ref.submissionId);if(existing)return existing;
   const eligible=await tx.get("SELECT * FROM memory_turn_state WHERE scope=? AND conversation_id=? AND submission_id=? AND harvest_status='eligible' AND expires_at>?",scope,ref.conversationId,ref.submissionId,now);if(!eligible)throw Error('HARVEST_NOT_ELIGIBLE');
   const active=await tx.get("SELECT version FROM skill_versions WHERE scope=? AND name=? AND status='active'",scope,name);const latest=await tx.get('SELECT MAX(version) AS version FROM skill_versions WHERE scope=? AND name=?',scope,name);
   if(input.expectedActiveVersion!==undefined&&(active?.version??null)!==input.expectedActiveVersion)throw Error('VERSION_CONFLICT');
   if(input.operation==='create'&&active)throw Error('SKILL_EXISTS');if(input.operation!=='create'&&!active)throw Error('SKILL_NOT_FOUND');
   const baseVersion=latest?.version??0,review=JSON.stringify(input.review),sourceRefs=JSON.stringify(input.sources),digest=createHash('sha256').update(JSON.stringify({id,operation:input.operation,name,content:input.content,reason:input.reason,review,sourceRefs,baseVersion})).digest('hex');
   await tx.run('INSERT INTO skill_candidates(id,scope,conversation_id,submission_id,name,content,reason,review,status,created_at,expires_at,base_version,source_refs,operation,digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,scope,ref.conversationId,ref.submissionId,name,input.content,input.reason,review,input.review.approved?'reviewed':'review_rejected',now,eligible.expires_at,baseVersion,sourceRefs,input.operation,digest);
   await tx.run("UPDATE memory_turn_state SET harvest_status='processed' WHERE scope=? AND conversation_id=? AND submission_id=?",scope,ref.conversationId,ref.submissionId);
   return tx.get('SELECT * FROM skill_candidates WHERE id=? AND scope=?',id,scope);
  });return skillCandidate(row);
 }
 async function listSkillCandidates(conversationId){const rows=await db.all('SELECT * FROM skill_candidates WHERE scope=? AND conversation_id=? ORDER BY created_at DESC LIMIT 50',scope,conversationId);const result=[];for(const row of rows){const item=await skillCandidate(row);if(item)result.push(item);}return result;}
 async function consumeRecommendation(ref){await db.run("UPDATE memory_turn_state SET harvest_status='processed' WHERE scope=? AND conversation_id=? AND submission_id=? AND harvest_status='eligible'",scope,ref.conversationId,ref.submissionId);}
 async function activeSkills(){const rows=await db.all("SELECT * FROM skill_versions WHERE scope=? AND status='active' ORDER BY created_at DESC LIMIT 100",scope);const result=[];for(const row of rows){let refs;try{refs=JSON.parse(row.source_refs);}catch{continue;}if(await checkSources(refs))result.push({...row,sources:refs});}return result;}
 async function selectedSkillNames(conversationId,available){const skills=available||await activeSkills(),stored=await metadata('skill_selection:'+conversationId);if(stored===undefined)return skills.slice(0,5).map(item=>item.name);try{const names=JSON.parse(stored);if(!Array.isArray(names)||names.length>5||names.some(name=>typeof name!=='string'))return [];const allowed=new Set(skills.map(item=>item.name));return [...new Set(names)].filter(name=>allowed.has(name));}catch{return [];}}
 async function setSkillSelection(conversationId,names){if(typeof conversationId!=='string'||!conversationId||!Array.isArray(names)||names.length>5||new Set(names).size!==names.length||names.some(name=>typeof name!=='string'||!name||name.length>100))throw Error('INVALID_SKILL_SELECTION');const available=await activeSkills(),allowed=new Set(available.map(item=>item.name));if(names.some(name=>!allowed.has(name)))throw Error('SKILL_UNAVAILABLE');await metadata('skill_selection:'+conversationId,JSON.stringify(names));return names;}
 async function skillVersions(){const rows=await db.all('SELECT * FROM skill_versions WHERE scope=? ORDER BY created_at DESC LIMIT 100',scope);const result=[];for(const row of rows){let refs;try{refs=JSON.parse(row.source_refs);}catch{continue;}if(await checkSources(refs))result.push({...row,sources:refs});}return result;}
 async function rejectSkill(id,digest){
  const candidate=await skillCandidate(await db.get('SELECT * FROM skill_candidates WHERE id=? AND scope=?',id,scope));if(!candidate)throw Error('NOT_FOUND');
  if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)||!candidate.digest||!timingSafeEqual(Buffer.from(digest),Buffer.from(candidate.digest)))throw Error('CANDIDATE_CONFLICT');
  return db.transaction(async tx=>{const current=await tx.get('SELECT status,digest FROM skill_candidates WHERE id=? AND scope=?',id,scope);if(!current||current.digest!==digest||!['reviewed','review_rejected','rejected'].includes(current.status))throw Error('CANDIDATE_CONFLICT');if(current.status!=='rejected'){await tx.run("UPDATE skill_candidates SET status='rejected' WHERE id=? AND scope=?",id,scope);await tx.run('INSERT INTO memory_changes VALUES(?,?,?,?,?)',randomUUID(),id,'skill_rejected',1,new Date().toISOString());}return {id,status:'rejected'};});
 }
 async function publishSkill(id,digest){
  const candidate=await skillCandidate(await db.get('SELECT * FROM skill_candidates WHERE id=? AND scope=?',id,scope));if(!candidate)throw Error('NOT_FOUND');
  if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)||!candidate.digest||!timingSafeEqual(Buffer.from(digest),Buffer.from(candidate.digest)))throw Error('CANDIDATE_CONFLICT');
  if(candidate.status!=='reviewed'||candidate.expires_at<=new Date().toISOString())throw Error('SKILL_REVIEW_REQUIRED');
  return db.transaction(async tx=>{
   const current=await tx.get('SELECT * FROM skill_candidates WHERE id=? AND scope=?',id,scope);if(!current||current.status!=='reviewed'||current.digest!==digest||current.expires_at<=new Date().toISOString())throw Error('CANDIDATE_CONFLICT');
   const latest=await tx.get('SELECT MAX(version) AS version FROM skill_versions WHERE scope=? AND name=?',scope,current.name);if((latest?.version??0)!==current.base_version)throw Error('VERSION_CONFLICT');
   await tx.run("UPDATE skill_versions SET status='historical' WHERE scope=? AND name=? AND status='active'",scope,current.name);
   const versionId=randomUUID(),version=current.base_version+1,hash=createHash('sha256').update(current.content).digest('hex'),status=current.operation==='delete'?'disabled':'active',now=new Date().toISOString();
   await tx.run('INSERT INTO skill_versions(id,scope,name,version,content,content_hash,status,source_candidate_id,created_at,source_refs,operation) VALUES(?,?,?,?,?,?,?,?,?,?,?)',versionId,scope,current.name,version,current.content,hash,status,id,now,current.source_refs,current.operation);
   await tx.run("UPDATE skill_candidates SET status='published' WHERE id=? AND scope=?",id,scope);
   await tx.run('INSERT INTO memory_changes VALUES(?,?,?,?,?)',randomUUID(),versionId,'skill_published',version,now);
   return {id:versionId,name:current.name,version,status};
  });
 }
 async function rollbackSkill(id,expectedVersion){
  const target=await db.get('SELECT * FROM skill_versions WHERE id=? AND scope=?',id,scope);if(!target)throw Error('NOT_FOUND');let refs;try{refs=JSON.parse(target.source_refs);}catch{throw Error('INVALID_SOURCE');}if(!await checkSources(refs))throw Error('FORBIDDEN');
  return db.transaction(async tx=>{
   const latest=await tx.get('SELECT MAX(version) AS version FROM skill_versions WHERE scope=? AND name=?',scope,target.name);if(latest?.version!==expectedVersion)throw Error('VERSION_CONFLICT');
   await tx.run("UPDATE skill_versions SET status='historical' WHERE scope=? AND name=? AND status='active'",scope,target.name);
   const idNew=randomUUID(),version=expectedVersion+1,status=target.operation==='delete'?'disabled':'active',now=new Date().toISOString();
   await tx.run('INSERT INTO skill_versions(id,scope,name,version,content,content_hash,status,source_candidate_id,created_at,source_refs,operation) VALUES(?,?,?,?,?,?,?,?,?,?,?)',idNew,scope,target.name,version,target.content,target.content_hash,status,target.source_candidate_id,now,target.source_refs,target.operation);
   await tx.run('INSERT INTO memory_changes VALUES(?,?,?,?,?)',randomUUID(),idNew,'skill_rollback',version,now);return {id:idNew,name:target.name,version,status};
  });
 }
 return {save,get,list,listPage,related,operationExists,mergeExactPending,update,review,search,embeddingItems,embeddingPage,saveEmbedding,metadata,recordTurn,recommendations,consumeRecommendation,taskStatus,queueTask,finishSkipped,linkTask,tasks,turnsSinceWriter,checkSources,createSkillCandidate,listSkillCandidates,activeSkills,selectedSkillNames,setSkillSelection,skillVersions,publishSkill,rejectSkill,rollbackSkill,db,scope};
}
