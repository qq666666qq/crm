import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowRight, Bell, Building2, CalendarClock, CheckCircle2, ChevronDown, CircleHelp, ClipboardList, Columns3, Globe2, LayoutDashboard, List, LogOut, Plus, Search, Settings, ShieldCheck, Sparkles, Users, X } from 'lucide-react';
import { api, queryKey } from './api';
import { Entity, labels, routes, stages, show, currencyName } from './definitions';
import { mergeEvent, SyncEvent } from './sync';
import { Editor } from './Editor';
import { stageRequest } from './actions';
import { clearWorkspaceCache } from './workspace';
import { Login } from './Auth';
import { Drawer } from './Drawer';
import { TaskWorkspace } from './TaskWorkspace';
import { AgentWorkspace } from './AgentWorkspace';
import { SettingsPanel } from './SettingsPanel';
import { MemberApprovals, Members } from './MemberManagement';
import { Account, JoinForm } from './Account';
import { Empty } from './PageEmpty';
import type { Tenant, User } from './sessionTypes';
import { distinctItems, loadOnScroll, PageFooter, usePagedRecords } from './paging';
import { pageModules, NotionDemo, CustomModulePage, type CustomPage, type WorkspacePage } from './modules';

type Page = WorkspacePage|'settings'|'members'|'account'|'approvals';
const pageTitles: Record<string,string> = {...Object.fromEntries(pageModules.map(module=>[module.page,module.title])),settings:'系统设置',members:'人员管理',account:'账号设置',approvals:'成员审批'};
const value = (record:any) => record?.name || record?.title || record?.subject || record?.summary || '未命名';
const date = (v:any) => v ? new Date(v).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';

function Status({text}:{text:any}) {return <span className={'status status-'+String(text)}><i/>{show(text)}</span>;}
function RecordCard({tenant,record,entity,onOpen}:{tenant:string;record:any;entity:Entity;onOpen:()=>void}) {const company=useQuery({queryKey:queryKey(tenant,'companies','detail',record.company_id),queryFn:()=>api('/companies/'+record.company_id),enabled:!!record.company_id});return <button className="record-card" onClick={onOpen}><div className="card-top"><span className="card-kicker">{entity==='leads'?'销售线索':entity==='opportunities'?'销售商机':'跟进任务'}</span>{record.priority && <Status text={record.priority}/>}</div><strong>{value(record)}</strong><p>{company.data?.name || record.company_name_raw || '客户待确认'} · {record.product_interest || record.product_summary || record.description || '暂无补充说明'}</p>{record.expected_amount!=null&&<small>{record.currency ? currencyName(record.currency) : ''} {record.expected_amount}</small>}{record.owner_name&&<small>负责人：{record.owner_name}</small>}<div className="card-foot"><span>{record.stage || record.status ? <Status text={record.stage || record.status}/> : '待评估'}</span><span>{date(record.due_at || record.updated_at)}</span></div></button>;}

function DashboardColumn({tenant, entity, title, sub, params, icon:Icon, open, setPage}:{tenant:string;entity:Entity;title:string;sub:string;params:string;icon:any;open:(e:Entity,r:any)=>void;setPage:(p:Page)=>void}) {
  const query=usePagedRecords(tenant,entity,'board',params);
  const items=distinctItems(query.data?.pages);
  return <section className="work-column"><header><div className="column-icon"><Icon size={18}/></div><div><h3>{title}</h3><p>{sub}</p></div><button className="text-button" onClick={()=>setPage(entity)}>查看全部 <ArrowRight size={14}/></button></header>
    <div className="column-cards scroll-column" onScroll={e=>loadOnScroll(e,query)}>{query.isLoading?<Empty text="正在加载…"/>:query.isError&&!query.data?<Empty text="加载失败"/>:items.length?items.map((r:any)=><RecordCard tenant={tenant} key={r.id} record={r} entity={entity} onOpen={()=>open(entity,r)}/>):<Empty text="暂时没有需要处理的记录"/>}<PageFooter query={query}/></div></section>;
}
function Dashboard({tenant,open,setPage}:{tenant:string;open:(e:Entity,r:any)=>void;setPage:(p:Page)=>void}) {
  const cols = [
    {title:'待转化线索',sub:'发现值得跟进的需求',entity:'leads' as Entity,params:'states=new,working,qualified',icon:Sparkles},
    {title:'推进中商机',sub:'关注正在进行的交易',entity:'opportunities' as Entity,params:'states=discovery,quoting,negotiating',icon:Columns3},
    {title:'优先跟进',sub:'把重要的事情安排好',entity:'follow_up_tasks' as Entity,params:'status=pending&sort=due',icon:CalendarClock}
  ];
  return <div className="dashboard-columns">{cols.map(c=><DashboardColumn key={c.entity} tenant={tenant} {...c} open={open} setPage={setPage}/>)}</div>;
}

