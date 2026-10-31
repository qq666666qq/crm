import {describe,it,expect} from 'vitest';
import {pageModules,validateModules,workspaceModules} from './modules';

describe('侧边栏模块',()=>{
  it('所有页面入口唯一且 Notion 是演示页面',()=>{
    expect(()=>validateModules(workspaceModules)).not.toThrow();
    expect(pageModules.find(module=>module.id==='notion-demo')?.demo).toBe(true);
  });
  it('拒绝重复标识、重复页面和非法名称',()=>{
    const first=pageModules[0];
    expect(()=>validateModules([first,first])).toThrow();
    expect(()=>validateModules([first,{...first,id:'other'}])).toThrow();
    expect(()=>validateModules([{...first,id:'../invalid'}])).toThrow();
    expect(()=>validateModules([{...first,label:'  '}])).toThrow();
  });
});
