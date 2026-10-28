import { Entity, routes } from './definitions';

export function canEdit(entity:Entity, record:Record<string,any>) {
  return !(entity === 'opportunities' && ['won','lost'].includes(record.stage)) && !(entity === 'leads' && record.status === 'converted') && !(entity === 'follow_up_tasks' && record.status !== 'pending');
}

export function editorRequest(entity:Entity, initial?:Record<string,any>, companyId?:string) {
  if (initial && !canEdit(entity, initial)) throw new Error('此记录不支持编辑');
  if (initial) return {path:`${routes[entity]}/${initial.id}`, method:'PATCH'};
  return {path:entity === 'contacts' ? `/companies/${companyId}/contacts` : routes[entity], method:'POST'};
}

export function stageRequest(record: {id:string;version:number}, stage:string, note:string) {
  if (!['discovery','quoting','negotiating','won','lost'].includes(stage)) throw new Error('无效商机阶段');
  if (stage === 'lost' && !note.trim()) throw new Error('请填写丢单原因');
  const path = stage === 'won' ? 'close-won' : stage === 'lost' ? 'close-lost' : 'stage';
  const body = stage === 'won' ? {expected_version:record.version,note:note || null} : stage === 'lost' ? {expected_version:record.version,reason:note} : {expected_version:record.version,stage};
  return {path:`/opportunities/${record.id}/${path}`, body};
}
