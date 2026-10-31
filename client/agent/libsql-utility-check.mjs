import {createClient} from '@libsql/client';
import {pathToFileURL} from 'node:url';import path from 'node:path';
try {
 const url=pathToFileURL(path.join(process.env.CRM_AGENT_TEST_DIR,'secure.sqlite')).href;
 let client=createClient({url,encryptionKey:'1'.repeat(64)});
 await client.execute('CREATE TABLE test(value TEXT)');
 await client.execute({sql:'INSERT INTO test VALUES (?)',args:['protected']});client.close();
 client=createClient({url,encryptionKey:'1'.repeat(64)});
 const value=(await client.execute('SELECT value FROM test')).rows[0].value;client.close();
 if(value!=='protected')throw Error('RECOVERY_FAILED');
 process.parentPort.postMessage({ok:true});
}catch(error){process.parentPort.postMessage({ok:false,error:String(error)});}
