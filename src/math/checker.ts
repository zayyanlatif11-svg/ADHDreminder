/**
 * Answer checking for the small set of question types the bank actually uses.
 *
 * This is explicitly NOT a symbolic math engine. When an answer cannot be
 * confidently graded, it returns `unknown` so the caller can queue it for
 * manual review — telling the user they were wrong when we do not know would
 * be worse than admitting uncertainty.
 */

export type QuestionType = 'integer' | 'fraction' | 'pair';

export type CheckVerdict = 'correct' | 'incorrect' | 'unknown';

export interface CheckResult {
  verdict: CheckVerdict;
  /** Populated when the verdict is `unknown`. */
  reason?: string;
  normalized?: string;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0 ? 1 : x;
}

interface Rational {
  numerator: number;
  denominator: number;
}

export function reduce(rational: Rational): Rational {
  const divisor = gcd(rational.numerator, rational.denominator);
  let numerator = rational.numerator / divisor;
  let denominator = rational.denominator / divisor;
  if (denominator < 0) {
    numerator = -numerator;
    denominator = -denominator;
  }
  return { numerator, denominator };
}

/**
 * Accepts "3", "-3", "3/4", "-3/4", "0.75", and tolerates surrounding words
 * like "x = 3" or "the answer is 3" because that is how people actually reply.
 */
export function parseRational(input: string): Rational | null {
  const cleaned = input
    .toLowerCase()
    .replace(/[^0-9+\-./]/g, ' ')
    .trim();
  if (cleaned === '') return null;

  // Prefer the last numeric token: "x = 3" should read as 3.
  const tokens = cleaned.split(/\s+/).filter((token) => /\d/.test(token));
  const token = tokens.at(-1);
  if (!token) return null;

  const fraction = /^([+-]?\d+)\/([+-]?\d+)$/.exec(token);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
      return null;
    }
    return reduce({ numerator, denominator });
  }

  const decimal = /^([+-]?\d*\.?\d+)$/.exec(token);
  if (decimal) {
    const value = Number(decimal[1]);
    if (!Number.isFinite(value)) return null;
    if (Number.isInteger(value)) return { numerator: value, denominator: 1 };
    // Convert a terminating decimal exactly, so 0.75 === 3/4.
    const decimals = (decimal[1] ?? '').split('.')[1]?.length ?? 0;
    const scale = 10 ** decimals;
    return reduce({ numerator: Math.round(value * scale), denominator: scale });
  }
  return null;
}

function rationalsEqual(a: Rational, b: Rational): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

function formatRational(rational: Rational): string {
  return rational.denominator === 1
    ? String(rational.numerator)
    : `${rational.numerator}/${rational.denominator}`;
}

/** Parses "2,3" / "2 and 3" / "(x+2)(x+3)" into a sorted numeric pair. */
export function parsePair(input: string): [number, number] | null {
  const numbers = [...input.matchAll(/[+-]?\d+/g)]
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value));
  if (numbers.length < 2) return null;
  // Take the last two numbers mentioned, which handles "(x+2)(x+3)".
  const a = numbers[numbers.length - 2] as number;
  const b = numbers[numbers.length - 1] as number;
  return a <= b ? [a, b] : [b, a];
}

export function checkAnswer(
  given: string,
  expected: string,
  type: QuestionType,
): CheckResult {
  const trimmed = given.trim();
  if (trimmed === '') {
    return { verdict: 'unknown', reason: 'empty answer' };
  }
  // A reply that is mostly prose is not something we can grade honestly.
  if (trimmed.length > 60) {
    return { verdict: 'unknown', reason: 'answer too long to grade confidently' };
  }

  if (type === 'pair') {
    const givenPair = parsePair(trimmed);
    const expectedPair = parsePair(expected);
    if (!givenPair || !expectedPair) {
      return { verdict: 'unknown', reason: 'could not read two numbers from the answer' };
    }
    const correct = givenPair[0] === expectedPair[0] && givenPair[1] === expectedPair[1];
    return {
      verdict: correct ? 'correct' : 'incorrect',
      normalized: `${givenPair[0]},${givenPair[1]}`,
    };
  }

  const givenRational = parseRational(trimmed);
  const expectedRational = parseRational(expected);
  if (!expectedRational) {
    return { verdict: 'unknown', reason: 'question bank answer is not numeric' };
  }
  if (!givenRational) {
    return { verdict: 'unknown', reason: 'could not read a number from the answer' };
  }

  // Integer questions should not silently accept 3.5 for 3.
  if (type === 'integer' && givenRational.denominator !== 1) {
    const equal = rationalsEqual(givenRational, expectedRational);
    if (!equal) {
      return { verdict: 'incorrect', normalized: formatRational(givenRational) };
    }
  }

  return {
    verdict: rationalsEqual(givenRational, expectedRational) ? 'correct' : 'incorrect',
    normalized: formatRational(givenRational),
  };
}
