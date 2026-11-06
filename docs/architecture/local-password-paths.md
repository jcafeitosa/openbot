# Local password paths

Status: plan note for plan 002. This note does not change code.

## Frozen paths (released Team API v1)

These routes are in the frozen v1 registry. Do not change their meaning or payload. Remove none of them.

| Route | Handler | Store method |
|---|---|---|
| `POST /v1/join` | `src/main/team-api-server.ts:909` | `TeamStore.acceptInvite` |
| `POST /v1/auth/login` | `src/main/team-api-server.ts:944` | `TeamStore.login` |
| `POST /v1/auth/password` | `src/main/team-api/route-team.ts:100` | `TeamStore.changePassword` |

Registry: `packages/contracts/src/team-protocol/v1.ts:1912-1914` (route map), `:1048-1056` (HTTP contracts), `:1153-1157` (request keys).

The store methods keep the password behavior that these routes need. Changing the stored hash or the check changes the meaning of a released route.

## Removable paths (internal, no Team API v1 contract)

| Path | Location | Why it is internal |
|---|---|---|
| `TeamStore.configure` (hashes the owner secret) | `src/main/team-store.ts:487`, hash at `:507` | Called by the host IPC `configure` (`src/main/ipc/team-handlers.ts:155`) and by `src/main/local-server-child.ts:234`. Not a Team API route. |
| Development client fixture | `src/main/host-service.ts:1270-1285` | Fixed password for a local development client. Used only in this file. |
| Local `hashPasswordEffect` and `verifyPasswordEffect` | `src/main/team-store.ts:1627`, `:1632` | Helpers. They can change only with the paths above. |

The account paths (`configureWithAccount`, `loginWithAccount`, `acceptInviteWithAccount`; `team-store.ts:555`, `:1224`, `:1170`) are the direction of plan 002. They do not change in this note.

## Rules

- A frozen path keeps its route, payload, and response. Its store behavior stays the same.
- A removable path can change or be deleted with an IPC or internal change. Check every caller in the table above first.
- Migrations are not part of this note. The next free schema version is 59 (see below).

## Schema version check

- `src/backend/openbot-database-schema-history.json`: 51 keys, versions 8 to 58, no gaps.
- `src/backend/openbot-database-schema.ts:978`: last migration is version 58.
- Plan 010 names migration 48. Version 48 already exists, so plan 010 must use 59.