function BoardColumn({tenant,stage,label,open,onMove}:{tenant:string;stage:string;label:string;open:(e:Entity,r:any)=>void;onMove:(r:any,stage:string)=>void}) {
  const query=usePagedRecords(tenant,'opportunities','board',`stage=${encodeURIComponent(stage)}`);
  const items=distinctItems(query.data?.pages);
  return <section className="kanban-column" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();try{const record=JSON.parse(e.dataTransfer.getData('application/json'));if(record.stage!==stage)onMove(record,stage);}catch{}}}>
    <header><span className={'stage-dot dot-'+stage}/><strong>{label}</strong><span>已加载 {items.length}</span></header>
    <div className="scroll-column" onScroll={e=>loadOnScroll(e,query)}>{query.isLoading?<Empty text="正在加载…"/>:query.isError&&!query.data?<Empty text="加载失败"/>:items.length?items.map((r:any)=><div key={r.id} draggable onDragStart={e=>e.dataTransfer.setData('application/json',JSON.stringify(r))}><RecordCard tenant={tenant} record={r} entity="opportunities" onOpen={()=>open('opportunities',r)}/></div>):<Empty text="暂无商机"/>}<PageFooter query={query}/></div>
  </section>;
}

function BrowserPage({tenant,user,entity,open,onNew,initialSearch=''}:{tenant:string;user:User;entity:Entity;open:(e:Entity,r:any)=>void;onNew:()=>void;initialSearch?:string}) {
  const [offset,setOffset]=useState(0),[filter,setFilter]=useState(''),[search,setSearch]=useState(initialSearch),[view,setView]=useState<'list'|'board'>(entity==='opportunities'?'board':'list'),[taskView,setTaskView]=useState('all'),[country,setCountry]=useState(''),[industry,setIndustry]=useState('');
  const [stageMove,setStageMove]=useState<{record:any;stage:string}|null>(null),[note,setNote]=useState(''),[error,setError]=useState(''),[moving,setMoving]=useState(false); const qc=useQueryClient();
  function ownerName(record:any){return record.owner_name || (record.owner_id===user.user_id?user.name:(record.owner_id?'其他负责人':'—'));}
  const param = `offset=${offset}`+(filter?`&${entity==='opportunities'?'stage':'status'}=${encodeURIComponent(filter)}`:'')+(entity==='companies' && search?`&q=${encodeURIComponent(search)}`:'')+(entity==='companies' && country?`&country=${encodeURIComponent(country)}`:'')+(entity==='companies' && industry?`&industry=${encodeURIComponent(industry)}`:'');
  const range=useMemo(()=>{const start=new Date();start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);end.setMilliseconds(-1);const now=new Date();return {start,end,now,soon:new Date(now.getTime()+7*86400000)};},[taskView]);
  let listPath=`${routes[entity]}?limit=20&${param}`;
  if(entity==='follow_up_tasks' && taskView==='today') listPath=`/follow-up-tasks/due?limit=20&offset=${offset}&from_at=${encodeURIComponent(range.start.toISOString())}&until=${encodeURIComponent(range.end.toISOString())}`;
  if(entity==='follow_up_tasks' && taskView==='overdue') listPath=`/follow-up-tasks/overdue?limit=20&offset=${offset}`;
  if(entity==='follow_up_tasks' && taskView==='upcoming') listPath=`/follow-up-tasks/due?limit=20&offset=${offset}&from_at=${encodeURIComponent(range.now.toISOString())}&until=${encodeURIComponent(range.soon.toISOString())}`;
  if(entity==='follow_up_tasks' && taskView==='completed') listPath=`/follow-up-tasks?limit=20&offset=${offset}&status=completed`;
  const list=useQuery({queryKey:queryKey(tenant,entity,'list',listPath),queryFn:()=>api(listPath)});
  async function move() { if (!stageMove || moving) return; setMoving(true); setError(''); const {record,stage}=stageMove; try {const {path,body}=stageRequest(record,stage,note); await api(path,'POST',body); await qc.invalidateQueries({queryKey:[tenant,'opportunities']}); setStageMove(null);setNote('');} catch(e){setError(e instanceof Error?e.message:'更新失败');await qc.invalidateQueries({queryKey:[tenant,'opportunities']});} finally {setMoving(false);} }
  return <><div className="page-heading"><div><h1>{pageTitles[entity]}</h1><p>{entity==='companies'?'管理客户信息与长期合作关系':entity==='leads'?'记录客户需求，发现新的业务机会':entity==='opportunities'?'追踪每一笔交易的销售进展':entity==='follow_up_tasks'?'为下一次联系做好准备':'记录已经发生的客户沟通'}</p></div><button className="button primary" onClick={onNew}><Plus size={17}/> 新建{labels[entity]}</button></div>
    <div className="toolbar"><div className="toolbar-left">{entity==='companies' && <label className="search-box"><Search size={16}/><input placeholder="搜索公司名称" value={search} onChange={e=>{setOffset(0);setSearch(e.target.value)}}/></label>}{entity==='companies' && <><input aria-label="筛选国家" placeholder="国家" value={country} onChange={e=>{setOffset(0);setCountry(e.target.value)}}/><input aria-label="筛选行业" placeholder="行业" value={industry} onChange={e=>{setOffset(0);setIndustry(e.target.value)}}/></>}{['leads','opportunities'].includes(entity) && <select aria-label="筛选状态" value={filter} onChange={e=>{setOffset(0);setFilter(e.target.value)}}><option value="">全部状态</option>{(entity==='opportunities'?stages:[['new','新线索'],['working','跟进中'],['qualified','已确认'],['converted','已转化'],['disqualified','无效']]).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>}{entity==='follow_up_tasks'&&<div className="segmented">{[['all','全部'],['today','今日'],['overdue','已逾期'],['upcoming','即将到期'],['completed','已完成']].map(([v,l])=><button key={v} className={taskView===v?'active':''} onClick={()=>{setTaskView(v);setOffset(0)}}>{l}</button>)}</div>}</div>{entity==='opportunities' && <div className="segmented"><button className={view==='list'?'active':''} onClick={()=>setView('list')}><List size={15}/> 列表</button><button className={view==='board'?'active':''} onClick={()=>setView('board')}><Columns3 size={15}/> 看板</button></div>}</div>
    {entity==='opportunities' && view==='board'? <div className="kanban">{stages.map(([key,label])=><BoardColumn key={key} tenant={tenant} stage={key} label={label} open={open} onMove={(record,stage)=>{setStageMove({record,stage});setError('');}}/>)}</div> : <div className="table-card"><div className="table-top"><div><h3>{labels[entity]}列表</h3><p>点击记录查看详情</p></div><span className="muted small">每页 20 条</span></div>{list.isLoading?<Empty text="正在加载…"/>:list.isError?<Empty text="加载失败，请检查网络或权限"/>:!list.data?.items?.length?<Empty/>:<div className="table-wrap"><table><thead><tr><th>名称 / 主题</th><th>{entity==='companies'?'国家':'状态 / 类型'}</th><th>{entity==='companies'?'行业':'关联信息'}</th>{entity==='companies'&&<><th>公司类型</th><th>合作状态</th><th>负责人</th></>}<th>最近更新</th><th/></tr></thead><tbody>{list.data.items.map((r:any)=><tr key={r.id} onClick={()=>open(entity,r)} tabIndex={0} onKeyDown={e=>e.key==='Enter'&&open(entity,r)}><td><strong>{value(r)}</strong><small>{show(r.website || r.source || r.product_summary || r.description)}</small></td><td><Status text={r.stage || r.status || r.activity_type || r.country}/></td><td>{show(r.industry || r.product_interest || r.priority || r.outcome)}</td>{entity==='companies'&&<><td>{show(r.company_type)}</td><td>{show(r.relationship_status)}</td><td>{ownerName(r)}</td></>}<td>{date(r.updated_at || r.occurred_at || r.created_at)}</td><td><ArrowRight size={16}/></td></tr>)}</tbody></table></div>}<div className="pagination"><button disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-20))}>上一页</button><span>第 {Math.floor(offset/20)+1} 页</span><button disabled={(list.data?.items?.length||0)<20} onClick={()=>setOffset(offset+20)}>下一页</button></div></div>}
    {stageMove && <div className="overlay"><div className="dialog compact" role="dialog" aria-modal="true"><header className="dialog-head"><div><span className="eyebrow">更新销售阶段</span><h2>移动到{show(stageMove.stage)}</h2></div><button className="icon-button" aria-label="关闭" onClick={()=>setStageMove(null)}><X size={20}/></button></header><div className="dialog-body"><p>商机：<strong>{value(stageMove.record)}</strong></p>{['won','lost'].includes(stageMove.stage)&&<label>{stageMove.stage==='lost'?'丢单原因（必填）':'成交备注'}<textarea value={note} onChange={e=>setNote(e.target.value)}/></label>}{error&&<div className="notice warning">{error}</div>}</div><footer className="dialog-foot"><button className="button secondary" onClick={()=>setStageMove(null)}>取消</button><button className="button primary" disabled={moving||(stageMove.stage==='lost'&&!note.trim())} onClick={move}>确认更新</button></footer></div></div>}
  </>;
}

