/** Terminal tab titles: `● π personal · sub glm-x · cmp glm-y · 2 agents` in the main window, `● ↳ personal` in a connected window. */
import type { ModelChoice } from './compactor.ts';
export type StatusState = 'waiting' | 'working';
export type WindowState = StatusState | 'done' | 'disconnected';

const agents = (count: number) => count > 0 ? ` · ${count} ${count === 1 ? 'agent' : 'agents'}` : '';
/** The models behind the profile, kept short for a tab title: model ids, full provider/model in the footer status. */
const modelsTag = ({ subagent, compactor }: { subagent: ModelChoice; compactor: ModelChoice }) =>
  subagent.provider === compactor.provider && subagent.model === compactor.model
    ? ` · ${subagent.model} (sub ${subagent.thinking} / cmp ${compactor.thinking})`
    : ` · sub ${subagent.model} · cmp ${compactor.model}`;
export const mainTitle = (profile: string, working: boolean, running: number, models?: { subagent: ModelChoice; compactor: ModelChoice }) =>
  `${working ? '● ' : ''}π ${profile}${models ? modelsTag(models) : ''}${agents(running)}`;
export const windowTitle = (profile: string, state: WindowState) =>
  `${state === 'working' ? '● ' : ''}↳ ${profile}${state === 'done' || state === 'disconnected' ? ` · ${state}` : ''}`;
/** A connected window's agent is working while it runs or stops, or waits on agents of its own; waiting with none means waiting for you. */
export const statusState = (state: string, agents = 0): StatusState =>
  state === 'running' || state === 'stopping' || state === 'waiting' && agents > 0 ? 'working' : 'waiting';

/**
 * Pi writes its own "π - <cwd>" title after binding a session (startup, reload, profile switch) and on
 * session renames, so the last title is kept and re-applied at those points.
 */
export class TabTitle {
  private title: string | undefined;
  private set: ((title: string) => void) | undefined;
  show(set: (title: string) => void, title: string) {
    this.set = set;
    if (title === this.title) return;
    this.title = title; this.apply();
  }
  reapply() { this.apply(); }
  clear() { this.title = undefined; this.set = undefined; }
  private apply() {
    if (!this.title || !this.set) return;
    try { this.set(this.title); } catch { /* A ctx captured before a session replacement is stale; the next session sets its own. */ }
  }
}
