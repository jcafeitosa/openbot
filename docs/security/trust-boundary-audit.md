# Trust-boundary audit: GabrielOS

Author: Security Lead. Base: branch gabrielos-work at 021bb0e49 (origin/main 021bb0e49).
Worktree: /Users/jcafeitosa/Projects/GabrielOS-security (branch security/trust-boundary-audit).
Mode: read-only. No production code changed. No tests run (no broad checks, per AGENTS.md).
The seven uncommitted files in /Users/jcafeitosa/Projects/GabrielOS were not touched.

Severity: High = breaks a non-negotiable or plan contract; Medium = boundary gap, exploit path
unconfirmed; Low = defence-in-depth gap with a mitigating control.

## Summary

| # | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| F1 | High (plan contract) | Host keeps local password sign-in; plan 002 forbids it | src/main/team-store.ts:507, 1272, 1297, 1362, 1627 |
| F2 | Medium | Team WebRTC window has no will-navigate or will-redirect guard | src/main/team-webrtc-bridge.ts:287-299 |
| F3 | Medium | Navigation policy for embedded browser has no unit or E2E test in the protected-area set | src/backend/browser-host.ts:3411-3420; src/backend/browser-policy.ts:63-65 |
| F4 | Low | Recorder window has no navigation guard | src/backend/browser-recorder.ts:110-122, 170-192 |
| F5 | Low (unconfirmed) | Browser diagnostics keep URL path, which can hold tokens; diagnostics go to providers after redactText | src/backend/browser-policy.ts:92-103; src/backend/browser-host.ts:3960; src/backend/browser-tab-operations.ts:172-188 |

No finding breaks a non-negotiable outright. F1 breaks plan 002, which is the stated next stage.

## 1. BrowserWindow and view options

Every window below sets `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
`webSecurity: true` is set where the option is listed. Exceptions are noted.

| Window or view | File:line | sandbox | contextIsolation | nodeIntegration | webSecurity | Window open | Navigation guard |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Main window (createWindow) | src/main/main-window.ts:231, prefs 251-258 | yes | yes | false | true | deny (297) | will-navigate to trusted origin (331-332) |
| Chat window | src/main/main-window.ts:380, prefs 393-400 | yes | yes | false | true | deny (414) | will-navigate (415-416) |
| Dynamic island | src/main/main-window.ts:615, prefs 633-640 | yes | yes | false | true | deny (648) | will-navigate (649-650) |
| Computer Use highlight | src/main/main-window.ts:667, prefs 685-692 | yes | yes | false | true | deny (710) | will-navigate (711-712) |
| Computer Use permission help | src/main/main-window.ts:738, prefs 755-762 | yes | yes | false | true | deny (771) | will-navigate (772-773) |
| Local sign-in window | src/main/local-sign-in-window.ts:242-248 | yes | yes | false | not set | allow only web URLs (275-279) | will-navigate and will-redirect to web URLs (271-276) |
| Chat visual preview | src/main/chat-visual-preview.ts:101-112 | yes | yes | false | not set | deny (146) | will-navigate and will-redirect block all (147-148) |
| Team WebRTC bridge | src/main/team-webrtc-bridge.ts:287-299 | yes | yes | false | yes | deny (299) | **none** (F2) |
| Picture-in-picture window | src/main/browser-picture-in-picture.ts:61-82 | yes | yes | false | yes | deny (112) | will-navigate (113) |
| Picture-in-picture controls view | src/main/browser-picture-in-picture.ts:87-95 | yes | yes | false | yes | deny (116) | will-navigate (117) |
| Browser dock overlay view | src/main/browser-dock-overlay.ts:205-215 | yes | yes | false | yes | deny (218) | will-navigate (219) |
| Browser tab views | src/backend/browser-host.ts:324-333 (BROWSER_WEB_PREFERENCES), 3058-3069 | yes | yes | false | yes | policy (3418-3440) | will-navigate and will-redirect (3411-3416) |
| Browser recorder window | src/backend/browser-recorder.ts:110-122 | yes | yes | false | yes | not set | **none** (F4) |

Notes:
- The main window's `will-navigate` handler is `isTrustedRendererUrl`, which accepts only the
  packaged `openbot-app://app` origin or the configured development origin
  (src/main/trusted-renderer.ts:1-15).
