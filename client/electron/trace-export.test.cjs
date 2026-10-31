const {test}=require('node:test');const assert=require('node:assert/strict');const {toOtlp}=require('./trace-export.cjs');
test('执行记录转为脱敏 OTLP JSON，忽略运行中任务',()=>{const payload=toOtlp([{id:'12345678-1234-1234-1234-123456789abc',started_at:'2026-01-01T00:00:00.000Z',finished_at:'2026-01-01T00:00:01.000Z',status:'completed',message:'私密客户信息'},{status:'running'}]);const span=payload.resourceSpans[0].scopeSpans[0].spans[0];assert.equal(span.traceId,'12345678123412341234123456789abc');assert.match(span.spanId,/^[0-9a-f]{16}$/);assert.equal(span.startTimeUnixNano,'1767225600000000000');assert.equal(payload.resourceSpans[0].scopeSpans[0].spans.length,1);assert.doesNotMatch(JSON.stringify(payload),/私密客户信息/);});
test('无效记录和倒退的时间被拒绝',()=>{assert.throws(()=>toOtlp([{id:'x',status:'failed'}]));assert.throws(()=>toOtlp([{id:'12345678-1234-1234-1234-123456789abc',started_at:'2026-01-02',finished_at:'2026-01-01',status:'failed'}]));});
test('本次会话导出完整轨迹，历史只剩状态的记录仍保留',()=>{
 const id='12345678-1234-1234-1234-123456789abc',old='22345678-1234-1234-1234-123456789abc';
 const base={started_at:'2026-01-01T00:00:00Z',finished_at:'2026-01-01T00:00:01Z',status:'completed'};
 const result=toOtlp([{...base,id},{...base,id:old}],{details:[{...base,id,userMessage:'原始问题',answer:'完整答案',generations:[{input:'完整上下文',output:'模型回答',status:'ok'}],toolCalls:[{name:'crm_search',args:{q:'客户'},output:'查询结果',status:'ok'}]}]});
 const spans=result.resourceSpans.flatMap(resource=>resource.scopeSpans.flatMap(scope=>scope.spans));
 assert.equal(spans.filter(item=>item.traceId===id.replaceAll('-','')&&item.name==='crm.agent.chat').length,1);
 assert.ok(spans.some(item=>item.traceId===old.replaceAll('-','')));
 assert.match(JSON.stringify(result),/完整上下文/);assert.match(JSON.stringify(result),/查询结果/);
});
