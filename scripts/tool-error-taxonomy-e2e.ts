// Checks the tool error taxonomy over the real LocalMcpBridge: an MCP client calls each tool through
// HTTP, and every failure answers with a code the model can act on. The answers come from the same
// classifier that the OpenBot tool router uses (tool-operation.ts). A bad argument is `validation`, an
// unavailable service is `unavailable` and retryable, a thrown defect is `internal`, not retryable, and
// redacted, and an approval gate is `approval_required`. The MCP client sees isError and the code in the
// content. No provider, account or network is started.
// Run: `bun scripts/tool-error-taxonomy-e2e.ts`. Writes .openbot-build/tool-error-taxonomy-e2e/report.json.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { redactText, registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import { z } from "zod";
import { type OpenBotToolResponse, openBotToolResult, TOOL_FAILURE_CODES } from "../src/backend/agent/routine-tools";
import { ToolFailureError, toolFailureResponse } from "../src/backend/agent/tool-operation";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { type DynamicToolNamespace, LocalMcpBridge, type LocalMcpSession } from "../src/backend/local-mcp-bridge";

const OUT = resolve(import.meta.dirname, "../.openbot-build/tool-error-taxonomy-e2e");
const SECRET = "tet-fake-secret-4d91f0";
const countArguments = z.object({ count: z.number().int() }).strict();
const successBody = z.object({ ok: z.literal(true) });
const failureBody = z.object({
  error: z.string(),
  code: z.enum(TOOL_FAILURE_CODES),
  retryable: z.boolean(),
  hint: z.string().optional(),
});
const textItem = z.object({ type: z.literal("text"), text: z.string() });
const toolArguments = z.object({ count: z.string().optional() });
type ToolArguments = z.infer<typeof toolArguments>;

interface Check {
  name: string;
  passed: boolean;
  error?: string;
}

const checks: Check[] = [];

async function check(name: string, run: () => Promise<void>): Promise<void> {
  process.stdout.write(`- ${name}\n`);
  try {
    await run();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
  }
}

const namespace: DynamicToolNamespace = {
  type: "namespace",
  name: "openbot",
  tools: [
    { type: "function", name: "ok_tool", inputSchema: { type: "object", properties: {} } },
    { type: "function", name: "invalid_args", inputSchema: { type: "object", properties: {} } },
    { type: "function", name: "unavailable_tool", inputSchema: { type: "object", properties: {} } },
    { type: "function", name: "leaky_tool", inputSchema: { type: "object", properties: {} } },
    { type: "function", name: "approval_tool", inputSchema: { type: "object", properties: {} } },
  ],
};

/** The tool handlers. Each one fails the way a real tool does, or answers with a value. */
function dispatch(tool: string, args: unknown): OpenBotToolResponse {
  switch (tool) {
    case "ok_tool":
      return openBotToolResult({ ok: true });
    case "invalid_args":
      return openBotToolResult(countArguments.parse(args));
    case "unavailable_tool":
      throw new ToolFailureError(
        { code: "unavailable", retryable: true, hint: "Try again in a minute." },
        "The calendar service is unavailable.",
      );
    case "leaky_tool":
      throw new Error(`The sync failed with token ${SECRET}.`);
    case "approval_tool":
      throw new ToolFailureError(
        { code: "approval_required", retryable: false, hint: "Ask the user to approve this change in OpenBot." },
        "This change needs the user's approval.",
      );
    default:
      throw new ToolFailureError({ code: "not_found", retryable: false }, `Unknown tool: ${tool}`);
  }
}

/** Runs one call the way the router does: a failure becomes a classified, redacted result. */
function answer(call: { tool: string; arguments: unknown }): Effect.Effect<OpenBotToolResponse> {
  return Effect.try({
    try: () => dispatch(call.tool, call.arguments),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(toolFailureResponse(cause, cause instanceof Error ? cause.message : String(cause), redactText)),
    ),
  );
}

/**
 * The SDK transport classes declare their handlers and `sessionId` as `T | undefined`, which
 * `exactOptionalPropertyTypes` does not accept as a `Transport`. This one forwards to such a class.
 */
