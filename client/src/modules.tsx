import React, {useEffect,useState} from 'react';
import {Activity, Building2, CalendarClock, Columns3, LayoutDashboard, Sparkles, type LucideIcon} from 'lucide-react';
import type {Entity} from './definitions';

export type WorkspacePage = 'dashboard' | Entity | 'agent' | 'notion-demo';
type PageModule = { id: string; kind: 'page'; page: WorkspacePage; label: string; title: string; icon: LucideIcon | typeof NotionIcon; demo?: boolean };
type BackgroundModule = { id: string; kind: 'background'; label: string };
export type ModuleManifest = PageModule | BackgroundModule;

// Host-owned components only. A manifest cannot load or execute arbitrary code.
function NotionIcon({size=18}:{size?:number}) {return <span aria-hidden="true" className="notion-icon" style={{width:size,height:size,fontSize:size*.7}}>N</span>;}
export const workspaceModules: readonly ModuleManifest[] = [
  {id:'dashboard',kind:'page',page:'dashboard',label:'工作台',title:'业务工作台',icon:LayoutDashboard},
  {id:'companies',kind:'page',page:'companies',label:'客户管理',title:'客户管理',icon:Building2},
  {id:'leads',kind:'page',page:'leads',label:'销售线索',title:'销售线索',icon:Sparkles},
  {id:'opportunities',kind:'page',page:'opportunities',label:'商机管理',title:'商机管理',icon:Columns3},
  {id:'follow-up',kind:'page',page:'follow_up_tasks',label:'跟进任务',title:'跟进任务',icon:CalendarClock},
  {id:'activities',kind:'page',page:'activities',label:'沟通记录',title:'沟通记录',icon:Activity},
  {id:'agent',kind:'page',page:'agent',label:'Agent 中心',title:'Agent 中心',icon:Sparkles},
  {id:'notion-demo',kind:'page',page:'notion-demo',label:'Notion 演示',title:'Notion 演示',icon:NotionIcon,demo:true},
];
export function validateModules(modules: readonly ModuleManifest[]): void {
  const ids=new Set<string>(), pages=new Set<string>();
  for(const module of modules){
    if(!/^[a-z][a-z0-9-]{0,63}$/.test(module.id)||ids.has(module.id)) throw new Error('模块标识无效或重复');
    if(!module.label.trim()||module.label.length>40) throw new Error('模块名称无效');
    ids.add(module.id);
    if(module.kind==='page'){
      if(!module.page || pages.has(module.page) || typeof module.icon!=='function' && typeof module.icon!=='object') throw new Error('模块页面入口无效或重复');
      pages.add(module.page);
    }
  }
}
validateModules(workspaceModules);
export const pageModules = workspaceModules.filter((module): module is PageModule => module.kind === 'page');
export type CustomPage = {id:string;label:string;title:string;description:string;cards:{title:string;text:string}[];fields?:{id:string;label:string}[]};
export function CustomModulePage({module}:{module:CustomPage}){
 const [rows,setRows]=useState<any[]>([]),[values,setValues]=useState<Record<string,string>>({}),[error,setError]=useState(''),[busy,setBusy]=useState(false),[editing,setEditing]=useState<{id:string;version:number}|null>(null);
 const load=()=>window.crm.moduleRecords('list',module.id).then(setRows);
 useEffect(()=>{let active=true;setValues({});setRows([]);setEditing(null);if(module.fields?.length)window.crm.moduleRecords('list',module.id).then(r=>{if(active)setRows(r)}).catch(()=>{if(active)setError('无法读取本地记录。')});return()=>{active=false}},[module]);
 async function save(e:React.FormEvent){e.preventDefault();try{setBusy(true);setError('');const input=Object.fromEntries((module.fields||[]).map(f=>[f.id,values[f.id]||'']));if(editing)await window.crm.moduleRecords('update',module.id,{id:editing.id,version:editing.version,values:input});else await window.crm.moduleRecords('create',module.id,input);await load();setValues({});setEditing(null);}catch{setError('保存失败，记录可能已更改；草稿暂时保留，请刷新并重新选择编辑。');}finally{setBusy(false)}}
 async function remove(row:any){if(!window.confirm('确定删除这条本地记录吗？'))return;try{setBusy(true);setError('');await window.crm.moduleRecords('delete',module.id,{id:row.id,version:row.version||1});await load();if(editing?.id===row.id){setEditing(null);setValues({});}}catch{setError('删除失败，记录可能已更改，请刷新后重试。');}finally{setBusy(false)}}
 return <section className="notion-demo"><header className="notion-demo-head"><div><h2>{module.title}</h2><p>{module.description}</p></div></header><div className="notion-demo-grid">{module.cards.map((card,index)=><article key={index}><strong>{card.title}</strong><p style={{whiteSpace:'pre-wrap'}}>{card.text}</p></article>)}</div>{!!module.fields?.length&&<section className="table-card" style={{marginTop:24,padding:24}}><h3>本地记录</h3><p>记录加密保存在当前设备，当前账号可见。</p>{error&&<p role="alert">{error}</p>}<form onSubmit={save}>{module.fields.map(f=><label key={f.id}>{f.label}<input maxLength={1000} value={values[f.id]||''} onChange={e=>setValues(v=>({...v,[f.id]:e.target.value}))}/></label>)}<button className="button primary" disabled={busy}>{editing?'保存修改':'添加记录'}</button>{editing&&<button type="button" className="button secondary" onClick={()=>{setEditing(null);setValues({})}}>取消编辑</button>}</form><button type="button" className="text-button" onClick={()=>void load().catch(()=>setError('无法读取本地记录。'))}>刷新记录</button>{rows.map(row=><article className="evidence" key={row.id}>{module.fields!.map(f=><p key={f.id}><strong>{f.label}：</strong>{row.values[f.id]||'—'}</p>)}<div className="button-row"><button type="button" className="button secondary" disabled={busy} onClick={()=>{setEditing({id:row.id,version:row.version||1});setValues({...row.values})}}>编辑</button><button type="button" className="button secondary" disabled={busy} onClick={()=>void remove(row)}>删除</button></div></article>)}</section>}</section>;
}
export function NotionDemo(){return <section className="notion-demo"><header className="notion-demo-head"><div className="notion-demo-badge"><NotionIcon size={30}/></div><div><span className="notion-demo-label">演示模块</span><h2>Notion 工作空间</h2><p>在这里集中查看客户资料、会议笔记与团队文档。</p></div></header><div className="notion-demo-notice">当前内容为本地演示数据，尚未连接 Notion，也不会同步或修改任何资料。</div><div className="notion-demo-grid"><article><span>客户资料</span><strong>海外客户档案</strong><p>汇总客户背景、需求和关联文档。</p><small>示例页面 · 仅供展示</small></article><article><span>会议记录</span><strong>客户沟通笔记</strong><p>整理会议要点，记录下一步跟进事项。</p><small>示例页面 · 仅供展示</small></article><article><span>团队知识</span><strong>销售资料库</strong><p>集中管理产品介绍和常用业务资料。</p><small>示例页面 · 仅供展示</small></article></div></section>;}
