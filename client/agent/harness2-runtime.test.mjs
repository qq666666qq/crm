import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openHarness2, parseProposal } from './harness2-runtime.mjs';

const MODEL = { provider: 'faux', modelId: 'faux-1' };

function promptText(context) {
  const parts = [];
  for (const message of context.messages || []) {
    if (message.role === 'system') {
      parts.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
      if (message.sections) parts.push(...Object.values(message.sections).filter((value) => typeof value === 'string'));
    } else if (message.role === 'user') {
      parts.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
    }
  }
  return parts.join('\n');
}

// One deterministic scripting step for every model call: a proposer call returns
// a JSON patch that appends SOLVED_MARK; a worker call answers OK only when its
// instructions contain the mark, so the loop converges after one proposal.
function step(context) {
  const text = promptText(context);
  if (text.includes('提议器')) {
    const match = text.match(/当前 harness 指导：\n([\s\S]*?)\n\n历史探测证据/);
    const current = match ? match[1] : '';
    return fauxAssistantMessage(
      JSON.stringify({ instructions: current.trimEnd() + '\nSOLVED_MARK', rationale: '测试：加标记' }),
    );
  }
  return fauxAssistantMessage(text.includes('SOLVED_MARK') ? 'OK' : 'NO');
}

function scriptFaux(calls = 80) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: calls }, () => step));
  return models;
}

test('parseProposal 接受 JSON、代码围栏与普通散文', () => {
  assert.deepEqual(parseProposal('{"instructions":"abc","rationale":"r"}'), { instructions: 'abc', rationale: 'r' });
  assert.deepEqual(parseProposal('\x60\x60\x60json\n{"instructions":"abc"}\n\x60\x60\x60'), { instructions: 'abc', rationale: null });
  assert.deepEqual(parseProposal('把语气改得更简洁'), { instructions: '把语气改得更简洁', rationale: '模型直接给出的指导' });
  assert.equal(parseProposal('{"tools":[]}'), null);
  assert.equal(parseProposal(''), null);
});

test('runSuite 在 Pi 会话上求解任务并产生候选', async () => {
  const harness = await Harness.open(new MemoryStorage(), { models: scriptFaux(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  const h2 = await openHarness2({ harness, model: MODEL, ready: () => true });
  const result = await h2.runSuite([{ id: 't1', domain: 'crm', input: '请给出一个答案', expected: 'OK' }]);
  assert.equal(result.total, 1);
  assert.equal(result.solved, 1);
  assert.equal(result.tasks[0].solved, true);
  assert.equal(result.tasks[0].improved, true);
  assert.ok(result.candidates.length >= 1);
  const snapshot = h2.snapshot();
  assert.equal(snapshot.counts.candidates, result.candidates.length);
  const promoted = await h2.promote(result.candidates[0].id);
  assert.ok(promoted.id.startsWith('exp_'));
  assert.equal(h2.snapshot().counts.adopted, 1);
  await harness.close(BACKGROUND_CONTEXT);
});

test('状态与经验存在同一 SQLite，重开后仍在且可回滚', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-h2-'));
  const db = path.join(dir, 'session.sqlite');
  try {
    let harness = await Harness.open(await openNodeSqliteStorage(db), { models: scriptFaux(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    let h2 = await openHarness2({ harness, model: MODEL, ready: () => true });
    const result = await h2.runSuite([{ id: 't1', domain: 'crm', input: '请给出一个答案', expected: 'OK' }]);
    const entry = await h2.promote(result.candidates[0].id);
    await harness.close(BACKGROUND_CONTEXT);

    harness = await Harness.open(await openNodeSqliteStorage(db), { models: scriptFaux(8), registry: createRegistry() }, BACKGROUND_CONTEXT);
    h2 = await openHarness2({ harness, model: MODEL, ready: () => true });
    assert.equal(h2.snapshot().counts.adopted, 1);
    assert.equal(h2.snapshot().library[0].id, entry.id);
    await h2.rollback(entry.id);
    assert.equal(h2.snapshot().counts.adopted, 0);
    await harness.close(BACKGROUND_CONTEXT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('未配置模型时拒绝运行', async () => {
  const harness = await Harness.open(new MemoryStorage(), { models: scriptFaux(4), registry: createRegistry() }, BACKGROUND_CONTEXT);
  const h2 = await openHarness2({ harness, model: MODEL, ready: () => false });
  await assert.rejects(() => h2.runSuite([{ id: 't1', input: 'hi', expected: 'OK' }]), /MODEL_NOT_CONFIGURED/);
  await harness.close(BACKGROUND_CONTEXT);
});

test('旧测试套件不能启用真实 CRM 工具',async()=>{
 const faux=fauxProvider(),models=createModels();models.setProvider(faux.provider);faux.setResponses([fauxAssistantMessage('NO'),fauxAssistantMessage(JSON.stringify({instructions:'尝试使用工具',tools:['crm_propose_lead']}))]);const harness=await Harness.open(new MemoryStorage(),{models,registry:createRegistry()},BACKGROUND_CONTEXT);
 try{const h2=await openHarness2({harness,model:MODEL,ready:()=>true});await assert.rejects(h2.runSuite([{id:'t1',input:'创建线索',expected:'OK'}]),/HARNESS_LIVE_TOOLS_DISABLED/);assert.equal(faux.state.callCount,2);}finally{await harness.close(BACKGROUND_CONTEXT);}
});
