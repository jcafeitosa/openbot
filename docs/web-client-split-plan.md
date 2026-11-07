# Web client split plan

Author: Frontend Lead
Base: `gabrielos-work` at `021bb0e49`. Branch: `web/split-plan`.
Status: plan only. No code change. No checks run. Line numbers come from `grep` and are approximate.

## 1. Problem

Two files hold almost all browser state and logic:

| File | Lines | Shape |
| --- | --- | --- |
| `src/renderer/src/features/web-client/web-client-context.tsx` | 2,281 | One closure, `createWebWorkspace` (lines 214–2246, about 2,030 lines). It holds state, effects, and actions. |
| `src/renderer/src/features/web-client/web-runtime.ts` | 1,640 | One closure, `createWebWorkspaceRuntime` (lines 442–1512, about 1,070 lines), plus decoders (1513–1640). |

The closures share many local `let` and `const` values. Plan 007 and PRs 3–5 must edit the same
bodies. A split reduces merge conflicts and makes review possible.

Rule for this split: behavior does not change. Move code. Do not rename released IPC or Team API
names. Keep the existing `props.createRuntime` injection point, which the tests use.

## 2. Split technique

1. **Pure code first.** Types, constants, and functions that read no closure state move to
   their own modules. Low risk.
2. **Controllers with an explicit context.** A group of closure functions moves to a factory
   such as `createAvatarLoader(deps)`. The factory receives only the signals and setters it
   uses, in a typed object. The closure calls the factory and keeps one line of wiring.
3. **Connect flow last.** `attemptConnection` (about 240 lines) and its helpers are the
   riskiest move. They touch host key pinning and host locks.

Each moved function keeps its name. Each new module starts with a short comment that names its
owner and the released contract it relies on.

## 3. Proposed split: `web-client-context.tsx`

| New module | Moves from `web-client-context.tsx` | Kind | Notes |
| --- | --- | --- | --- |
| `web-workspace-types.ts` | `WebConversation`, `WebWorkspaceState` (82–212), `trimToLatestPage` (104–122), constants (94–97) | Pure | Step 1. |
| `web-workspace-events.ts` | `changedConversation` (2250–2266), `presenceWithChatColors` (2268–2281), `FOCUS_RESYNC_MS` (2247–2248) | Pure | Step 1. |
| `web-avatar-loader.ts` | `avatarLoads`, `loadAvatars` (713–741) | Controller | Limits concurrent loads. Keeps the existing "few at a time" rule. |
| `web-pin-scopes.ts` | `pinScope`, `pinScopes`, `openHostPins` (651–666) | Controller | Pure logic on `state.host`. |
| `web-recovery.ts` | `makeRecovery`, `noteConnectionFailure`, `recover`, `recoverNow` (311–355) | Controller | Owns the retry timing. Keep the existing delays. |
| `web-conversation-deltas.ts` | `applyDelta` (1510–1547), `heldDeltas` buffer (306), `conversationReads` (305) | Controller | Owns event ordering. Needs a test-only seam. |
| `web-queue-sync.ts` | `loadQueue`, `changeQueue` (1549–1665), `queueLoads`, `queueRevisions` (300–302) | Controller | Coalesces event bursts per agent. |
| `web-frame-sync.ts` | `saveFrame` (1357–1509), the two `createEffect` frame blocks (676–696) | Controller | Keeps the cross-tab sync messages unchanged. |
| `web-host-connect.ts` | `attemptConnection` (1120–1356), `refreshHosts` (887–1019), `clearRevokedWorkspace`, `blockAccess` (1029–1119) | Controller | Step 4 only. Highest risk. |

After the split, `web-client-context.tsx` keeps: the `createWebWorkspace` shell, the `runtime`
creation (line 382), the `createSidebarPreferences` wiring, and the return object. Target size:
under 900 lines. This target is a goal, not a gate.

## 4. Proposed split: `web-runtime.ts`

| New module | Moves from `web-runtime.ts` | Kind | Notes |
| --- | --- | --- | --- |
| `web-runtime-types.ts` | `WebAdminRuntime`, `WebFile`, `WebWorkspaceRuntime`, `WebRuntimeEvents`, `WebHostIncompatibleError`, `WebHostConnectionError` (203–417) | Pure | Step 1. Public types keep their names. Other modules import them from here, and `web-runtime.ts` re-exports them. |
| `web-runtime-decoders.ts` | `decodeWebFile`, `decodeWebBrowserTab`, `decodeWebBrowserPreview`, `decodeWebConversationPage`, `decodeWebConversationSnapshot`, `queueSnapshot`, `hostRefusal`, `toTeamMember`, `toTeamInvite` (1513–1640, 1532–1570) | Pure | Step 1. Decoders validate untrusted values. Keep each decoder's behavior exactly. AGENTS.md: decode at the boundary. |
| `web-host-protocol.ts` | `hostProtocolKey`, `savedHostProtocol`, `pinWebHostKey` (425–441) | Pure with storage | Host key pinning. Security & QA review required. |
| `web-drafts.ts` | `localDraftPreview`, `revokeLocalDraftPreviews`, `trackCompletedDraft`, `removeCompletedDrafts`, `discardCompletedDrafts`, `completedDraftIdsByHost`, `localDraftPreviews` (584–651) | Controller | Owns blob URL revoke. Keep revoke timing. |
| `web-team-api.ts` | `request`, `teamApi`, `requireHost`, `routineFlowsRequest`, `listChatColors`, `listMembers`, `readSidebarLayout` (652–790) | Controller | Shared request path. Keeps the `Team API` decode rule. |
| `web-browser-view.ts` | `releaseLiveView`, `viewListeners`, `emitView`, `browserView` wiring (791–815) | Controller | Remote browser view (PR 7). |
| `web-connect.ts` | `connectHost`, `closeOpenedHost`, `giveUpHost` (815–1000+), `createOpenedPeer`, `retire` (513–538) | Controller | Step 4. Highest risk. |

