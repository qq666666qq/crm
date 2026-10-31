import React, {useEffect,useState} from 'react';

export function SettingsPanel() {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [status,setStatus]=useState<any>(null),[base,setBase]=useState(''),[publicKey,setPublicKey]=useState(''),[secretKey,setSecretKey]=useState(''),[auto,setAuto]=useState(false),[notice,setNotice]=useState('');
  const load=()=>window.crm.langfuse('status').then((s:any)=>{setStatus(s);setBase(s.baseUrl||'');setAuto(!!s.autoUpload);}).catch(()=>{});
  useEffect(()=>{void load();return window.crm.on('langfuse-status',()=>{void window.crm.langfuse('status').then(setStatus).catch(()=>{});});},[]);
  async function save(e:React.FormEvent){e.preventDefault();try{setBusy(true);setError('');setNotice('');const r=await window.crm.langfuse('config',{baseUrl:base,publicKey,secretKey,autoUpload:auto});setStatus(r);setPublicKey('');setSecretKey('');setNotice(r.configured?'已保存 Langfuse 配置。':'请填写完整地址与密钥。');}catch{setError('Langfuse 配置保存失败。');}finally{setBusy(false);}}
  async function upload(){try{setBusy(true);setError('');setNotice('');const r=await window.crm.langfuse('upload');setNotice('已上传 '+r.uploaded+'/'+r.total+' 条，失败 '+r.failed+' 条'+(r.lastError==='LANGFUSE_PARTIAL_FAILURE'?'。服务端只接收了部分内容，请检查服务端记录；系统不会自动重复上传。':r.lastError==='LANGFUSE_PAYLOAD_TOO_LARGE'?'。记录超出服务端大小限制，请调整服务端设置。':r.lastError?'（'+r.lastError+'）':'。'));await load();}catch{setError('Langfuse 上传失败，请检查配置与网络。');}finally{setBusy(false);}}
  return <><div className="page-heading"><div><h1>系统设置</h1><p>管理界面偏好与外部观测服务。</p></div></div>
    <section className="table-card account-details"><h2>系统语言</h2><label>界面语言<select value="zh-CN" disabled><option value="zh-CN">简体中文</option></select></label></section>
    <section className="table-card"><div className="table-top"><div><h3>Langfuse 观测</h3><p>把完整对话、客户字段、工具调用、模型用量上传到 Langfuse，便于复盘</p></div><span className={'agent-state '+(status?.configured?'ready':'')}><i/>{status?.configured?'已配置':'未配置'}</span></div>
      {notice&&<p className="notice" role="status">{notice}</p>}{error&&<p className="notice warning">{error}</p>}{!error&&status?.lastError&&<p className="notice warning">{status.lastError==='TRACE_STORAGE_FAILED'?'有记录未能保存到本机，关闭应用前请先导出或上传。':status.lastError==='LANGFUSE_PARTIAL_FAILURE'?'服务端只接收了部分内容，请检查服务端记录；系统不会自动重复上传。':status.lastError==='LANGFUSE_PAYLOAD_TOO_LARGE'?'记录超出服务端大小限制，请调整服务端设置。':'上次自动上传未完成，记录仍待上传。'}</p>}
      <form className="account-details" onSubmit={save}>
        <label>服务地址<input value={base} onChange={e=>setBase(e.target.value)} placeholder="https://cloud.langfuse.com 或自建地址"/></label>
        <label>Public Key<input value={publicKey} onChange={e=>setPublicKey(e.target.value)} placeholder={status?.configured?'已保存，输入以替换':'pk-lf-...'}/></label>
        <label>Secret Key<input type="password" autoComplete="off" value={secretKey} onChange={e=>setSecretKey(e.target.value)} placeholder={status?.configured?'已保存，输入以替换':'sk-lf-...'}/></label>
        <label style={{display:'flex',gap:8,alignItems:'center'}}><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> 运行结束后自动上传</label>
        <div className="button-row"><button className="button primary" disabled={busy}>保存配置</button><button type="button" className="button secondary" disabled={busy||!status?.configured} onClick={()=>void upload()}>立即上传 {status?.pending??0} 条</button></div>
      </form>
      <p className="muted small">密钥仅在本次运行时使用，不上传模型密钥。持久会话的记录保存在本机，重新登录后可继续上传；临时会话的记录会在退出后清除。</p>
    </section>
  </>;
}
