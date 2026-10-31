const {test} = require('node:test');
const assert = require('node:assert/strict');
const {buildLangfusePayload, uploadLangfuse, tracesUrl, normalizeBaseUrl} = require('./langfuse-export.cjs');

const run = {
  id: '12345678-1234-1234-1234-123456789abc',
  kind: 'chat',
  sessionId: 'conv-1',
  started_at: '2026-01-01T00:00:00.000Z',
  finished_at: '2026-01-01T00:00:02.500Z',
  status: 'completed',
  userMessage: '客户张伟想采购 200 台设备',
  answer: '已记录，需要确认交期。',
  model: {provider: 'openai', modelId: 'gpt-4.1-mini'},
  usage: {input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: {input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003}},
  toolCalls: [
    {name: 'crm_search', operation: 'search', args: {q: '张伟'}, output: [{id: 'c1', name: '张伟', phone: '123'}], startedAt: '2026-01-01T00:00:00.500Z', finishedAt: '2026-01-01T00:00:01.000Z', status: 'ok'},
  ],
};

test('builds nested OTLP payload with full content', () => {
  const payload = buildLangfusePayload(run, {userId: 'user-hash-1', tags: ['crm', 'desktop']});
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans[0].traceId, '12345678123412341234123456789abc');
  assert.match(spans[0].spanId, /^[0-9a-f]{16}$/);
  assert.equal(spans[0].startTimeUnixNano, '1767225600000000000');
  const gen = spans.find(s => s.name === 'llm.call');
  assert.ok(gen, 'generation span exists');
  assert.equal(gen.parentSpanId, spans[0].spanId);
  const attrs = Object.fromEntries(spans[0].attributes.map(a => [a.key, a.value.stringValue]));
  assert.equal(attrs['langfuse.trace.name'], 'crm.agent.chat');
  assert.equal(attrs['langfuse.trace.input'], '客户张伟想采购 200 台设备');
  assert.equal(attrs['langfuse.trace.output'], '已记录，需要确认交期。');
  assert.equal(attrs['langfuse.user.id'], 'user-hash-1');
  assert.equal(attrs['langfuse.session.id'], 'user-hash-1:conv-1');
  const genAttrs = Object.fromEntries(gen.attributes.map(a => [a.key, a.value.stringValue || a.value.intValue]));
  assert.equal(genAttrs['langfuse.observation.model.name'], 'gpt-4.1-mini');
  assert.equal(genAttrs['gen_ai.usage.input_tokens'], '120');
  const tool = spans.find(s => s.name === 'crm_search');
  assert.ok(tool, 'tool span exists');
  assert.equal(tool.parentSpanId, spans[0].spanId);
  const toolAttrs = Object.fromEntries(tool.attributes.map(a => [a.key, a.value.stringValue]));
  assert.match(toolAttrs['langfuse.observation.output'], /张伟/);
  // full content survives serialization
  assert.match(JSON.stringify(payload), /200 台设备/);
});

test('保留可读原文，跳过密文字段和凭据',()=>{
 const payload=buildLangfusePayload({...run,toolCalls:[{name:'source',status:'ok',args:{question:'原文问题',api_key:'secret-key'},output:{text:'可读原文',encrypted:true,ciphertext:'cipher-body'}}]}, {includeRawKey:true,rawKey:'secret-key'});
 const text=JSON.stringify(payload);
 assert.match(text,/原文问题/);assert.match(text,/客户张伟想采购/);
 assert.doesNotMatch(text,/secret-key|cipher-body/);
});

test('failed run marks error status', () => {
  const payload = buildLangfusePayload({...run, status: 'failed', error: 'MODEL_REQUEST_FAILED', answer: ''});
  const root = payload.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(root.status.code, 2);
  assert.equal(root.status.message, 'MODEL_REQUEST_FAILED');
});

test('rejects invalid runs and negative time', () => {
  assert.throws(() => buildLangfusePayload({id: 'x'}));
  assert.throws(() => buildLangfusePayload({...run, started_at: '2026-01-02T00:00:00Z', finished_at: '2026-01-01T00:00:00Z'}));
});

test('保留超过十万字符的对话内容', () => {
  const big = 'x'.repeat(150000);
  const payload = buildLangfusePayload({...run, userMessage: big});
  const attrs = Object.fromEntries(payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.map(a => [a.key, a.value.stringValue]));
  assert.equal(attrs['langfuse.trace.input'], big);
});

test('分别导出实际模型调用及其上下文和回复', () => {
  const payload=buildLangfusePayload({...run,generations:[
    {input:[{role:'user',content:'查询原文'}],output:{content:[{type:'toolCall',name:'crm_search'}]},startedAt:run.started_at,finishedAt:run.finished_at,status:'ok',model:run.model},
    {input:[{role:'toolResult',content:'完整查询结果'}],output:{content:[{type:'text',text:'最终答复'}]},startedAt:run.started_at,finishedAt:run.finished_at,status:'ok',model:run.model},
  ]});
  const spans=payload.resourceSpans[0].scopeSpans[0].spans;
  const calls=spans.filter(span=>span.name==='llm.call');
  assert.equal(calls.length,2);
  assert.match(JSON.stringify(calls[0]),/查询原文/);
  assert.match(JSON.stringify(calls[1]),/完整查询结果/);
  assert.match(JSON.stringify(calls[1]),/最终答复/);
  assert.notEqual(calls[0].spanId,calls[1].spanId);
});

