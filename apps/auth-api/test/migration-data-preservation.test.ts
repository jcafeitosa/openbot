import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migratedDatabase, migration } from "./sqlite-d1";

// Data-preservation fixtures for migrations that no other test names. Each fixture
// migrates to the released schema before the migration, seeds rows, applies the
// migration file and asserts the rows survive. The migration files are not changed.
// 0001 has no released schema before it, so it has no fixture here.

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function seeded(last: string): DatabaseSync {
  const database = migratedDatabase(last);
  databases.push(database);
  return database;
}

function apply(database: DatabaseSync, name: string): void {
  database.exec(migration(name));
}

describe("data preservation of unnamed migrations", () => {
  it("0003 renames google_subject to identity_key and keeps every account", () => {
    const database = seeded("0002_email_login_codes.sql");
    database.exec(`
      INSERT INTO users(id, google_subject, email, name, avatar_url, created_at, updated_at)
        VALUES ('u1', 'sub-1', 'a@example.com', 'Ada', 'https://example.com/a.png', 1, 2);
    `);
    apply(database, "0003_remove_google_oauth.sql");
    expect(
      database.prepare("SELECT id, identity_key, email, name, avatar_url, created_at, updated_at FROM users").all(),
    ).toEqual([
      {
        id: "u1",
        identity_key: "sub-1",
        email: "a@example.com",
        name: "Ada",
        avatar_url: "https://example.com/a.png",
        created_at: 1,
        updated_at: 2,
      },
    ]);
  });

  it("0004 keeps accounts and existing rows untouched", () => {
    const database = seeded("0003_remove_google_oauth.sql");
    database.exec(`
      INSERT INTO users(id, identity_key, email, created_at, updated_at)
        VALUES ('u1', 'sub-1', 'a@example.com', 1, 2);
    `);
    apply(database, "0004_team_auth_tickets.sql");
    expect(database.prepare("SELECT id, identity_key, email, created_at, updated_at FROM users").all()).toEqual([
      { id: "u1", identity_key: "sub-1", email: "a@example.com", created_at: 1, updated_at: 2 },
    ]);
  });

  it("0005 keeps accounts and existing rows untouched", () => {
    const database = seeded("0004_team_auth_tickets.sql");
    database.exec(`
      INSERT INTO users(id, identity_key, email, created_at, updated_at)
        VALUES ('u1', 'sub-1', 'a@example.com', 1, 2);
    `);
    apply(database, "0005_team_tunnels.sql");
    expect(database.prepare("SELECT id, email FROM users").all()).toEqual([{ id: "u1", email: "a@example.com" }]);
  });

  it("0006 keeps every tunnel row when the one-server-per-user index is rebuilt", () => {
    const database = seeded("0005_team_tunnels.sql");
    database.exec(`
      INSERT INTO users(id, identity_key, email, created_at, updated_at)
        VALUES ('u1', 'sub-1', 'a@example.com', 1, 2);
      INSERT INTO team_tunnels(server_id, user_id, tunnel_id, tunnel_name, api_hostname, vnc_hostname, status, created_at, updated_at)
        VALUES ('s1', 'u1', 't1', 'tunnel-1', 'api-1.example.com', 'vnc-1.example.com', 'active', 3, 4);
    `);
    apply(database, "0006_one_team_server_per_user.sql");
    expect(
      database
        .prepare(
          "SELECT server_id, user_id, tunnel_id, tunnel_name, api_hostname, vnc_hostname, status, created_at, updated_at FROM team_tunnels",
        )
        .all(),
    ).toEqual([
      {
        server_id: "s1",
        user_id: "u1",
        tunnel_id: "t1",
        tunnel_name: "tunnel-1",
        api_hostname: "api-1.example.com",
        vnc_hostname: "vnc-1.example.com",
        status: "active",
        created_at: 3,
        updated_at: 4,
      },
    ]);
  });

  it("0007 keeps every tunnel row and leaves its new machine token hash empty", () => {
    const database = seeded("0006_one_team_server_per_user.sql");
    database.exec(`
      INSERT INTO users(id, identity_key, email, created_at, updated_at)
        VALUES ('u1', 'sub-1', 'a@example.com', 1, 2);
      INSERT INTO team_tunnels(server_id, user_id, tunnel_id, tunnel_name, api_hostname, vnc_hostname, status, created_at, updated_at)
        VALUES ('s1', 'u1', 't1', 'tunnel-1', 'api-1.example.com', 'vnc-1.example.com', 'active', 3, 4);
    `);
    apply(database, "0007_team_host_machine_tokens.sql");
    expect(
      database
        .prepare(
          "SELECT server_id, user_id, tunnel_id, tunnel_name, api_hostname, status, created_at, updated_at, machine_token_hash FROM team_tunnels",
        )
        .all(),
    ).toEqual([
      {
        server_id: "s1",
        user_id: "u1",
        tunnel_id: "t1",
        tunnel_name: "tunnel-1",
        api_hostname: "api-1.example.com",
        status: "active",
        created_at: 3,
        updated_at: 4,
        machine_token_hash: null,
      },
    ]);
  });

  it("0008 copies every tunnel row, with its machine token hash, into the rebuilt table", () => {
    const database = seeded("0007_team_host_machine_tokens.sql");
    database.exec(`
      INSERT INTO users(id, identity_key, email, created_at, updated_at)
        VALUES ('u1', 'sub-1', 'a@example.com', 1, 2);
      INSERT INTO team_tunnels(server_id, user_id, tunnel_id, tunnel_name, api_hostname, vnc_hostname, status, created_at, updated_at, machine_token_hash)
        VALUES ('s1', 'u1', 't1', 'tunnel-1', 'api-1.example.com', 'vnc-1.example.com', 'active', 3, 4, 'hash-1');
    `);
    apply(database, "0008_remove_team_tunnel_vnc.sql");
    expect(
      database
        .prepare(
          "SELECT server_id, user_id, tunnel_id, tunnel_name, api_hostname, status, created_at, updated_at, machine_token_hash FROM team_tunnels",
        )
        .all(),
    ).toEqual([
      {
        server_id: "s1",
        user_id: "u1",
        tunnel_id: "t1",
        tunnel_name: "tunnel-1",
        api_hostname: "api-1.example.com",
        status: "active",
        created_at: 3,
        updated_at: 4,
        machine_token_hash: "hash-1",
      },
    ]);
  });

  it("0016 keeps accounts and the remote hosts that predate hosted sites", () => {
    const database = seeded("0015_email_challenge_delivery_state.sql");
    database.exec(`
      INSERT INTO users(id, identity_key, email, created_at, updated_at)
        VALUES ('u1', 'sub-1', 'a@example.com', 1, 2);
      INSERT INTO remote_hosts(host_id, owner_user_id, name, created_at, updated_at)
        VALUES ('h1', 'u1', 'Desk', 3, 4);
    `);
    apply(database, "0016_hosted_sites.sql");
    expect(
      database.prepare("SELECT host_id, owner_user_id, name, created_at, updated_at FROM remote_hosts").all(),
    ).toEqual([{ host_id: "h1", owner_user_id: "u1", name: "Desk", created_at: 3, updated_at: 4 }]);
  });

  it("0025 keeps existing remote hosts and accounts", () => {
    const database = seeded("0024_hosted_site_servers.sql");
    database.exec(`
      INSERT INTO users(id, identity_key, email, created_at, updated_at)
        VALUES ('u1', 'sub-1', 'a@example.com', 1, 2);
      INSERT INTO remote_hosts(host_id, owner_user_id, name, created_at, updated_at)
        VALUES ('h1', 'u1', 'Desk', 3, 4);
    `);
    apply(database, "0025_slack_workspace_routes.sql");
    expect(database.prepare("SELECT host_id, name FROM remote_hosts").all()).toEqual([{ host_id: "h1", name: "Desk" }]);
    expect(database.prepare("SELECT id, email FROM users").all()).toEqual([{ id: "u1", email: "a@example.com" }]);
  });

  it("0026 keeps existing remote hosts and accounts", () => {
    const database = seeded("0025_slack_workspace_routes.sql");
    database.exec(`
      INSERT INTO users(id, identity_key, email, created_at, updated_at)
        VALUES ('u1', 'sub-1', 'a@example.com', 1, 2);
      INSERT INTO remote_hosts(host_id, owner_user_id, name, created_at, updated_at)
        VALUES ('h1', 'u1', 'Desk', 3, 4);
    `);
    apply(database, "0026_discord_guild_routes.sql");
    expect(database.prepare("SELECT host_id, name FROM remote_hosts").all()).toEqual([{ host_id: "h1", name: "Desk" }]);
    expect(database.prepare("SELECT id, email FROM users").all()).toEqual([{ id: "u1", email: "a@example.com" }]);
  });

  it("0027 keeps existing remote hosts and accounts", () => {
    const database = seeded("0026_discord_guild_routes.sql");
    database.exec(`
      INSERT INTO users(id, identity_key, email, created_at, updated_at)
        VALUES ('u1', 'sub-1', 'a@example.com', 1, 2);
      INSERT INTO remote_hosts(host_id, owner_user_id, name, created_at, updated_at)
        VALUES ('h1', 'u1', 'Desk', 3, 4);
    `);
    apply(database, "0027_webhook_routes.sql");
    expect(database.prepare("SELECT host_id, name FROM remote_hosts").all()).toEqual([{ host_id: "h1", name: "Desk" }]);
    expect(database.prepare("SELECT id, email FROM users").all()).toEqual([{ id: "u1", email: "a@example.com" }]);
  });

  it("0028 keeps every hosted server and leaves the new lifecycle columns empty", () => {
    const database = seeded("0027_webhook_routes.sql");
    database.exec(`
      INSERT INTO users(id, identity_key, email, created_at, updated_at)
        VALUES ('u1', 'sub-1', 'a@example.com', 1, 2);
      INSERT INTO hosted_servers(server_id, owner_user_id, name, size, plan, billing_interval, currency, desired_state, observed_state, idempotency_key, created_at, updated_at)
        VALUES ('srv1', 'u1', 'Box', 'small', 'starter', 'month', 'usd', 'running', 'running', 'idem-1', 3, 4);
    `);
    apply(database, "0028_hosted_server_lifecycle.sql");
    expect(
      database
        .prepare(
          "SELECT server_id, owner_user_id, name, size, plan, desired_state, observed_state, idempotency_key, created_at, updated_at, deletion_scheduled_at, lifecycle_token FROM hosted_servers",
        )
        .all(),
    ).toEqual([
      {
        server_id: "srv1",
        owner_user_id: "u1",
        name: "Box",
        size: "small",
        plan: "starter",
        desired_state: "running",
        observed_state: "running",
        idempotency_key: "idem-1",
        created_at: 3,
        updated_at: 4,
        deletion_scheduled_at: null,
        lifecycle_token: null,
      },
    ]);
  });

  it("0032 keeps existing sessions, hosts and accounts", () => {
    const database = seeded("0031_billing_sales.sql");
    database.exec(`
      INSERT INTO users(id, identity_key, email, created_at, updated_at)
        VALUES ('u1', 'sub-1', 'a@example.com', 1, 2);
      INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at)
        VALUES ('sess1', 'u1', 'tok-1', 100, 1, 2);
      INSERT INTO remote_hosts(host_id, owner_user_id, name, created_at, updated_at)
        VALUES ('h1', 'u1', 'Desk', 3, 4);
    `);
    apply(database, "0032_mobile_connect_links.sql");
    expect(database.prepare("SELECT id, user_id, token_hash FROM auth_sessions").all()).toEqual([
      { id: "sess1", user_id: "u1", token_hash: "tok-1" },
    ]);
    expect(database.prepare("SELECT host_id, name FROM remote_hosts").all()).toEqual([{ host_id: "h1", name: "Desk" }]);
  });

  it("0033 keeps every mobile session and leaves its connect-link host empty", () => {
    const database = seeded("0032_mobile_connect_links.sql");
    database.exec(`
      INSERT INTO users(id, identity_key, email, created_at, updated_at)
        VALUES ('u1', 'sub-1', 'a@example.com', 1, 2);
      INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at)
        VALUES ('sess1', 'u1', 'tok-1', 100, 1, 2);
      INSERT INTO mobile_auth_sessions(session_id, user_id, device_id, device_name, platform, created_at)
        VALUES ('sess1', 'u1', 'dev-1', 'Phone', 'ios', 5);
    `);
    apply(database, "0033_mobile_session_connect_link.sql");
    expect(
      database
        .prepare(
          "SELECT session_id, user_id, device_id, device_name, platform, created_at, connect_link_host_id FROM mobile_auth_sessions",
        )
        .all(),
    ).toEqual([
      {
        session_id: "sess1",
        user_id: "u1",
        device_id: "dev-1",
        device_name: "Phone",
        platform: "ios",
        created_at: 5,
        connect_link_host_id: null,
      },
    ]);
  });

  it("0036 marks each removed membership at its update time and leaves active members unchanged", () => {
    const database = seeded("0035_billing_sales_reversals.sql");
    database.exec(`
      INSERT INTO users(id, identity_key, email, created_at, updated_at)
        VALUES ('u1', 'sub-1', 'a@example.com', 1, 2),
               ('u2', 'sub-2', 'b@example.com', 1, 2);
      INSERT INTO remote_hosts(host_id, owner_user_id, name, created_at, updated_at)
        VALUES ('h1', 'u1', 'Desk', 3, 4);
      INSERT INTO remote_memberships(membership_id, host_id, user_id, role, status, created_at, updated_at)
        VALUES ('m1', 'h1', 'u1', 'owner', 'active', 3, 400),
               ('m2', 'h1', 'u2', 'member', 'revoked', 3, 500);
    `);
    apply(database, "0036_membership_removed_at.sql");
    expect(
      database
        .prepare(
          "SELECT membership_id, user_id, role, status, created_at, updated_at, removed_at FROM remote_memberships ORDER BY membership_id",
        )
        .all(),
    ).toEqual([
      {
        membership_id: "m1",
        user_id: "u1",
        role: "owner",
        status: "active",
        created_at: 3,
        updated_at: 400,
        removed_at: null,
      },
      {
        membership_id: "m2",
        user_id: "u2",
        role: "member",
        status: "revoked",
        created_at: 3,
        updated_at: 500,
        removed_at: 500,
      },
    ]);
  });
});
