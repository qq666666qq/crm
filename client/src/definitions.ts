export type Entity = 'companies'|'contacts'|'leads'|'opportunities'|'follow_up_tasks'|'activities';
export type Field = { key: string; label: string; type?: 'textarea'|'select'|'currency'|'datetime'|'number'|'company'|'lead'|'opportunity'|'task'; required?: boolean; options?: [string,string][]; createOnly?: boolean; editOnly?: boolean };
const currencyNames = new Intl.DisplayNames(['zh-CN'], {type:'currency'});
export const currencyName = (code:string) => currencyNames.of(code) || code;
export const currencyCodes = Intl.supportedValuesOf('currency');
export const labels: Record<Entity, string> = { companies:'客户', contacts:'联系人', leads:'线索', opportunities:'商机', follow_up_tasks:'跟进任务', activities:'沟通记录' };
export const routes: Record<Entity, string> = { companies:'/companies', contacts:'/contacts', leads:'/leads', opportunities:'/opportunities', follow_up_tasks:'/follow-up-tasks', activities:'/activities' };
export const stages: [string,string][] = [['discovery','需求确认'],['quoting','报价中'],['negotiating','商务谈判'],['won','已成交'],['lost','已丢单']];
export const fields: Record<Entity, Field[]> = {
  companies: [
    {key:'name',label:'公司名称',required:true},{key:'country',label:'国家'},{key:'industry',label:'行业'},
    {key:'company_type',label:'公司类型'},{key:'company_size',label:'公司规模'},{key:'website',label:'官网地址'},
    {key:'relationship_status',label:'合作状态'},{key:'source',label:'客户来源'},
    {key:'business_summary',label:'业务简介',type:'textarea'},{key:'summary_source',label:'简介来源链接'}
  ],
  contacts:[{key:'name',label:'姓名',required:true},{key:'job_title',label:'职位'},{key:'email',label:'邮箱'},{key:'phone',label:'电话（国际格式）'},{key:'whatsapp_id',label:'WhatsApp'},{key:'preferred_language',label:'首选语言'},{key:'contact_status',label:'联系人状态'}],
  leads:[{key:'title',label:'线索标题',required:true},{key:'company_id',label:'关联公司',type:'company'},{key:'company_name_raw',label:'来源公司名称'},{key:'source',label:'来源渠道',type:'select',required:true,options:[['manual','人工录入'],['email','邮件'],['whatsapp','WhatsApp'],['website','网站'],['other','其他']]},{key:'product_interest',label:'意向产品'},{key:'requirement_notes',label:'采购需求',type:'textarea'}, {key:'intent_level',label:'意向等级',type:'select',options:[['unknown','未知'],['low','低'],['medium','中'],['high','高']]},{key:'manual_note',label:'事实依据（人工记录）',type:'textarea',required:true,createOnly:true}],
  opportunities:[{key:'name',label:'商机名称',required:true},{key:'company_id',label:'所属公司',type:'company',required:true},{key:'product_summary',label:'意向产品'},{key:'requirement_notes',label:'采购需求',type:'textarea'},{key:'expected_amount',label:'预估金额',type:'number'},{key:'currency',label:'币种',type:'currency'}],
  follow_up_tasks:[{key:'title',label:'任务名称',required:true},{key:'company_id',label:'客户公司',type:'company'},{key:'lead_id',label:'线索',type:'lead'},{key:'opportunity_id',label:'商机',type:'opportunity'},{key:'description',label:'跟进内容',type:'textarea'},{key:'due_at',label:'计划时间',type:'datetime',required:true},{key:'remind_at',label:'提醒时间',type:'datetime'},{key:'priority',label:'优先级',type:'select',options:[['normal','普通'],['high','高'],['low','低']]}],
  activities:[{key:'activity_type',label:'沟通方式',type:'select',required:true,options:[['email','邮件'],['phone','电话'],['whatsapp','WhatsApp'],['meeting','会议'],['note','人工备注']]},{key:'direction',label:'沟通方向',type:'select',options:[['','未指定'],['inbound','客户主动'],['outbound','销售主动']]},{key:'company_id',label:'客户公司',type:'company'},{key:'lead_id',label:'线索',type:'lead'},{key:'opportunity_id',label:'商机',type:'opportunity'},{key:'follow_up_task_id',label:'跟进任务',type:'task'},{key:'subject',label:'主题'},{key:'summary',label:'沟通内容',type:'textarea',required:true},{key:'outcome',label:'沟通结果',type:'textarea'},{key:'occurred_at',label:'发生时间',type:'datetime',required:true}]
};
export const human: Record<string,string> = Object.fromEntries([...stages,['new','新线索'],['working','跟进中'],['qualified','已确认'],['converted','已转化'],['disqualified','无效'],['pending','待处理'],['completed','已完成'],['cancelled','已取消'],['high','高'],['normal','普通'],['low','低'],['medium','中'],['unknown','未知'],['email','邮件'],['phone','电话'],['whatsapp','WhatsApp'],['meeting','会议'],['note','备注'],['manual','人工录入'],['website','网站'],['other','其他']]);
export const show = (v: any) => v == null || v === '' ? '—' : human[String(v)] || String(v);