- Browser tab views spread the opener's `webPreferences` first and then `BROWSER_WEB_PREFERENCES`,
  so the security flags win (src/backend/browser-host.ts:3058-3069). Popup options come from the
  browser page, not from a preload.
- Permissions: the default session allows the renderer only what `canRequestRendererPermission`
  permits (src/main/session-configuration.ts:53-68). The browser tab session allows only
  `clipboard-sanitized-write` (src/backend/browser-host.ts:3117-3120; src/backend/browser-policy.ts:74-76).
- Renderer CSP is set only for trusted main frames (src/main/session-configuration.ts:38-50).
- The `openbot-app` protocol serves files only under the renderer root and returns 404 for any other
  host (src/main/session-configuration.ts:239-258).

## 2. Navigation policy: what it allows and blocks

### Main renderer (`openbot-app://app`)
- Allows: navigation whose origin is the packaged app origin, or the development origin when
  `ELECTRON_RENDERER_URL` is set (src/main/trusted-renderer.ts:1-15).
- Blocks: every other navigation, by `event.preventDefault()` (src/main/main-window.ts:331-332).
- Blocks: every `window.open` (src/main/main-window.ts:297).
- Existing tests: src/main/trusted-ipc.test.ts:27-45 cover `isTrustedRendererUrl` for packaged,
  development, foreign-host, foreign-origin, and null inputs. They do not cover the
  `will-navigate` handler, the `will-redirect` handler, or `setWindowOpenHandler`. No test covers the
  main window's navigation guard directly. Unconfirmed: whether an E2E script drives it.

### Embedded browser tabs (web pages)
- Allows: `about:blank` and `http:`/`https:` URLs (src/backend/browser-policy.ts:63-65;
  src/backend/browser-state.ts:169-176).
- Blocks: `file:`, `javascript:`, `data:`, `openbot-app:`, custom schemes, by preventing the
  navigation (src/backend/browser-host.ts:3411-3416). `will-redirect` is checked only for the main
  frame, which is correct for top-level redirects.
- Popups: allowed only for `foreground-tab`, `background-tab`, `new-window` dispositions, and only
  to allowed URLs, with tab, capacity, and memory checks (src/backend/browser-host.ts:3418-3440).
  Secure-input tabs refuse popups.
- Permissions: only `clipboard-sanitized-write` (src/backend/browser-policy.ts:74-76). Camera,
  microphone, location, notifications, and clipboard read are refused.
- Tests: none found under `src/` for `isAllowedMainUrl`, `isPersistableBrowserUrl`, or
  `isAllowedBrowserPermission`. The scripts `scripts/browser-smoke-electron.ts`,
  `scripts/browser-sign-in-electron.ts`, and `scripts/browser-agent-session-electron.ts` reference
  `about:blank` or popups. Unconfirmed: whether they assert the block rules. I did not read them in full.

### Local sign-in window
- Allows: web URLs only (src/main/local-sign-in-window.ts:271-279).
- Child windows inherit the same guard (src/main/local-sign-in-window.ts:282).

## 3. Findings

### F1 (High, plan contract): local password sign-in on the host
- `src/main/team-store.ts:507` (`configure`), `:1272` (`acceptInvite`), `:1362` (`changePassword`)
  call `hashPasswordEffect`. `:1297` (`login`) verifies a password.
- `:1627-1643` define `hashPasswordEffect` with scrypt.
- Plan 002 (`plans/002-tanstack-solid-cloudflare-d1-auth.md`) says the API neither accepts nor
  stores an OpenBot password. `plans/README.md` records the same conflict and says plan 002 stays
  IN PROGRESS.
- This is not a non-negotiable in AGENTS.md. It is an open stage of plan 002.
- Not a breach of "Redact secrets": I did not find password values in logs. Unconfirmed.

### F2 (Medium): Team WebRTC window has no navigation guard
- `src/main/team-webrtc-bridge.ts:287-299`: the window sets `setWindowOpenHandler` to deny, and it
  has a preload (`teamWebrtc.cjs`), but no `will-navigate` or `will-redirect` handler.
