/**
 * Optional LLM layer.
 *
 * Hard boundary: the model may only ever *rephrase* things. Deadlines,
 * priorities, completion, calendar maths, the academic lock, rescue mode and
 * quiet hours are all decided by deterministic code before any provider is
 * consulted, and no provider output is ever executed, evaluated, or used to
 * mutate state. A provider returning garbage degrades the wording of one
 * message and nothing else.
 */

export interface NextActionRequest {
  title: string;
  category: string;
  estimatedMinutes: number;
  course?: string | null;
  notes?: string | null;
}

export interface AiProvider {
  readonly name: string;
  readonly enabled: boolean;
  /** Turns a vague task into a concrete physical first action. */
  suggestNextAction(request: NextActionRequest): Promise<string | null>;
  /** Splits a large assignment into ordered sub-steps. */
  decompose(request: NextActionRequest, maxSteps: number): Promise<string[]>;
}

/** Cap on anything a provider returns, before it can reach a message. */
export const MAX_AI_TEXT = 120;

/**
 * Sanitises model output. Strips newlines, markdown, and anything that looks
 * like an instruction rather than an action, then truncates.
 */
export function sanitizeAiText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return null;
  if (cleaned.length > MAX_AI_TEXT) return `${cleaned.slice(0, MAX_AI_TEXT - 1).trimEnd()}…`;
  return cleaned;
}

/** The default. Every feature works with this in place. */
export class NoopAiProvider implements AiProvider {
  readonly name = 'none';
  readonly enabled = false;

  async suggestNextAction(): Promise<string | null> {
    return null;
  }

  async decompose(): Promise<string[]> {
    return [];
  }
}
