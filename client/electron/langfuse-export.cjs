'use strict';
// Langfuse OTLP/HTTP exporter for CRM agent runs.
// Pure Node module: no Electron dependency, safe to unit test.
const {createHash} = require('node:crypto');

const TRACE_NAME = 'crm.agent.chat';
function traceName(run){return !run.kind||run.kind==='chat'?TRACE_NAME:`crm.agent.${String(run.kind).replace(/[^a-z0-9_.-]/gi,'_').slice(0,80)}`;}
const OMIT=Symbol('omit');
function exportable(value,seen=new WeakSet()){
  if(value===null||typeof value!=='object')return value;
  if(Buffer.isBuffer(value)||ArrayBuffer.isView(value)||value instanceof ArrayBuffer||seen.has(value))return OMIT;
  seen.add(value);
  if(Array.isArray(value)){const result=value.map(item=>exportable(item,seen)).filter(item=>item!==OMIT);seen.delete(value);return result;}
  const output={};for(const [key,item] of Object.entries(value)){
    if(/^(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret[_-]?key|ciphertext)$/i.test(key))continue;
    const clean=exportable(item,seen);if(clean!==OMIT)output[key]=clean;
  }seen.delete(value);return output;
}

function sha16(value) { return createHash('sha256').update(String(value)).digest('hex').slice(0, 16); }
function traceIdOf(id) {
  const hex = String(id).replace(/[^a-f0-9]/gi, '').toLowerCase();
  return hex.length === 32 ? hex : createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
}
function nano(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) throw Error('INVALID_TIME');
  return (BigInt(Math.floor(ms)) * 1000000n).toString();
}
function valueText(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
}
function str(key, value) { return {key, value: {stringValue: valueText(value)}}; }
function int(key, value) { return {key, value: {intValue: String(Math.trunc(Number(value)) || 0)}}; }
function arr(key, values) { return {key, value: {arrayValue: {values: values.map(v => ({stringValue: valueText(v)}))}}}; }

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw Error('INVALID_BASE_URL');
  const url = new URL(baseUrl.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw Error('INVALID_BASE_URL');
  if (url.username || url.password) throw Error('INVALID_BASE_URL');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) throw Error('INSECURE_BASE_URL');
  return url;
}
function tracesUrl(baseUrl) { return new URL('/api/public/otel/v1/traces', normalizeBaseUrl(baseUrl)).toString(); }

function spanTime(startIso, endIso) {
  const start = nano(startIso);
  let endMs = Date.parse(endIso);
  if (!Number.isFinite(endMs) || endMs < Date.parse(startIso)) endMs = Date.parse(startIso);
  return {start, end: (BigInt(Math.floor(endMs)) * 1000000n).toString()};
}

// Trace-level attributes are copied onto every span so Langfuse can group/filter them.
function traceAttributes(run, opts, includeContent=false) {
  const attrs = [
    str('langfuse.trace.name', traceName(run)),
    str('langfuse.trace.metadata.status', String(run.status || 'unknown')),
  ];
  if(includeContent){attrs.push(str('langfuse.trace.input',run.userMessage),str('langfuse.trace.output',run.answer));}
  if (run.sessionId) attrs.push(str('langfuse.session.id', opts.userId ? `${opts.userId}:${run.sessionId}` : String(run.sessionId)));
  if (run.submissionId) attrs.push(str('langfuse.trace.metadata.submission_id', String(run.submissionId)));
  if (run.reconstructed) attrs.push(str('langfuse.trace.metadata.reconstructed', 'true'));
  if (run.timing) attrs.push(str('langfuse.trace.metadata.timing', String(run.timing)));
  if (opts.userId) attrs.push(str('langfuse.user.id', String(opts.userId)));
  if (opts.release) attrs.push(str('langfuse.release', String(opts.release)));
  if (opts.environment) attrs.push(str('langfuse.environment', String(opts.environment)));
  if (opts.version) attrs.push(str('langfuse.version', String(opts.version)));
  if (Array.isArray(opts.tags) && opts.tags.length) attrs.push(arr('langfuse.trace.tags', opts.tags.map(String)));
  if (run.error) attrs.push(str('langfuse.trace.metadata.error', String(run.error)));
  if (run.model && run.model.provider) attrs.push(str('langfuse.trace.metadata.model_provider', String(run.model.provider)));
  if (run.model && run.model.modelId) attrs.push(str('langfuse.trace.metadata.model_id', String(run.model.modelId)));
  return attrs;
}

