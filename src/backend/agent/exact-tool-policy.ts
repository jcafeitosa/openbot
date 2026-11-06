/**
 * Decides whether a user request contains arithmetic or a comparison that should go through the
 * `compute_exact` tool instead of being computed in text. Pure: no model call, no I/O.
 *
 * Rule: the request has an operator (`+ - * / % ^`, or a comparison `== != <= >= < >`) that joins a
 * left operand ending in a digit or `)` to a right operand starting with a digit, `.digit`, or `(`.
 * Every operator accepts optional spaces, except `-`, which needs spaces on both sides so that dates and
 * codes such as `2024-05-06` do not match. Bare identifiers never match, so `x + y` gives null, while
 * `sqrt(2) + 1` gives guidance because it is arithmetic, even though `compute_exact` refuses the call.
 * Known false positives are advisory: `1/2 cup`. False negatives: `10-3` without spaces.
 *
 * The guidance is a fixed template. It never contains any part of the request.
 */

export const EXACT_TOOL_GUIDANCE =
  "This request has arithmetic or a comparison. Get the exact result by calling compute_exact with the expression, not by computing it in text. This guidance is advisory.";

const ARITHMETIC_JOIN = /[\d)]\s*(?:[+*/%^]|==|!=|<=|>=|[<>])\s*(?:\d|\.\d|\()|[\d)]\s+-\s+(?:\d|\.\d|\()/;

/** The fixed guidance line when the request holds arithmetic or a comparison, otherwise null. */
export function exactToolGuidance(request: string): string | null {
  return ARITHMETIC_JOIN.test(request) ? EXACT_TOOL_GUIDANCE : null;
}
