import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';import os from 'node:os';
import {createClient} from '@libsql/client';

test('libSQL 本地加密及中文全文索引',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'crm-libsql-')),file=path.join(dir,'secure.db'),url=pathToFileURL(file).href;
 let db;
 try{
  db=createClient({url,encryptionKey:'1'.repeat(64)});
  await db.execute('CREATE VIRTUAL TABLE notes USING fts5(content, tokenize="trigram")');
  await db.execute({sql:'INSERT INTO notes(content) VALUES (?)',args:['客户需要采购厨房设备']});
  assert.equal((await db.execute({sql:'SELECT content FROM notes WHERE notes MATCH ?',args:['采购厨房']})).rows.length,1);
  db.close();assert.equal((await readFile(file)).includes(Buffer.from('客户需要采购厨房设备')),false);
  db=createClient({url,encryptionKey:'1'.repeat(64)});assert.equal((await db.execute('SELECT count(*) AS n FROM notes')).rows[0].n,1);db.close();
  db=createClient({url,encryptionKey:'2'.repeat(64)});
  await assert.rejects(db.execute('SELECT count(*) FROM notes'));
 }finally{db?.close();try{await rm(dir,{recursive:true,force:true});}catch{}}
});
