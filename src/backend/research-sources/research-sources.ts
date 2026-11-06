/**
 * The web sources an agent's searches fetched, kept so a later turn can reuse a recent answer without
 * searching again. `record` stores one source when a web search completes; `recall` returns the recent
 * sources of an agent for the same query, each with its age. Query, url and title are stored after
 * `redactText`, and a value that matches a registered secret is refused, as the memory path refuses it.
 * The snippet is kept only as its SHA-256. The store reads and writes its own table through the
 * connection read at each use, and never imports the facade.
 */

import { createHash, randomUUID } from "node:crypto";
import { containsRegisteredSecret, redactText } from "@openbot/logging";
import { databaseRows, optionalStringColumn, requiredStringColumn } from "../database/database-rows";
import type { OpenBotDatabase } from "../openbot-database";

const RESEARCH_SOURCE_QUERY_LIMIT = 500;
const RESEARCH_SOURCE_TITLE_LIMIT = 300;
/** The most recent sources one `recall` returns. */
const RECALL_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ResearchSourceInput {
  agentId: string;
  query: string;
  url: string | null;
  title: string | null;
  /** The text the search returned. Only its SHA-256 is stored. */
  snippet: string;
}

export interface RecalledResearchSource {
  id: string;
  query: string;
  url: string | null;
  title: string | null;
  snippetHash: string;
  fetchedAt: string;
  /** Days since the source was fetched, at the moment of the recall. */
  ageDays: number;
}

/** The form a query is stored and matched in: redacted, whitespace-collapsed and lower-cased. */
function normalizeResearchQuery(query: string): string {
  return redactText(query).trim().replace(/\s+/gu, " ").toLowerCase();
}

export class ResearchSourceStore {
  readonly #database: OpenBotDatabase;

  constructor(database: OpenBotDatabase) {
    this.#database = database;
  }

  /**
   * Stores one source fetched at `now` and returns its id. A value that matches a registered secret is
   * refused rather than masked, so the row never says what it was for. A query that is empty after
   * normalizing, or longer than the column allows, is refused too.
   */
  record(input: ResearchSourceInput, now = new Date()): string {
    for (const value of [input.query, input.url ?? "", input.title ?? "", input.snippet]) {
      if (containsRegisteredSecret(value)) throw new Error("A research source holds a registered secret.");
    }
    const query = normalizeResearchQuery(input.query);
    if (query.length === 0) throw new Error("A research source needs a query.");
    if (query.length > RESEARCH_SOURCE_QUERY_LIMIT) throw new Error("A research source query is too long.");
    const url = input.url === null ? null : redactText(input.url).trim() || null;
    const title = input.title === null ? null : redactText(input.title).trim() || null;
    const id = randomUUID();
    this.#database.connection
      .prepare(
        `INSERT INTO research_sources (id, agent_id, query, url, title, snippet_hash, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        query,
        url,
        title === null ? null : Array.from(title).slice(0, RESEARCH_SOURCE_TITLE_LIMIT).join(""),
        createHash("sha256").update(input.snippet).digest("hex"),
        now.toISOString(),
      );
    return id;
  }

  /**
   * The sources an agent fetched for this query within the last `maxAgeDays`, newest first. The query is
   * matched after the same normalizing `record` applies, so a query that differs only in case or spacing
   * finds the same sources.
   */
  recall(agentId: string, query: string, maxAgeDays: number, now = new Date()): RecalledResearchSource[] {
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) throw new Error("The research source age must be positive.");
    const cutoff = new Date(now.getTime() - maxAgeDays * DAY_MS).toISOString();
    const rows = databaseRows(
      this.#database.connection
        .prepare(
          `SELECT id, query, url, title, snippet_hash, fetched_at FROM research_sources
           WHERE agent_id = ? AND query = ? AND fetched_at >= ?
           ORDER BY fetched_at DESC LIMIT ?`,
        )
        .all(agentId, normalizeResearchQuery(query), cutoff, RECALL_LIMIT),
    );
    return rows.map((row) => {
      const fetchedAt = requiredStringColumn(row, "fetched_at");
      return {
        id: requiredStringColumn(row, "id"),
        query: requiredStringColumn(row, "query"),
        url: optionalStringColumn(row, "url"),
        title: optionalStringColumn(row, "title"),
        snippetHash: requiredStringColumn(row, "snippet_hash"),
        fetchedAt,
        ageDays: (now.getTime() - Date.parse(fetchedAt)) / DAY_MS,
      };
    });
  }
}
