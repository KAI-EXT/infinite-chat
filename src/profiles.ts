import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelChoice } from './compactor.ts';
import { record } from './cache.ts';
import { atomicWrite, type Store } from './store.ts';
import { DEFAULT_SETTINGS, invalid, readSettings, SETTING_KEYS, type Settings } from './settings.ts';

export const isWindows = process.platform === 'win32';
const PIPE_PREFIX = '\\\\.\\pipe\\';

/** The data root: `~/.infinite-chat` by default. `INFINITE_CHAT_HOME` moves it (the old `OPTCHAT_HOME` spelling still works),
 * which is how sandboxed systems like ohos point it at a directory their sandbox can actually write. */
export const dataHome = () => resolve(process.env.INFINITE_CHAT_HOME ?? process.env.OPTCHAT_HOME ?? join(homedir(), '.infinite-chat'));
/** `main` is the last model and thinking level picked in Pi while this profile was open; absent until one is picked. */
export interface ProfileConfig extends Settings { compactor: ModelChoice; subagent: ModelChoice; main?: ModelChoice }
export const defaults: ProfileConfig = {
  compactor: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', thinking: 'medium' },
  subagent: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', thinking: 'high' },
  ...DEFAULT_SETTINGS,
};
export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export function profilePath(name: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Profile names: 1–64 lowercase letters, digits, hyphens, or underscores.');
  return join(dataHome(), 'profiles', name);
}
export function listProfiles() {
  const root = join(dataHome(), 'profiles');
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(f => f.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.name)).map(f => f.name).sort() : [];
}

/** Directory scoping, `profile.json` inside the profile: which project directory the profile was created in, and when it was last
 * opened. The picker shows a profile under its own directory first; a profile without a recorded directory (created elsewhere or
 * migrated) is offered everywhere until the first open claims it for the directory it opened in. */
export interface ProfileMeta { cwd?: string; createdAt?: string; lastUsedAt?: string }
export interface ProfileEntry { name: string; meta: ProfileMeta }
/** The real path when it exists, so /tmp and /private/tmp (or a symlinked project root) count as the same directory. */
export const normalizeDir = (dir: string) => { try { return realpathSync.native(resolve(dir)); } catch { return resolve(dir); } };
export function loadMeta(dir: string): ProfileMeta {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'));
    if (!record(value)) return {};
    const meta: ProfileMeta = {};
    if (typeof value.cwd === 'string') meta.cwd = value.cwd;
    if (typeof value.createdAt === 'string') meta.createdAt = value.createdAt;
    if (typeof value.lastUsedAt === 'string') meta.lastUsedAt = value.lastUsedAt;
    return meta;
  } catch { return {}; }
}
const saveMeta = (dir: string, meta: ProfileMeta) => atomicWrite(join(dir, 'profile.json'), JSON.stringify(meta, null, 2) + '\n');
export function listProfilesMeta(): ProfileEntry[] { return listProfiles().map(name => ({ name, meta: loadMeta(profilePath(name)) })); }
/** The profiles a picker should show: those of this directory (or unscoped ones) first, most recently used first. */
export function groupProfiles(entries: ProfileEntry[], cwd?: string): { here: ProfileEntry[]; others: ProfileEntry[] } {
  const home = cwd === undefined ? undefined : normalizeDir(cwd);
  const byRecency = (a: ProfileEntry, b: ProfileEntry) => (b.meta.lastUsedAt ?? '').localeCompare(a.meta.lastUsedAt ?? '') || a.name.localeCompare(b.name);
  const here: ProfileEntry[] = [], others: ProfileEntry[] = [];
  for (const entry of entries) (home === undefined || entry.meta.cwd === undefined || entry.meta.cwd === home ? here : others).push(entry);
  here.sort(byRecency); others.sort(byRecency);
  return { here, others };
}

