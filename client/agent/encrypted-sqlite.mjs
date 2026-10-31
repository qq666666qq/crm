import {createClient} from '@libsql/client';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Pi and host storage share this one ordered connection facade.
export async function openEncryptedDatabase(file,key) {
  if(!path.isAbsolute(file)||!/^[0-9a-f]{64}$/i.test(key)) throw Error('INVALID_DATABASE_KEY');
  const client=createClient({url:pathToFileURL(file).href,encryptionKey:key,intMode:'number'});
  try {
    await client.execute('SELECT count(*) FROM sqlite_master');
    await client.execute('PRAGMA foreign_keys=ON');
    await client.execute('PRAGMA temp_store=MEMORY');
    await client.execute('PRAGMA journal_mode=WAL');
  } catch(error) {client.close();throw error;}
  let tail=Promise.resolve(),closed=false;
  const enqueue=fn=>{const operation=tail.then(()=>{if(closed)throw Error('DATABASE_CLOSED');return fn();});tail=operation.catch(()=>{});return operation;};
  const execute=(target,scope={active:true})=>({
    exec:async sql=>{if(!scope.active)throw Error('TRANSACTION_CLOSED');await target.executeMultiple(sql);},
    run:async (sql,...args)=>{if(!scope.active)throw Error('TRANSACTION_CLOSED');await target.execute({sql,args});},
    get:async (sql,...args)=>{if(!scope.active)throw Error('TRANSACTION_CLOSED');const result=await target.execute({sql,args});return result.rows[0]===undefined?undefined:Object.fromEntries(result.columns.map(name=>[name,result.rows[0][name]]));},
    all:async (sql,...args)=>{if(!scope.active)throw Error('TRANSACTION_CLOSED');const result=await target.execute({sql,args});return result.rows.map(row=>Object.fromEntries(result.columns.map(name=>[name,row[name]])));},
  });
  return {
    exec:sql=>enqueue(()=>execute(client).exec(sql)),
    run:(sql,...args)=>enqueue(()=>execute(client).run(sql,...args)),
    get:(sql,...args)=>enqueue(()=>execute(client).get(sql,...args)),
    all:(sql,...args)=>enqueue(()=>execute(client).all(sql,...args)),
    transaction:callback=>enqueue(async()=>{const transaction=await client.transaction('write'),scope={active:true};try{const result=await callback(execute(transaction,scope));scope.active=false;await transaction.commit();return result;}catch(error){scope.active=false;try{await transaction.rollback();}catch(rollback){throw new AggregateError([error,rollback],'ROLLBACK_FAILED');}throw error;}}),
    close:()=>closed?Promise.resolve():enqueue(async()=>{await client.execute('PRAGMA wal_checkpoint(TRUNCATE)');client.close();closed=true;}),
  };
}
