import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfile, dataHome, defaults, globalConfigPath, groupProfiles, lastProfile, listProfilesMeta, loadConfig, loadGlobalConfig, loadMeta, migrateLegacyHome, normalizeDir, profilePath, rememberProfile, socketCandidates } from '../src/profiles.ts';
import { removeDir } from './support.ts';

/** Saves the env vars these tests touch; HOME is already sandboxed by support.ts. */
function envSandbox() {
  const saved = { INFINITE_CHAT_HOME: process.env.INFINITE_CHAT_HOME, OPTCHAT_HOME: process.env.OPTCHAT_HOME, INFINITE_CHAT_SOCK_HOME: process.env.INFINITE_CHAT_SOCK_HOME, INFINITE_CHAT_NO_MIGRATE: process.env.INFINITE_CHAT_NO_MIGRATE };
  return () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}

test('dataHome defaults to ~/.infinite-chat, moved by INFINITE_CHAT_HOME, with OPTCHAT_HOME as a legacy fallback', () => {
  const cleanup = envSandbox();
  try {
    delete process.env.INFINITE_CHAT_HOME; delete process.env.OPTCHAT_HOME;
    assert.equal(dataHome(), normalizeDir(join(homedir(), '.infinite-chat')));
    process.env.OPTCHAT_HOME = join(homedir(), 'legacy-home');
    assert.equal(dataHome(), normalizeDir(join(homedir(), 'legacy-home')), 'the pi-optchat spelling still works');
    process.env.INFINITE_CHAT_HOME = join(homedir(), 'new-home');
    assert.equal(dataHome(), normalizeDir(join(homedir(), 'new-home')), 'the new spelling wins');
  } finally { cleanup(); }
});

test('a profile records the directory it was created in, and the picker groups by it', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'infinite-chat-scope-'));
  const cleanup = envSandbox();
  process.env.INFINITE_CHAT_HOME = join(dir, 'home');
  try {
    const projectA = normalizeDir(fs.mkdtempSync(join(dir, 'project-a-'))), projectB = normalizeDir(fs.mkdtempSync(join(dir, 'project-b-')));
    createProfile('a-work', projectA);
    createProfile('b-work', projectB);
    createProfile('drifter');
    const meta = loadMeta(profilePath('a-work'));
    assert.equal(meta.cwd, projectA);
    assert.ok(meta.createdAt, 'creation time is recorded');

    const { here, others } = groupProfiles(listProfilesMeta(), projectA);
    assert.deepEqual(here.map(({ name }) => name), ['a-work', 'drifter'], 'unscoped profiles are offered in every directory');
    assert.deepEqual(others.map(({ name }) => name), ['b-work']);

    rememberProfile('b-work', projectB);
    rememberProfile('a-work', projectA); // a-work last, so it is the most recent in project A
    assert.equal(lastProfile(projectA), 'a-work');
    assert.equal(lastProfile(projectB), 'b-work');
    const nowhere = groupProfiles(listProfilesMeta(), projectB);
    assert.deepEqual(nowhere.here.map(({ name }) => name), ['b-work', 'drifter'], 'unscoped profiles show in every directory');
    assert.deepEqual(nowhere.others.map(({ name }) => name), ['a-work']);
  } finally { cleanup(); removeDir(dir); }
});

test('a profile opened elsewhere from an unscoped state claims that directory', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'infinite-chat-adopt-'));
  const cleanup = envSandbox();
  process.env.INFINITE_CHAT_HOME = join(dir, 'home');
  try {
    const project = normalizeDir(fs.mkdtempSync(join(dir, 'project-')));
    createProfile('orphan');
    assert.equal(loadMeta(profilePath('orphan')).cwd, undefined);
    rememberProfile('orphan', project);
    assert.equal(loadMeta(profilePath('orphan')).cwd, project, 'first open scopes the profile');
    assert.equal(lastProfile(project), 'orphan');
    const elsewhere = normalizeDir(fs.mkdtempSync(join(dir, 'elsewhere-')));
    rememberProfile('orphan', elsewhere);
    assert.equal(loadMeta(profilePath('orphan')).cwd, project, 'a scoped profile keeps its directory');
  } finally { cleanup(); removeDir(dir); }
});

test('~/.infinite-chat/config.json seeds new profiles and fills gaps when a profile loads', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'infinite-chat-global-'));
  const cleanup = envSandbox();
  process.env.INFINITE_CHAT_HOME = dir;
  try {
    fs.writeFileSync(globalConfigPath(), JSON.stringify({
      compactor: { provider: 'zai-coding-cn', model: 'glm-5.3', thinking: 'high' },
      subagentLevels: 3, previousExchange: false,
    }));
    const warnings: string[] = [];
    const global = loadGlobalConfig(warning => warnings.push(warning));
    createProfile('seeded', undefined, global);
    const config = loadConfig(profilePath('seeded'), global);
    assert.deepEqual(config.compactor, { provider: 'zai-coding-cn', model: 'glm-5.3', thinking: 'high' }, 'the global compactor becomes the new profile choice');
    assert.deepEqual(config.subagent, defaults.subagent, 'roles the global file leaves out keep the built-in defaults');
    assert.equal(config.subagentLevels, 3);
    assert.equal(config.previousExchange, false);
    assert.deepEqual(config.maxAgents, defaults.maxAgents);

    // A profile config that leaves keys out inherits them from the global file at load time.
    fs.mkdirSync(profilePath('partial'), { recursive: true });
    fs.writeFileSync(join(profilePath('partial'), 'config.json'), JSON.stringify({ subagent: defaults.subagent }));
    const partial = loadConfig(profilePath('partial'), global);
    assert.deepEqual(partial.compactor, global.compactor);
    assert.equal(partial.subagentLevels, 3);
    assert.equal(partial.maxAgents, defaults.maxAgents, 'keys neither file has take the built-in default');

    // Without a global file nothing is inherited.
    fs.rmSync(globalConfigPath());
    const plain = loadConfig(profilePath('partial'));
    assert.deepEqual(plain.compactor, defaults.compactor);
    assert.equal(plain.subagentLevels, defaults.subagentLevels);
    assert.equal(plain.previousExchange, defaults.previousExchange);
  } finally { cleanup(); removeDir(dir); }
});

