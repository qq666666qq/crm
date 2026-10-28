import React, { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, AlertTriangle } from 'lucide-react';
import { api, ApiError } from './api';
import { Entity, Field, fields, labels, routes, currencyCodes, currencyName } from './definitions';
import { threeWay } from './sync';
import { Lookup } from './Lookup';
import { editorRequest } from './actions';

type Props = { tenant: string; entity: Entity; initial?: Record<string, any>; companyId?: string; onClose: () => void; onSaved: () => void };
function valueFor(field: Field, record: Record<string, any>) {
  const value = record[field.key];
  if (field.type === 'datetime' && value) { const d = new Date(value); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16); }
  return value == null ? '' : String(value);
}

export function Editor({tenant, entity, initial, companyId, onClose, onSaved}: Props) {
  const qc = useQueryClient();
  const formFields = useMemo(() => fields[entity].filter(f => initial ? !f.createOnly : !f.editOnly), [entity, initial]);
  const baseFields = () => Object.fromEntries(formFields.map(f => [f.key, valueFor(f, initial || {})]));
  const [base, setBase] = useState(baseFields);
  const [draft, setDraft] = useState<Record<string,string>>(() => ({ ...baseFields(), ...(!initial && entity === 'leads' ? { source:'manual', intent_level:'unknown' } : {}), ...(!initial && entity === 'follow_up_tasks' ? {priority:'normal'} : {}), ...(!initial && entity === 'activities' ? {activity_type:'note'} : {}) }));
  const [baseVersion, setBaseVersion] = useState(initial?.version);
  const [remoteVersion, setRemoteVersion] = useState<number | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [remote, setRemote] = useState<Record<string,string>>({});
  const [choices, setChoices] = useState<Record<string,string>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [duplicates, setDuplicates] = useState<any[]>([]); const [confirmedName, setConfirmedName] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError('');
    if (remoteVersion !== null && conflicts.some(k => !choices[k])) { setError('请选择每个冲突字段使用哪个版本。'); return; }
    setBusy(true);
    const next = { ...draft };
    try {
      if (entity === 'companies' && !initial) {
        const fingerprint = `${next.name || ''}|${next.country || ''}`;
        if (confirmedName !== fingerprint) {
          const params = new URLSearchParams({name: next.name || ''}); if(next.country) params.set('country',next.country);
          const candidates = await api(`/companies/duplicates?${params}`);
          if (candidates.items.length) { setDuplicates(candidates.items); setError('发现同名客户，请先核对；如确认不是同一家，可继续创建。'); setBusy(false); return; }
        }
      }
      for (const key of conflicts) if (choices[key] === 'remote') next[key] = remote[key];
      const payload: Record<string, any> = {};
      for (const f of formFields) {
        if (initial && next[f.key] === base[f.key]) continue;
        const v = next[f.key] ?? '';
        if (f.key === 'manual_note') continue;
        if (f.type === 'datetime') payload[f.key] = v ? new Date(v).toISOString() : null;
        else payload[f.key] = v === '' ? null : v;
      }
      if (entity === 'leads' && !initial) payload.evidence = [{evidence_type:'manual',source_type:'manual',manual_note:next.manual_note}];
      if (initial) payload.expected_version = remoteVersion ?? baseVersion;
      const target = editorRequest(entity, initial, companyId);
      await api(target.path, target.method, payload);
      await qc.invalidateQueries({queryKey:[tenant]}); onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT' && initial) {
        try {
          const latest = await api(`${routes[entity]}/${initial.id}`);
          const remoteFields = Object.fromEntries(formFields.map(f=>[f.key,valueFor(f,latest)]));
          const result = threeWay(base, next, remoteFields);
          setDraft(result.merged as Record<string,string>); setBase(remoteFields); setRemote(remoteFields); setConflicts(result.conflicts); setChoices({}); setRemoteVersion(latest.version);
          setError(result.conflicts.length ? '其他人修改了部分字段，请选择保留的版本。草稿仍然保留。' : '其他人的修改已合并到草稿，请检查后再次保存。');
        } catch { setError('无法获取最新数据，请检查权限或网络。草稿仍然保留。'); }
      } else setError(err instanceof Error ? err.message : '保存失败');
    } finally { setBusy(false); }
  }
  return <div className="overlay" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-label={`${initial?'编辑':'新建'}${labels[entity]}`}>
    <header className="dialog-head"><div><h2>{initial?'编辑':'新建'}{labels[entity]}</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={20}/></button></header>
    <form onSubmit={submit}><div className="dialog-body">
      {error && <div className="notice warning"><AlertTriangle size={17}/><span>{error}</span></div>}
      {duplicates.length>0 && <div className="conflict"><strong>疑似重复客户</strong>{duplicates.map(c=><div key={c.id}>{c.name} · {c.country || '国家未填写'}</div>)}<button type="button" className="text-button" onClick={()=>{setConfirmedName(`${draft.name || ''}|${draft.country || ''}`);setDuplicates([]);setError('已确认，请再次点击保存。');}}>确认不是同一家，继续创建</button></div>}
      {conflicts.map(key=><div className="conflict" key={key}><strong>{formFields.find(f=>f.key===key)?.label || key}</strong><label><input type="radio" name={key} onChange={()=>setChoices({...choices,[key]:'local'})}/> 使用我的草稿：{draft[key] || '（空）'}</label><label><input type="radio" name={key} onChange={()=>setChoices({...choices,[key]:'remote'})}/> 使用服务器：{remote[key] || '（空）'}</label></div>)}
      <div className="form-grid">{formFields.map(f=><label key={f.key} className={f.type==='textarea'?'wide':''}><span>{f.label}{f.required?' *':''}</span>
        {f.type==='textarea' ? <textarea required={f.required} value={draft[f.key] || ''} onChange={e=>setDraft({...draft,[f.key]:e.target.value})}/> :
         f.type==='select' ? <select required={f.required} value={draft[f.key] || ''} onChange={e=>setDraft({...draft,[f.key]:e.target.value})}>{f.options?.map(([v,l])=><option value={v} key={v}>{l}</option>)}</select> :
         f.type==='currency' ? <select value={draft[f.key] || ''} onChange={e=>setDraft({...draft,[f.key]:e.target.value})}><option value="">请选择币种</option>{draft[f.key]&&!currencyCodes.includes(draft[f.key])&&<option value={draft[f.key]}>{currencyName(draft[f.key])}</option>}{currencyCodes.map(code=><option key={code} value={code}>{currencyName(code)}</option>)}</select> :
         ['company','lead','opportunity','task'].includes(f.type || '') ? <Lookup tenant={tenant} kind={f.type as 'company'|'lead'|'opportunity'|'task'} required={f.required} value={draft[f.key] || ''} onChange={v=>setDraft({...draft,[f.key]:v})}/> :
         <input required={f.required} type={f.type==='datetime'?'datetime-local':f.type==='number'?'number':'text'} step={f.type==='number'?'any':undefined} value={draft[f.key] || ''} onChange={e=>setDraft({...draft,[f.key]:e.target.value})}/>}
      </label>)}</div>

    </div><footer className="dialog-foot"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={busy}>{busy?'保存中…':'保存'}</button></footer></form>
  </section></div>;
}