export function createProfile(name: string, cwd?: string, overrides?: Partial<ProfileConfig>) {
  const dir = profilePath(name);
  if (existsSync(dir)) throw new Error(`Profile already exists: ${name}`);
  mkdirSync(resolve(dir, '..'), { recursive: true, mode: 0o700 });
  // Claim the directory exclusively, so a competing creator cannot have its
  // profile overwritten or removed by this attempt's cleanup.
  mkdirSync(dir, { mode: 0o700 });
  try {
    saveConfig(dir, { ...defaults, ...overrides });
    saveMeta(dir, { cwd: cwd === undefined ? undefined : normalizeDir(cwd), createdAt: new Date().toISOString() });
    atomicWrite(join(dir, 'AGENTS.md'), `# ${name}\n\nThis is the ${name} profile.\nAdd your personal instructions here.\n`);
  } catch (error) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
    catch { throw new Error(`Failed to create profile ${name}, and could not remove its incomplete directory: ${dir}`, { cause: error }); }
    throw error;
  }
}
export function saveConfig(dir: string, config: ProfileConfig) { atomicWrite(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n'); }
function modelChoice(value: unknown): value is ModelChoice {
  return record(value) && typeof value.provider === 'string' && typeof value.model === 'string'
    && THINKING.some(level => level === value.thinking);
}
const isModelChoice = modelChoice;
/** User-wide defaults, `<dataHome>/config.json`, same shape as a profile's own config.json. Its values override the built-in
 * defaults for every new profile, and fill any key a profile's own config.json leaves out. Invalid keys are dropped with a
 * warning, never fatal: one bad line must not take every profile down. */
export const globalConfigPath = () => join(dataHome(), 'config.json');
export function loadGlobalConfig(warn: (text: string) => void = console.error): Partial<ProfileConfig> {
  let value: unknown;
  try { value = JSON.parse(readFileSync(globalConfigPath(), 'utf8')); }
  catch (error) { if (existsSync(globalConfigPath())) warn(`Ignoring ${globalConfigPath()}: ${error instanceof Error ? error.message : String(error)}`); return {}; }
  if (!record(value)) { warn(`Ignoring ${globalConfigPath()}: expected a JSON object.`); return {}; }
  const config: Partial<ProfileConfig> = {};
  for (const key of ['compactor', 'subagent', 'main'] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (isModelChoice(raw)) config[key] = raw;
    else warn(`Ignoring ${globalConfigPath()}: "${key}" is not a model choice (provider, model, thinking).`);
  }
  const kept: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const problem = invalid(key, value[key]);
    if (problem) warn(`Ignoring ${globalConfigPath()}: ${problem}`);
    else kept[key] = value[key];
  }
  Object.assign(config, kept);
  return config;
}
/** A profile's config.json wins; missing keys fall back to the user's global config, then the built-in defaults. */
export function loadConfig(dir: string, globalDefaults: Partial<ProfileConfig> = {}): ProfileConfig {
  const value: unknown = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  if (!record(value)) throw new Error(`Invalid profile config: ${dir}/config.json`);
  const { compactor, subagent, main } = value;
  if (compactor !== undefined && !isModelChoice(compactor)) throw new Error(`Invalid profile config: ${dir}/config.json: compactor`);
  if (subagent !== undefined && !isModelChoice(subagent)) throw new Error(`Invalid profile config: ${dir}/config.json: subagent`);
  if (main !== undefined && !isModelChoice(main)) throw new Error(`Invalid profile config: ${dir}/config.json: main`);
  const withFallback = (raw: unknown, key: 'compactor' | 'subagent', dflt: ModelChoice): ModelChoice =>
    isModelChoice(raw) ? raw : isModelChoice(globalDefaults[key]) ? globalDefaults[key] as ModelChoice : dflt;  const chosenMain = isModelChoice(main) ? main : isModelChoice(globalDefaults.main) ? globalDefaults.main : undefined;
  // Raw keys first, then the global defaults' keys; readSettings fills the rest (and keeps the importJobs alias) from its own defaults.
  const settings: Record<string, unknown> = Object.hasOwn(value, 'importJobs') ? { importJobs: value.importJobs } : {};
  for (const key of SETTING_KEYS) {
    if (Object.hasOwn(value, key)) settings[key] = value[key];
    else if (Object.hasOwn(globalDefaults, key)) settings[key] = globalDefaults[key as keyof ProfileConfig];
  }
  try { return { compactor: withFallback(compactor, 'compactor', defaults.compactor), subagent: withFallback(subagent, 'subagent', defaults.subagent), ...chosenMain && { main: chosenMain }, ...readSettings(settings) }; }
  catch (error) { throw new Error(`Invalid profile config: ${dir}/config.json: ${error instanceof Error ? error.message : String(error)}`); }
}
export function instructions(dir: string) { return readFileSync(join(dir, 'AGENTS.md'), 'utf8'); }
/** The profile last opened in `cwd`: the picker's first row, so Enter re-opens it. Scoping is per directory; nothing global. */
export function lastProfile(cwd?: string) {
  if (cwd === undefined) return undefined;
  const home = normalizeDir(cwd);
  let best: { name: string; at: string } | undefined;
  for (const name of listProfiles()) {
    const { cwd: dir, lastUsedAt } = loadMeta(profilePath(name));
    if (dir !== home || lastUsedAt === undefined) continue;
    if (!best || lastUsedAt > best.at) best = { name, at: lastUsedAt };
  }
  return best?.name;
}
/** Records that this profile was just opened here; claims an unscoped profile for this directory on first open. */
export function rememberProfile(name: string, cwd?: string) {
  try {
    const dir = profilePath(name), meta = loadMeta(dir);
    meta.lastUsedAt = new Date().toISOString();
    if (meta.cwd === undefined && cwd !== undefined) meta.cwd = normalizeDir(cwd);
    saveMeta(dir, meta);
  } catch { /* The session binding still works; only the picker's ordering misses this. */ }
}

/** The previous pi-optchat data home, offered only while InfiniteChat uses the default home itself: a custom
 * INFINITE_CHAT_HOME (a sandbox, ohos) must not silently pull in host data. `INFINITE_CHAT_NO_LEGACY` hides the
 * old profiles entirely. */
export const legacyHome = () =>
  process.env.INFINITE_CHAT_HOME || process.env.OPTCHAT_HOME || process.env.INFINITE_CHAT_NO_LEGACY ? undefined : join(homedir(), '.optchat');
/** Old pi-optchat profiles not converted yet: present in `~/.optchat/profiles`, absent from the InfiniteChat data home. */
export function listLegacyProfiles(): string[] {
  const legacy = legacyHome();
  const root = legacy && join(legacy, 'profiles');
  if (!root || !existsSync(root)) return [];
  const known = new Set(listProfiles());
  return readdirSync(root, { withFileTypes: true })
    .filter(f => f.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.name) && !known.has(f.name))
    .map(f => f.name).sort();
}
/** Converts one old pi-optchat profile into the InfiniteChat data home: a full copy (never a move, so the old plugin
 * keeps working), minus stale lock sockets and lock files, plus the `profile.json` metadata old profiles never had.
 * The copy starts unscoped, so the first open claims it for the directory it opened in. */
