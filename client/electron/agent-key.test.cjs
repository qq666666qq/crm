const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {agentDatabaseKey}=require('./agent-key.cjs');
const safe={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('protected:'+s),decryptString:b=>b.toString().slice(10)};
test('账号密钥受系统保护并在重启后恢复，不会因丢失密钥覆盖数据库',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crm-agent-key-'));
 try{
  const one=agentDatabaseKey(safe,dir,'scope-a');assert.match(one,/^[a-f0-9]{64}$/);
  assert.equal(agentDatabaseKey(safe,dir,'scope-a'),one);
  assert.throws(()=>agentDatabaseKey(safe,dir,'scope-b'),/KEY_SCOPE_MISMATCH/);
  fs.unlinkSync(path.join(dir,'database-key.bin'));fs.writeFileSync(path.join(dir,'conversations.encrypted.sqlite'),'existing');
  assert.throws(()=>agentDatabaseKey(safe,dir,'scope-a'),/DATABASE_KEY_MISSING/);
  assert.throws(()=>agentDatabaseKey({isEncryptionAvailable:()=>false},dir,'scope-a'),/ENCRYPTION_UNAVAILABLE/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
