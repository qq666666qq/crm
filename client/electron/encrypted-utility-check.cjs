const {app,utilityProcess}=require('electron');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
app.whenReady().then(()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crm-encrypted-electron-'));
  const script=process.env.CRM_AGENT_TEST_LIBSQL==='1'?'libsql-utility-check.mjs':'encrypted-utility-check.mjs';
  const child=utilityProcess.fork(path.join(__dirname,'../agent',script),[],{env:{CRM_AGENT_TEST_DIR:dir,SystemRoot:process.env.SystemRoot||''},stdio:'pipe'});
  let passed=false;
  child.stderr?.on('data',data=>process.stderr.write(data));
  child.on('message',message=>{passed=message?.ok===true;if(!passed)console.error(message?.error||'Encrypted utility failed');child.kill();});
  const timer=setTimeout(()=>child.kill(),20000);
  child.on('exit',()=>{clearTimeout(timer);try{fs.rmSync(dir,{recursive:true,force:true});}catch{};console.log(passed?'Encrypted Pi utility check passed':'Encrypted Pi utility check failed');app.exit(passed?0:1);});
});
