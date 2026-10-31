// Runtime adapter for the Harness² engine (client/agent/harness2.mjs) that
// runs *on the Pi agent core* instead of a private model adapter.
//
// - execute: a Pi conversation uses the candidate instructions with no live
//   tools. Safe recorded-result replay belongs to the chat evolution flow.
// - propose: a second conversation, with the proposer system prompt and no
//   extensions, returns a JSON patch of the harness *configuration*.
// - verify: checks the answer contains the task's expected text.
//
// All state (base spec, adopted experiences, candidates, audit) is a
// session-scoped pi-durable document, so it lives in the same session.sqlite
// as the conversations and is committed atomically with them. The two worker
// conversations are remembered by id in that document, so reopening reuses them
// instead of growing the database.

import { defineDoc, AssistantEntry } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { randomUUID } from 'node:crypto';
import { Harness2 } from './harness2.mjs';

export const HARNESS2_BASE_SPEC = {
  instructions:
    '你是 CRM 销售助手。请依据用户提供的信息作答，缺少依据时说明待确认，不要编造客户事实。',
  tools: [],
};

export const HARNESS2_STATE_KIND = 'crm.harness2';

export const Harness2State = defineDoc({
  kind: HARNESS2_STATE_KIND,
  version: 1,
  scope: 'session',
  initial: () => ({
    version: 1,
    base: null,
    library: [],
    candidates: [],
    audit: [],
    workerConversationId: null,
    proposerConversationId: null,
  }),
  checkpointWhen: () => true,
});

const PROPOSER_PROMPT =
  '你是 Harness² 提议器。目标：不改变模型权重，只通过修改“harness 配置”（给模型的完整指导文本，可选工具名列表）来帮助完成当前任务。只返回 JSON，形如 {"instructions":"新的完整指导文本","rationale":"一句话理由"}，其中 instructions 必须是可以直接使用的完整文本，不要省略、不要包含代码。';

function sanitizeProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const patch = {};
  if (typeof value.instructions === 'string' && value.instructions.trim()) patch.instructions = value.instructions;
  if (Array.isArray(value.tools)) {
    const tools = value.tools.filter((tool) => typeof tool === 'string' && tool.trim());
    if (tools.length) patch.tools = tools;
  }
  if (patch.instructions === undefined && patch.tools === undefined) return null;
  const rationale = typeof value.rationale === 'string' ? value.rationale : typeof value.reason === 'string' ? value.reason : null;
  patch.rationale = rationale;
  return patch;
}

