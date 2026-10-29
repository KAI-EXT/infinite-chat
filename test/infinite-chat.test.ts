import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfile, creationSeed, dataHome, defaults, globalConfigExists, globalConfigPath, groupProfiles, importLegacyProfile, lastProfile, legacyHome, listLegacyProfiles, listProfilesMeta, loadConfig, loadGlobalConfig, loadMeta, lockProfile, normalizeDir, profilePath, rememberProfile, renameProfile, renamedProfile, seedGlobalConfig, socketCandidates } from '../src/profiles.ts';
import { removeDir } from './support.ts';

/** Saves the env vars these tests touch; HOME is already sandboxed by support.ts. */
function envSandbox() {
  const saved = { INFINITE_CHAT_HOME: process.env.INFINITE_CHAT_HOME, OPTCHAT_HOME: process.env.OPTCHAT_HOME, INFINITE_CHAT_SOCK_HOME: process.env.INFINITE_CHAT_SOCK_HOME, INFINITE_CHAT_NO_LEGACY: process.env.INFINITE_CHAT_NO_LEGACY };
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

test('the creation wizard seeds from the global config or the defaults, and the first setup writes the global config once', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'infinite-chat-wizard-'));
  const cleanup = envSandbox();
  process.env.INFINITE_CHAT_HOME = dir;
  try {
    // No global config yet: the wizard starts from the built-in defaults.
    assert.ok(!globalConfigExists(), 'the fresh data home has no global config');
    const fallback = creationSeed({});
    assert.deepEqual(fallback.subagent, defaults.subagent);
    assert.deepEqual(fallback.compactor, defaults.compactor);

    // The user keeps the subagent, changes the compactor, and the profile is created with both.
    createProfile('first', undefined, { subagent: fallback.subagent, compactor: { provider: 'zai-coding-cn', model: 'glm-5.3', thinking: 'low' } });

    // First setup: the chosen models become the global config so the next profile starts from them.
    assert.ok(seedGlobalConfig({ subagent: fallback.subagent, compactor: { provider: 'zai-coding-cn', model: 'glm-5.3', thinking: 'low' } }), 'the first setup writes the global config');
    assert.deepEqual(loadGlobalConfig().compactor, { provider: 'zai-coding-cn', model: 'glm-5.3', thinking: 'low' });

    // The next wizard starts from that global config, and it is never overwritten again.
    const next = creationSeed(loadGlobalConfig());
    assert.deepEqual(next.compactor, { provider: 'zai-coding-cn', model: 'glm-5.3', thinking: 'low' });
    fs.writeFileSync(globalConfigPath(), JSON.stringify({ subagent: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', thinking: 'max' } }));
    assert.equal(seedGlobalConfig({ subagent: fallback.subagent, compactor: fallback.compactor }), false, 'an existing global config is never overwritten');
    assert.deepEqual(creationSeed(loadGlobalConfig()).subagent, { provider: 'zai-coding-cn', model: 'glm-5.3-flash', thinking: 'max' }, 'hand edits stay in charge');
    assert.deepEqual(creationSeed(loadGlobalConfig()).compactor, defaults.compactor, 'a missing key still falls back to the defaults');
  } finally { cleanup(); removeDir(dir); }
});

test('a profile can be renamed: the directory moves, old session bindings follow, a busy profile refuses', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'infinite-chat-rename-'));
  const cleanup = envSandbox();
  process.env.INFINITE_CHAT_HOME = dir;
  try {
    createProfile('old', '/tmp/project-a');
    createProfile('taken');
    // Refusals first: nothing below may have moved anything.
    await assert.rejects(renameProfile('old', 'old'), /same as the old/);
    await assert.rejects(renameProfile('missing', 'other'), /does not exist/);
    await assert.rejects(renameProfile('old', 'taken'), /already exists/);
    await assert.rejects(renameProfile('old', 'Bad Name'), /lowercase/);
    // A held lock means a running owner (here: this test), and a rename would move the directory out from under it.
    const unlock = await lockProfile(profilePath('old'), 'holder');
    await assert.rejects(renameProfile('old', 'new'), /Profile already running/);
    await unlock();
    await renameProfile('old', 'new');
    assert.equal(fs.existsSync(profilePath('old')), false);
    assert.ok(loadMeta(profilePath('new')).createdAt, 'the metadata travels with the directory');
    assert.deepEqual(renamedProfile('old'), 'new', 'sessions bound to the old name resolve to the new one');
    assert.equal(renamedProfile('new'), undefined);
    assert.equal(renamedProfile('never-bound'), undefined);
    // An AGENTS.md that still carries the exact creation template is refreshed; an edited one is left alone.
    assert.equal(fs.readFileSync(join(profilePath('new'), 'AGENTS.md'), 'utf8'), '# new\n\nThis is the new profile.\nAdd your personal instructions here.\n');
    fs.writeFileSync(join(profilePath('new'), 'AGENTS.md'), '# my own instructions');
    await renameProfile('new', 'newer');
    assert.equal(fs.readFileSync(join(profilePath('newer'), 'AGENTS.md'), 'utf8'), '# my own instructions');
    // Chains collapse on write: old→new followed by new→newer resolves in one hop.
    assert.deepEqual(renamedProfile('old'), 'newer');
    assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, 'renames.json'), 'utf8')), { old: 'newer', new: 'newer' });
    // Renaming back to an earlier name drops the entries that would point at themselves.
    await renameProfile('newer', 'old');
    assert.equal(fs.existsSync(profilePath('old')), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, 'renames.json'), 'utf8')), { new: 'old', newer: 'old' });
    assert.deepEqual(renamedProfile('newer'), 'old');
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

