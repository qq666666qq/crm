// Harness² engine — Recursive Agent Harnessing for an open world.
// Implements the two layers described in google-research/harness2
// ("Recursive Agent Harnessing for an Open World", arXiv:2610.14224):
//   L1  task-level  Propose -> Probe -> Compose  (per-task harness search)
//   L2  harness-level experience library          (cross-task transfer)
// Safety boundary: a "harness" here is a *configuration* (instructions +
// tool allow-list), never executable code. Proposals are data and are
// validated before use; nothing is eval'd. Promotion to the persistent
// experience library requires a human gate (consistent with this app's
// approval model), while within a single suite run improvements transfer
// task-to-task automatically to preserve the recursive behaviour.

import { randomUUID, createHash } from 'node:crypto';

export const HARNESS2_VERSION = 1;

const MAX_INSTRUCTIONS = 20000;
const MAX_TOOLS = 32;
const MAX_TOOL_NAME = 120;
const MAX_LESSON = 2000;

function fail(message) {
  throw new Error('harness2: ' + message);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return prefix + '_' + randomUUID();
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function safeJson(value) {
  try {
    return clone(value === undefined ? null : value);
  } catch {
    return String(value);
  }
}

function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).find((entry) => entry.trim());
  return line ? line.trim() : '';
}

function truncate(text, limit) {
  const value = String(text || '');
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}

// ---- harness specs -------------------------------------------------------

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('harness spec must be an object');
  if (typeof spec.instructions !== 'string' || !spec.instructions.trim()) fail('instructions must be a non-empty string');
  if (spec.instructions.length > MAX_INSTRUCTIONS) fail('instructions too long');
  const rawTools = spec.tools === undefined ? [] : spec.tools;
  if (!Array.isArray(rawTools)) fail('tools must be an array');
  if (rawTools.length > MAX_TOOLS) fail('too many tools');
  const tools = [];
  for (const tool of rawTools) {
    if (typeof tool !== 'string' || !tool.trim()) fail('tools must be non-empty strings');
    if (tool.length > MAX_TOOL_NAME) fail('tool name too long');
    if (!tools.includes(tool.trim())) tools.push(tool.trim());
  }
  return { instructions: spec.instructions.trim(), tools };
}

export function createHarness(spec) {
  const validated = validateSpec(spec);
  return { id: newId('h'), digest: digestOf(validated), spec: validated };
}

function harnessFromSpec(spec) {
  const validated = validateSpec(spec);
  return { id: newId('h'), digest: digestOf(validated), spec: validated };
}

// Compose a proposal patch onto a base harness. Only the two safe fields are
// accepted; anything else in the patch is ignored.
export function composeHarness(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('patch must be an object');
  const next = {
    instructions: patch.instructions !== undefined ? patch.instructions : base.spec.instructions,
    tools: patch.tools !== undefined ? patch.tools : base.spec.tools,
  };
  const validated = validateSpec(next);
  return { id: newId('h'), digest: digestOf(validated), spec: validated };
}

// Normalise whatever a proposer returns into a patch, a string (shorthand for
// new instructions), or null (no further proposal -> stop searching).
export function normalizePatch(proposed) {
  if (proposed === null || proposed === undefined) return null;
  if (typeof proposed === 'string') {
    return proposed.trim() ? { instructions: proposed, rationale: null } : null;
  }
  if (typeof proposed !== 'object' || Array.isArray(proposed)) fail('proposer must return an object, string, or null');
  const patch = {};
  let changed = false;
  if (proposed.instructions !== undefined) {
    if (typeof proposed.instructions !== 'string') fail('patch.instructions must be a string');
    patch.instructions = proposed.instructions;
    changed = true;
  }
  if (proposed.tools !== undefined) {
    if (!Array.isArray(proposed.tools)) fail('patch.tools must be an array');
    patch.tools = proposed.tools;
    changed = true;
  }
  if (!changed) return null;
  const rationale = proposed.rationale ?? proposed.reason ?? null;
  patch.rationale = typeof rationale === 'string' ? rationale : null;
  return patch;
}

export function validateTask(task, index = 0) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail('task[' + index + '] must be an object');
  if (typeof task.id !== 'string' || !task.id.trim()) fail('task[' + index + '].id must be a non-empty string');
  if (typeof task.input !== 'string') fail('task[' + index + '].input must be a string');
  if (task.domain != null && typeof task.domain !== 'string') fail('task[' + index + '].domain must be a string');
  if (task.expected != null && typeof task.expected !== 'string') fail('task[' + index + '].expected must be a string');
  return {
    id: task.id.trim(),
    domain: task.domain ? task.domain.trim() : null,
    input: task.input,
    expected: task.expected,
    title: typeof task.title === 'string' ? task.title : task.id,
  };
}

