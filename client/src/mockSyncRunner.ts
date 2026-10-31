type MockSync = (action:'run'|'list',destination?:string,key?:string)=>Promise<any>;

// Keep a key per destination until the simulated write has a definite result.
export function createMockSyncRunner(mockSync:MockSync,newKey:()=>string) {
  const pending=new Map<string,string>();
  return {
    async run(destination:string,retryKey?:string):Promise<{ok:boolean;jobs:any[]}> {
      try {
        const key=retryKey||pending.get(destination)||newKey();
        pending.set(destination,key);
        await mockSync('run',destination,key);
        pending.delete(destination);
        return {ok:true,jobs:await mockSync('list')};
      } catch {
        return {ok:false,jobs:await mockSync('list').catch(()=>[])};
      }
    }
  };
}