test('an invalid global config warns and is ignored, key by key', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'infinite-chat-badcfg-'));
  const cleanup = envSandbox();
  process.env.INFINITE_CHAT_HOME = dir;
  try {
    const warnings: string[] = [];
    const warn = (warning: string) => warnings.push(warning);
    fs.writeFileSync(globalConfigPath(), 'not json');
    assert.deepEqual(loadGlobalConfig(warn), {});
    fs.writeFileSync(globalConfigPath(), JSON.stringify({ compactor: { provider: 'x', model: 'y' }, maxAgents: -1, subagentLevels: 2 }));
    const config = loadGlobalConfig(warn);
    assert.equal(config.compactor, undefined, 'a bad model choice is dropped');
    assert.equal(config.maxAgents, undefined, 'an out-of-range number is dropped');
    assert.equal(config.subagentLevels, 2, 'the valid keys around them still apply');
    assert.equal(warnings.length, 3, 'one warning per dropped key, plus the earlier parse failure');
    fs.writeFileSync(globalConfigPath(), JSON.stringify(['not', 'an', 'object']));
    assert.deepEqual(loadGlobalConfig(warn).subagentLevels, undefined);
  } finally { cleanup(); removeDir(dir); }
});

test('a previous ~/.optchat install is copied into ~/.infinite-chat once, sockets excepted', () => {
  const cleanup = envSandbox();
  delete process.env.INFINITE_CHAT_HOME; delete process.env.OPTCHAT_HOME; delete process.env.INFINITE_CHAT_NO_MIGRATE;
  const home = mkdtempHome();
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const legacyProfile = join(home, '.optchat', 'profiles', 'old');
    fs.mkdirSync(legacyProfile, { recursive: true });
    fs.writeFileSync(join(legacyProfile, 'config.json'), '{}');
    fs.writeFileSync(join(home, '.optchat', 'profiles', 'old', 'lock.sock'), 'stale');
    fs.writeFileSync(join(home, '.optchat', 'last-profile'), 'old');

    const first = migrateLegacyHome(error => { throw error; });
    assert.deepEqual(first, ['old']);
    assert.equal(fs.readFileSync(join(home, '.infinite-chat', 'profiles', 'old', 'config.json'), 'utf8'), '{}');
    assert.ok(!fs.existsSync(join(home, '.infinite-chat', 'profiles', 'old', 'lock.sock')), 'stale sockets are not copied');
    assert.ok(fs.existsSync(join(home, '.optchat', 'profiles', 'old', 'config.json')), 'the old install keeps its data');
    assert.deepEqual(migrateLegacyHome(), [], 'the second run is a no-op');

    fs.rmSync(join(home, '.infinite-chat'), { recursive: true, force: true });
    process.env.INFINITE_CHAT_NO_MIGRATE = '1';
    assert.deepEqual(migrateLegacyHome(), [], 'INFINITE_CHAT_NO_MIGRATE skips the copy');
    delete process.env.INFINITE_CHAT_NO_MIGRATE;
    fs.rmSync(join(home, '.optchat'), { recursive: true, force: true });
    assert.deepEqual(migrateLegacyHome(), [], 'nothing to migrate, nothing happens');
  } finally {
    cleanup();
    process.env.HOME = homedir(); process.env.USERPROFILE = homedir();
    removeDir(home);
  }
});

test('socket candidates prefer an explicit sock home, then the profile, and always stay under the path limit', () => {
  // Short paths on macOS: the limit there is 103 bytes, and the default tmpdir is ~49 already.
  const root = fs.mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'infinite-chat-sock-'));
  const dir = join(root, 'd');
  fs.mkdirSync(dir);
  const cleanup = envSandbox();
  process.env.INFINITE_CHAT_HOME = join(root, 'home');
  delete process.env.INFINITE_CHAT_SOCK_HOME;
  try {
    if (process.platform !== 'win32') {
      assert.deepEqual(socketCandidates(dir)[0], join(dir, 'lock.sock'), 'the profile directory is the first choice');
      const candidates = socketCandidates(dir, 'windows');
      assert.ok(candidates.some(path => path.startsWith(join(process.env.INFINITE_CHAT_HOME!, 'sock'))), 'the data home offers a fallback');
      assert.ok(candidates.every(path => Buffer.byteLength(path) <= 107), 'every candidate fits sun_path on Linux-sized limits');

      const overLimit = join(dir, 'q'.repeat(200));
      assert.notEqual(socketCandidates(overLimit)[0], join(overLimit, 'lock.sock'), 'an over-long profile path is skipped');
      assert.ok(Buffer.byteLength(socketCandidates(overLimit)[0]) <= 107);

      process.env.INFINITE_CHAT_SOCK_HOME = join(dir, 'sockhome');
      assert.ok(socketCandidates(dir)[0].startsWith(join(dir, 'sockhome')), 'an explicit sock home wins');
    }
  } finally { cleanup(); removeDir(root); }
});

function mkdtempHome() { return fs.mkdtempSync(join(tmpdir(), 'infinite-chat-home-')); }