export function parseProposal(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const fenced = trimmed.match(/\x60\x60\x60(?:json)?\s*([\s\S]*?)\x60\x60\x60/i);
  if (fenced) candidates.push(fenced[1].trim());
  const braced = trimmed.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const patch = sanitizeProposal(parsed);
      if (patch) return patch;
    } catch {
      /* try next */
    }
  }
  if (!/^[\[{]/.test(trimmed) && trimmed.length <= 8000) {
    return { instructions: trimmed, rationale: '模型直接给出的指导' };
  }
  return null;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((part) => part && part.type === 'text').map((part) => part.text).join('\n');
  return '';
}

/**
 * Open the Harness² engine on an already-open pi-durable Harness.
 *
 * @param {object} options
 * @param {import('@earendil-works/pi-durable').Harness} options.harness
 * @param {object} options.model        Pi model ref, e.g. {provider:'openai',modelId:'gpt-4.1-mini'}
 * @param {() => boolean} [options.ready] Whether a model credential is configured.
 * Historical test suites run without live tools; replay is handled by the chat evolution flow.
 * @param {object} [options.baseSpec]  Seed harness configuration.
 * @param {number} [options.maxRounds]
 */
export async function openHarness2({ harness, model, ready, traceCapture, onAuxRunDetail=()=>{}, baseSpec = HARNESS2_BASE_SPEC, maxRounds = 4 } = {}) {
  if (!harness || typeof harness.commit !== 'function') throw new Error('harness2: 需要已打开的 Pi Harness');
  const context = BACKGROUND_CONTEXT;
  if (typeof ready === 'function' && !ready()) {
    // Still open so callers can inspect empty state; runs reject below.
  }

  const saved = await harness.snapshot(Harness2State, context);
  let worker = null;
  let proposer = null;

  function ensureReady() {
    if (typeof ready === 'function' && !ready()) throw new Error('MODEL_NOT_CONFIGURED');
    if (!model) throw new Error('MODEL_NOT_CONFIGURED');
  }

  async function rememberIds() {
    await harness.commit(async (tx) => {
      const doc = await tx.doc(Harness2State);
      if (worker) doc.workerConversationId = worker.id;
      if (proposer) doc.proposerConversationId = proposer.id;
    }, context);
  }

  async function resolveConversation(kind, storedId) {
    if (storedId !== null && storedId !== undefined) {
      const existing = await harness.conversation(storedId, context);
      if (existing) return existing;
    }
    const agent = kind === 'worker'
      ? { model, extensions: [], tools: [], modelTools: [], instructions: baseSpec.instructions }
      : { model, extensions: [], instructions: PROPOSER_PROMPT };
    return harness.createConversation({ ownership: { kind: 'ownerless' }, agent }, context);
  }

  async function conversations() {
    if (worker && proposer) return { worker, proposer };
    if (!worker) worker = await resolveConversation('worker', saved?.workerConversationId ?? null);
    if (!proposer) proposer = await resolveConversation('proposer', saved?.proposerConversationId ?? null);
    if (!saved || saved.workerConversationId !== worker.id || saved.proposerConversationId !== proposer.id) {
      await rememberIds();
    }
    return { worker, proposer };
  }

  async function ask(conversation, input, kind) {
    const detail={id:randomUUID(),kind:'harness.'+kind,sessionId:String(conversation.id),started_at:new Date().toISOString(),status:'running',userMessage:input,model,generations:[],toolCalls:[]};
    if(traceCapture)traceCapture.begin(conversation.id,detail.id);
    try{
      const submission = await conversation.submit({ type: 'input', content: input }, context);
      const settled = await submission.wait(context);
      if (!settled || settled.status !== 'done' || settled.type !== 'input') throw new Error('MODEL_REQUEST_FAILED');
      const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      const answer = contentToText(entry?.model?.[0]?.content);
      if (!answer) throw new Error('EMPTY_RESPONSE');
      detail.answer=answer;detail.status='completed';return answer;
    }catch(error){detail.status='failed';detail.error='MODEL_REQUEST_FAILED';throw error;}
    finally{
      if(traceCapture){const record=traceCapture.finish(conversation.id);if(record){detail.generations=record.generations;detail.toolCalls=record.toolCalls;}}
      detail.finished_at=new Date().toISOString();if(detail.generations.length)try{onAuxRunDetail(detail);}catch{}
    }
  }

  async function configureWorker(conversation, spec) {
    if(Array.isArray(spec.tools)&&spec.tools.length)throw Error('HARNESS_LIVE_TOOLS_DISABLED');
    await conversation.configure({model,extensions:traceCapture?[traceCapture.extension]:[],tools:[],modelTools:[],instructions:spec.instructions},context);
  }

  const adapters = {
    async execute({ harness: spec, task }) {
      ensureReady();
      const { worker: executor } = await conversations();
      await configureWorker(executor, spec);
      await executor.reset(undefined, context);
      return ask(executor, task.input, 'execute');
    },

    async propose({ task, harness: current, probes }) {
      ensureReady();
      const { proposer: conv } = await conversations();
      const evidence = probes.length
        ? probes
            .map((probe, index) => '第' + (index + 1) + '次：' + (probe.passed ? '通过' : '未通过') + (probe.evidence ? '（' + JSON.stringify(probe.evidence).slice(0, 300) + '）' : ''))
            .join('\n')
        : '（暂无）';
      const user =
        '任务 ID：' + task.id +
        '\n领域：' + (task.domain || '通用') +
        '\n任务输入：\n' + task.input +
        '\n\n验证要求（回答需包含的文字）：' + (task.expected || '（无）') +
        '\n\n当前 harness 指导：\n' + current.spec.instructions +
        '\n\n历史探测证据：\n' + evidence +
        '\n\n请提出一次改进。';
      await conv.configure({ model, extensions: traceCapture?[traceCapture.extension]:[], instructions: PROPOSER_PROMPT, modelTools: [] }, context);
      await conv.reset(undefined, context);
      return parseProposal(await ask(conv, user, 'propose'));
    },

    async verify({ task, output }) {
      if (typeof task.expected !== 'string' || !task.expected.trim()) {
        return { passed: false, evidence: { reason: '任务缺少 expected，无法自动验证' } };
      }
      const answer = typeof output === 'string' ? output : String(output ?? '');
      const passed = answer.includes(task.expected.trim());
      return { passed, score: passed ? 1 : 0, evidence: { expected: task.expected.trim(), found: passed } };
    },
  };

  const engine = Harness2.fromState({ ...adapters, baseSpec, maxRounds }, saved ?? undefined);

  async function persist() {
    const state = engine.serialize();
    await harness.commit(async (tx) => {
      const doc = await tx.doc(Harness2State);
      doc.version = state.version;
      doc.base = state.base;
      doc.library = state.library;
      doc.candidates = state.candidates;
      doc.audit = state.audit;
    }, context);
  }

  return {
    snapshot: () => engine.snapshot(),
    history: (limit) => engine.history(limit),
    async runSuite(tasks) {
      const result = await engine.runSuite({ tasks });
      await persist();
      return result;
    },
    async promote(candidateId) {
      const entry = engine.promote(candidateId);
      await persist();
      return entry;
    },
    async rollback(entryId) {
      const removed = engine.rollback(entryId);
      await persist();
      return removed;
    },
  };
}
