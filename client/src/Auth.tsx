import React, {useState} from 'react';
import { ArrowRight, Building2 } from 'lucide-react';
type Tenant = {id:string;name:string;role:string};
type Mode = 'login'|'register'|'verify'|'forgot'|'reset';
export function Login({onLogin}:{onLogin:(items:Tenant[])=>void}) {
  const [mode,setMode]=useState<Mode>('login'),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[name,setName]=useState(''),[tenantId,setTenantId]=useState(''),[code,setCode]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  function go(next:Mode){setMode(next);setError('');setNotice('');setPassword('');setCode('');}
  async function submit(e:React.FormEvent){
    e.preventDefault();if(busy)return;setBusy(true);setError('');setNotice('');
    try {
      if(mode==='login') {const r=await window.crm.login(email,password);setPassword('');if(!r.ok)throw new Error(r.error.message);onLogin(r.data.items);return;}
      const action=mode==='forgot'?'resetRequest':mode;
      const body=mode==='register'?{email,name,tenant_id:tenantId}:mode==='verify'?{code,password}:mode==='forgot'?{email}:{code,password};
      const r=await window.crm.authAction(action,body);setPassword('');setCode('');if(!r.ok)throw new Error(r.error.message);
      if(mode==='register'){setMode('verify');setNotice('如果注册申请可用，验证码将发送到邮箱。');}
      else if(mode==='verify'){setMode('login');setNotice('邮箱已验证。企业管理员审核通过后即可进入企业。');}
      else if(mode==='forgot'){setMode('reset');setNotice('如果账号存在，验证码将发送到邮箱。');}
      else {setMode('login');setNotice('密码已重置，请重新登录。');}
    } catch(e){setError(e instanceof Error?e.message:'请求失败，请检查网络。');} finally {setBusy(false);}
  }
  const titles:Record<Mode,string>={login:'登录工作台',register:'注册账号',verify:'验证邮箱并设置密码',forgot:'找回密码',reset:'重置密码'};
  return <div className="login-page"><div className="login-card"><div className="brand-mark large"><Building2 size={25}/></div><h1>{titles[mode]}</h1><p>{mode==='register'?'填写企业 ID 提交申请，邮箱验证后由管理员审核。':'使用你的 CRM 账号继续。'}</p><form onSubmit={submit}>
    {['login','register','forgot'].includes(mode)&&<label>邮箱<input type="email" required autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)}/></label>}
    {mode==='register'&&<><label>姓名<input required maxLength={255} value={name} onChange={e=>setName(e.target.value)}/></label><label>企业 ID<input required value={tenantId} onChange={e=>setTenantId(e.target.value)}/></label></>}
    {['verify','reset'].includes(mode)&&<label>邮箱验证码<input required autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value)}/></label>}
    {['login','verify','reset'].includes(mode)&&<label>{mode==='login'?'密码':'新密码（至少 12 个字符）'}<input type="password" required minLength={mode==='login'?1:12} autoComplete={mode==='login'?'current-password':'new-password'} value={password} onChange={e=>setPassword(e.target.value)}/></label>}
    {error&&<div className="notice warning">{error}</div>}{notice&&<div className="notice">{notice}</div>}
    <button className="button primary full" disabled={busy}>{busy?'处理中…':titles[mode]} <ArrowRight size={16}/></button></form>
    <div className="auth-links">{mode==='login'?<><button className="text-button" onClick={()=>go('register')}>注册账号</button><button className="text-button" onClick={()=>go('forgot')}>忘记密码</button><button className="text-button" onClick={()=>go('verify')}>已有注册验证码</button></>:<button className="text-button" onClick={()=>go('login')}>返回登录</button>}</div>
  </div><div className="login-art"><div className="art-card"><h2>把握每一个<br/>值得跟进的机会。</h2><p>客户、线索、商机和行动，在同一个工作空间中清晰连接。</p><div className="art-chart"><i/><i/><i/><i/><i/><i/></div></div></div></div>;
}