- The window loads `openbot-app://app/team-webrtc.html` in production
  (src/main/team-webrtc-bridge.ts:300-304). A navigation to another origin would load that origin
  in a window with a preload that carries a `MessagePort` to the bridge.
- Exploit path: unconfirmed. It needs a navigation the renderer can trigger. The page is internal,
  so the risk depends on whether the page has any link or form.
- Fix: add the same guard as the main window (`isTrustedRendererUrl` in `will-navigate` and
  `will-redirect`). This touches the trust boundary, so Security Lead approves it before merge.

### F3 (Medium): embedded browser navigation policy has no test
- The policy is at `src/backend/browser-host.ts:3411-3440` and `src/backend/browser-policy.ts:63-76`.
- The main-window guard (`src/main/main-window.ts:331-332`) and `setWindowOpenHandler` have no
  direct test.
- AGENTS.md lists "navigation and permission policy" as a protected area that needs Vitest
  coverage. There is no test for it in `src/` (checked with `grep` for `isAllowedMainUrl`,
  `isTrustedRendererUrl`, `will-navigate`, `setWindowOpenHandler` in `*.test.ts`). Only
  `src/main/ipc-channel-coverage.test.ts` and `src/main/trusted-ipc.test.ts` match, and they do not
  test the guards.
- Plan for the test (not implemented, per the task): see section 5.

### F4 (Low): recorder window has no navigation guard
- `src/backend/browser-recorder.ts:110-122` creates a hidden window with sandbox, context isolation,
  and webSecurity, and no preload.
- `:170-190` registers an `https` protocol handler on the recorder partition. Any `https` request in
  that partition gets the recorder page, with `default-src 'none'`. A `POST /chunk` writes a
  recording chunk.
- `:192` loads only `https://recorder.openbot.invalid/`.
- Mitigation: no preload, so no IPC. The partition is unique per recording.
- Gap: no `will-navigate` guard. Low severity.

### F5 (Low, unconfirmed): diagnostics keep the URL path
- `src/backend/browser-policy.ts:92-103` (`diagnosticUrl`) strips credentials, query, and hash, and
  keeps the path. The comment at `:79-82` says a path can carry a secret such as `/reset/<secret>`
  or `/invite/<secret>`.
- `src/backend/browser-host.ts:3960` (`diagnosticUrlField`) adds that URL to network diagnostics
  (lines 3093, 3112, 3340, 3350).
- `src/backend/browser-tab-operations.ts:172-188` sends these diagnostics to the provider after
  `src/backend/browser-diagnostics.ts` runs `redactText` (`:19`, `:112`).
- Unconfirmed: whether `redactText` removes a bare secret in a URL path. I did not test it with a
  sample. Needs a test.
- `src/main/maintenance-service.ts:160-220` (the diagnostics export) does not include URLs, paths, or
  raw error messages. Its `privacy` field says so. Good.

## 4. Redaction sampling

Count: the brief said 92 redact hits. My count with `grep -rn redact` over `src apps packages remote`,
excluding vendor and `node_modules`, is 729 lines in 133 files. Unconfirmed: the brief's count may
use a narrower path set.

| Path | File:line | Result |
| --- | --- | --- |
| Logger, text | packages/logging/src/index.ts:168 (`redactText`) | Registered secrets and JSON and text rules. |
| Logger, values | packages/logging/src/index.ts:369 (`redactValue`, `toLogValue`) | Cycle-safe conversion; each string through `redactText`. |
| Provider log | src/main/provider-log.ts | 2 redact references. Not read in full. |
| Analytics | src/main/analytics.ts:1153 (`#track`) | Every event goes through `sanitizeHostEvent`. Not read in full. |
| Trace file | src/main/trace-file.ts:170-180 | Writes NDJSON lines. Redaction upstream: unconfirmed. |
| Remote diagnostics | src/main/remote-diagnostics.ts:86-97 | Cuts lines so a secret is not split. 7 redact references. |
| Diagnostics export | src/main/maintenance-service.ts:160-220 | Structured fields only, no raw strings. Good. |
| Browser diagnostics to provider | src/backend/browser-diagnostics.ts:112 | Redact before cut. See F5. |
| Chat visual preview console | src/main/chat-visual-preview.ts (console-message handler) | `redactText` before the line goes to the provider. |