function statusOf(run) {
  return run.status === 'completed' ? {code: 1} : {code: 2, message: valueText(run.error || 'failed')};
}

function buildRootSpan(run, ids, opts) {
  const attrs = traceAttributes(run, opts, true).concat([
    str('langfuse.observation.type', 'agent'),
    str('langfuse.observation.input', run.userMessage),
    str('langfuse.observation.output', run.answer),
  ]);
  const times = spanTime(run.started_at, run.finished_at || run.started_at);
  return {
    traceId: ids.traceId, spanId: ids.root, name: traceName(run), kind: 1,
    startTimeUnixNano: times.start, endTimeUnixNano: times.end,
    attributes: attrs, status: statusOf(run),
  };
}

function buildGenerationSpan(run, call, ids, index, opts) {
  const model = call.model || run.model || {};
  const attrs = traceAttributes(run, opts).concat([
    str('langfuse.observation.type', call.type === 'embedding' ? 'embedding' : 'generation'),
    str('langfuse.observation.input', call.input === undefined ? [{role: 'user', content: run.userMessage === undefined ? '' : run.userMessage}] : call.input),
    str('langfuse.observation.output', call.output === undefined ? run.answer : call.output),
  ]);
  if (model.provider) attrs.push(str('gen_ai.system', String(model.provider)));
  if (model.modelId) {
    attrs.push(str('gen_ai.request.model', String(model.modelId)));
    attrs.push(str('langfuse.observation.model.name', String(model.modelId)));
  }
  const usage = call.usage || run.usage || {};
  if (typeof usage.input === 'number') attrs.push(int('gen_ai.usage.input_tokens', usage.input));
  if (typeof usage.output === 'number') attrs.push(int('gen_ai.usage.output_tokens', usage.output));
  const details = {};
  const usageKeys = {input: 'input', output: 'output', cacheRead: 'cacheRead', cacheWrite: 'cacheWrite', reasoning: 'reasoning', totalTokens: 'total'};
  for (const [k, label] of Object.entries(usageKeys)) { if (typeof usage[k] === 'number') details[label] = usage[k]; }
  if (Object.keys(details).length) attrs.push(str('langfuse.observation.usage_details', JSON.stringify(details)));
  const cost = call.cost || usage.cost || run.cost || {};
  const costDetails = {};
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) { if (typeof cost[k] === 'number') costDetails[k] = cost[k]; }
  if (Object.keys(costDetails).length) attrs.push(str('langfuse.observation.cost_details', JSON.stringify(costDetails)));
  const start = call.startedAt || run.started_at;
  const times = spanTime(start, call.finishedAt || run.finished_at || start);
  if(call.status)attrs.push(str('langfuse.observation.metadata.status',call.status));
  if(call.inputUnavailable)attrs.push(str('langfuse.observation.metadata.input_unavailable','true'));
  if(call.timing)attrs.push(str('langfuse.observation.metadata.timing',call.timing));
  if(call.parameters)attrs.push(str('langfuse.observation.metadata.model_parameters',call.parameters));
  const status=call.status === 'ok' ? {code:1} : ['running','interrupted'].includes(call.status) ? {code:0} : call.status ? {code:2} : statusOf(run);
  return {
    traceId: ids.traceId, spanId: sha16(run.id + ':generation:' + index), parentSpanId: ids.root, name: call.type === 'embedding' ? 'embedding.call' : 'llm.call', kind: 1,
    startTimeUnixNano: times.start, endTimeUnixNano: times.end,
    attributes: attrs, status,
  };
}