function summarizeRun(run) {
  return {
    taskId: run.taskId,
    domain: run.domain,
    solved: run.solved,
    rounds: run.probes.length,
    harnessDigest: run.harness.digest,
    seedDigest: run.seedDigest,
    improved: run.harness.digest !== run.seedDigest,
    probes: run.probes.map((probe) => ({
      harnessDigest: probe.harness.digest,
      passed: probe.passed,
      score: probe.score,
      rationale: probe.patchRationale,
    })),
  };
}

// ---- engine --------------------------------------------------------------

export class Harness2 {
  constructor({ propose, execute, verify, baseSpec, maxRounds = 4 } = {}) {
    if (typeof propose !== 'function') fail('propose must be a function');
    if (typeof execute !== 'function') fail('execute must be a function');
    if (typeof verify !== 'function') fail('verify must be a function');
    this.propose = propose;
    this.execute = execute;
    this.verify = verify;
    this.maxRounds = clampInt(maxRounds, 1, 12, 4);
    const base = baseSpec ? validateSpec(baseSpec) : { instructions: '你是一个 CRM 销售助手。', tools: [] };
    this.state = {
      version: HARNESS2_VERSION,
      base: { id: newId('base'), digest: digestOf(base), spec: base },
      library: [],
      candidates: [],
      audit: [],
    };
    this._provisional = new Map();
    this._audit('init', {});
  }

  _audit(action, detail) {
    const entry = { id: newId('audit'), action, at: nowIso(), detail: clone(detail || {}) };
    this.state.audit.push(entry);
    return entry;
  }

  // Best adopted experience for a domain: provisional (this suite run) first,
  // then the most recently adopted library entry for the exact domain, then a
  // wildcard ('*') entry. Returns a harness or null.
  _resolveSeed(domain) {
    const key = domain || '*';
    const provisional = this._provisional.get(key);
    if (provisional) return harnessFromSpec(provisional);
    const scoped = this.state.library.filter((entry) => entry.domain === key);
    const pool = scoped.length ? scoped : this.state.library.filter((entry) => entry.domain === '*');
    if (!pool.length) return null;
    const latest = pool.reduce((best, entry) => (entry.adoptedAt > best.adoptedAt ? entry : best));
    return harnessFromSpec(latest.harness.spec);
  }

  seed(domain) {
    return this._resolveSeed(domain) || harnessFromSpec(this.state.base.spec);
  }

  async probe(task, harness) {
    const output = await this.execute({ harness: clone(harness.spec), task: clone(task) });
    const verdict = await this.verify({ task: clone(task), output: safeJson(output), harness: clone(harness.spec) });
    if (!verdict || typeof verdict.passed !== 'boolean') fail('verify must resolve to { passed: boolean }');
    return {
      taskId: task.id,
      harness: { id: harness.id, digest: harness.digest },
      patchRationale: harness.patchRationale || null,
      output: safeJson(output),
      passed: verdict.passed,
      score: typeof verdict.score === 'number' ? verdict.score : null,
      evidence: safeJson(verdict.evidence ?? null),
    };
  }

  async runTask(rawTask) {
    const task = validateTask(rawTask);
    let current = this.seed(task.domain);
    const seedDigest = current.digest;
    const probes = [];
    // Probe the seed harness first: a task may already be solvable with the
    // experience carried over from earlier work.
    const baseline = await this.probe(task, current);
    probes.push(baseline);
    if (baseline.passed) {
      return { taskId: task.id, domain: task.domain, solved: true, seedDigest, harness: current, probes };
    }
    for (let round = 0; round < this.maxRounds; round += 1) {
      const proposed = await this.propose({
        task: clone(task),
        harness: { id: current.id, digest: current.digest, spec: clone(current.spec) },
        probes: clone(probes),
        round,
      });
      const patch = normalizePatch(proposed);
      if (!patch) break;
      const candidate = composeHarness(current, patch);
      candidate.patchRationale = patch.rationale || null;
      if (candidate.digest === current.digest) break; // no-op proposal
      const probe = await this.probe(task, candidate);
      probes.push(probe);
      if (probe.passed) {
        return { taskId: task.id, domain: task.domain, solved: true, seedDigest, harness: candidate, probes };
      }
      current = candidate;
    }
    return { taskId: task.id, domain: task.domain, solved: false, seedDigest, harness: current, probes };
  }

  _lessonFor(task, run) {
    const rationale = run.probes.length ? run.probes[run.probes.length - 1].patchRationale : null;
    if (rationale) return truncate(rationale, MAX_LESSON);
    return truncate('在领域 ' + (task.domain || '通用') + ' 通过自定义 harness 解决任务：' + firstLine(run.harness.spec.instructions), MAX_LESSON);
  }

