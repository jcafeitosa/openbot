// @vitest-environment node

import { describe, expect, it } from "vitest";
import { BrowserDiagnostics } from "./browser-diagnostics";
import { diagnosticUrl } from "./browser-policy";

describe("browser diagnostics redaction", () => {
  it("redacts a known secret token in a URL path before it enters diagnostics", () => {
    // A path that carries a token matching a known secret prefix.
    const url = "https://example.com/reset/sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890";
    const diagnostic = diagnosticUrl(url);
    expect(diagnostic).toBeDefined();

    const diagnostics = new BrowserDiagnostics();
    diagnostics.add({ kind: "network", level: "info", message: `GET ${diagnostic}` });
    const snapshot = diagnostics.snapshot();
    const message = snapshot.diagnostics[0]?.message ?? "";
    expect(message).not.toContain("sk-ant-api03");
    expect(message).toContain("[redacted]");
  });

  it("redacts a bearer token that appears in a diagnostic message", () => {
    const diagnostics = new BrowserDiagnostics();
    diagnostics.add({
      kind: "network",
      level: "error",
      message: "GET https://api.example.com/data failed Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    });
    const snapshot = diagnostics.snapshot();
    const message = snapshot.diagnostics[0]?.message ?? "";
    expect(message).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(message).toContain("[redacted]");
  });

  it("keeps a safe diagnostic URL path readable", () => {
    const diagnostic = diagnosticUrl("https://example.com/docs/getting-started?token=secret#hash");
    expect(diagnostic).toBe("https://example.com/docs/getting-started");
  });
});
