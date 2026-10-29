import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataHome, listLegacyProfiles, normalizeDir, profilePath } from '../src/profiles.ts';
import { agentDir, listSessions, sessionsDirFor, type SessionSummary } from '../src/sessions.ts';

const FAKE_PROJECT = normalizeDir(join(tmpdir(), 'ic-sessions-fake-project'));
// Same munged pool name ('[/\\:]' → '-'), so only the recorded header cwd tells the two apart.
const OTHER_PROJECT = normalizeDir(`${tmpdir()}/ic:sessions:fake:project`);

/** Saves the env vars these tests touch; HOME and PI_CODING_AGENT_DIR are already sandboxed by support.ts. */
function envSandbox() {
  const saved = { INFINITE_CHAT_HOME: process.env.INFINITE_CHAT_HOME, INFINITE_CHAT_NO_LEGACY: process.env.INFINITE_CHAT_NO_LEGACY, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  return () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}

let seq = 0;
const id = () => `e${String(++seq).padStart(4, '0')}`;

/** Writes a session file the way pi does: a header line, then custom and message entries, one JSON per line. */
function writeSession(dir: string, file: string, cwd: string, options: { bindings?: { legacy?: boolean; name: string }[]; userTexts?: string[] }) {
  const lines = [JSON.stringify({ type: 'session', version: 3, id: file.replace(/\.jsonl$/, ''), timestamp: '2026-10-29T00:00:00.000Z', cwd })];
  let parent: string | undefined;
  const link = (entry: Record<string, unknown>) => {
    const withParent = { id: id(), parentId: parent, timestamp: '2026-10-29T00:01:00.000Z', ...entry };
    parent = withParent.id as string;
    lines.push(JSON.stringify(withParent));
  };
  for (const binding of options.bindings ?? []) {
    link({ type: 'custom', customType: binding.legacy ? 'optchat.profile' : 'infinite-chat.profile', data: { name: binding.name } });
  }
  for (const text of options.userTexts ?? []) {
    link({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1792737586516 } });
  }
  fs.writeFileSync(join(dir, file), `${lines.join('\n')}\n`);
}

function at(dir: string, file: string, mtime: string) {
  const time = new Date(mtime);
  fs.utimesSync(join(dir, file), time, time);
}

const bound = (summary: SessionSummary) => summary.resolved;

test('sessionsDirFor munges the cwd the way pi encodes session pools', () => {
  assert.equal(sessionsDirFor('/tmp/project'), normalizeDir(join(agentDir(), 'sessions', '--tmp-project--')));
  assert.equal(sessionsDirFor(FAKE_PROJECT), normalizeDir(join(agentDir(), 'sessions', `--${FAKE_PROJECT.replace(/^\//, '').replace(/\//g, '-')}--`)));
});

