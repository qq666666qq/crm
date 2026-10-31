// Validate renderer requests before passing allowed actions to the Agent worker.
// The main process authenticates the caller and owns session and worker lifecycle.
async function dispatchAgentAction(action,value,agentRequest) {
    if (action==='presets') return agentRequest('presets');
    if (action==='history') return agentRequest('history');
    if (action==='migration-status') return agentRequest('migration-status');
    if (action==='conversations'||action==='new-conversation') return agentRequest(action);
    if (action==='select-conversation' && typeof value==='string' && value.length<=100) return agentRequest(action,{conversationId:value});
    if (action==='evolve' && typeof value==='string' && value.length<=100) return agentRequest(action,{traceId:value});
    if (action==='evolution-history' && typeof value==='string' && /^\d{1,20}$/.test(value)) return agentRequest('evolution-history',{traceId:value});
    if (action==='evolution-tasks') return agentRequest('evolution-tasks');
    if (action==='evolution-decide' && value && typeof value==='object' && typeof value.id==='string' && /^[0-9a-f-]{36}$/i.test(value.id) && Number.isSafeInteger(value.expectedVersion) && value.expectedVersion>0 && ['baseline','candidate'].includes(value.decision)) return agentRequest('evolution-decide',{value:{id:value.id,expectedVersion:value.expectedVersion,decision:value.decision}});
    if (action==='traces') return agentRequest('traces');
    if (action==='memory-status') return agentRequest('memory-status');
    if (action==='memory-page' && value && typeof value==='object' && ['active','pending'].includes(value.status) && (value.cursor===null || typeof value.cursor==='string' && value.cursor.length>0 && value.cursor.length<=512)) return agentRequest('memory-page',{value:{status:value.status,cursor:value.cursor}});
    if (action==='memory-skills' && Array.isArray(value) && value.length<=5 && value.every(name=>typeof name==='string' && name.length>0 && name.length<=100)) return agentRequest('memory-skills',{value:[...value]});
    if (action==='memory-sources' && typeof value==='string' && /^[0-9a-f-]{36}$/i.test(value)) return agentRequest('memory-sources',{value});
    if (action==='memory-review' && value && typeof value==='object' && typeof value.id==='string' && /^[0-9a-f-]{36}$/i.test(value.id) && Number.isSafeInteger(value.expectedVersion) && value.expectedVersion>0 && ['accept','reject'].includes(value.decision) && (value.confirmedConflicts===undefined || Array.isArray(value.confirmedConflicts) && value.confirmedConflicts.length<=10 && value.confirmedConflicts.every(item=>item && typeof item.id==='string' && /^[0-9a-f-]{36}$/i.test(item.id) && Number.isSafeInteger(item.version) && item.version>0 && ['active','pending'].includes(item.status)))) return agentRequest('memory-review',{value:{id:value.id,expectedVersion:value.expectedVersion,decision:value.decision,confirmedConflicts:value.confirmedConflicts?.map(item=>({id:item.id,version:item.version,status:item.status}))}});
    if (action==='memory-update' && value && typeof value==='object' && typeof value.id==='string' && /^[0-9a-f-]{36}$/i.test(value.id) && Number.isSafeInteger(value.expectedVersion) && value.expectedVersion>0 && ['edit','delete'].includes(value.operation) && (value.operation==='delete'||typeof value.content==='string'&&value.content.trim()&&value.content.length<=4000)) return agentRequest('memory-update',{value:{id:value.id,expectedVersion:value.expectedVersion,operation:value.operation,content:value.operation==='edit'?value.content:undefined}});
    if (action==='memory-search' && typeof value==='string' && value.trim() && value.length<=200) return agentRequest('memory-search',{value});
    if (action==='memory-semantic-model' && typeof value==='string' && /^[a-zA-Z0-9._-]{1,100}$/.test(value)) return agentRequest('memory-semantic-model',{value});
    if (action==='memory-semantic' && typeof value==='boolean') return agentRequest('memory-semantic',{value});
    if (action==='memory-retry' && value && typeof value==='object' && typeof value.submissionId==='string' && /^\d{1,20}$/.test(value.submissionId) && ['writer','reflection','harvest'].includes(value.kind)) return agentRequest('memory-retry',{value:{submissionId:value.submissionId,kind:value.kind}});
    if (action==='memory-harvest' && typeof value==='string' && /^\d{1,20}$/.test(value)) return agentRequest('memory-harvest',{value});
    if (action==='memory-publish' && value && typeof value==='object' && typeof value.id==='string' && /^[0-9a-f-]{36}$/i.test(value.id) && typeof value.digest==='string' && /^[0-9a-f]{64}$/i.test(value.digest)) return agentRequest('memory-publish',{value:{id:value.id,digest:value.digest}});
    if (action==='memory-reject' && value && typeof value==='object' && typeof value.id==='string' && /^[0-9a-f-]{36}$/i.test(value.id) && typeof value.digest==='string' && /^[0-9a-f]{64}$/i.test(value.digest)) return agentRequest('memory-reject',{value:{id:value.id,digest:value.digest}});
    if (action==='memory-rollback' && value && typeof value==='object' && typeof value.id==='string' && /^[0-9a-f-]{36}$/i.test(value.id) && Number.isSafeInteger(value.expectedVersion) && value.expectedVersion>0) return agentRequest('memory-rollback',{value:{id:value.id,expectedVersion:value.expectedVersion}});
    if (action==='demo-lead') return agentRequest('demo-lead');
    if (action==='configure-model' && typeof value==='string' && value.length>=10 && value.length<=512) return agentRequest('configure-model',{key:value});
    if (action==='chat' && typeof value==='string' && value.trim() && value.length<=8000) return agentRequest('chat',{text:value});
    if (action==='select-preset' && ['lead-opportunity','rag','creator'].includes(value)) return agentRequest('select-preset',{preset:value});
    if (action==='demo-search' && typeof value==='string' && value.length<=500) return agentRequest('demo-search',{query:value});
    if (action==='harness2-state') return agentRequest('harness2-state');
    if (action==='harness2-history') return agentRequest('harness2-history',{limit:100});
    if (action==='harness2-run' && Array.isArray(value) && value.length>=1 && value.length<=10 && value.every(task=>task&&typeof task==='object'&&!Array.isArray(task)&&typeof task.id==='string'&&task.id.length<=100&&typeof task.input==='string'&&task.input.length<=4000&&typeof task.expected==='string'&&task.expected.trim()&&task.expected.length<=300&&(task.domain===undefined||typeof task.domain==='string'))) return agentRequest('harness2-run',{tasks:value});
    if (action==='harness2-promote' && typeof value==='string' && /^cand_[0-9a-f-]{36}$/i.test(value)) return agentRequest('harness2-promote',{candidateId:value});
    if (action==='harness2-rollback' && typeof value==='string' && /^exp_[0-9a-f-]{36}$/i.test(value)) return agentRequest('harness2-rollback',{entryId:value});
    throw new Error('Invalid agent action');
}

module.exports={dispatchAgentAction};
