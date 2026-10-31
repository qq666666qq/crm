import {openRuntime} from './runtime.mjs';
import path from 'node:path';
try {
  const file=path.join(process.env.CRM_AGENT_TEST_DIR,'encrypted.sqlite');
  let runtime=await openRuntime(file,{databaseKey:'1'.repeat(64)});
  const id=String(runtime.conversationId);await runtime.close();
  runtime=await openRuntime(file,{databaseKey:'1'.repeat(64)});
  if(String(runtime.conversationId)!==id)throw Error('SESSION_NOT_RESTORED');
  await runtime.close();
  process.parentPort.postMessage({ok:true});
} catch(error) {process.parentPort.postMessage({ok:false,error:String(error)});}
