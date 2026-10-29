import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { answer } from '../src/ask.ts';
import { Memory } from '../src/memory.ts';
import { askArchive, askTool, ASK_CAP, memoryTools, staleFiles } from '../src/tools.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';

const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ic-ask-'));
  // An empty models store keeps the real ~/.pi/agent one from leaking in.
  writeFileSync(join(dir, 'models-cache.json'), '{}');
  return dir;
};

const fakeRegistry = async (dir: string, reply: (question: string, archive: string) => string) => {
  const seen: { question: string; archive: string }[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  runtime.registerProvider('infinite-chat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'answerer', name: 'Synthetic answerer', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const user = context.messages.find(m => m.role === 'user');
      const text = textContent(user?.content);
      const archive = /<archive>\n([\s\S]*?)\n<\/archive>/.exec(text)?.[1] ?? '';
      const question = text.split('\n\n').at(-1) ?? '';
      seen.push({ question, archive });
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: reply(question, archive) }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      void (async () => {
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: message.content[0].type === 'text' ? message.content[0].text : '', partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  return { registry, seen };
};

const textOf = (out: { content: readonly { type: string; text?: string }[] }) => out.content[0]?.text ?? '';

test('staleFiles names only files a line names that changed after the line was written', () => {
  const dir = sandbox();
  try {
    const old = join(dir, 'old.ts'), fresh = join(dir, 'fresh.json');
    writeFileSync(old, 'export {}'); writeFileSync(fresh, '{}');
    utimesSync(old, new Date(0), new Date(0));
    // The line predates fresh.json's touch by a minute, so fresh is changed and old is not.
    const memory = { root: [{ i: 0, kind: 'tool', text: '', date: new Date(Date.now() - 60_000).toISOString() }] } as unknown as Memory;
    const note = staleFiles(memory, 0, `edited ${old} and ${fresh}.`);
    assert.match(note, /fresh\.json/, 'the changed file is named');
    assert.ok(!note.includes(`${old}:`) && !/old\.ts/.test(note), 'the untouched file is not');
    assert.match(note, /changed after this line/);
    assert.equal(staleFiles(memory, 0, 'no paths at all'), '');
    assert.equal(staleFiles(memory, 99, 'x'), '', 'an unknown line says nothing');
    // A relative path resolves and is judged the same way.
    writeFileSync(join(dir, 'rel.ts'), 'export {}');
    utimesSync(join(dir, 'rel.ts'), new Date(0), new Date(0));
    assert.doesNotMatch(staleFiles(memory, 0, `see ${join(dir, 'rel.ts')}`), /rel\.ts/);
    // More than three changed files fold into "+N more".
    const many = [1, 2, 3, 4, 5].map(k => { const f = join(dir, `many-${k}.md`); writeFileSync(f, 'x'); return f; }).join(' ');
    assert.match(staleFiles(memory, 0, many), /\+2 more/);
    // A bare filename resolves against the session's working directory.
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      writeFileSync(join(dir, 'bare.json'), '{}');
      assert.match(staleFiles(memory, 0, 'see bare.json'), /bare\.json/);
    } finally { process.chdir(cwd); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('askArchive keeps short text whole and cuts a huge one to head and tail', () => {
  const small = 'x'.repeat(1000);
  assert.equal(askArchive(small), small);
  const big = 'a'.repeat(100_000) + 'MIDDLE-MARKER' + 'b'.repeat(150_000);
  const cut = askArchive(big);
  assert.ok(cut.length <= ASK_CAP + 200, 'the cut archive stays near the cap');
  assert.match(cut, /characters cut/);
  assert.ok(cut.startsWith('a') && cut.endsWith('b'), 'head and tail survive');
  assert.ok(!cut.includes('MIDDLE-MARKER'), 'only the middle goes');
});

test('ask answers one question about a line through the compactor model, records usage, and notes stale files', async () => {
  const dir = sandbox();
  try {
    const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
    const plan = join(dir, 'launch-plan.md');
    memory.append('user', `The launch is on Friday. See ${plan} for the runbook.`, new Date(Date.now() - 60_000).toISOString());
    writeFileSync(plan, '# runbook');
    const { registry, seen } = await fakeRegistry(dir, question => `Answer: ${question.includes('launch') ? 'Friday' : 'unknown'}`);
    const usage: AssistantMessage[] = [];
    const sessions: string[] = [];
    const tool = askTool({ memory: () => memory, choice: () => ({ provider: 'infinite-chat-test', model: 'answerer', thinking: 'off' }),
      onUsage: (message, session) => { usage.push(message); sessions.push(session); } });
    const out = await tool.execute('t1', { question: 'When is the launch?', id: 0 },
      undefined, undefined, { modelRegistry: registry });
    const text = textOf(out);
    assert.match(text, /Friday/);
    assert.match(text, /launch-plan\.md/, 'the stale-file note follows the answer');
    assert.match(seen[0].archive, /The launch is on Friday/, 'the archive reaches the model');
    assert.match(seen[0].question, /When is the launch\?/, 'so does the question');
    assert.equal(seen.length, 1, 'one model call');
    assert.equal(usage.length, 1, 'usage is recorded');
    // A message id that does not exist, and a model that does, fail with the compactor's phrasing.
    await assert.rejects(tool.execute('t2', { question: 'x', id: 99 }, undefined, undefined, { modelRegistry: registry }), /No message 99/);
    const missing = askTool({ memory: () => memory, choice: () => ({ provider: 'infinite-chat-test', model: 'nope', thinking: 'off' }) });
    await assert.rejects(missing.execute('t3', { question: 'x', id: 0 }, undefined, undefined, { modelRegistry: registry }), /Ask model unavailable/);
    await assert.rejects(tool.execute('t4', { question: 'x', id: 0 }, undefined, undefined, {}), /No model registry/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ask over a subtree and a run transcript; zoom notes stale files too', async () => {
  const dir = sandbox();
  try {
    const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
    memory.append('user', 'first');
    memory.append('user', 'second');
    memory.append('user', 'third');
    const { registry, seen } = await fakeRegistry(dir, (_question, archive) => `Answer: ${archive.includes('third') ? 'yes' : 'no'}`);
    const runMessages: AgentMessage[] = [{ role: 'user', content: [{ type: 'text' as const, text: 'run step one' }] }] as AgentMessage[];
    const tool = askTool({ memory: () => memory, runs: id => id === 'r1' ? runMessages : undefined, choice: () => ({ provider: 'infinite-chat-test', model: 'answerer', thinking: 'off' }) });
    const top = await tool.execute('t1', { question: 'is first or second there?', id: 0, n: 2 }, undefined, undefined, { modelRegistry: registry });
    assert.match(textOf(top), /no/, 'n=2 covers only the first two messages');
    const third = await tool.execute('t1b', { question: 'is third there?', id: 2, n: 1 }, undefined, undefined, { modelRegistry: registry });
    assert.match(textOf(third), /yes/, 'n=1 on message 2 reaches it');
    const run = await tool.execute('t2', { question: 'what did the run do?', id: 'r1' }, undefined, undefined, { modelRegistry: registry });
    assert.match(seen.at(-1)!.archive, /run step one/, 'the run transcript is the archive');
    assert.match(textOf(run), /yes|no/);
    await assert.rejects(tool.execute('t3', { question: 'x', id: 'nope' }, undefined, undefined, { modelRegistry: registry }), /No run nope/);
    await assert.rejects(tool.execute('t4', { question: 'x', id: 1, n: 3 }, undefined, undefined, { modelRegistry: registry }), /power of 2/);
    // zoom, the path ask saves context on, gains the same stale-file note.
    writeFileSync(join(dir, 'stale.md'), 'x');
    const memory2 = new Memory(join(dir, 'm2'), async input => input.source.slice(0, 100), () => {});
    memory2.append('user', `check ${join(dir, 'stale.md')}`, new Date(Date.now() - 60_000).toISOString());
    const [zoom] = memoryTools(() => memory2);
    const page = await zoom.execute('t5', { id: 0, n: 1 });
    assert.match(textOf(page), /files named here changed after this line: .*stale\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('answer surfaces model errors and empty replies', async () => {
  const dir = sandbox();
  try {
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    const registry = new ModelRegistry(runtime);
    runtime.registerProvider('infinite-chat-test', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'answerer', name: 'Synthetic answerer', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model) {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'error', errorMessage: 'provider down', usage: emptyUsage() };
        void (async () => { stream.push({ type: 'error', reason: 'error', error: message }); stream.end(); })();
        return stream;
      },
    });
    await assert.rejects(answer(registry, () => ({ provider: 'infinite-chat-test', model: 'answerer', thinking: 'off' }), 'archive', 'question'), /provider down|Ask model/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
