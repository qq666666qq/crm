import React, {useEffect,useState} from 'react';
import {createMockSyncRunner} from './mockSyncRunner';

export function MockSyncPanel({busy,setBusy,onError}:{busy:boolean;setBusy:(busy:boolean)=>void;onError:(message:string)=>void}) {
  const [mockEnabled,setMockEnabled]=useState(true),[background,setBackground]=useState<any>({running:false});
  const [mockJobs,setMockJobs]=useState<any[]>([]);
  const [runner]=useState(()=>createMockSyncRunner((action,destination,key)=>window.crm.mockSync(action,destination,key),()=>crypto.randomUUID()));
  useEffect(()=>{
    let active=true;
    void window.crm.mockSync('config').then(result=>{if(active)setMockEnabled(result.enabled)}).catch(()=>{});
    void window.crm.mockBackground('status').then(result=>{if(active)setBackground(result)}).catch(()=>{});
    return()=>{active=false;};
  },[]);
  async function runMockSync(destination:string,retryKey?:string){
    try{setBusy(true);onError('');const result=await runner.run(destination,retryKey);setMockJobs(result.jobs);if(!result.ok)onError('模拟同步未完成，请查看记录并重试。');}
    finally{setBusy(false);}
  }
  return <details className="agent-control-card agent-collapsible"><summary className="agent-card-summary"><span className="agent-card-title">后台同步演示</span><span className="agent-card-status">{background.running?'运行中':'已停止'}</span><span className="agent-card-chevron" aria-hidden="true">⌄</span></summary><div className="agent-card-content"><div className="agent-control-heading"><div><h3>后台同步演示</h3><p>仅在本机模拟，不连接真实应用或客户数据</p></div></div><div className="button-row"><button className="button secondary" disabled={busy} onClick={()=>void window.crm.mockSync(mockEnabled?'disable':'enable').then(r=>{setMockEnabled(r.enabled);if(!r.enabled)setBackground({running:false})}).catch(()=>onError('无法更新模块状态。'))}>{mockEnabled?'停用模拟模块':'启用模拟模块'}</button><button className="button secondary" disabled={busy||!mockEnabled} onClick={()=>void runMockSync('notion-demo')}>模拟 Notion</button><button className="button secondary" disabled={busy||!mockEnabled} onClick={()=>void runMockSync('feishu-demo')}>模拟飞书</button><button className="button secondary" onClick={()=>void window.crm.mockSync('list').then(setMockJobs).catch(()=>onError('无法读取模拟记录。'))}>查看记录</button><button className="button secondary" disabled={busy||!mockEnabled} onClick={()=>void window.crm.mockBackground(background.running?'stop':'start','notion-demo').then(setBackground).catch(()=>onError('无法更改后台模拟状态。'))}>{background.running?'停止后台模拟':'启动后台模拟'}</button></div><p className="agent-control-note">{background.running?'后台每分钟执行一次 Notion 模拟；退出时暂停，重新登录后恢复。':'后台模拟已停止。'}</p>{mockJobs.slice(-5).reverse().map(j=><p key={j.id}>{j.destination==='notion-demo'?'Notion':'飞书'}模拟 · {({completed:'已完成',failed:'失败',interrupted:'已中断',pending:'待执行'} as Record<string,string>)[j.status]||j.status} · {new Date(j.at).toLocaleString()} {j.status!=='completed'&&<button className="text-button" disabled={busy||!mockEnabled} onClick={()=>void runMockSync(j.destination,j.key)}>重试</button>}</p>)}</div></details>;
}
