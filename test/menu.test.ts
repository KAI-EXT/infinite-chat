import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { infiniteChatMenu, type MenuAction } from '../src/menu.ts';
import { defaults } from '../src/profiles.ts';

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const status = { profile: 'personal', messages: 5251, pending: 1, compactor: defaults.compactor, agents: defaults.subagent, error: 'Rate limited' };

test('/infinite-chat shows the profile status as aligned rows and returns the chosen action', () => {
  const chosen: (MenuAction | undefined)[] = [];
  const menu = infiniteChatMenu(plain, 'InfiniteChat v1.2.3', status, action => chosen.push(action));
  const lines = menu.render(80).map(line => line.trimEnd());
  assert.ok(lines.includes(' InfiniteChat v1.2.3 · personal'));
  assert.ok(lines.includes(' Memory     5,251 messages · 1 pending'));
  assert.ok(lines.includes(` Compactor  ${defaults.compactor.provider}/${defaults.compactor.model} · ${defaults.compactor.thinking}`));
  assert.ok(lines.includes(` Agents     ${defaults.subagent.provider}/${defaults.subagent.model} · ${defaults.subagent.thinking}`));
  assert.ok(lines.includes(' Summaries failing: Rate limited'));
  menu.handleInput('j'); menu.handleInput('\r');
  menu.handleInput('\x1b');
  assert.deepEqual(chosen, ['settings', undefined]);
});

test('/infinite-chat without a profile says so and keeps every action', () => {
  const lines = infiniteChatMenu(plain, 'InfiniteChat', undefined, () => {}).render(80).map(line => line.trimEnd());
  assert.ok(lines.includes(' InfiniteChat') && lines.includes(' No active profile'));
  assert.ok(lines.some(line => line.includes('import') && line.includes('Import history')));
});