test('后台任务使用真实的任务名称',()=>{
 const payload=buildLangfusePayload({...run,kind:'memory.reflect'});
 assert.equal(payload.resourceSpans[0].scopeSpans[0].spans[0].name,'crm.agent.memory.reflect');
});

test('历史恢复轨迹标记缺失的输入，并按账号隔离编号',()=>{
 const historical={...run,id:'history:1:2',kind:'chat.history',reconstructed:true,generations:[{input:null,inputUnavailable:true,output:'历史回复',status:'ok'}]};
 const first=buildLangfusePayload(historical,{userId:'account-a'}),second=buildLangfusePayload(historical,{userId:'account-b'});
 const spans=first.resourceSpans[0].scopeSpans[0].spans;
 assert.notEqual(spans[0].traceId,second.resourceSpans[0].scopeSpans[0].spans[0].traceId);
 assert.ok(spans[0].attributes.some(item=>item.key==='langfuse.trace.metadata.reconstructed'&&item.value.stringValue==='true'));
 assert.ok(spans.find(item=>item.name==='llm.call').attributes.some(item=>item.key==='langfuse.observation.metadata.input_unavailable'&&item.value.stringValue==='true'));
});

test('语义向量调用导出为 embedding 步骤',()=>{
 const payload=buildLangfusePayload({...run,kind:'memory.embedding',generations:[{type:'embedding',input:['检索'],output:[[0.1,0.2]],status:'ok'}]});
 const span=payload.resourceSpans[0].scopeSpans[0].spans.find(item=>item.name==='embedding.call');
 assert.ok(span);assert.ok(span.attributes.some(item=>item.key==='langfuse.observation.type'&&item.value.stringValue==='embedding'));
});

test('标记为加密的对象中可读内容仍保留，密文和凭据字段不上传',()=>{
  const payload=buildLangfusePayload({...run,toolCalls:[{name:'source',status:'ok',output:{encrypted:true,text:'可读内容',ciphertext:'unreadable',api_key:'key-value'}}]});
  const text=JSON.stringify(payload);
  assert.match(text,/可读内容/);
  assert.doesNotMatch(text,/unreadable|key-value/);
});

test('服务部分拒绝数据时不能报告上传成功',async()=>{
  const result=await uploadLangfuse({}, {baseUrl:'https://x.test',publicKey:'a',secretKey:'b'}, {fetchImpl:async()=>({ok:true,status:200,json:async()=>({partialSuccess:{rejectedSpans:1,errorMessage:'invalid span'}})})});
  assert.equal(result.ok,false);
  assert.equal(result.error,'LANGFUSE_PARTIAL_FAILURE');
  assert.equal(result.rejectedSpans,1);
});

test('服务端拒绝过大记录时明确报告失败',async()=>{
  const result=await uploadLangfuse({}, {baseUrl:'https://x.test',publicKey:'a',secretKey:'b'}, {fetchImpl:async()=>({ok:false,status:413})});
  assert.deepEqual(result,{ok:false,status:413,error:'LANGFUSE_PAYLOAD_TOO_LARGE'});
});

test('upload posts to /api/public/otel/v1/traces with basic auth', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({url, init}); return {ok: true, status: 207}; };
  const result = await uploadLangfuse({resourceSpans: []}, {baseUrl: 'https://cloud.langfuse.com', publicKey: 'pk', secretKey: 'sk'}, {fetchImpl: fakeFetch});
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://cloud.langfuse.com/api/public/otel/v1/traces');
  assert.equal(calls[0].init.headers.Authorization, 'Basic ' + Buffer.from('pk:sk').toString('base64'));
  assert.equal(calls[0].init.headers['x-langfuse-ingestion-version'], '4');
});
test('upload swallows failures and validates config', async () => {
  assert.equal((await uploadLangfuse({}, {})).error, 'LANGFUSE_NOT_CONFIGURED');
  const throwing = async () => { throw new Error('net'); };
  const result = await uploadLangfuse({}, {baseUrl: 'https://x.test', publicKey: 'a', secretKey: 'b'}, {fetchImpl: throwing});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'LANGFUSE_UPLOAD_FAILED');
});
test('rejects insecure remote base url', () => {
  assert.throws(() => normalizeBaseUrl('http://evil.example.com'));
  assert.equal(tracesUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/api/public/otel/v1/traces');
});
test('不上传密钥片段或密钥指纹，非 UUID 记录也有合法的追踪编号', () => {
  const payload=buildLangfusePayload({...run,id:'short-id'}, {keyAlias:'openai-TAIL',keyFingerprint:'deadbeef'});
  assert.doesNotMatch(JSON.stringify(payload),/TAIL|deadbeef|key_alias|key_fingerprint/);
  assert.match(payload.resourceSpans[0].scopeSpans[0].spans[0].traceId,/^[0-9a-f]{32}$/);
});
