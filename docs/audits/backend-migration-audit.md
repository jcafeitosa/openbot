# Backend migration audit

Scope: `apps/auth-api/migrations`, the test harness, and the production D1 job in CI.
Base: `gabrielos-work` at `021bb0e49`.
Mode: read-only. No migration file, workflow file, or code file was changed.

## Summary

| Item | Count or result |
| --- | --- |
| Migration files | 51 (`0001` to `0050`, with one prefix used twice) |
| Duplicate prefix | 1 (`0034`, two files) |
| Migrations with no test that names the file | 15 |
| Of those 15, schema applied by the shared harness | 15 (up to cut `0049`; see below) |
| Migrations with a data-preservation fixture confirmed | Not confirmed for any of the 15 |
| Production D1 apply step with a dry run or gate | 0 (`.github/workflows/ci.yml:1179`) |
| `remote/api` test files | 0 |

## 1. The duplicate `0034` prefix

Files:

- `apps/auth-api/migrations/0034_account_attribution.sql`: creates `account_attribution` (`user_id` primary key, foreign key to `users`, cascade delete).
- `apps/auth-api/migrations/0034_server_claims.sql`: creates `server_claims` and index `server_claims_expires_at`. Foreign key to `users`, cascade delete.

Facts:

- Neither file alters the other's table. Neither file depends on the other.
- Order is by full file name. `0034_account_attribution.sql` sorts before `0034_server_claims.sql`. The shared test harness (`test/sqlite-d1.ts`) uses the same sort.
- Wrangler D1 tracks applied migrations by file name, not by prefix (confirmed by the Wrangler docs only; not run here).
- No source file in `src/` or `scripts/` parses the numeric prefix. Checked by grep for `migrations` in `src` and `scripts`.

Conclusion: the duplicate does not break apply order today. It is a risk for future tools that key on the prefix.

Decision needed: none for the current files. Do not rename a shipped migration; the rule in `AGENTS.md` makes any change to a released migration a developer decision. A new migration must use `0051` or higher.

## 2. The 15 migrations with no test that names the file

Method: grep for the file prefix (for example `0016`) and for the full file name in `apps/auth-api/test/*.ts`. Zero matches for each file below.

| Migration | Named in a test |
| --- | --- |
| 0001_google_auth.sql | no |
| 0003_remove_google_oauth.sql | no |
| 0004_team_auth_tickets.sql | no |
| 0005_team_tunnels.sql | no |
| 0006_one_team_server_per_user.sql | no |
| 0007_team_host_machine_tokens.sql | no |
| 0008_remove_team_tunnel_vnc.sql | no |
| 0016_hosted_sites.sql | no |
| 0025_slack_workspace_routes.sql | no |
| 0026_discord_guild_routes.sql | no |
| 0027_webhook_routes.sql | no |
| 0028_hosted_server_lifecycle.sql | no |
| 0032_mobile_connect_links.sql | no |
| 0033_mobile_session_connect_link.sql | no |
| 0036_membership_removed_at.sql | no |

Correction to the earlier count: the name-based check overstates the gap. The shared harness in `test/sqlite-d1.ts` applies every migration whose name sorts at or before a cut value. It is imported by 12 test files. Cut values found in tests include `0034_server_claims.sql`, `0040_server_member_limits.sql`, `0046_remote_session_indexes.sql`, and `0049_user_chat_color.sql`. A cut at `0049` applies all 15 files above, and so does every cut above them.

So the 15 files are covered for schema apply. Not covered: data preservation. The rule in `AGENTS.md` requires a data-preservation fixture for each affected released schema, plus the failure and rollback cases in `apps/auth-api/AGENTS.md`. The shared harness applies the SQL. It does not insert rows before a migration and check the rows after it. Per-file data fixtures were not found by name. Unconfirmed: a test may insert rows before a cut and check them afterwards without naming the file. Checked by reading test names and the `migratedDatabase` call sites only; not every test body was read.

Decision needed: whether each of the 15 files needs a data-preservation fixture now. The AGENTS.md rule says a migration always needs one. Adding tests is not a migration change, so this does not need a developer decision under the irreversibility rule. It does need the developer to accept the test scope.

## 3. The production D1 apply step has no dry run or gate

Location: `.github/workflows/ci.yml`, job `deploy-production` (line 1022), step "Apply production D1 migrations" (lines 1174 to 1179).

Facts:

- Trigger: `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`. Every push to `main` runs it.
- Needs 12 lanes: `check`, `browser`, `tests-desktop`, `signal-e2e`, `automation-cli-e2e`, `team-api-routes-e2e`, `reverse-actions-e2e`, `provider-fakes-e2e`, `api`, `storybook`, `surfaces`, `mobile-share-sender-e2e`.
- Environment: `cloudflare-production`.
- Step runs `wrangler d1 migrations apply DB --remote --config wrangler.jsonc` with no preceding list, dry run, or approval step.
- The step runs before the Worker deploy. A failed apply after a partial run is not reverted (migrations are irreversible).
- Not confirmed: whether the environment `cloudflare-production` has a manual approval rule. Checked the job only; environment settings are in GitHub and were not read.

## 4. `remote/api` has no tests

Checked: `find remote -name '*.test.*'` returns 0 files. `remote/api/src` has 16 source files. Not in this audit's scope: whether a test lane in CI covers it by another name.

## Proposed dry-run gate (plan only; `ci.yml` is not edited)

1. Before the apply step, add a step `wrangler d1 migrations list DB --remote --config wrangler.jsonc`. Save the output as a job artifact.
2. Compare the list with the migration files in the commit. Fail the job if a file is missing from the remote list when it should be applied, or if the remote list has a name that is not in the commit.
3. Require a manual approval on the `cloudflare-production` environment before the apply step, if GitHub settings allow it. Confirm this in GitHub settings first.
4. Keep the apply step. Do not add a backup step; the rule is that no backup is assumed.
5. Add a note to the release notes for any step that changes the schema: the file name and the rollback position (forward-only).

Owner: Backend (worker), Release & Reliability (CI owner), migration critic (Backend). Desktop Core co-reviews any shared schema change.

## Unconfirmed claims

- Wrangler D1 keys applied migrations by file name: from general knowledge of Wrangler; not checked in this repo or run.
- Environment `cloudflare-production` approval rules: not read; GitHub settings are outside the repo.
- Data-preservation fixtures per migration: not confirmed; test bodies were not all read.
- `remote/api` tests in other CI lanes: not checked.
