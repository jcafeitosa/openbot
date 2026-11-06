import { Schema } from "effect";
import { z } from "zod";
import { causeHelpers } from "../effect-boundary";
import {
  type OpenBotToolResponse,
  openBotToolFailure,
  type ToolFailureDetail,
  VALIDATION_FAILURE,
} from "./routine-tools";

/** Expected failures from tool validation and injected storage or provider adapters. */
export class ToolOperationFailed extends Schema.TaggedError<ToolOperationFailed>()("ToolOperationFailed", {
  cause: Schema.Defect(),
}) {}

export const { sync: toolStep, rewrap: toToolOperationFailed } = causeHelpers(ToolOperationFailed);

/**
 * A tool failure whose code is known where it is thrown. The router answers with that code; any other
 * error is `internal`.
 */
export class ToolFailureError extends Error {
  readonly detail: ToolFailureDetail;

  constructor(detail: ToolFailureDetail, message: string) {
    super(message);
    this.name = "ToolFailureError";
    this.detail = detail;
  }
}

/** Arguments that the tool cannot use. The same call with corrected arguments can succeed. */
export function invalidToolArgument(message: string): ToolFailureError {
  return new ToolFailureError(VALIDATION_FAILURE, message);
}

/** The code, retry flag and hint of a failed tool call, read from the cause that the router caught. */
export function toolFailureDetail(cause: unknown): ToolFailureDetail {
  if (cause instanceof ToolOperationFailed) return toolFailureDetail(cause.cause);
  if (cause instanceof ToolFailureError) return cause.detail;
  if (cause instanceof z.ZodError) return VALIDATION_FAILURE;
  return { code: "internal", retryable: false };
}

/** The answer to a failed tool call. The message is redacted, since a defect can carry a secret. */
export function toolFailureResponse(
  cause: unknown,
  message: string,
  redact: (text: string) => string,
): OpenBotToolResponse {
  return openBotToolFailure(redact(message), toolFailureDetail(cause));
}
