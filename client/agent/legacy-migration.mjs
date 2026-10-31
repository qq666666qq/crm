import {DatabaseSync} from 'node:sqlite';
import {access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {SqliteStorage} from '@earendil-works/pi-durable/storage/sqlite';
import {openEncryptedDatabase} from './encrypted-sqlite.mjs';

const tables=['durable_schema','durable_metadata','record_ids','conversations','entries','tasks','submissions','documents','document_revisions'];
const exists=async file=>{try{await access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const digest=rows=>{const hash=createHash('sha256');for(const row of rows)hash.update(JSON.stringify(row)+'\n');return hash.digest('hex');};

// Preserve the original; a marker makes the encrypted copy resumable after a crash.
export async function migrateLegacySession(sourceFile,targetFile,key){
 if(!await exists(sourceFile))return {migrated:false,reason:'no_legacy'};
 const targetExists=await exists(targetFile);
 let db=await openEncryptedDatabase(targetFile,key),storage,source;
 try{
  if(targetExists){
   const marker=await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_session_migration'");
   if(!marker){
    const existing=await db.get("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    if(existing.n!==0)return {migrated:false,reason:'existing_target'};
    await db.exec("CREATE TABLE crm_session_migration(id INTEGER PRIMARY KEY CHECK(id=1),status TEXT NOT NULL CHECK(status IN ('pending','complete'))); INSERT INTO crm_session_migration VALUES(1,'pending');");
   }else{
    const state=await db.get('SELECT status FROM crm_session_migration WHERE id=1');
    if(state?.status==='complete')return {migrated:false,reason:'complete'};
    if(state?.status!=='pending')throw Error('MIGRATION_STATE_INVALID');
   }
  }else{
   await db.exec("CREATE TABLE crm_session_migration(id INTEGER PRIMARY KEY CHECK(id=1),status TEXT NOT NULL CHECK(status IN ('pending','complete'))); INSERT INTO crm_session_migration VALUES(1,'pending');");
  }
  storage=await SqliteStorage.open(db);
  await storage.close();storage=null;
  db=await openEncryptedDatabase(targetFile,key);
  source=new DatabaseSync(sourceFile,{readOnly:true});source.exec('BEGIN');
  if(source.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('LEGACY_INTEGRITY_FAILED');
  const sourceTables=source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row=>row.name);
  if(sourceTables.length!==tables.length||sourceTables.some(name=>!tables.includes(name)))throw Error('LEGACY_SCHEMA_UNSUPPORTED');
  await db.transaction(async tx=>{
   for(const table of tables){
    const oldColumns=source.prepare(`PRAGMA table_info("${table}")`).all().map(x=>x.name);
    const newColumns=(await tx.all(`PRAGMA table_info("${table}")`)).map(x=>x.name);
    if(JSON.stringify(oldColumns)!==JSON.stringify(newColumns))throw Error('LEGACY_SCHEMA_UNSUPPORTED');
    await tx.run(`DELETE FROM "${table}"`);
    const cols=oldColumns.map(name=>`"${name.replaceAll('"','""')}"`).join(',');
    const insert=`INSERT INTO "${table}" (${cols}) VALUES (${oldColumns.map(()=>'?').join(',')})`;
    const rows=source.prepare(`SELECT ${cols} FROM "${table}" ORDER BY rowid`).all();
    for(const row of rows)await tx.run(insert,...oldColumns.map(name=>row[name]));
    const restored=await tx.all(`SELECT ${cols} FROM "${table}" ORDER BY rowid`);
    const normalize=items=>items.map(row=>oldColumns.map(name=>row[name]));
    if(rows.length!==restored.length||digest(normalize(rows))!==digest(normalize(restored)))throw Error('LEGACY_COPY_VERIFICATION_FAILED');
   }
   await tx.run("UPDATE crm_session_migration SET status='complete' WHERE id=1");
  });
  source.exec('ROLLBACK');source.close();source=null;
  return {migrated:true};
 }finally{
  if(source){try{source.exec('ROLLBACK');}catch{}source.close();}
  if(storage)await storage.close();else await db.close();
 }
}