After the split, `web-runtime.ts` keeps the `createWebWorkspaceRuntime` shell, the `directory`
client (452), the session actions (465), and the returned runtime object. Target size: under 400
lines.

## 5. PR order

Each PR is one commit series. Each PR must leave the tree compiling by its own check.

| Order | PR | Scope | Risk | Review |
| --- | --- | --- | --- | --- |
| 1 | S1 Pure extraction | `web-workspace-types.ts`, `web-workspace-events.ts`, `web-runtime-types.ts`, `web-runtime-decoders.ts`. No logic change. | Low | Frontend specialist. Desktop Core co-review (renderer owner). |
| 2 | S2 Runtime controllers | `web-drafts.ts`, `web-team-api.ts`, `web-browser-view.ts`, `web-host-protocol.ts`. | Medium | Desktop Core (renderer). Security & QA for `web-host-protocol.ts`. |
| 3 | S3 Context controllers | `web-avatar-loader.ts`, `web-pin-scopes.ts`, `web-recovery.ts`, `web-conversation-deltas.ts`, `web-queue-sync.ts`, `web-frame-sync.ts`. | Medium | Frontend and Desktop Core. Accessibility and performance critic. |
| 4 | S4 Connect flow | `web-host-connect.ts`, `web-connect.ts`. | High | Security & QA (host pinning, session). Backend & Infra for host route use. |

PR 4 of `docs/web-client.md` (history, live updates, approvals, drafts) starts only after S1–S3
merge. S4 may run after PR 4 if the feature work does not touch `attemptConnection`.

Stop rule: if any move changes a test result or a released contract, stop the PR and report
to the Frontend Lead.

## 6. E2E gaps and scripts to write

All scripts go under `scripts/`. They are E2E only (AGENTS.md). Each writes
`.openbot-build/<name>/report.json` and screenshots. Mutating steps need `--allow-mutations`.
Use the pattern of `scripts/web-client-threads-e2e.ts`, with `channel-e2e-support` and
`dev-automation/cdp-client`.

| Script | Covers | Gap today | Plan / PR |
| --- | --- | --- | --- |
| `scripts/web-client-signin-e2e.ts` | Email code sign-in at `/app`. Wrong code rejected. Code limit (5 failures per code). Cookie flags `Secure; HttpOnly; SameSite=Lax`. | No E2E. | Plan 002; PR 2. |
| `scripts/web-client-session-revoke-e2e.ts` | Sign-out sends `Max-Age=0`. An old session cookie is refused after revoke. | No E2E. | Plan 002; PR 2. |
| `scripts/web-client-csrf-e2e.ts` | Cross-site `POST` without `X-OpenBot-Browser` is refused. A mismatched `Origin` is refused. Records the current defense, because no CSRF token exists. | No E2E. | PR 2; Security & QA. |
| `scripts/web-client-approvals-e2e.ts` | An approval and a question round trip from the host to the web tab. | No E2E. | PR 4. |
| `scripts/web-client-files-e2e.ts` | Draft upload, preview, cancel, and discard (`web-attachments.ts`). | No E2E. | PR 5. |
| `scripts/web-client-small-screen-e2e.ts` | At a 390×844 viewport, switch between conversation and workspace panes (`WebMobileNavigation.tsx`). | No E2E. | PR 7. |

The existing scripts cover trim (`web-client-conversation-trim-e2e.ts`), performance
(`web-client-perf-e2e.ts`), and threads (`web-client-threads-e2e.ts`). They are not changed by this plan.

Acceptance for each script: it passes against this worktree's dev stack, and its report has no
secret values (AGENTS.md: redact on every log path).

## 7. Open items and unverified claims

- Not verified: the exact line ranges of each helper. They come from `grep` on the `web-client-context.tsx` and `web-runtime.ts` at `021bb0e49`. The implementer re-checks each range before a move.
- Not verified: whether `web-client-threads-e2e.ts` passes on this base.
- Not verified: dead code in these two files (knip not run; no checks run, per the task rules).
- Not verified: the 400-day cookie lifetime is intended. Security & QA must confirm (plan 002 does not state it).
- Base check: `gabrielos-work` resolves to `021bb0e49`. `origin/main` does not resolve in this repo as a local ref (remotes are `origin`, `private`, `upstream`). CTO's `021bb0e49` base is taken as given.
