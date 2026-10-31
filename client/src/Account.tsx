import React, {useState} from 'react';
import type {Tenant,User} from './sessionTypes';

export function Account({user,tenant,onLogout,onTenantsRefresh}:{user:User;tenant:Tenant;onLogout:()=>void;onTenantsRefresh:()=>void}) {
  const [current,setCurrent]=useState(''),[next,setNext]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function change(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{const r=await window.crm.authAction('change',{current_password:current,new_password:next});setCurrent('');setNext('');if(!r.ok)throw new Error(r.error.message);onLogout();}catch(e){setError(e instanceof Error?e.message:'修改失败');}finally{setBusy(false);}}
  return <><div className="page-heading"><div><h1>账号设置</h1><p>查看当前账号与企业身份。</p></div></div><div className="table-card"><div className="account-details"><div><span>姓名</span><strong>{user.name}</strong></div><div><span>邮箱</span><strong>{user.email}</strong></div><div><span>当前企业</span><strong>{tenant.name}</strong></div><div><span>企业 ID</span><strong>{tenant.id}</strong></div><div><span>企业角色</span><strong>{{admin:'管理员',manager:'经理',sales:'销售员'}[user.role as 'admin'|'manager'|'sales'] || user.role}</strong></div></div><form className="account-details" onSubmit={change}><label>当前密码<input type="password" required value={current} onChange={e=>setCurrent(e.target.value)}/></label><label>新密码（至少 12 位）<input type="password" required minLength={12} value={next} onChange={e=>setNext(e.target.value)}/></label>{error&&<p className="notice warning">{error}</p>}<button className="button primary" disabled={busy}>修改密码</button></form><div className="account-actions"><JoinForm onRefresh={onTenantsRefresh}/></div><div className="account-actions"><p className="muted small">修改密码后需要重新登录。</p><button className="button secondary" onClick={onLogout}>退出登录</button></div></div></>;
}

export function JoinForm({onRefresh}:{onRefresh:()=>void}) {
  const [id,setId]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);try{const r=await window.crm.authAction('join',{tenant_id:id});setNotice(r.ok?'申请已提交，请等待管理员审核。':r.error.message);}catch{setNotice('申请失败，请检查网络。');}finally{setBusy(false);}}
  return <><p>请等待管理员审核，或使用企业 ID 申请加入其他企业。</p><form onSubmit={submit}><label>企业 ID<input required value={id} onChange={e=>setId(e.target.value)}/></label><button className="button secondary" disabled={busy}>提交加入申请</button></form>{notice&&<div className="notice">{notice}</div>}<button className="text-button" onClick={onRefresh}>刷新企业列表</button></>;
}