function asTransport(inner: {
  start(): Promise<void>;
  send: Transport["send"];
  close(): Promise<void>;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: Transport["onmessage"] | undefined;
  setProtocolVersion?: ((version: string) => void) | undefined;
}): Transport {
  const transport: Transport = {
    start: () => {
      inner.onclose = () => transport.onclose?.();
      inner.onerror = (error) => transport.onerror?.(error);
      inner.onmessage = (message, extra) => transport.onmessage?.(message, extra);
      return inner.start();
    },
    send: (message, options) => inner.send(message, options),
    close: () => inner.close(),
    setProtocolVersion: (version) => inner.setProtocolVersion?.(version),
  };
  return transport;
}

interface Answer {
  isError: boolean;
  text: string;
  body: unknown;
}

/** One tool call through the MCP SDK client, over the session's HTTP server. */
async function callTool(session: LocalMcpSession, name: string, args: ToolArguments): Promise<Answer> {
  const server = session.servers[0];
  assert.ok(server, "The session has an MCP server.");
  const header = server.headers.find((candidate) => candidate.name === "Authorization");
  assert.ok(header, "The session's server carries a token.");
  const client = new Client({ name: "e2e-tool-error-taxonomy", version: "1.0.0" });
  try {
    await client.connect(
      asTransport(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { Authorization: header.value } },
        }),
      ),
    );
    const result = await client.callTool({ name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((item) => {
        const parsed = textItem.safeParse(item);
        return parsed.success ? parsed.data.text : "";
      })
      .join("");
    return { isError: result.isError === true, text, body: JSON.parse(text) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** The message a call throws, as the handler sees it. */
function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("The call did not throw.");
}

registerSecretValue(SECRET);
const bridge = new LocalMcpBridge();
const session = await runCauseEffect(
  bridge.createSession(
    "thread-tool-error-taxonomy",
    [namespace],
    () => "turn-tool-error-taxonomy",
    (call) => answer(call),
  ),
);

try {
  await check("a successful call answers without a failure code", async () => {
    const answered = await callTool(session, "ok_tool", {});
    assert.equal(answered.isError, false);
    successBody.parse(answered.body);
  });

  await check("invalid arguments return code validation, not retryable, error text unchanged", async () => {
    const expected = thrownMessage(() => countArguments.parse({ count: "many" }));
    const answered = await callTool(session, "invalid_args", { count: "many" });
    const failure = failureBody.parse(answered.body);
    assert.equal(answered.isError, true);
    assert.equal(failure.code, "validation");
    assert.equal(failure.retryable, false);
    // redactText re-serializes a JSON message compactly. A validation message holds no secret, so the text
    // is the thrown message as the redaction layer returns it.
    assert.equal(failure.error, redactText(expected));
  });

  await check("an unavailable tool returns code unavailable, retryable true", async () => {
    const answered = await callTool(session, "unavailable_tool", {});
    const failure = failureBody.parse(answered.body);
    assert.equal(answered.isError, true);
    assert.equal(failure.code, "unavailable");
    assert.equal(failure.retryable, true);
    assert.equal(failure.error, "The calendar service is unavailable.");
  });

  await check("a defect returns code internal, not retryable, with the seeded secret removed", async () => {
    const answered = await callTool(session, "leaky_tool", {});
    const failure = failureBody.parse(answered.body);
    assert.equal(answered.isError, true);
    assert.equal(failure.code, "internal");
    assert.equal(failure.retryable, false);
    assert.ok(!answered.text.includes(SECRET), "The returned text carries no seeded secret.");
  });

  await check("an approval-gated call returns code approval_required", async () => {
    const answered = await callTool(session, "approval_tool", {});
    const failure = failureBody.parse(answered.body);
    assert.equal(answered.isError, true);
    assert.equal(failure.code, "approval_required");
    assert.equal(failure.retryable, false);
  });
} finally {
  session.close();
  await runCauseEffect(bridge.close());
}

const passed = checks.every((entry) => entry.passed);
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
process.stdout.write(
  `${passed ? "PASS" : "FAIL"}: ${checks.filter((entry) => entry.passed).length}/${checks.length}\n`,
);
if (!passed) {
  for (const entry of checks) if (!entry.passed) process.stderr.write(`${entry.name}: ${entry.error}\n`);
  process.exitCode = 1;
}
