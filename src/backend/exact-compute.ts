/**
 * Exact evaluation of one arithmetic or boolean expression, for the `compute_exact` tool.
 *
 * A number is a rational over BigInt, so `0.1 + 0.2` is exactly `0.3`. A result that no finite decimal
 * holds, such as `1/3`, is returned as a fraction. The parser is recursive descent over a token list.
 * There is no `eval` and no `Function`: the tokenizer refuses identifiers, so there are no names, calls
 * or property accesses to resolve.
 */

/** The longest expression accepted, in characters. */
export const EXACT_COMPUTE_MAX_LENGTH = 500;
/** How deeply parentheses, unary minus, `not` and exponents may nest. */
const MAX_DEPTH = 64;
/** The largest numerator or denominator, in bits. It bounds the work and the length of the output. */
const MAX_BITS = 16_384;

export type ExactComputeResult =
  | { ok: true; type: "number" | "boolean"; value: string }
  | { ok: false; code: "validation"; message: string };

interface Rational {
  readonly num: bigint;
  /** Always positive. */
  readonly den: bigint;
}

type Value = { kind: "number"; value: Rational } | { kind: "boolean"; value: boolean };

interface Token {
  kind: "number" | "keyword" | "operator";
  text: string;
}

class ExactComputeError extends Error {}

const KEYWORDS: Readonly<Record<string, true>> = { and: true, or: true, not: true, true: true, false: true };
const NUMBER = /\d+(?:\.\d+)?|\.\d+/y;
const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;
const OPERATOR = /==|!=|<=|>=|[-+*/%^()<>]/y;
const SUM_OPERATORS = ["+", "-"] as const;
const PRODUCT_OPERATORS = ["*", "/", "%"] as const;
const COMPARISON_OPERATORS = ["==", "!=", "<=", ">=", "<", ">"] as const;

/** Evaluates one expression. Every expected failure is `code: "validation"` with a message for the agent. */
export function computeExact(expression: string): ExactComputeResult {
  try {
    if (expression.length > EXACT_COMPUTE_MAX_LENGTH) {
      throw new ExactComputeError(`The expression has more than ${EXACT_COMPUTE_MAX_LENGTH} characters.`);
    }
    const value = new Parser(tokenize(expression)).parse();
    if (value.kind === "boolean") return { ok: true, type: "boolean", value: String(value.value) };
    return { ok: true, type: "number", value: formatRational(value.value) };
  } catch (error) {
    if (error instanceof ExactComputeError) return { ok: false, code: "validation", message: error.message };
    throw error;
  }
}

function scan(pattern: RegExp, source: string, at: number): string | null {
  pattern.lastIndex = at;
  return pattern.exec(source)?.[0] ?? null;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    if (/\s/.test(source.charAt(at))) {
      at += 1;
      continue;
    }
    const number = scan(NUMBER, source, at);
    if (number !== null) {
      tokens.push({ kind: "number", text: number });
      at += number.length;
      continue;
    }
    const word = scan(WORD, source, at);
    if (word !== null) {
      if (!Object.hasOwn(KEYWORDS, word)) {
        throw new ExactComputeError(
          `"${word}" is not allowed: identifiers, function calls and properties are refused.`,
        );
      }
      tokens.push({ kind: "keyword", text: word });
      at += word.length;
      continue;
    }
    const operator = scan(OPERATOR, source, at);
    if (operator === null) throw new ExactComputeError(`Unsupported character "${source.charAt(at)}".`);
    tokens.push({ kind: "operator", text: operator });
    at += operator.length;
  }
  return tokens;
}

/**
 * Grammar, loosest binding first: `or`, `and`, `not`, one comparison, `+ -`, `* / %`, unary `-`, `^`,
 * then a number, `true`, `false` or a parenthesized expression. `^` is right-associative, and its
 * exponent may carry a unary minus. Operands are checked for type when they are evaluated.
 */
class Parser {
  readonly #tokens: readonly Token[];
  #at = 0;
  #depth = 0;

  constructor(tokens: readonly Token[]) {
    this.#tokens = tokens;
  }

  parse(): Value {
    const value = this.#or();
    const next = this.#tokens[this.#at];
    if (next) throw new ExactComputeError(`Unexpected "${next.text}".`);
    return value;
  }

