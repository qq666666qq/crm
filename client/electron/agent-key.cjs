'use strict';
const fs=require('node:fs');const path=require('node:path');const {randomBytes}=require('node:crypto');

function agentDatabaseKey(safeStorage,directory,scope){
 if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==='basic_text')throw Error('ENCRYPTION_UNAVAILABLE');
 const keyFile=path.join(directory,'database-key.bin'),database=path.join(directory,'conversations.encrypted.sqlite');
 fs.mkdirSync(directory,{recursive:true});
 let raw;
 try{raw=fs.readFileSync(keyFile);}catch(error){
  if(error.code!=='ENOENT')throw error;
  if(fs.existsSync(database)||fs.existsSync(database+'-wal'))throw Error('DATABASE_KEY_MISSING');
  const key=randomBytes(32).toString('hex');
  const encrypted=safeStorage.encryptString(JSON.stringify({version:1,scope,key}));
  try{fs.writeFileSync(keyFile,encrypted,{flag:'wx',mode:0o600});return key;}
  catch(writeError){if(writeError.code!=='EEXIST')throw writeError;raw=fs.readFileSync(keyFile);}
 }
 let data;try{data=JSON.parse(safeStorage.decryptString(raw));}catch{throw Error('DATABASE_KEY_UNAVAILABLE');}
 if(data.scope!==scope)throw Error('KEY_SCOPE_MISMATCH');
 if(data.version!==1||!/^[a-f0-9]{64}$/i.test(data.key))throw Error('DATABASE_KEY_INVALID');
 return data.key;
}
module.exports={agentDatabaseKey};