  _recordCandidate(task, run) {
    const last = run.probes[run.probes.length - 1] || null;
    const evaluation = {
      passed: Boolean(last && last.passed),
      score: last ? last.score : null,
      evidence: last ? last.evidence : null,
      rounds: run.probes.length,
      taskId: task.id,
    };
    const candidate = {
      id: newId('cand'),
      domain: task.domain || '*',
      harness: { id: run.harness.id, digest: run.harness.digest, spec: clone(run.harness.spec) },
      lesson: this._lessonFor(task, run),
      evaluation,
      status: 'candidate',
      createdAt: nowIso(),
    };
    this.state.candidates.push(candidate);
    this._audit('candidate', { candidateId: candidate.id, domain: candidate.domain, taskId: task.id });
    return candidate;
  }

  // Run a suite of tasks. Within the suite, a solved improvement becomes
  // provisional experience for later tasks of the same domain (L2 transfer);
  // it still must be promoted by a human to persist across runs.
  async runSuite({ tasks, autoAdopt = false } = {}) {
    if (!Array.isArray(tasks) || tasks.length === 0) fail('tasks must be a non-empty array');
    if (tasks.length > 50) fail('too many tasks in one suite');
    const validated = tasks.map((task, index) => validateTask(task, index));
    this._provisional = new Map();
    const runs = [];
    const produced = [];
    try {
      for (const task of validated) {
        const run = await this.runTask(task);
        runs.push(summarizeRun(run));
        if (run.solved && run.harness.digest !== run.seedDigest) {
          const candidate = this._recordCandidate(task, run);
          produced.push({
            id: candidate.id,
            domain: candidate.domain,
            lesson: candidate.lesson,
            evaluation: candidate.evaluation,
            status: candidate.status,
          });
          // Provisional cross-task transfer for the remainder of this suite.
          this._provisional.set(candidate.domain, clone(run.harness.spec));
          if (autoAdopt) this.promote(candidate.id, { approvedBy: 'auto' });
        }
      }
    } finally {
      this._provisional = new Map();
    }
    this._audit('suite', { tasks: validated.length, solved: runs.filter((run) => run.solved).length, produced: produced.length });
    return {
      tasks: runs,
      solved: runs.filter((run) => run.solved).length,
      total: runs.length,
      candidates: produced,
    };
  }

  promote(candidateId, { approvedBy = 'human' } = {}) {
    const candidate = this.state.candidates.find((entry) => entry.id === candidateId);
    if (!candidate) fail('candidate not found: ' + candidateId);
    if (candidate.status !== 'candidate') fail('only pending candidates can be promoted');
    if (!candidate.evaluation || !candidate.evaluation.passed) fail('candidate has not passed evaluation');
    const entry = {
      id: newId('exp'),
      domain: candidate.domain,
      harness: clone(candidate.harness),
      lesson: candidate.lesson,
      evaluation: clone(candidate.evaluation),
      adoptedAt: nowIso(),
      approvedBy,
      candidateId: candidate.id,
    };
    this.state.library.push(entry);
    candidate.status = 'adopted';
    this._audit('promote', { candidateId: candidate.id, entryId: entry.id, domain: entry.domain });
    return clone(entry);
  }

  rollback(entryId) {
    const index = this.state.library.findIndex((entry) => entry.id === entryId);
    if (index < 0) fail('experience entry not found: ' + entryId);
    const [removed] = this.state.library.splice(index, 1);
    const candidate = this.state.candidates.find((entry) => entry.id === removed.candidateId);
    if (candidate && candidate.status === 'adopted') candidate.status = 'rolled_back';
    this._audit('rollback', { entryId: removed.id, domain: removed.domain });
    return clone(removed);
  }

  adoptedFor(domain) {
    const key = domain || '*';
    const scoped = this.state.library.filter((entry) => entry.domain === key);
    const pool = scoped.length ? scoped : this.state.library.filter((entry) => entry.domain === '*');
    return clone(pool);
  }

  snapshot() {
    return {
      version: this.state.version,
      base: clone(this.state.base),
      library: clone(this.state.library),
      candidates: clone(this.state.candidates),
      audit: clone(this.state.audit),
      counts: {
        experiences: this.state.library.length,
        candidates: this.state.candidates.filter((entry) => entry.status === 'candidate').length,
        adopted: this.state.candidates.filter((entry) => entry.status === 'adopted').length,
      },
    };
  }

  history(limit = 100) {
    const entries = this.state.audit.slice(-Math.max(1, limit));
    return clone(entries);
  }

  serialize() {
    return clone(this.state);
  }

  static fromState({ propose, execute, verify, maxRounds = 4 } = {}, state) {
    const engine = new Harness2({ propose, execute, verify, maxRounds });
    if (state && typeof state === 'object' && state.version === HARNESS2_VERSION) {
      engine.state = {
        version: HARNESS2_VERSION,
        base: state.base && state.base.spec ? clone(state.base) : engine.state.base,
        library: Array.isArray(state.library) ? clone(state.library) : [],
        candidates: Array.isArray(state.candidates) ? clone(state.candidates) : [],
        audit: Array.isArray(state.audit) ? clone(state.audit) : [],
      };
    }
    return engine;
  }
}

export function createHarness2(options) {
  return new Harness2(options);
}