  #or(): Value {
    let left = this.#and();
    while (this.#eat("or")) {
      const a = truth(left, "or");
      const b = truth(this.#and(), "or");
      left = { kind: "boolean", value: a || b };
    }
    return left;
  }

  #and(): Value {
    let left = this.#not();
    while (this.#eat("and")) {
      const a = truth(left, "and");
      const b = truth(this.#not(), "and");
      left = { kind: "boolean", value: a && b };
    }
    return left;
  }

  #not(): Value {
    if (!this.#eat("not")) return this.#comparison();
    return this.#nested(() => ({ kind: "boolean", value: !truth(this.#not(), "not") }));
  }

  #comparison(): Value {
    const left = this.#sum();
    const operator = this.#eatOne(COMPARISON_OPERATORS);
    if (operator === null) return left;
    return compare(left, operator, this.#sum());
  }

  #sum(): Value {
    let left = this.#product();
    let operator = this.#eatOne(SUM_OPERATORS);
    while (operator !== null) {
      left = binary(left, operator, this.#product());
      operator = this.#eatOne(SUM_OPERATORS);
    }
    return left;
  }

  #product(): Value {
    let left = this.#unary();
    let operator = this.#eatOne(PRODUCT_OPERATORS);
    while (operator !== null) {
      left = binary(left, operator, this.#unary());
      operator = this.#eatOne(PRODUCT_OPERATORS);
    }
    return left;
  }

  #unary(): Value {
    if (!this.#eat("-")) return this.#power();
    return this.#nested(() => {
      const operand = numberOf(this.#unary(), "-");
      return { kind: "number", value: rational(-operand.num, operand.den) };
    });
  }

  #power(): Value {
    const base = this.#atom();
    if (!this.#eat("^")) return base;
    const exponent = this.#nested(() => this.#unary());
    return { kind: "number", value: power(numberOf(base, "^"), numberOf(exponent, "^")) };
  }

  #atom(): Value {
    const token = this.#tokens[this.#at];
    if (!token) throw new ExactComputeError("The expression ends too early.");
    if (token.kind === "number") {
      this.#at += 1;
      return { kind: "number", value: decimal(token.text) };
    }
    if (token.kind === "keyword" && (token.text === "true" || token.text === "false")) {
      this.#at += 1;
      return { kind: "boolean", value: token.text === "true" };
    }
    if (this.#eat("(")) {
      return this.#nested(() => {
        const inner = this.#or();
        if (!this.#eat(")")) throw new ExactComputeError('A "(" has no matching ")".');
        return inner;
      });
    }
    throw new ExactComputeError(`Unexpected "${token.text}".`);
  }

  /** Runs one level of nesting, refusing to go deeper than `MAX_DEPTH`. */
  #nested(parse: () => Value): Value {
    this.#depth += 1;
    if (this.#depth > MAX_DEPTH) {
      throw new ExactComputeError(`The expression is nested more than ${MAX_DEPTH} levels deep.`);
    }
    try {
      return parse();
    } finally {
      this.#depth -= 1;
    }
  }

  #eat(text: string): boolean {
    if (this.#tokens[this.#at]?.text !== text) return false;
    this.#at += 1;
    return true;
  }

  #eatOne(texts: readonly string[]): string | null {
    return texts.find((text) => this.#eat(text)) ?? null;
  }
}

function numberOf(value: Value, operator: string): Rational {
  if (value.kind !== "number") throw new ExactComputeError(`"${operator}" needs numbers, not true or false.`);
  return value.value;
}

function truth(value: Value, operator: string): boolean {
  if (value.kind !== "boolean") throw new ExactComputeError(`"${operator}" needs true or false, not a number.`);
  return value.value;
}

function binary(left: Value, operator: string, right: Value): Value {
  const a = numberOf(left, operator);
  const b = numberOf(right, operator);
  switch (operator) {
    case "+":
      return { kind: "number", value: rational(a.num * b.den + b.num * a.den, a.den * b.den) };
    case "-":
      return { kind: "number", value: rational(a.num * b.den - b.num * a.den, a.den * b.den) };
    case "*":
      return { kind: "number", value: rational(a.num * b.num, a.den * b.den) };
    case "/":
      return { kind: "number", value: divide(a, b) };
    default:
      return { kind: "number", value: remainder(a, b) };
  }
}

