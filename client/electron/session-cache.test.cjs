const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {sessionCache} = require('./session-cache.cjs');

test('会话加密保存、按服务地址隔离并可清除', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crm-session-'));
  const key=crypto.randomBytes(32);
  const safe={isEncryptionAvailable:()=>true,encryptString:text=>{const iv=crypto.randomBytes(16);const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const content=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),content]);},decryptString:data=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,data.subarray(0,16));decipher.setAuthTag(data.subarray(16,32));return Buffer.concat([decipher.update(data.subarray(32)),decipher.final()]).toString('utf8');}};
  try {const cache=sessionCache(safe,dir,'https://crm.example');assert.equal(cache.save('private-token','tenant-a'),true);assert.equal(fs.readFileSync(path.join(dir,'login-session.bin')).includes(Buffer.from('private-token')),false);assert.deepEqual(cache.load(),{token:'private-token',tenant:'tenant-a'});assert.equal(sessionCache(safe,dir,'https://other.example').load(),null);cache.clear();assert.equal(cache.load(),null);} finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('系统加密不可用时不写入明文',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crm-session-'));try{const cache=sessionCache({isEncryptionAvailable:()=>false},dir,'https://crm.example');assert.equal(cache.save('private-token','tenant-a'),false);assert.deepEqual(fs.readdirSync(dir),[]);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