test('old pi-optchat profiles are listed from ~/.optchat and converted only on explicit import', () => {
  const cleanup = envSandbox();
  delete process.env.INFINITE_CHAT_HOME; delete process.env.OPTCHAT_HOME; delete process.env.INFINITE_CHAT_NO_LEGACY;
  const home = mkdtempHome();
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const legacyProfile = join(home, '.optchat', 'profiles', 'old');
    fs.mkdirSync(legacyProfile, { recursive: true });
    fs.writeFileSync(join(legacyProfile, 'config.json'), '{}');
    fs.writeFileSync(join(legacyProfile, 'AGENTS.md'), '# old\n');
    fs.writeFileSync(join(legacyProfile, 'lock.sock'), 'stale');
    fs.mkdirSync(join(legacyProfile, 'main'), { recursive: true });
    fs.writeFileSync(join(legacyProfile, 'main', '2026-01-01.jsonl'), '{}\n');
    assert.deepEqual(legacyHome(), join(home, '.optchat'));
    assert.deepEqual(listLegacyProfiles(), ['old'], 'unconverted old profiles are offered');
    assert.deepEqual(listLegacyProfiles(), ['old'], 'nothing is copied by listing');
    assert.ok(!fs.existsSync(join(home, '.infinite-chat', 'profiles', 'old')), 'listing never touches the data home');

    importLegacyProfile('old');
    const converted = profilePath('old');
    assert.equal(fs.readFileSync(join(converted, 'config.json'), 'utf8'), '{}');
    assert.ok(!fs.existsSync(join(converted, 'lock.sock')), 'stale sockets are not copied');
    assert.ok(fs.existsSync(join(legacyProfile, 'config.json')), 'the old install keeps its data');
    assert.equal(loadMeta(converted).cwd, undefined, 'the converted profile starts unscoped, so the first open claims it');
    assert.deepEqual(listLegacyProfiles(), [], 'a converted profile is no longer offered');
    assert.throws(() => importLegacyProfile('old'), /Profile already exists: old/);
    assert.throws(() => importLegacyProfile('never-there'), /No old pi-optchat profile named never-there/);

    createProfile('fresh');
    assert.deepEqual(listLegacyProfiles(), [], 'a name already taken in the data home is not offered again');
    process.env.INFINITE_CHAT_NO_LEGACY = '1';
    assert.deepEqual(listLegacyProfiles(), [], 'INFINITE_CHAT_NO_LEGACY hides the old profiles');
    delete process.env.INFINITE_CHAT_NO_LEGACY;
    process.env.INFINITE_CHAT_HOME = join(home, 'custom');
    assert.equal(legacyHome(), undefined, 'a custom data home never reads the host ~/.optchat');
    assert.deepEqual(listLegacyProfiles(), []);
    fs.rmSync(join(home, '.optchat'), { recursive: true, force: true });
    delete process.env.INFINITE_CHAT_HOME;
    assert.deepEqual(listLegacyProfiles(), [], 'nothing to convert, nothing offered');
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
