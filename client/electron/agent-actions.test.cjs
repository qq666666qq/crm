const {test}=require('node:test');
const assert=require('node:assert/strict');
const {dispatchAgentAction}=require('./agent-actions.cjs');
const id='f1dd6840-768d-4a20-b951-6c45acdc20c9';

test('允许的记忆复审只转发审核需要的字段',async()=>{
  const calls=[];
  const invoke=async(type,payload)=>{calls.push({type,payload});return 'ok';};
  const input={id,expectedVersion:2,decision:'accept',tenant:'other',confirmedConflicts:[{id,version:3,status:'active',extra:'ignored'}]};
  assert.equal(await dispatchAgentAction('memory-review',input,invoke),'ok');
  assert.deepEqual(calls,[{type:'memory-review',payload:{value:{id,expectedVersion:2,decision:'accept',confirmedConflicts:[{id,version:3,status:'active'}]}}}]);
});

test('非法动作和非法审核参数不会发给 Agent 工作进程',async()=>{
  const calls=[];
  const invoke=async(...args)=>calls.push(args);
  for(const [action,value] of [
    ['unknown','x'],['select-preset','outside'],['memory-page',{status:'deleted',cursor:null}],
    ['memory-review',{id,expectedVersion:0,decision:'accept'}],
    ['memory-review',{id,expectedVersion:1,decision:'accept',confirmedConflicts:Array.from({length:11},()=>({id,version:1,status:'active'}))}],
    ['memory-publish',{id,digest:'bad'}],['chat','  '],['configure-model','short'],
  ]) await assert.rejects(dispatchAgentAction(action,value,invoke),/Invalid agent action/);
  assert.deepEqual(calls,[]);
});

test('预设、对话和技能选择映射到限定的工作进程请求',async()=>{
  const invoke=async(type,payload)=>({type,payload});
  assert.deepEqual(await dispatchAgentAction('select-preset','creator',invoke),{type:'select-preset',payload:{preset:'creator'}});
  assert.deepEqual(await dispatchAgentAction('chat','你好',invoke),{type:'chat',payload:{text:'你好'}});
  const selected=['skill-a'];
  const result=await dispatchAgentAction('memory-skills',selected,invoke);
  selected.push('later-change');
  assert.deepEqual(result,{type:'memory-skills',payload:{value:['skill-a']}});
});


test('对话续接只转发合法的消息和稳定请求标识',async()=>{
 const invoke=async(type,payload)=>({type,payload}),requestId='12345678-1234-1234-1234-123456789abc';
 assert.deepEqual(await dispatchAgentAction('chat',{text:'你好',requestId,extra:'ignored'},invoke),{type:'chat',payload:{text:'你好',requestId}});
 await assert.rejects(dispatchAgentAction('chat',{text:'你好',requestId:'invalid'},invoke),/Invalid agent action/);
});
