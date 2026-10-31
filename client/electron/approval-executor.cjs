function createApprovalExecutor({getStore, session, request}) {
  const inFlight = new Set();

  return async function execute(action, id, digest) {
    const store = getStore();
    if (action === 'list') return store.list();
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw Error('审批标识无效');
    if (action === 'reject') return store.transition(id, ['pending'], 'rejected');
    if (action !== 'confirm' || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw Error('无效操作');
    if (inFlight.has(id)) throw Error('审批正在执行');
    inFlight.add(id);
    try {
      const item = store.transition(id, ['pending', 'retry', 'submitting'], 'submitting', {}, digest);
      const current = session();
      try {
        const result = await request(item.request.path, item.request.method, item.request.body, current.token, current.tenant, {id:item.id, runId:item.runId});
        if (current.generation !== session().generation) throw Error('会话变化');
        if (result.ok) return store.transition(id, ['submitting'], 'succeeded', {result:result.data});
        if (result.status >= 500) return store.transition(id, ['submitting'], 'retry', {message:'结果不确定，可安全重试'});
        return store.transition(id, ['submitting'], 'failed', {message:result.error?.message || '请求失败'});
      } catch {
        if (current.generation === session().generation) return store.transition(id, ['submitting'], 'retry', {message:'结果不确定，可安全重试'});
        throw Error('会话已变化');
      }
    } finally {
      inFlight.delete(id);
    }
  };
}

module.exports = {createApprovalExecutor};
