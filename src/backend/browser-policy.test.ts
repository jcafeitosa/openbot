// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPreferredSystemLanguages: () => ["en-US"],
    getLocale: () => "en-US",
  },
}));

import { isAllowedBrowserPermission, isAllowedMainUrl } from "./browser-policy";

describe("browser navigation policy", () => {
  it("allows about:blank and http/https URLs", () => {
    expect(isAllowedMainUrl("about:blank")).toBe(true);
    expect(isAllowedMainUrl("http://example.com/")).toBe(true);
    expect(isAllowedMainUrl("https://example.com/path?q=1")).toBe(true);
  });

  it("blocks file, javascript, data, and app schemes", () => {
    expect(isAllowedMainUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedMainUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedMainUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isAllowedMainUrl("openbot-app://app/index.html")).toBe(false);
  });

  it("blocks invalid and empty URLs", () => {
    expect(isAllowedMainUrl("")).toBe(false);
    expect(isAllowedMainUrl("not a url")).toBe(false);
  });
});

describe("browser permission policy", () => {
  it("permits only clipboard-sanitized-write", () => {
    expect(isAllowedBrowserPermission("clipboard-sanitized-write")).toBe(true);
  });

  it("refuses other permissions", () => {
    expect(isAllowedBrowserPermission("clipboard-read")).toBe(false);
    expect(isAllowedBrowserPermission("media")).toBe(false);
    expect(isAllowedBrowserPermission("geolocation")).toBe(false);
    expect(isAllowedBrowserPermission("notifications")).toBe(false);
  });
});