export function importLegacyProfile(name: string): string {
  const legacy = legacyHome();
  const source = legacy && join(legacy, 'profiles', name);
  const dir = profilePath(name);
  if (!legacy || !source || !existsSync(source)) throw new Error(`No old pi-optchat profile named ${name} in ${legacy ?? '~/.optchat'}.`);
  if (existsSync(dir)) throw new Error(`Profile already exists: ${name}`);
  cpSync(source, dir, { recursive: true, errorOnExist: true, force: false, filter: path => !/\.(sock|lock)$/.test(path) });
  if (!existsSync(join(dir, 'profile.json'))) {
    try { saveMeta(dir, { createdAt: statSync(source).birthtime.toISOString() }); }
    catch { saveMeta(dir, {}); }
  }
  return dir;
}

export class ProfileBusyError extends Error {
  constructor(readonly owner: string) { super(`Profile already running: ${owner}`); }
}
/** Hashes the profile directory's real identity, so another casing, a junction or a symlink to the same profile finds the same name. */
const socketHash = (dir: string) => {
  let identity = resolve(dir); try { identity = realpathSync.native(identity); } catch {}
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
};
/** Where a profile's sockets live, most preferred first; owner and connector compute the same list, so they meet.
 *
 * POSIX prefers the profile itself (travels with the profile, mode 0600). But some systems refuse to bind there: ohos app
 * sandboxes may map the home onto storage that rejects unix sockets, and a deeply nested home can push the path over sun_path.
 * Each fallback is a short hashed name in a directory that stays valid for every process that can read the profile:
 * `INFINITE_CHAT_SOCK_HOME` (explicit override, e.g. a sandbox-writable path on ohos), the data home's `sock/`, then the system
 * temp dir. Windows has no Unix sockets, so the profile path is hashed into a named pipe in the machine-wide pipe namespace. */
