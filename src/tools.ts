import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { Type, type Static } from 'typebox';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { answer } from './ask.ts';
import type { ModelChoice } from './compactor.ts';
import { flat, PAGE, start, type Memory } from './memory.ts';
import { loadImages } from './images.ts';
import { runTranscript } from './transcript.ts';
export const result = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });
export const SEARCH_PAGE = 20;
const SNIPPET = 200;

/** One page of hits, each with its id, the view line holding it, its date and a snippet around the first match; at most ~5 KB. */
export function searchPage(memory: Memory, text: string, before?: number) {
  const hits = memory.search(text, before), older = before === undefined ? '' : 'older ';
  if (!hits.length) return `No ${older}messages contain "${text}".`;
  const page = hits.slice(0, SEARCH_PAGE), needle = text.toLowerCase();
  const lines = page.map(entry => {
    // Cut the original text, whose match may span lines, and flatten only the cut.
    const at = Math.max(0, entry.text.toLowerCase().indexOf(needle) - SNIPPET / 4);
    const snippet = flat(entry.text.slice(at, at + SNIPPET).replace(/^[\udc00-\udfff]|[\ud800-\udbff]$/g, ''));
    // The live view, which may have folded since the turn's snapshot: its lines are built, so zoom always opens them.
    const line = memory.covering(entry.i); // Named only when the hit is inside a summary line.
    return `${entry.i}${line?.l ? ` (in ${start(line)}+${2 ** line.l})` : ''} · ${new Date(entry.date).toString().slice(0, 21)} · ${entry.kind}: ${at ? '…' : ''}${snippet}${at + SNIPPET < entry.text.length ? '…' : ''}`;
  });
  const more = hits.length > page.length ? `\nOlder matches: search again with before: ${page[page.length - 1].i}.` : '';
  return `${hits.length} ${older}${hits.length === 1 ? 'message contains' : 'messages contain'} "${text}", newest first:\n${lines.join('\n')}${more}`;
}

const zoomParameters = Type.Object({ id: Type.Union([Type.Integer({ minimum: 0 }), Type.String({ minLength: 1 })]), n: Type.Optional(Type.Integer({ minimum: 1 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: PAGE })) });

/** A page of a run's transcript, saying where the next one starts. */
export function runPage(text: string, offset = 0, limit = PAGE) {
  if (offset > text.length) throw new Error(`This transcript has ${text.length} characters; offset must be 0 to ${text.length}.`);
  // Never split a surrogate pair: a page starts on its first half and ends after its second.
  const from = /[\udc00-\udfff]/.test(text[offset] ?? '') ? offset - 1 : offset;
  let to = Math.min(text.length, from + limit);
  if (to < text.length && /[\ud800-\udbff]/.test(text[to - 1])) to += to - 1 === from ? 1 : -1;
  return `${text.slice(from, to)}\n[characters ${from}-${to} of ${text.length}${to < text.length ? `; go on with offset ${to}` : ''}]`;
}

/** `runs` gives a subagent's messages by run id, live or finished; undefined for no such run. */
export function memoryTools(memory: () => Memory, runs?: (id: string) => readonly AgentMessage[] | undefined) {
  return [
    { name: 'zoom', label: 'Zoom memory', description: `Open the line id+n of the view into the two lines of n/2 under it; n = 1 (the default) gives the message whole. A message over ${PAGE.toLocaleString('en-US')} characters comes in pages; offset and limit (characters) read any part of it, and are not needed for a shorter one. A message's images come back with it. zoom("<run id>") gives a subagent's whole chat so far, in the same pages.`,
      parameters: zoomParameters,
      async execute(_id: string, { id, n = 1, offset, limit }: Static<typeof zoomParameters>) {
        if (typeof id === 'string') {
          const messages = runs?.(id);
          if (messages) return result(runPage(runTranscript(messages), offset, limit));
          // A model may quote a message id; eight digits can be a run id (src/agents.ts), so those never open a message.
          if (!/^\d+$/.test(id) || id.length === 8) throw new Error(`No run ${id}.`);
        }
        const m = memory(), text = m.zoom(Number(id), n, offset, limit);
        // Files the page names that changed since the line was written, so an old note can't mislead quietly.
        const page = result(text + staleFiles(m, Number(id), text));
        // A message's images come back with its text, as read returns a PNG; summaries stay text.
        return n === 1 ? { ...page, content: [...page.content, ...await loadImages(m.store, text)] } : page;
      } },
    { name: 'date', label: 'Memory date', description: 'The date and time of message id.',
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
      async execute(_id: string, args: { id: number }) { return result(memory().date(args.id)); } },
  ] as const;
}

