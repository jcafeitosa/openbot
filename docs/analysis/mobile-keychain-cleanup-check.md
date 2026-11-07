# Keychain cleanup check: phone cache key

Base: `gabrielos-work` at `021bb0e49`. Worktree: `/Users/jcafeitosa/Projects/GabrielOS-mobile`, branch `mobile/keychain-cleanup-check`.
Mode: read-only. No lint, typecheck, build, or test run.

## Result

| Path | Key deleted? | Evidence |
|---|---|---|
| Sign-out (user action) | Yes, if the session state clears | `mobile-session-context.tsx:76` calls `deleteWorkspaceCaches()`, which deletes the key (`workspace-cache.ts:322`). |
| Session expiry (`MobileSessionExpiredError`) | Yes | `mobile-session-context.tsx` `handleSessionError` calls `setCurrentSession(null)`, which reaches line 76. |
| Server removal | No, by design | `mobile-workspace-context.tsx:539` calls `workspaceCache.remove(serverId)`, which deletes one server file. The key is device-wide, not per server. |
| Server list pruning | No, by design | `mobile-workspace-context.tsx:583` calls `retain`, which deletes files only. |

## Trace of the key

- Created: `workspace-cache.ts:82-88` in `cacheKey()`. It reads `KEY_NAME` (`openbot.mobile.workspace-cache-key.v1`, line 59). If absent, it generates an AES-256 key and stores it.
- Stored through `shared/lib/locked-keychain.ts`, service `openbot.after-first-unlock`, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`.
- Read: `workspace-cache.ts:82`, through the same `cacheKey()`.
- Deleted: `workspace-cache.ts:322` in `deleteWorkspaceCaches()`. `locked-keychain.ts:54-58` deletes both the new and the old keychain service.
- Only caller of `deleteWorkspaceCaches()`: `mobile-session-context.tsx:76`.

## Gaps and risks found by reading

1. **Sign-out depends on `logoutMobileSession` succeeding.** `mobile-session-context.tsx` `signOut` awaits `logoutMobileSession` (`mobile-auth.ts:465`) before `setCurrentSession(null)`. If that call throws, the cache and key are not deleted. The session state also stays set. Unconfirmed whether this can happen in practice, because `logoutMobileSession` writes the pending revocation first.
2. **Delete errors are swallowed.** `workspace-cache.ts:322` uses `.catch(() => undefined)`. If the keychain delete fails, the key stays and the caller sees no error.
3. **Possible key resurrection.** `deleteWorkspaceCaches()` sets `keyLoad = null`. A cache write still in flight after that calls `cacheKey()`, which generates and stores a new key. Not reproduced. Needs a test.
4. **No cleanup on cold start without a session.** `deleteWorkspaceCaches()` runs only when `sessionRef.current` was set. If the app closes during sign-out, a key can remain with no session. Unconfirmed.
5. **Keychain key survives app reinstall?** `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` is per device. Whether iOS removes keychain items on uninstall was not checked. Unconfirmed.

## Proposed E2E check (plan only; not written)

Name: `scripts/mobile-cache-keychain-e2e.ts`. Following the pattern of `scripts/mobile-*-e2e.ts`.

1. Sign in on a test device or simulator. Warm the cache. Confirm that the cache file and key exist.
2. Sign out. Confirm that the cache root is gone and that `openbot.mobile.workspace-cache-key.v1` is absent from both keychain services.
3. Repeat with session expiry (revoke the session on the host first).
4. Repeat with a failed `logoutMobileSession`. Confirm the result per risk 1.
5. Write a JSON report under `.openbot-build/`.

Run only on explicit user request, because it needs a device or simulator (`apps/mobile/AGENTS.md`).

## Not confirmed

- Behavior at runtime (no device or simulator run).
- Risks 1, 3, 4, and 5 above.
- Whether `docs/architecture/channels-and-messaging.md` describes the key lifecycle. Not read.

## Evidence

Read in the worktree: `apps/mobile/src/features/workspace/model/workspace-cache.ts`, `apps/mobile/src/shared/lib/locked-keychain.ts`, `apps/mobile/src/features/auth/context/mobile-session-context.tsx`, `apps/mobile/src/features/auth/api/mobile-auth.ts` (lines 262–296, 465–479), `apps/mobile/src/features/workspace/context/mobile-workspace-context.tsx` (lines 388–400, 530–545, 580–600).
Grep for `KEY_NAME`, `deleteWorkspaceCaches`, `deleteItemAsync`, and `LockedKeychain` across `apps/mobile/src`.