export function socketCandidates(dir: string, purpose: 'lock' | 'windows' = 'lock'): string[] {
  if (isWindows) return [`${PIPE_PREFIX}infinite-chat-${socketHash(dir).toLowerCase()}-${purpose}`];
  const candidates: string[] = [];
  const consider = (path: string | undefined) => {
    if (path && Buffer.byteLength(path) <= SOCKET_PATH_LIMIT && !candidates.includes(path)) candidates.push(path);
  };
  const hash = socketHash(dir);
  consider(process.env.INFINITE_CHAT_SOCK_HOME ? join(resolve(process.env.INFINITE_CHAT_SOCK_HOME), `infinite-chat-${hash}-${purpose}.sock`) : undefined);
  consider(join(dir, `${purpose}.sock`));
  consider(join(dataHome(), 'sock', `infinite-chat-${hash}-${purpose}.sock`));
  consider(join(tmpdir(), `infinite-chat-${hash}-${purpose}.sock`));
  if (!candidates.length) throw new Error(`No directory can hold the profile socket under ${SOCKET_PATH_LIMIT} bytes. Set INFINITE_CHAT_SOCK_HOME to a short, writable directory.`);
  return candidates;
}

/** The primary socket path for a profile: candidate 1 of socketCandidates. Kept for tooling and tests. */
export function profileSocket(dir: string, purpose: 'lock' | 'windows' = 'lock') { return socketCandidates(dir, purpose)[0]; }

// sun_path is 104 bytes on macOS and 108 elsewhere, both including the NUL; a Windows named pipe path is capped at 259 characters, which for the ASCII names InfiniteChat generates is also its byte length. Node 22 binds a truncated socket instead of failing, so the length is checked before listen.
export const SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 103 : isWindows ? 259 : 107;
export function checkSocketPath(path: string) {
  const length = Buffer.byteLength(path);
  if (length > SOCKET_PATH_LIMIT) throw new Error(`Cannot listen on the profile socket: its path is ${length} bytes, over this system's limit of ${SOCKET_PATH_LIMIT}. Set INFINITE_CHAT_HOME to a shorter directory: ${path}`);
}

/** A socket that may be replaced; a file that only shares its name is refused, never deleted. A Windows pipe has no filesystem entry, so there is nothing to check or remove. */
function existingSocket(path: string): { stat: Stats; removable: true } | { removable: false } | undefined {
  if (isWindows) return { removable: false };
  let stat; try { stat = lstatSync(path); } catch { return undefined; }
  if (!stat.isSocket()) throw new Error(`${path} is not an InfiniteChat socket. Move it out of the profile and try again.`);
  return { stat, removable: true };
}
/** Removes a dead socket left by a previous owner. */
export function removeStaleSocket(path: string) { if (existingSocket(path)?.removable) unlinkSync(path); }

