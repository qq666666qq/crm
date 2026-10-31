import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import {AgentApprovalsPanel,type ApprovalItem} from './AgentApprovals';

describe('Agent approval details',()=>{
  it('shows the proposed manual evidence and makes its origin clear',()=>{
    const item:ApprovalItem={id:'a',type:'create_lead',status:'pending',digest:'digest',request:{path:'/api/v1/leads',body:{title:'样品咨询',company_name_raw:'示例公司',evidence:[{manual_note:'客户希望了解样品'}]}}};
    const html=renderToStaticMarkup(<AgentApprovalsPanel busy={false} approvalItems={[item]} approvalNotice="" decideApproval={vi.fn()}/>);
    expect(html).toContain('样品咨询');
    expect(html).toContain('示例公司');
    expect(html).toContain('客户希望了解样品');
    expect(html).toContain('不是客户原文');
    expect(html).toContain('确认执行');
    expect(html).toContain('拒绝');
  });
  it('shows uncertain submissions as retries and does not offer execution for failed items',()=>{
    const base={type:'create_company',digest:'digest',request:{path:'/api/v1/companies',body:{name:'示例公司'}}};
    const items:ApprovalItem[]=[{...base,id:'retry',status:'retry'},{...base,id:'failed',status:'failed',message:'权限不足'}];
    const html=renderToStaticMarkup(<AgentApprovalsPanel busy={true} approvalItems={items} approvalNotice="" decideApproval={vi.fn()}/>);
    expect(html).toContain('上次结果不确定');
    expect(html).toContain('权限不足');
    expect(html.match(/>重试<\/button>/g)).toHaveLength(1);
    expect(html).toContain('disabled=""');
  });
});