test('lists the directory pool newest first, with profile bindings, rename follow, counts and previews', async () => {
  const restore = envSandbox();
  const root = fs.mkdtempSync(join(tmpdir(), 'ic-sessions-pool-'));
  process.env.INFINITE_CHAT_HOME = join(root, 'home');
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  try {
    const dir = sessionsDirFor(FAKE_PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(profilePath('alpha'), { recursive: true });
    fs.mkdirSync(profilePath('renamed-new'), { recursive: true });
    fs.writeFileSync(join(dataHome(), 'renames.json'), JSON.stringify({ 'renamed-old': 'renamed-new' }));

    writeSession(dir, 'a-unbound.jsonl', FAKE_PROJECT, { userTexts: ['first words of an old conversation'] });
    writeSession(dir, 'b-alpha.jsonl', FAKE_PROJECT, { bindings: [{ name: 'alpha' }], userTexts: ['fix the build\nand the lint', 'second message'] });
    writeSession(dir, 'c-renamed.jsonl', FAKE_PROJECT, { bindings: [{ name: 'renamed-old' }], userTexts: [`${'x'.repeat(70)} tail`] });
    at(dir, 'a-unbound.jsonl', '2026-10-28T10:00:00Z');
    at(dir, 'b-alpha.jsonl', '2026-10-29T12:00:00Z');
    at(dir, 'c-renamed.jsonl', '2026-10-29T23:00:00Z');

    const sessions = await listSessions(FAKE_PROJECT);
    assert.deepEqual(sessions.map(s => s.path.split('/').pop()), ['c-renamed.jsonl', 'b-alpha.jsonl', 'a-unbound.jsonl'], 'newest first');

    const [renamed, alpha, unbound] = sessions;
    assert.equal(bound(renamed!), 'renamed-new', 'a bound name follows the rename chain');
    assert.equal(renamed!.profile, 'renamed-old');
    assert.equal(renamed!.missing, false);
    assert.equal(renamed!.userMessages, 1);
    assert.match(renamed!.preview, /^x{60}…$/, 'long previews collapse to 60 characters');

    assert.equal(bound(alpha!), 'alpha');
    assert.equal(alpha!.userMessages, 2, 'one count per user message');
    assert.equal(alpha!.preview, 'fix the build and the lint', 'multi-line previews collapse whitespace');
    assert.equal(alpha!.owner, undefined, 'no lock means not busy');

    assert.equal(unbound!.profile, undefined);
    assert.equal(unbound!.resolved, undefined);
    assert.equal(unbound!.userMessages, 1);
    assert.equal(unbound!.legacy, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); restore(); }
});

test('the last binding wins and a bound name without a profile shows as missing, not legacy', async () => {
  const restore = envSandbox();
  const root = fs.mkdtempSync(join(tmpdir(), 'ic-sessions-bind-'));
  process.env.INFINITE_CHAT_HOME = join(root, 'home');
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  try {
    const dir = sessionsDirFor(FAKE_PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    // Rebound sessions carry every binding they ever had; the newest one decides.
    writeSession(dir, 'rebound.jsonl', FAKE_PROJECT, { bindings: [{ name: 'alpha' }, { name: 'beta' }], userTexts: ['hello'] });
    writeSession(dir, 'legacy-unconverted.jsonl', FAKE_PROJECT, { bindings: [{ legacy: true, name: 'old-tool' }], userTexts: ['hello'] });
    // A custom INFINITE_CHAT_HOME never reads the host's ~/.optchat, so the legacy list is empty here.
    assert.deepEqual(listLegacyProfiles(), []);

    const sessions = await listSessions(FAKE_PROJECT);
    const rebound = sessions.find(s => s.path.endsWith('rebound.jsonl'))!;
    assert.equal(rebound.profile, 'beta');
    assert.equal(rebound.missing, true, 'beta has no profile directory yet');
    assert.equal(rebound.legacy, false);

    const legacy = sessions.find(s => s.path.endsWith('legacy-unconverted.jsonl'))!;
    assert.equal(legacy.profile, 'old-tool');
    assert.equal(legacy.missing, true, 'without a host legacy home an unknown old name cannot be converted');
    assert.equal(legacy.legacy, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); restore(); }
});

test('sessions recorded for another directory stay out of the listing', async () => {
  const restore = envSandbox();
  const root = fs.mkdtempSync(join(tmpdir(), 'ic-sessions-cwd-'));
  process.env.INFINITE_CHAT_HOME = join(root, 'home');
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  try {
    const dir = sessionsDirFor(FAKE_PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    writeSession(dir, 'mine.jsonl', FAKE_PROJECT, { userTexts: ['mine'] });
    writeSession(dir, 'theirs.jsonl', OTHER_PROJECT, { userTexts: ['theirs'] });

    const sessions = await listSessions(FAKE_PROJECT);
    assert.deepEqual(sessions.map(s => s.path.split('/').pop()), ['mine.jsonl']);
    const other = await listSessions(OTHER_PROJECT);
    assert.deepEqual(other.map(s => s.path.split('/').pop()), ['theirs.jsonl'], 'a munge collision is resolved by the header cwd, like pi discovery does');
  } finally { fs.rmSync(root, { recursive: true, force: true }); restore(); }
});

test('a directory with no pool lists as empty instead of throwing', async () => {
  const restore = envSandbox();
  const root = fs.mkdtempSync(join(tmpdir(), 'ic-sessions-empty-'));
  process.env.INFINITE_CHAT_HOME = join(root, 'home');
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  try {
    assert.deepEqual(await listSessions(join(root, 'nowhere')), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); restore(); }
});