/** Asks the current owner who holds the socket; nothing answering means the entry is stale. A Windows pipe that has disappeared reports ENOENT instead of ECONNREFUSED. */
function readOwner(path: string) {
  return new Promise<string | undefined>((resolve, reject) => {
    const socket = createConnection(path); let message = '';
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Profile lock did not respond; refusing to steal it.')); });
    socket.on('data', data => { message += data.toString(); });
    socket.on('end', () => resolve(message || 'another Pi instance'));
    socket.on('error', e => { if ('code' in e && (e.code === 'ECONNREFUSED' || isWindows && e.code === 'ENOENT')) resolve(undefined); else reject(e); });
  });
}

/** OS-owned socket lifetime, no timeout-based stealing of a busy profile. Binds the first candidate directory that works:
 * a filesystem that refuses unix sockets (some ohos mounts) or a path over sun_path falls through to the next candidate,
 * while a socket already held by a live owner is always reported as busy, never shadowed by a second candidate. */
export async function lockProfile(dir: string, description: string) {
  let last: unknown;
  for (const socketPath of socketCandidates(dir)) {
    try { return await lockAt(socketPath, description); }
    catch (error) {
      if (error instanceof ProfileBusyError) throw error;
      if (!fallbackable(error)) throw error;
      last = error;
    }
  }
  throw new Error(`Could not create the profile lock socket for ${dir}: ${errorText(last)}. Set INFINITE_CHAT_SOCK_HOME to a writable directory.`, { cause: last });
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Errors that mean "this directory cannot hold a socket here" (permissions, no socket support, path issues), so the next candidate is worth trying. */
export function fallbackable(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && ['EACCES', 'EPERM', 'ENOENT', 'ENOSYS', 'EROFS', 'EINVAL', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG', 'EOPNOTSUPP', 'EPFNOSUPPORT'].includes(code);
}
export const isAddrInUse = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
async function lockAt(socketPath: string, description: string) {
  const server = createServer(socket => { socket.on('error', () => socket.destroy()); socket.end(description); });
  const listen = () => new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready); server.listen(socketPath);
  });
  try { await listen(); }
  catch (error) {
    if (!isAddrInUse(error)) throw error;
    const before = existingSocket(socketPath);
    if (!before) throw new Error('Profile lock changed; try again.');
    const owner = await readOwner(socketPath);
    if (owner !== undefined) throw new ProfileBusyError(owner);
    // Nothing answered, so the entry is stale. POSIX leaves a file behind that can be removed; a Windows pipe disappears with its owner, so rebinding is the whole cleanup.
    if (before.removable) {
      if (statSync(socketPath).ino !== before.stat.ino) throw new Error('Profile lock changed; try again.');
      unlinkSync(socketPath);
    }
    await listen();
  }
  const unlock = () => new Promise<void>(resolve => server.close(() => resolve()));
  if (!isWindows) { try { chmodSync(socketPath, 0o600); } catch (error) { await unlock(); throw error; } }
  return unlock;
}

/** How often a held lease is renewed; a store lets one lapse after about 30 seconds without renewal. */
export const HEARTBEAT_MS = 10_000;
/** Holds the profile until the returned function is called: through the store's lease if it has one, else the machine-local lock. */
export async function holdProfile(store: Pick<Store, 'lock'>, dir: string, profile: string, description: string, warn: (text: string) => void) {
  const { lock } = store;
  if (!lock) return lockProfile(dir, description);
  const owner = await lock.lease(profile, description);
  if (owner !== undefined) throw new ProfileBusyError(owner);
  const beat = setInterval(() => {
    lock.heartbeat().catch((error: unknown) => { warn(`Could not renew the profile lease: ${error instanceof Error ? error.message : String(error)}`); });
  }, HEARTBEAT_MS);
  beat.unref();
  return async () => { clearInterval(beat); await lock.release(); };
}
