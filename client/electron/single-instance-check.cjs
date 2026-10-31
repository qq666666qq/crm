// Isolated real-Electron check; no application windows or existing user data.
const {app}=require('electron');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawn}=require('node:child_process');
const dir=process.env.CRM_LOCK_TEST_DIR||fs.mkdtempSync(path.join(os.tmpdir(),'crm-instance-'));app.setPath('userData',dir);
const acquired=app.requestSingleInstanceLock();
if(process.env.CRM_LOCK_TEST_CHILD==='1'){process.exit(acquired?1:0);}
if(!acquired){console.error('无法取得测试锁');app.exit(1);}else app.whenReady().then(()=>{const child=spawn(process.execPath,[__filename],{env:{...process.env,CRM_LOCK_TEST_DIR:dir,CRM_LOCK_TEST_CHILD:'1'},windowsHide:true,stdio:'ignore'});const timer=setTimeout(()=>{child.kill();app.exit(1)},10000);child.on('exit',code=>{clearTimeout(timer);app.releaseSingleInstanceLock();try{fs.rmSync(dir,{recursive:true,force:true});}catch{}console.log(code===0?'真实 Electron 单实例验证通过':'第二实例错误地取得锁');app.exit(code===0?0:1);});child.on('error',()=>app.exit(1));});
