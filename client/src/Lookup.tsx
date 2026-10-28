import React, {useEffect, useState} from 'react';
import { Entity, routes } from './definitions';
import { distinctItems, loadOnScroll, PageFooter, usePagedRecords } from './paging';

type Kind = 'company'|'lead'|'opportunity'|'task'|'contact';
const entities:Record<Kind,Entity> = {company:'companies',lead:'leads',opportunity:'opportunities',task:'follow_up_tasks',contact:'contacts'};
export function Lookup({tenant, kind, value, onChange, required=false, companyId, exclude=[], allowNew=false}:{tenant:string;kind:Kind;value:string;onChange:(id:string)=>void;required?:boolean;companyId?:string;exclude?:string[];allowNew?:boolean}) {
  const [search,setSearch] = useState('');
  const [term,setTerm] = useState('');
  useEffect(()=>{const timer=setTimeout(()=>setTerm(search.trim()),250);return()=>clearTimeout(timer)},[search]);
  const entity = entities[kind];
  const endpoint = kind === 'contact' ? `/companies/${companyId}/contacts` : routes[entity];
  const query = usePagedRecords(tenant,entity,'select',`q=${encodeURIComponent(term)}`,kind !== 'contact' || !!companyId,endpoint);
  const items=distinctItems(query.data?.pages).filter((item:any)=>!exclude.includes(item.id));
  const selected=items.some((item:any)=>item.id===value);
  return <div className="lookup">
    <input aria-label="搜索关联记录" placeholder="输入名称搜索" value={search} onChange={e=>setSearch(e.target.value)}/>
    <select required={required} value={value} onChange={e=>onChange(e.target.value)} aria-label="选择关联记录">
      <option value="">请选择</option>{allowNew&&<option value="new">新建公司</option>}
      {value && value!=='new' && !selected && <option value={value}>已选择的记录</option>}
      {items.map((item:any)=><option key={item.id} value={item.id}>{item.name || item.title}</option>)}
    </select>
    <div className="lookup-pages" onScroll={e=>loadOnScroll(e,query)}>{query.isLoading?<span className="muted small">正在加载…</span>:query.isError&&!query.data?<PageFooter query={query}/>:<><span className="muted small">已加载 {items.length} 条{term?'匹配记录':''}</span><PageFooter query={query}/></>}</div>
  </div>;
}
