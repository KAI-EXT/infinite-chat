import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { reasoningFor, retryTransient, type ModelChoice } from './compactor.ts';
import { ASK } from './prompts.ts';

/** One archive question: the profile's compactor model (cheap, already configured) reads the whole range
 * and answers, so the archive never enters the asking agent's context. The shared session id is the
 * OpenAI prompt-cache key, and SSE as in the compactor; Pi's own cache marks cover the rest. */
export async function answer(registry: ModelRegistry, choice: () => ModelChoice, archive: string,
  question: string, onUsage: (message: AssistantMessage) => void = () => {}, signal?: AbortSignal) {
  const selected = choice();
  const model = registry.find(selected.provider, selected.model);
  if (!model) throw new Error(`Ask model unavailable: ${selected.provider}/${selected.model}. Use /infinite-chat model.`);
  const thinking = reasoningFor(model, selected.thinking);
  const messages: Message[] = [{ role: 'user', content: [
    { type: 'text', text: `<archive>\n${archive}\n</archive>` },
    // OpenAI joins text blocks with nothing between them, so the question starts its own paragraph.
    { type: 'text', text: `\n\n${question}` },
  ], timestamp: Date.now() }];
  const reply = await retryTransient(async () => {
    const stream = registry.streamSimple(model, { systemPrompt: ASK, messages }, {
      sessionId: 'infinite-chat-ask', transport: 'sse', reasoning: thinking, signal, cacheRetention: 'short',
    });
    return stream.result();
  }, onUsage, undefined, signal);
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `Ask model ${reply.stopReason}.`);
  if (reply.stopReason === 'length') throw new Error('The answer hit the model\'s token limit; ask a narrower question.');
  const text = reply.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
  if (!text) throw new Error('The ask model returned no text.');
  return text;
}