export const searchTool = (memory: () => Memory) => ({ name: 'search', label: 'Search memory',
  description: `Find the original messages that contain text (plain text, any case), newest first, ${SEARCH_PAGE} at a time; before: id continues with older ones. zoom(id, 1) gives a hit whole.`,
  parameters: Type.Object({ text: Type.String({ minLength: 1 }), before: Type.Optional(Type.Integer({ minimum: 0 })) }),
  async execute(_id: string, args: { text: string; before?: number }) { return result(searchPage(memory(), args.text, args.before)); } });

/** The most archive characters one ask sends the model; a 128K-token context holds roughly three times this. */
export const ASK_CAP = 200_000;

/** Head and tail of a huge archive: the head holds the task, the tail the conclusion, the middle can be zoomed if missed. */
export function askArchive(text: string) {
  if (text.length <= ASK_CAP) return text;
  const head = 80_000;
  return `${text.slice(0, head)}\n[… ${(text.length - ASK_CAP).toLocaleString('en-US')} characters cut …]\n${text.slice(-(ASK_CAP - head))}`;
}

const PATHS = /(?:\/|~\/)[\w@.+_-]+(?:\/[\w@.+_-]+)+/g;
const RELATIVE = /(?<![\w/.-])(?:[\w@._-]+\/)*[\w@._-]+\.(?:ts|tsx|js|mjs|cjs|jsx|json|md|py|go|rs|java|rb|php|c|h|cpp|sh|yaml|yml|toml|html|css|sql|tf)\b/g;

/** Files the text names that changed after the line was written, so an old note can't mislead quietly; '' when none.
 * Pull-based on purpose: pushing staleness into the view would break its byte-stable cached prefix. */
export function staleFiles(memory: Memory, id: number, text: string) {
  const leaf = memory.root[id];
  if (!leaf) return '';
  const since = Date.parse(leaf.date) + 2000;
  const names = new Set<string>();
  for (const pattern of [PATHS, RELATIVE]) for (const m of text.matchAll(pattern)) names.add(m[0].replace(/[.,;:)'"]+$/, ''));
  const changed: string[] = [];
  let extra = 0, probed = 0;
  for (const name of names) {
    if (probed >= 40) break;
    probed++;
    let at: number;
    try { at = statSync(name.startsWith('~/') ? homedir() + name.slice(1) : name).mtimeMs; } catch { continue; }
    if (at <= since) continue;
    if (changed.length < 3) changed.push(name); else extra++;
  }
  return changed.length ? `\n[files named here changed after this line: ${changed.join(', ')}${extra ? ` +${extra} more` : ''}]` : '';
}

const askParameters = Type.Object({ question: Type.String({ minLength: 1 }),
  id: Type.Union([Type.Integer({ minimum: 0 }), Type.String({ minLength: 1 })]), n: Type.Optional(Type.Integer({ minimum: 1 })) });

/** Ask one question about archived memory through the profile's compactor model, so a huge line or a
 * subagent's whole chat never enters the asking agent's context; only the answer does. */
export const askTool = ({ memory, runs, choice, onUsage }: {
  memory: () => Memory; runs?: (id: string) => readonly AgentMessage[] | undefined;
  choice: () => ModelChoice; onUsage?: (message: AssistantMessage, session: string) => void;
}) => ({ name: 'ask', label: 'Ask memory',
  description: `Answer one question about archived memory without loading it into context: ask('what did the user decide about X?', id, n) reads line id+n whole (n a power of 2, like zoom) and returns only the answer; ask('...', "<run id>") does the same for a subagent's whole chat. Prefer it over zoom when the text is huge and one fact or a summary is enough; zoom still gives the text itself.`,
  parameters: askParameters,
  async execute(_id: string, { question, id, n = 1 }: Static<typeof askParameters>,
    _signal: AbortSignal | undefined, _onUpdate: unknown, ctx?: { modelRegistry?: ModelRegistry; sessionManager?: { getSessionId(): string } }) {
    const registry = ctx?.modelRegistry;
    if (!registry) throw new Error('No model registry in this context.');
    let archive: string, note = '';
    if (typeof id === 'string') {
      const messages = runs?.(id);
      if (!messages) throw new Error(`No run ${id}.`);
      archive = runTranscript(messages);
    } else {
      const m = memory();
      if (!Number.isSafeInteger(id) || id < 0 || id >= m.root.length) throw new Error(`No message ${id}.`);
      archive = n === 1 ? `${id}+1|${m.root[id].kind}: ${m.root[id].text}` : m.zoom(id, n);
      note = staleFiles(m, id, archive);
    }
    const text = await answer(registry, choice, askArchive(archive), question,
      message => onUsage?.(message, ctx?.sessionManager?.getSessionId() ?? ''), _signal);
    return result(text + note);
  } });
