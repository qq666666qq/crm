const {app,utilityProcess}=require('electron');
const path=require('node:path');
app.whenReady().then(()=>{
 const child=utilityProcess.fork(path.join(__dirname,'../agent/telemetry-utility-check.mjs'),[],{env:{SystemRoot:process.env.SystemRoot||''},stdio:'pipe'});
 let passed=false;
 child.stderr?.on('data',data=>process.stderr.write(data));
 child.on('message',message=>{passed=message?.ok===true;if(!passed)console.error(message?.error||'Telemetry utility failed');child.kill();});
 const timer=setTimeout(()=>child.kill(),20000);
 child.on('exit',()=>{clearTimeout(timer);console.log(passed?'Pi telemetry utility check passed':'Pi telemetry utility check failed');app.exit(passed?0:1);});
});