function compare(left: Value, operator: string, right: Value): Value {
  if (operator === "==" || operator === "!=") {
    let equal: boolean;
    if (left.kind === "boolean" && right.kind === "boolean") equal = left.value === right.value;
    else if (left.kind === "number" && right.kind === "number") equal = orderOf(left.value, right.value) === 0;
    else throw new ExactComputeError(`"${operator}" compares two numbers or two booleans.`);
    return { kind: "boolean", value: operator === "==" ? equal : !equal };
  }
  const order = orderOf(numberOf(left, operator), numberOf(right, operator));
  switch (operator) {
    case "<":
      return { kind: "boolean", value: order < 0 };
    case "<=":
      return { kind: "boolean", value: order <= 0 };
    case ">":
      return { kind: "boolean", value: order > 0 };
    default:
      return { kind: "boolean", value: order >= 0 };
  }
}

function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** The bits of a magnitude; zero has one. */
function bitLength(value: bigint): number {
  return magnitude(value).toString(2).length;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

/** A reduced fraction with a positive denominator. The caller guarantees `den` is not zero. */
function rational(num: bigint, den: bigint): Rational {
  const sign = den < 0n ? -1n : 1n;
  const top = num * sign;
  const bottom = den * sign;
  const common = gcd(magnitude(top), bottom);
  const reduced = { num: top / common, den: bottom / common };
  if (bitLength(reduced.num) > MAX_BITS || bitLength(reduced.den) > MAX_BITS) {
    throw new ExactComputeError("The result is too large.");
  }
  return reduced;
}

/** A literal such as `12.5` or `.5`. The grammar gives it at least one digit. */
function decimal(text: string): Rational {
  const [whole, fraction = ""] = text.split(".");
  return rational(BigInt((whole || "0") + fraction), 10n ** BigInt(fraction.length));
}

function divide(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new ExactComputeError("Division by zero.");
  return rational(a.num * b.den, a.den * b.num);
}

/** The remainder has the sign of the dividend, as in JavaScript: `-7 % 3` is `-1`. */
function remainder(a: Rational, b: Rational): Rational {
  const quotient = divide(a, b);
  // BigInt division truncates toward zero, which is the whole part of the quotient.
  const whole = quotient.num / quotient.den;
  return rational(a.num * b.den - b.num * whole * a.den, a.den * b.den);
}

function orderOf(a: Rational, b: Rational): number {
  const difference = a.num * b.den - b.num * a.den;
  if (difference < 0n) return -1;
  return difference > 0n ? 1 : 0;
}

/** Only a whole-number exponent keeps the result rational. `0^0` is 1, as in JavaScript. */
function power(base: Rational, exponent: Rational): Rational {
  if (exponent.den !== 1n) throw new ExactComputeError("The exponent must be a whole number.");
  const k = exponent.num;
  if (base.num === 0n) {
    if (k < 0n) throw new ExactComputeError("Division by zero.");
    return k === 0n ? { num: 1n, den: 1n } : { num: 0n, den: 1n };
  }
  if (base.den === 1n && (base.num === 1n || base.num === -1n)) {
    const negative = base.num === -1n && k % 2n !== 0n;
    return { num: negative ? -1n : 1n, den: 1n };
  }
  const bits = BigInt(Math.max(bitLength(base.num), bitLength(base.den))) * magnitude(k);
  if (bits > BigInt(MAX_BITS)) throw new ExactComputeError("The result is too large.");
  const top = base.num ** magnitude(k);
  const bottom = base.den ** magnitude(k);
  return k < 0n ? rational(bottom, top) : rational(top, bottom);
}

/**
 * The exact decimal of a finite value, or the reduced fraction when no finite decimal holds it.
 * A denominator is finite-decimal exactly when it has no prime factors besides 2 and 5.
 */
function formatRational(value: Rational): string {
  const { num, den } = value;
  if (den === 1n) return num.toString();
  let rest = den;
  let twos = 0;
  let fives = 0;
  while (rest % 2n === 0n) {
    rest /= 2n;
    twos += 1;
  }
  while (rest % 5n === 0n) {
    rest /= 5n;
    fives += 1;
  }
  if (rest !== 1n) return `${num}/${den}`;
  const places = Math.max(twos, fives);
  // `den` divides 10^places, so this division is exact.
  const scaled = (magnitude(num) * 10n ** BigInt(places)) / den;
  const digits = scaled.toString().padStart(places + 1, "0");
  const point = digits.length - places;
  const sign = num < 0n ? "-" : "";
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}
