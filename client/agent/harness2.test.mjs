import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Harness2,
  createHarness,
  createHarness2,
  composeHarness,
  validateSpec,
  normalizePatch,
  HARNESS2_VERSION,
} from './harness2.mjs';

// A deterministic mock world: a task is solved when the harness instructions
// contain a per-task magic marker. Proposers add the marker; executors report
// whether it is present; verifiers check the reported answer.
function mockWorld(plan) {
  const calls = { propose: 0, execute: 0, verify: 0 };
  const propose = async ({ task, harness, round }) => {
    calls.propose += 1;
    const marker = plan.markerFor(task);
    if (harness.spec.instructions.includes(marker)) return null; // already learned
    const step = plan.steps ? plan.steps(task, round) : { instructions: harness.spec.instructions + '\n' + marker, rationale: '加入标记 ' + marker };
    return step;
  };
  const execute = async ({ harness, task }) => {
    calls.execute += 1;
    const marker = plan.markerFor(task);
    return { taskId: task.id, answer: harness.instructions.includes(marker) ? 'OK' : 'NO' };
  };
  const verify = async ({ task, output }) => {
    calls.verify += 1;
    const passed = output && output.answer === 'OK';
    return { passed, score: passed ? 1 : 0, evidence: { expected: plan.markerFor(task), got: output && output.answer } };
  };
  return { propose, execute, verify, calls };
}

const baseSpec = { instructions: '你是 CRM 助手。', tools: ['crm_search'] };

test('spec validation rejects bad shapes', () => {
  assert.throws(() => validateSpec({ instructions: '' }), /instructions/);
  assert.throws(() => validateSpec({ instructions: 'ok', tools: [1] }), /tools/);
  assert.deepEqual(validateSpec({ instructions: '  hi  ', tools: ['a', 'a', 'b'] }), { instructions: 'hi', tools: ['a', 'b'] });
});

test('composeHarness merges instructions/tools and dedupes', () => {
  const base = createHarness(baseSpec);
  const next = composeHarness(base, { tools: ['a', 'b', 'a'] });
  assert.deepEqual(next.spec.tools, ['a', 'b']);
  assert.equal(next.spec.instructions, base.spec.instructions);
  assert.notEqual(next.digest, base.digest);
});

test('normalizePatch accepts string shorthand and rejects invalid types', () => {
  assert.deepEqual(normalizePatch('新指令'), { instructions: '新指令', rationale: null });
  assert.equal(normalizePatch(null), null);
  assert.equal(normalizePatch({}), null);
  assert.throws(() => normalizePatch({ instructions: 3 }), /instructions/);
});

test('L1: single task converges within a few rounds and reports probes', async () => {
  const world = mockWorld({ markerFor: () => 'MAGIC_A' });
  const engine = createHarness2({ ...world, baseSpec, maxRounds: 4 });
  const run = await engine.runTask({ id: 't1', domain: 'sales', input: '整理线索' });
  assert.equal(run.solved, true);
  // baseline probe + one proposal probe
  assert.equal(run.probes.length, 2);
  assert.equal(run.probes[0].passed, false);
  assert.equal(run.probes[1].passed, true);
  assert.match(run.harness.spec.instructions, /MAGIC_A/);
  assert.notEqual(run.harness.digest, run.seedDigest);
});

test('L1: unsolved task stops at maxRounds with baseline probe included', async () => {
  const world = mockWorld({
    markerFor: () => 'NEVER',
    // always propose a *new* instruction that still lacks the marker
    steps: (_task, round) => ({ instructions: '尝试第 ' + round + ' 次，仍无标记', rationale: 'round ' + round }),
  });
  const engine = createHarness2({ ...world, baseSpec, maxRounds: 3 });
  const run = await engine.runTask({ id: 't2', input: '无解任务' });
  assert.equal(run.solved, false);
  assert.equal(run.probes.length, 4); // 1 baseline + 3 proposals
});

test('L1: a null proposal with a failing seed stops early', async () => {
  const world = mockWorld({ markerFor: () => 'X', steps: () => null });
  const engine = createHarness2({ ...world, baseSpec, maxRounds: 5 });
  const run = await engine.runTask({ id: 't3', input: 'x' });
  assert.equal(run.solved, false);
  assert.equal(run.probes.length, 1); // only baseline
});

