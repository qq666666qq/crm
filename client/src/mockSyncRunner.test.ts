import {describe,expect,it,vi} from 'vitest';
import {createMockSyncRunner} from './mockSyncRunner';

describe('simulated sync retries',()=>{
  it('reuses the key after an uncertain result and creates a new key after success',async()=>{
    const attempts:string[]=[];
    let fail=true,sequence=0;
    const sync=vi.fn(async(action:'run'|'list',_destination?:string,key?:string)=>{
      if(action==='list')return [{id:'job'}];
      attempts.push(key!);
      if(fail){fail=false;throw new Error('uncertain');}
      return {};
    });
    const runner=createMockSyncRunner(sync,()=>`key-${++sequence}`);
    expect(await runner.run('notion-demo')).toEqual({ok:false,jobs:[{id:'job'}]});
    expect(await runner.run('notion-demo')).toEqual({ok:true,jobs:[{id:'job'}]});
    await runner.run('notion-demo');
    expect(attempts).toEqual(['key-1','key-1','key-2']);
  });
  it('keeps destinations separate and honors a saved retry key',async()=>{
    const attempts:Array<[string|undefined,string|undefined]>=[];
    let sequence=0;
    const sync=async(action:'run'|'list',destination?:string,key?:string)=>{
      if(action==='list')throw new Error('offline');
      attempts.push([destination,key]);
      throw new Error('uncertain');
    };
    const runner=createMockSyncRunner(sync,()=>`key-${++sequence}`);
    expect(await runner.run('notion-demo')).toEqual({ok:false,jobs:[]});
    await runner.run('feishu-demo');
    await runner.run('notion-demo');
    await runner.run('feishu-demo','persisted-key');
    await runner.run('feishu-demo');
    expect(attempts).toEqual([['notion-demo','key-1'],['feishu-demo','key-2'],['notion-demo','key-1'],['feishu-demo','persisted-key'],['feishu-demo','persisted-key']]);
  });
});
