const {mockSync}=require('./mock-sync.cjs');const {makeTestStorage}=require('./test-safe-storage.cjs');
const store=mockSync(process.argv[2],makeTestStorage(Buffer.alloc(32,7)),'scope',{beforeCommit:()=>{require('node:fs').writeSync(1,'running\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}});
store.run('notion-demo','12345678-1234-1234-1234-123456789abc');