test('L2: suite transfers a solved harness to later same-domain tasks', async () => {
  // Both tasks need the SAME marker, so the second is solved purely by transfer.
  const world = mockWorld({ markerFor: () => 'SHARED' });
  const engine = createHarness2({ ...world, baseSpec, maxRounds: 3 });
  const result = await engine.runSuite({
    tasks: [
      { id: 'a1', domain: 'sales', input: '任务一' },
      { id: 'a2', domain: 'sales', input: '任务二' },
    ],
  });
  assert.equal(result.solved, 2);
  assert.equal(result.tasks[0].solved, true);
  assert.equal(result.tasks[0].improved, true);
  assert.equal(result.tasks[1].solved, true);
  assert.equal(result.tasks[1].improved, false, 'second task should reuse the transferred harness');
  assert.equal(result.tasks[1].rounds, 1, 'second task solved by baseline probe only');
  assert.equal(result.candidates.length, 1, 'only the first task produced a candidate');
});

test('human gate: candidate is not persisted until promoted; rollback removes it', async () => {
  const world = mockWorld({ markerFor: () => 'GOV' });
  const engine = createHarness2({ ...world, baseSpec, maxRounds: 3 });
  const result = await engine.runSuite({ tasks: [{ id: 'g1', domain: 'ops', input: '治理' }] });
  assert.equal(result.candidates.length, 1);
  assert.equal(engine.snapshot().library.length, 0, 'not persisted before promotion');

  const entry = engine.promote(result.candidates[0].id, { approvedBy: 'tester' });
  assert.equal(engine.snapshot().library.length, 1);
  assert.equal(engine.snapshot().library[0].domain, 'ops');
  assert.equal(engine.snapshot().library[0].approvedBy, 'tester');

  const removed = engine.rollback(entry.id);
  assert.equal(removed.id, entry.id);
  assert.equal(engine.snapshot().library.length, 0);
  const candidate = engine.snapshot().candidates.find((item) => item.id === result.candidates[0].id);
  assert.equal(candidate.status, 'rolled_back');
});

test('promote rejects unknown or already-adopted candidates', async () => {
  const world = mockWorld({ markerFor: () => 'MARK_Z' });
  const engine = createHarness2({ ...world, baseSpec, maxRounds: 2 });
  assert.throws(() => engine.promote('missing'), /not found/);
  const result = await engine.runSuite({ tasks: [{ id: 'p1', input: 'x' }] });
  engine.promote(result.candidates[0].id);
  assert.throws(() => engine.promote(result.candidates[0].id), /only pending/);
});

test('invalid proposer output is rejected', async () => {
  const engine = createHarness2({
    propose: async () => ({ instructions: 42 }),
    execute: async () => ({ answer: 'NO' }),
    verify: async () => ({ passed: false }),
    baseSpec,
    maxRounds: 2,
  });
  await assert.rejects(engine.runTask({ id: 'bad', input: 'x' }), /instructions/);
});

test('serialize/fromState round-trips the learned experience library', async () => {
  const world = mockWorld({ markerFor: () => 'PERSIST' });
  const engine = createHarness2({ ...world, baseSpec, maxRounds: 2 });
  const result = await engine.runSuite({ tasks: [{ id: 's1', domain: 'd1', input: 'x' }] });
  engine.promote(result.candidates[0].id);
  const saved = engine.serialize();
  assert.equal(saved.version, HARNESS2_VERSION);
  assert.equal(saved.library.length, 1);

  const restored = Harness2.fromState({ ...world, maxRounds: 2 }, JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.snapshot().library.length, 1);
  // The restored library should seed a fresh same-domain task.
  const run = await restored.runTask({ id: 's2', domain: 'd1', input: 'y' });
  assert.equal(run.solved, true);
  assert.equal(run.probes.length, 1);
});

test('audit trail records init, candidate, suite, promote', async () => {
  const world = mockWorld({ markerFor: () => 'AUDIT' });
  const engine = createHarness2({ ...world, baseSpec, maxRounds: 2 });
  const result = await engine.runSuite({ tasks: [{ id: 'u1', domain: 'aud', input: 'x' }] });
  engine.promote(result.candidates[0].id);
  const actions = engine.history(50).map((entry) => entry.action);
  assert.ok(actions.includes('init'));
  assert.ok(actions.includes('candidate'));
  assert.ok(actions.includes('suite'));
  assert.ok(actions.includes('promote'));
});

test('runSuite validates tasks and rejects empty input', async () => {
  const world = mockWorld({ markerFor: () => 'MARK_W' });
  const engine = createHarness2({ ...world, baseSpec });
  await assert.rejects(engine.runSuite({ tasks: [] }), /non-empty/);
  await assert.rejects(engine.runSuite({ tasks: [{ input: 'no id' }] }), /id/);
});
