import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openEncryptedDatabase} from './encrypted-sqlite.mjs';

test('加密数据库可恢复数据，并在事务失败时回滚', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'crm-encrypted-'));
  const file=path.join(dir,'test.sqlite'), key='1'.repeat(64);
  try {
    let db=await openEncryptedDatabase(file,key);
    await db.exec('CREATE TABLE records(value TEXT NOT NULL)');
    assert.equal((await db.get('PRAGMA temp_store')).temp_store,2);
    await db.run('INSERT INTO records VALUES (?)','private-message');
    try{assert.equal((await readFile(file+'-wal')).includes(Buffer.from('private-message')),false);}catch(error){if(error.code!=='ENOENT')throw error;}
    await assert.rejects(db.transaction(async tx=>{await tx.run('INSERT INTO records VALUES (?)','rollback');throw Error('abort');}));
    await db.close();
    assert.equal((await readFile(file)).includes(Buffer.from('private-message')),false);
    db=await openEncryptedDatabase(file,key);
    assert.deepEqual(await db.all('SELECT value FROM records'),[{value:'private-message'}]);
    await db.close();
    await assert.rejects(openEncryptedDatabase(file,'2'.repeat(64)));
  } finally {try{await rm(dir,{recursive:true,force:true});}catch{}}
});