Unredacted secret found in sampling: none confirmed. F5 is the one open question.

Test coverage of redaction:
- `src/backend/mcp-redaction.test.ts`, `src/main/github-rest-redaction.test.ts`,
  `src/main/vault-service.test.ts`, `src/main/remote-diagnostics.test.ts`,
  `scripts/analytics-redaction-e2e.ts`, `scripts/browser-secret-smoke.ts`,
  `scripts/provider-fakes/transcript-redaction.test.ts`.
- Not checked: whether these cover every log and export path listed above.

## 5. Plan for the navigation test (not implemented)

Owner: Security & QA worker, after the user creates the team.
1. Unit test (Vitest allowed for the trust boundary): `src/main/trusted-renderer.test.ts` or an
   extension of `trusted-ipc.test.ts`. Cases: packaged origin accepted; development origin accepted;
   `openbot-app://other/`, `https://`, `file://`, `javascript:` rejected; `null` rejected. Covers
   F2's fix.
2. Unit test: `isAllowedMainUrl` and `isAllowedBrowserPermission` (`src/backend/browser-policy.test.ts`).
   Cases: `about:blank`, `http:`, `https:` allowed; `file:`, `javascript:`, `data:`, `openbot-app:`
   rejected; only `clipboard-sanitized-write` permitted. Covers F3.
3. E2E script under `scripts/` (AGENTS.md requires E2E for new tests): load the main renderer, try a
   navigation to a foreign origin, and check it is blocked. Write a JSON artifact under
   `.openbot-build/`. Covers F2 and F3.
4. Decide whether `diagnosticUrl` should drop the path. This is a product choice, so the user decides.

## 6. Recommended next actions

1. Add a navigation guard to the Team WebRTC window (F2). Team: Desktop Core, approved by Security
   Lead. Small change.
2. Add the navigation and permission tests in section 5 (F3). Team: Security & QA worker.
3. Remove local password sign-in per plan 002 (F1). Team: Desktop Core and Backend. The user
   decides how existing password rows migrate, because migrations are irreversible.
4. Add a guard to the recorder window (F4). Team: Desktop Core. Low priority.
5. Test whether `redactText` removes secrets in URL paths, then decide on F5. Team: Security & QA.

## 7. Unconfirmed claims

- F2 exploit path: not reproduced.
- F5: `redactText` on URL paths not tested.
- Redaction coverage of every log and export path: only sampled.
- Count of redact hits: 729 lines in 133 files, versus 92 in the brief.
- Existing E2E scripts for the browser: not read in full.
- Whether password sign-in in `team-store.ts` is reachable from the UI: not traced.

## 8. Evidence

Commands, all read-only except the worktree creation:
- `git worktree add -b security/trust-boundary-audit .../GabrielOS-security gabrielos-work`. Needed
  the sandbox disabled, because the sandbox blocked writes under `.git`.
- `grep -rn "new BrowserWindow\|new BrowserView\|WebContentsView"` over `src apps packages`.
- `grep -rn "webPreferences"` over `src`.
- `grep -rln "will-navigate\|setWindowOpenHandler\|will-redirect\|setPermission..."` over `src`.
- `sed -n` reads of: `src/main/main-window.ts` (225-275, 375-410, 610-770), `src/main/trusted-renderer.ts`,
  `src/main/local-sign-in-window.ts` (236-285), `src/main/session-configuration.ts` (36-75, 239-262),
  `src/main/chat-visual-preview.ts` (98-150), `src/main/team-webrtc-bridge.ts` (283-305),
  `src/main/browser-picture-in-picture.ts` (58-100), `src/main/browser-dock-overlay.ts` (203-225),
  `src/backend/browser-recorder.ts` (106-192), `src/backend/browser-host.ts` (3058-3110, 3405-3450),
  `src/backend/browser-policy.ts` (63-103), `src/main/maintenance-service.ts` (155-220),
  `src/main/trace-file.ts` (160-180), `src/main/remote-diagnostics.ts` (75-97),
  `packages/logging/src/index.ts` (150-200, 365-400).
- `grep` for test coverage of the guards in `*.test.ts` and `scripts/`.
- `grep -rl redact` count over `src apps packages remote`.
