const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createApprovalExecutor} = require('./approval-executor.cjs');

function setup(request) {
  const item = {id:'f1dd6840-768d-4a20-b951-6c45acdc20c9', digest:'a'.repeat(64), status:'pending', request:{path:'/api/v1/leads',method:'POST',body:{title:'询问'}}, runId:'run-1'};
  const state = {token:'token-a', tenant:'A', generation:1};
  const store = {
    list:()=>[{...item}],
    transition(id, allowed, status, fields={}, digest) {
      if (id !== item.id || !allowed.includes(item.status)) throw Error('状态冲突');
      if (digest && digest !== item.digest) throw Error('内容已更改');
      Object.assign(item, fields, {status});
      return {...item};
    },
  };
  return {item, state, execute:createApprovalExecutor({getStore:()=>store, session:()=>({...state}), request})};
}

test('不确定的提交保留审批标识，人工重试使用同一个标识', async () => {
  const requests = [];
  const h = setup(async (...args) => { requests.push(args); if (requests.length === 1) throw Error('timeout'); return {ok:true,data:{id:'created'}}; });
  assert.equal((await h.execute('confirm',h.item.id,h.item.digest)).status, 'retry');
  assert.equal((await h.execute('confirm',h.item.id,h.item.digest)).status, 'succeeded');
  assert.deepEqual(requests.map(args=>args[5].id), [h.item.id,h.item.id]);
  assert.deepEqual(requests.map(args=>args[4]), ['A','A']);
});

test('同一审批同时只能提交一次', async () => {
  let finish, calls=0;
  const h = setup(() => { calls++; return new Promise(resolve=>{finish=resolve;}); });
  const first = h.execute('confirm',h.item.id,h.item.digest);
  await assert.rejects(h.execute('confirm',h.item.id,h.item.digest), /审批正在执行/);
  assert.equal(calls,1);
  finish({ok:true,data:{id:'created'}});
  assert.equal((await first).status,'succeeded');
});

test('切换会话后旧请求不能更新审批结果', async () => {
  let finish;
  const h = setup(() => new Promise(resolve=>{finish=resolve;}));
  const pending = h.execute('confirm',h.item.id,h.item.digest);
  h.state.generation++;
  h.state.tenant='B';
  finish({ok:true,data:{id:'created'}});
  await assert.rejects(pending, /会话已变化/);
  assert.equal(h.item.status,'submitting');
});

test('过期的审核内容不能发起请求', async () => {
  let calls=0;
  const h = setup(async () => { calls++; return {ok:true}; });
  await assert.rejects(h.execute('confirm',h.item.id,'b'.repeat(64)), /内容已更改/);
  assert.equal(calls,0);
  assert.equal(h.item.status,'pending');
});
