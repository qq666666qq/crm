import React, {useEffect,useMemo,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {createApprovalController,type ApprovalAction,type ApprovalItem} from './approvalController';
export type {ApprovalItem} from './approvalController';

type SetBusy = (busy:boolean)=>void;
type SetError = (message:string)=>void;

export function useAgentApprovals(setBusy:SetBusy,setError:SetError) {
  const qc=useQueryClient();
  const [approvalItems,setApprovalItems]=useState<ApprovalItem[]>([]),[approvalNotice,setApprovalNotice]=useState('');
  const [controller]=useState(()=>createApprovalController({
    list:()=>window.crm.approvals('list'),
    decide:(action,id,digest)=>window.crm.approvals(action,id,digest),
    invalidate:()=>qc.invalidateQueries(),
    onItems:setApprovalItems,
    onNotice:setApprovalNotice,
    onError:setError,
    onBusy:setBusy,
  }));
  useEffect(()=>{
    controller.start();
    const off=window.crm.on('approval',()=>void controller.refresh());
    return()=>{off();controller.stop();};
  },[controller]);
  const approvalCounts=useMemo(()=>{
    const counts=new Map<string,number>();
    for(const item of approvalItems)if(item.runId)counts.set(item.runId,(counts.get(item.runId)||0)+1);
    return counts;
  },[approvalItems]);
  return {approvalItems,approvalNotice,approvalCounts,decideApproval:controller.decide};
}

export function AgentApprovalsPanel({busy,approvalItems,approvalNotice,decideApproval}:{busy:boolean;approvalItems:ApprovalItem[];approvalNotice:string;decideApproval:(id:string,action:ApprovalAction,digest:string)=>Promise<void>}) {
  return <details className="agent-control-card agent-collapsible"><summary className="agent-card-summary"><span className="agent-card-title">待确认操作</span><span className="agent-card-status">{approvalItems.filter(item=>['pending','retry','submitting'].includes(item.status)).length} 项待处理</span><span className="agent-card-chevron" aria-hidden="true">⌄</span></summary><div className="agent-card-content"><div className="agent-control-heading"><div><h3>待确认操作</h3><p>核对内容后才会执行</p></div></div>{approvalNotice&&<p role="status" className="agent-control-note">{approvalNotice}</p>}{approvalItems.filter(item=>['pending','retry','submitting','failed'].includes(item.status)).length===0?<p className="agent-control-note">暂无待确认操作</p>:approvalItems.filter(item=>['pending','retry','submitting','failed'].includes(item.status)).map(item=><article className="evidence" key={item.id}><strong>{{create_company:'创建客户公司',create_contact:'创建联系人',create_opportunity:'创建商机',create_task:'创建跟进任务',create_activity:'创建沟通记录',update_company:'修改客户公司',update_contact:'修改联系人',complete_task:'完成跟进任务',create_lead:'创建线索',convert_lead:'线索转商机',update_lead:'修改线索',update_opportunity:'修改商机'}[item.type as 'create_company'|'create_contact'|'create_opportunity'|'create_task'|'create_activity'|'update_company'|'update_contact'|'complete_task'|'create_lead'|'convert_lead'|'update_lead'|'update_opportunity']||'业务操作'}</strong>{['create_contact','create_opportunity','create_task','create_activity'].includes(item.type)?<>{item.type==='create_contact'&&<p>所属公司 ID：{item.request.path.split('/')[4]}</p>}{Object.entries(item.request.body).map(([key,value])=><p key={key}>{{company_id:'公司 ID',contact_id:'联系人 ID',lead_id:'线索 ID',opportunity_id:'商机 ID',follow_up_task_id:'任务 ID',activity_type:'沟通方式',direction:'联系方向',subject:'主题',summary:'摘要',outcome:'沟通结果',occurred_at:'发生时间',name:'名称',title:'标题',job_title:'职位',email:'邮箱',phone:'电话',whatsapp_id:'WhatsApp',product_summary:'意向产品',requirement_notes:'采购需求',description:'描述',due_at:'到期时间',priority:'优先级'}[key]||key}：{({priority:{low:'低',normal:'普通',high:'高'},activity_type:{email:'邮件',phone:'电话',whatsapp:'WhatsApp',meeting:'会议',note:'备注'},direction:{inbound:'客户主动联系',outbound:'销售主动联系'}} as Record<string,Record<string,string>>)[key]?.[String(value)]||String(value)}</p>)}</>:item.type==='create_company'?<>{Object.entries(item.request.body).map(([key,value])=><p key={key}>{{name:'公司名称',country:'国家',industry:'行业',website:'官网'}[key]||key}：{String(value)}</p>)}<small>请核对公司身份和可能的重复记录。</small></>:item.type==='create_lead'?<><p>标题：{item.request.body.title}</p>{item.request.body.company_name_raw&&<p>公司：{item.request.body.company_name_raw}</p>}{item.request.body.product_interest&&<p>意向产品：{item.request.body.product_interest}</p>}<p>人工核对依据：{item.request.body.evidence[0].manual_note}</p><small>此依据由 Agent 提出，请确认事实属实；它不是客户原文。</small></>:item.type==='convert_lead'?<><p>线索 ID：{item.request.path.split('/')[4]}</p><p>商机名称：{item.request.body.name}</p><p>公司 ID：{item.request.body.company_id}</p><p>线索版本：{item.request.body.expected_version}</p></>:<><p>记录 ID：{item.request.path.split('/')[4]}</p><p>当前版本：{item.request.body.expected_version}</p>{Object.entries(item.request.body).filter(([key])=>key!=='expected_version').map(([key,value])=><p key={key}>{{title:'标题',name:'名称',country:'国家',industry:'行业',business_summary:'业务简介',job_title:'职位',email:'邮箱',phone:'电话',whatsapp_id:'WhatsApp',note:'完成备注',product_interest:'意向产品',product_summary:'意向产品',requirement_notes:'采购需求'}[key]||key}：{String(value)}</p>)}</>}{item.status==='failed'&&<p>操作未完成：{item.message||'请检查权限或重新读取最新版本后重新申请。'}</p>}{['retry','submitting'].includes(item.status)&&<p>上次结果不确定，可使用同一操作安全重试。</p>}{item.status!=='failed'&&<div className="button-row"><button className="button primary" disabled={busy} onClick={()=>void decideApproval(item.id,'confirm',item.digest)}>{item.status==='pending'?'确认执行':'重试'}</button>{item.status==='pending'&&<button className="button secondary" disabled={busy} onClick={()=>void decideApproval(item.id,'reject',item.digest)}>拒绝</button>}</div>}</article>)}</div></details>;
}