function Workspace({tenant,user,tenants,onSwitch,onLogout,connection,onTenantsRefresh}:{tenant:Tenant;user:User;tenants:Tenant[];onSwitch:(id:string)=>void;onLogout:()=>void;connection:string;onTenantsRefresh:()=>void}) {
  const [page,setPage]=useState<Page>('dashboard'),[drawer,setDrawer]=useState<{entity:Entity;id:string}|null>(null),[editor,setEditor]=useState<Entity|null>(null),[search,setSearch]=useState(''),[activeSearch,setActiveSearch]=useState(''),[alerts,setAlerts]=useState(false),[taskAll,setTaskAll]=useState(false);
  const [customModules,setCustomModules]=useState<CustomPage[]>([]),[customPage,setCustomPage]=useState(''),[moduleError,setModuleError]=useState('');
  const loadModules=()=>window.crm.modules('list').then(setCustomModules).catch(()=>setModuleError('模块列表加载失败'));
  useEffect(()=>{void loadModules();},[tenant.id,user.user_id]);
  const [seen,setSeen]=useState<Set<string>>(()=>new Set());
  const reminders=useQuery({queryKey:queryKey(tenant.id,'follow_up_tasks','reminders'),queryFn:()=>api('/follow-up-tasks/reminders?limit=20'),refetchInterval:60000});
  useEffect(()=>{const items=reminders.data?.items||[];const next=new Set(seen);for(const item of items) if(!next.has(item.id)){next.add(item.id);window.crm.notify('跟进提醒',item.title).catch(()=>{});} if(next.size!==seen.size)setSeen(next);},[reminders.data]);
  function open(entity:Entity,record:any){setDrawer({entity,id:record.id});}
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><Globe2 size={20}/></div><div><strong>外贸 CRM</strong></div></div><div className="side-label">工作空间</div><nav className="side-nav">{pageModules.map(({id,page:modulePage,label,icon:Icon})=><button key={id} className={!customPage&&page===modulePage?'selected':''} onClick={()=>{setCustomPage('');setPage(modulePage);setDrawer(null);setActiveSearch('');if(modulePage==='follow_up_tasks')setTaskAll(false)}}><Icon size={18}/><span>{label}</span>{!customPage&&page===modulePage&&<i/>}</button>)}{customModules.map(module=><button key={module.id} className={customPage===module.id?'selected':''} onClick={()=>{setCustomPage(module.id);setDrawer(null)}}><ClipboardList size={18}/><span>{module.label}</span>{customPage===module.id&&<i/>}</button>)}</nav><div className="side-bottom">{user.permissions?.manage_approvals&&<button className={page==='approvals'?'selected':''} onClick={()=>{setCustomPage('');setPage('approvals');setDrawer(null)}}><CheckCircle2 size={18}/> 成员审批</button>}{user.permissions?.manage_members&&<button className={page==='members'?'selected':''} onClick={()=>{setCustomPage('');setPage('members');setDrawer(null)}}><Users size={18}/> 人员管理</button>}<button className={page==='settings'?'selected':''} onClick={()=>{setCustomPage('');setPage('settings');setDrawer(null)}}><Settings size={18}/> 系统设置</button><div className="side-help"><CircleHelp size={16}/><span>保持联系，持续推进</span></div></div></aside>
    <div className="main-shell"><header className="topbar"><div className="top-path">工作空间 <span>/</span> <strong>{customModules.find(m=>m.id===customPage)?.label||pageTitles[page]}</strong></div><form className="global-search" onSubmit={e=>{e.preventDefault();setActiveSearch(search);setCustomPage('');setPage('companies')}}><Search size={17}/><input placeholder="搜索客户公司" value={search} onChange={e=>setSearch(e.target.value)}/><kbd>↵</kbd></form><div className="top-actions"><span className={'connection '+(connection==='connected'?'online':'')}><i/>{connection==='connected'?'已连接':'连接中'}</span><div className="alert-wrap"><button className="icon-button" aria-label="跟进提醒" onClick={()=>setAlerts(!alerts)}><Bell size={19}/>{!!reminders.data?.items?.length&&<b/>}</button>{alerts&&<div className="alert-menu"><strong>跟进提醒</strong>{reminders.data?.items?.length?reminders.data.items.map((t:any)=><button key={t.id} onClick={()=>{open('follow_up_tasks',t);setAlerts(false)}}>{t.title}<small>{date(t.due_at)}</small></button>):<p>暂无到期提醒</p>}</div>}</div><div className="top-divider"/><div className="user-avatar">{user.name.slice(0,1)}</div><button className="user-info account-link" aria-label="账号设置" onClick={()=>{setCustomPage('');setPage('account');setDrawer(null)}}><strong>{user.name}</strong><span>{{admin:'管理员',manager:'经理',sales:'销售员'}[user.role as 'admin'|'manager'|'sales']}</span></button><button className="icon-button" aria-label="退出登录" title="退出登录" onClick={onLogout}><LogOut size={17}/></button></div></header>
    <main className={"content"+(!customPage&&page==='agent'?' agent-page':'')}>{moduleError&&<div className="notice warning">{moduleError}</div>}{customPage&&customModules.find(m=>m.id===customPage)?<CustomModulePage module={customModules.find(m=>m.id===customPage)!}/>:page==='notion-demo'?<NotionDemo/>:page==='agent'?<AgentWorkspace onInstalled={()=>void loadModules()}/>:page==='dashboard'?<Dashboard tenant={tenant.id} open={open} setPage={setPage}/>:page==='members'&&user.permissions?.manage_members?<Members tenant={tenant.id} user={user}/>:page==='settings'?<SettingsPanel/>:page==='approvals'?<MemberApprovals tenant={tenant.id} user={user}/>:page==='account'?<Account user={user} tenant={tenant} onLogout={onLogout} onTenantsRefresh={onTenantsRefresh}/>:page==='follow_up_tasks'&&!taskAll?<TaskWorkspace tenant={tenant.id} open={r=>open('follow_up_tasks',r)} onNew={()=>setEditor('follow_up_tasks')} onAll={()=>setTaskAll(true)}/>:<>{page==='follow_up_tasks'&&<button className="text-button" onClick={()=>setTaskAll(false)}>← 返回任务日历</button>}<BrowserPage key={`${page}-${activeSearch}`} tenant={tenant.id} user={user} entity={page as Entity} open={open} onNew={()=>setEditor(page as Entity)} initialSearch={activeSearch}/></>}</main><footer className="app-footer"><span></span><span>数据由服务端实时校验</span></footer></div>
    {drawer&&<Drawer key={`${drawer.entity}-${drawer.id}`} tenant={tenant.id} entity={drawer.entity} id={drawer.id} onClose={()=>setDrawer(null)} onOpen={open}/>} {editor&&<Editor tenant={tenant.id} entity={editor} onClose={()=>setEditor(null)} onSaved={()=>setEditor(null)}/>}
  </div>;
}

