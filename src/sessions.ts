import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { listLegacyProfiles, profileOwner, profilePath, renamedProfile } from './profiles.ts';

/** Pi stores sessions per directory, in `<agentDir>/sessions/<munged-cwd>/*.jsonl`. The same pool holds every
 * profile's conversations for that cwd, and `pi -r` always resumes the most recently written one — a live window
 * keeps its own session newest, so it wins and an older profile's work is only reachable by picking a session.
 * This module lists the pool the way a person thinks: newest first, annotated with the profile each session
 * belongs to (the session binding decides), how much is in it, and whether that profile is currently held. */

export interface SessionSummary {
  path: string;
  mtimeMs: number;
  /** The name the session was bound with (last binding entry wins), or undefined when unbound. */
  profile: string | undefined;
  /** The bound name after following any rename chain. */
  resolved: string | undefined;
  /** Bound by old pi-optchat and not converted into the data home yet (resume converts on demand). */
  legacy: boolean;
  /** The bound profile exists neither in the data home nor as a convertible legacy one. */
  missing: boolean;
  userMessages: number;
  /** First user message, whitespace collapsed, for recognizing the conversation. */
  preview: string;
  /** Lock owner when the bound profile is held by another window right now. */
  owner: string | undefined;
}

/** The pi agent dir: `PI_CODING_AGENT_DIR` (tilde expanded) or `~/.pi/agent`, mirroring pi's config.getAgentDir. */
export function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env !== undefined && env !== '') return env.startsWith('~') ? join(homedir(), env.slice(1)) : env;
  return join(homedir(), '.pi', 'agent');
}

/** The cwd-encoded session pool directory, with the same `--<path>--` munging pi's session manager uses. */
export function sessionsDirFor(cwd: string, dir: string = agentDir()): string {
  const safePath = `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return join(dir, 'sessions', safePath);
}

interface Parsed {
  cwd?: string;
  profile?: string;
  legacyBinding: boolean;
  userMessages: number;
  preview: string;
}

function parseSessionFile(path: string): Parsed {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return { legacyBinding: false, userMessages: 0, preview: '' }; }
  const parsed: Parsed = { legacyBinding: false, userMessages: 0, preview: '' };
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue;
    if (parsed.cwd === undefined && line.includes('"type":"session"')) {
      try { const header: unknown = JSON.parse(line); if (record(header) && typeof header.cwd === 'string') parsed.cwd = header.cwd; } catch { /* not a header line */ }
    }
    const isBinding = line.includes(BINDING) || line.includes(LEGACY_BINDING);
    const isUser = line.includes('"role":"user"');
    if (!isBinding && !isUser) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!record(entry)) continue;
    if (isBinding && entry.type === 'custom') {
      const data = entry.data;
      if (record(data) && typeof data.name === 'string') {
        if (entry.customType === BINDING) { parsed.profile = data.name; parsed.legacyBinding = false; }
        else if (entry.customType === LEGACY_BINDING) { parsed.profile = data.name; parsed.legacyBinding = true; }
      }
    }
    if (isUser && entry.type === 'message' && record(entry.message) && entry.message.role === 'user') {
      parsed.userMessages++;
      if (!parsed.preview) parsed.preview = firstText(entry.message.content);
    }
  }
  return parsed;
}

const BINDING = 'infinite-chat.profile';
const LEGACY_BINDING = 'optchat.profile';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstText(content: unknown): string {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(item => record(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : '').join(' ')
    : '';
  const squashed = text.replace(/\s+/g, ' ').trim();
  return squashed.length > 60 ? `${squashed.slice(0, 60)}…` : squashed;
}

/** Sessions whose recorded cwd differs from the asked-for one stay out, like pi's own discovery does —
 * munged directory names can only collide, never distinguish. */
function sameCwd(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const left = resolve(a), right = resolve(b);
  if (left === right) return true;
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
}

export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  const dir = sessionsDirFor(cwd);
  let files: string[];
  try { files = readdirSync(dir).filter(file => file.endsWith('.jsonl')); } catch { return []; }
  const legacy = listLegacyProfiles();
  const summaries: SessionSummary[] = [];
  for (const file of files) {
    const path = join(dir, file);
    let mtimeMs: number;
    try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
    const parsed = parseSessionFile(path);
    if (!sameCwd(parsed.cwd, cwd)) continue;
    const resolved = parsed.profile === undefined ? undefined : renamedProfile(parsed.profile) ?? parsed.profile;
    const exists = resolved !== undefined && existsSync(profilePath(resolved));
    summaries.push({
      path, mtimeMs,
      profile: parsed.profile,
      resolved,
      legacy: exists ? false : resolved !== undefined && legacy.includes(resolved),
      missing: resolved !== undefined && !exists && !legacy.includes(resolved),
      userMessages: parsed.userMessages,
      preview: parsed.preview,
      owner: undefined,
    });
  }
  summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // One probe per distinct live profile: a lock answer is a round trip, and several sessions may share a profile.
  const names = [...new Set(summaries.map(s => s.resolved).filter((name): name is string => name !== undefined && existsSync(profilePath(name))))];
  await Promise.all(names.map(async name => {
    const owner = await profileOwner(name);
    if (owner !== undefined) for (const summary of summaries) if (summary.resolved === name) summary.owner = owner;
  }));
  return summaries;
}
