const fs=require('node:fs');const path=require('node:path');const {approvalStore}=require('./agent-approvals.cjs');const {makeTestStorage}=require('./test-safe-storage.cjs');
const dir=process.argv[2],store=approvalStore(path.join(dir,'approvals'),makeTestStorage(Buffer.alloc(32,9)),'scope');
(async()=>{const {openTrace}=await import('../agent/trace.mjs');const trace=await openTrace(dir),run=await trace.start();const item=store.create('create_lead',{title:'测试线索',manual_note:'测试依据'},'crash-call',run);store.transition(item.id,['pending'],'submitting',{},item.digest);
// Simulate a server commit keyed by the approval ID, before its response reaches the client.
fs.writeFileSync(path.join(dir,'mock-committed-key'),item.id,{flag:'wx'});fs.writeSync(1,'committed\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);})().catch(()=>process.exit(1));
