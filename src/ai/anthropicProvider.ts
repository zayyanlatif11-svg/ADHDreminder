import type { Logger } from '../utils/logger.js';
import {
  sanitizeAiText,
  type AiProvider,
  type NextActionRequest,
} from './provider.js';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * Optional wording helper. Implemented with plain fetch so the MVP has no extra
 * dependency and no API key is required to install or run the project.
 *
 * Every failure path returns null/[] — a network blip must never break a
 * command, it just means the deterministic fallback wording is used.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly enabled = true;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly log: Logger;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AnthropicOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.log = options.logger.child({ module: 'ai:anthropic' });
    this.doFetch = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  private async complete(system: string, user: string, maxTokens: number): Promise<string | null> {
    try {
      const response = await this.doFetch(API_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!response.ok) {
        this.log.warn({ status: response.status }, 'LLM request failed; using fallback wording');
        return null;
      }
      const body = (await response.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = (body.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join(' ');
      return text.trim() === '' ? null : text;
    } catch (error) {
      this.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'LLM request errored; using fallback wording',
      );
      return null;
    }
  }

  async suggestNextAction(request: NextActionRequest): Promise<string | null> {
    const system = [
      'You write the single first physical action for someone with ADHD who struggles to start.',
      'Rules: one sentence, under 15 words, imperative, concrete and physical.',
      'It must be something you could watch them do in the next 60 seconds.',
      'No encouragement, no explanation, no preamble. Output the action only.',
    ].join(' ');

    const user = [
      `Task: ${request.title}`,
      `Category: ${request.category}`,
      request.course ? `Course: ${request.course}` : null,
      `Estimated: ${request.estimatedMinutes} minutes`,
      request.notes ? `Notes: ${request.notes.slice(0, 300)}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    return sanitizeAiText(await this.complete(system, user, 60));
  }

  async decompose(request: NextActionRequest, maxSteps: number): Promise<string[]> {
    const system = [
      `Break the task into at most ${maxSteps} concrete steps for someone with ADHD.`,
      'Each step: under 12 words, imperative, physically startable.',
      'Output one step per line. No numbering, no commentary.',
    ].join(' ');

    const raw = await this.complete(system, `Task: ${request.title}`, 200);
    if (!raw) return [];

    return raw
      .split('\n')
      .map((line) => sanitizeAiText(line.replace(/^[-*\d.)\s]+/, '')))
      .filter((line): line is string => line !== null)
      .slice(0, maxSteps);
  }
}