export function App(){
  const qc=useQueryClient();const [tenants,setTenants]=useState<Tenant[]>([]),[tenant,setTenant]=useState<Tenant|null>(null),[user,setUser]=useState<User|null>(null),[error,setError]=useState(''),[connection,setConnection]=useState('connecting'),[epoch,setEpoch]=useState(0),[checking,setChecking]=useState(false),[signedIn,setSignedIn]=useState(false);
  const [restoring,setRestoring]=useState(true);const restoreRequest=useRef<Promise<Result>|null>(null);
  useEffect(()=>{let active=true;restoreRequest.current ||= window.crm.restoreSession();restoreRequest.current.then(result=>{if(!active)return;if(result.ok){const items:Tenant[]=result.data.tenants;const selected=items.find(item=>item.id===result.data.tenant_id);if(selected){setTenants(items);setSignedIn(true);setTenant(selected);setUser(result.data.user);}}else if(result.status===503)setError(result.error.message);}).catch(()=>{if(active)setError('无法恢复登录，请检查网络后重新登录。');}).finally(()=>{if(active)setRestoring(false);});return()=>{active=false;};},[]);
  async function select(id:string,items=tenants){
    setChecking(true);setError('');await clearWorkspaceCache(qc);setEpoch(x=>x+1);setTenant(null);setUser(null);
    try {const result=await window.crm.selectTenant(id);if(!result.ok)throw new Error(result.error.message);const t=items.find(x=>x.id===id);if(!t)throw new Error('企业不可用');setTenant(t);setUser(result.data);}catch(e){setError(e instanceof Error?e.message:'无法切换企业');}finally{setChecking(false);}
  }
  async function logout(){try{await window.crm.logout();}catch{}await clearWorkspaceCache(qc);setTenants([]);setSignedIn(false);setTenant(null);setUser(null);setEpoch(x=>x+1);}
  useEffect(()=>{
    const reset=async()=>{await clearWorkspaceCache(qc);setEpoch(x=>x+1);try{const result=await window.crm.refresh();if(result.ok)setUser(result.data);else {setTenant(null);setUser(null);setTenants([]);setError('登录或企业权限已失效，请重新登录。');}}catch{setError('无法验证当前权限，请检查网络。');setTenant(null);setUser(null);}};
    const off1=window.crm.on('sync', data=>{
      if (!tenant) return;
      if(data.reset || data.events?.some((e:SyncEvent)=>e.action==='reset')){void reset();return;}
      for(const event of data.events || []){
        if(event.action==='resync'){qc.invalidateQueries({queryKey:[tenant.id]});continue;}
        if(!event.entity||!event.entity_id) {void reset();return;}
        const key=queryKey(tenant.id,event.entity,'detail',event.entity_id);
        const current=qc.getQueryData<Record<string,any>>(key);
        const merged=mergeEvent(current,event);
        if(merged.status==='merged') qc.setQueryData(key,merged.value);
        else if(merged.status==='refetch') qc.invalidateQueries({queryKey:key});
        qc.invalidateQueries({queryKey:[tenant.id,event.entity,'list']});
        qc.invalidateQueries({queryKey:[tenant.id,event.entity,'board']});
        qc.invalidateQueries({queryKey:[tenant.id,event.entity,'related']});
        qc.invalidateQueries({queryKey:[tenant.id,event.entity,'select']});
        if(event.entity==='follow_up_tasks')qc.invalidateQueries({queryKey:[tenant.id,'follow_up_tasks','reminders']});
      }
    });
    const off2=window.crm.on('revoked',()=>{qc.clear();setTenants([]);setSignedIn(false);setTenant(null);setUser(null);setEpoch(x=>x+1);setError('登录或企业权限已失效，请重新登录。');});
    const off3=window.crm.on('connection',state=>setConnection(state));
    const off4=window.crm.on('permission',()=>{if(tenant)void reset();});
    return ()=>{off1();off2();off3();off4();};
  },[tenant?.id,qc]);
  if(restoring)return <div className="login-page"><div className="login-card">正在验证登录状态…</div></div>;
  if(tenant&&user&&!checking)return <Workspace key={`${tenant.id}-${epoch}`} tenant={tenant} user={user} tenants={tenants} onSwitch={id=>void select(id)} onLogout={()=>void logout()} connection={connection} onTenantsRefresh={()=>void window.crm.tenants().then(r=>{if(r.ok)setTenants(r.data.items);else setError(r.error.message);})}/>;
  if(signedIn) return <div className="login-page chooser"><div className="login-card"><div className="brand-mark large"><Globe2 size={24}/></div><div className="eyebrow">选择工作空间</div><h1>欢迎回来</h1><p>选择一个企业，进入对应的 CRM 工作台。</p>{error&&<div className="notice warning">{error}</div>}<div className="tenant-list">{tenants.map(t=><button key={t.id} disabled={checking} onClick={()=>void select(t.id)}><span className="tenant-avatar">{t.name.slice(0,1)}</span><strong>{t.name}</strong><ArrowRight size={16}/></button>)}</div><JoinForm onRefresh={()=>void window.crm.tenants().then(r=>{if(r.ok)setTenants(r.data.items);else setError(r.error.message);})}/><button className="text-button" onClick={()=>void logout()}>返回登录</button></div></div>;
  return <><Login onLogin={items=>{setError('');setSignedIn(true);setTenants(items);if(items.length===1)void select(items[0].id,items);}}/>{error&&<div className="floating-error">{error}</div>}</>;
}