function buildToolSpan(call, run, ids, index, opts) {
  const attrs = traceAttributes(run, opts).concat([
    str('langfuse.observation.type', 'tool'),
    str('langfuse.observation.input', call.args),
    str('langfuse.observation.output', call.output !== undefined ? call.output : call.error !== undefined ? call.error : ''),
  ]);
  if (call.status) attrs.push(str('langfuse.observation.metadata.status', String(call.status)));
  if (call.id) attrs.push(str('langfuse.observation.metadata.tool_call_id', String(call.id)));
  if (call.diagnostics) attrs.push(str('langfuse.observation.metadata.diagnostics', call.diagnostics));
  if (call.details !== undefined) attrs.push(str('langfuse.observation.metadata.details', call.details));
  if (call.structuredOutput !== undefined) attrs.push(str('langfuse.observation.metadata.structured_output', call.structuredOutput));
  if (call.usage !== undefined) attrs.push(str('langfuse.observation.metadata.usage', call.usage));
  if (call.control !== undefined) attrs.push(str('langfuse.observation.metadata.control', call.control));
  if (call.timing) attrs.push(str('langfuse.observation.metadata.timing', call.timing));
  const startIso = call.startedAt || run.started_at;
  const times = spanTime(startIso, call.finishedAt || startIso);
  const status = call.status === 'ok' ? {code: 1} : ['running','unknown','interrupted'].includes(call.status) ? {code: 0} : {code: 2};
  return {
    traceId: ids.traceId, spanId: sha16(run.id + ':tool:' + index), parentSpanId: ids.root,
    name: String(call.name || call.operation || 'tool'), kind: 1,
    startTimeUnixNano: times.start, endTimeUnixNano: times.end, attributes: attrs, status,
  };
}

function buildLangfusePayload(run, opts = {}) {
  if (!run || typeof run !== 'object' || typeof run.id !== 'string' || !run.id) throw Error('INVALID_RUN');
  run=exportable(run);
  if (!run.started_at || !Number.isFinite(Date.parse(run.started_at))) throw Error('INVALID_TIME');
  if (run.finished_at && (!Number.isFinite(Date.parse(run.finished_at)) || Date.parse(run.finished_at) < Date.parse(run.started_at))) throw Error('INVALID_TIME');
  const scopedId=run.reconstructed?String(opts.userId||'local')+':'+run.id:run.id;
  const ids = {traceId: traceIdOf(scopedId), root: sha16(scopedId + ':root')};
  const spans = [buildRootSpan(run, ids, opts)];
  const generations = Array.isArray(run.generations) ? run.generations : run.model && run.model.modelId ? [{}] : [];
  generations.forEach((call,index)=>spans.push(buildGenerationSpan(run,call,ids,index,opts)));
  const calls = Array.isArray(run.toolCalls) ? run.toolCalls : [];
  const toolIds = new Map(calls.map((call,index)=>[call.id,sha16(run.id + ':tool:' + index)]));
  calls.forEach((call, index) => {const span=buildToolSpan(call,run,ids,index,opts);if(call.parentCallId&&toolIds.has(call.parentCallId))span.parentSpanId=toolIds.get(call.parentCallId);spans.push(span);});
  return {
    resourceSpans: [{
      resource: {attributes: [{key: 'service.name', value: {stringValue: 'crm-desktop-agent'}}]},
      scopeSpans: [{scope: {name: 'crm.agent'}, spans}],
    }],
  };
}

// Never throws: telemetry failures must not break the main flow.
async function uploadLangfuse(payload, config = {}, options = {}) {
  try {
    if (!config || !config.baseUrl || !config.publicKey || !config.secretKey) return {ok: false, error: 'LANGFUSE_NOT_CONFIGURED'};
    const url = tracesUrl(config.baseUrl);
    const auth = 'Basic ' + Buffer.from(config.publicKey + ':' + config.secretKey).toString('base64');
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') return {ok: false, error: 'FETCH_UNAVAILABLE'};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 8000);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: auth, 'x-langfuse-ingestion-version': '4'},
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if(!response?.ok)return {ok:false,status:response?.status,error:response?.status===413?'LANGFUSE_PAYLOAD_TOO_LARGE':'LANGFUSE_HTTP_ERROR'};
      let body;
      if(typeof response.text==='function'){
        const text=await response.text();
        if(text.trim()){try{body=JSON.parse(text);}catch{return {ok:false,status:response.status,error:'LANGFUSE_INVALID_RESPONSE'};}}
      }else if(typeof response.json==='function')body=await response.json();
      const rejected=Number(body?.partialSuccess?.rejectedSpans||0);
      if(rejected>0)return {ok:false,status:response.status,error:'LANGFUSE_PARTIAL_FAILURE',rejectedSpans:rejected};
      return {ok:true,status:response.status};
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const message = error && (error.message === 'INVALID_BASE_URL' || error.message === 'INSECURE_BASE_URL') ? error.message : 'LANGFUSE_UPLOAD_FAILED';
    return {ok: false, error: message};
  }
}

module.exports = {buildLangfusePayload, uploadLangfuse, tracesUrl, normalizeBaseUrl, TRACE_NAME};
