/**
 * The preferences that a person stated in a message, one value per key. The store holds no rule about who
 * writes: the tool that calls `set` checks that the message came from the person, before it reaches here.
 * It reads and writes its own table through the connection read at each use, and never imports the facade.
 */

import { databaseRows, requiredStringColumn } from "../database/database-rows";
import type { OpenBotDatabase } from "../openbot-database";
import { storedWorkstateText } from "./workstate-text";

/** The person of this computer: the one OpenBot user whose messages set preferences. */
export const LOCAL_PERSON_ID = "owner";

export const PREFERENCE_KEY_LIMIT = 64;
export const PREFERENCE_VALUE_LIMIT = 300;

/** The newest-updated preferences that the developer instructions state, and the most characters they take. */
const INSTRUCTION_PREFERENCES = 12;
const INSTRUCTION_CHARACTERS = 1200;

export interface PersonPreference {
  key: string;
  value: string;
  updatedAt: string;
}

export class PersonPreferencesStore {
  readonly #database: OpenBotDatabase;

  constructor(database: OpenBotDatabase) {
    this.#database = database;
  }

  /** Sets one preference of a person. A value with a registered secret is refused; the rest is stored after redaction. */
  set(personId: string, key: string, value: string, now = new Date()): PersonPreference {
    const name = storedWorkstateText(key, PREFERENCE_KEY_LIMIT, 1, "The preference key");
    const stored = storedWorkstateText(value, PREFERENCE_VALUE_LIMIT, 1, "The preference value");
    const updatedAt = now.toISOString();
    this.#database.connection
      .prepare(
        `INSERT INTO person_preferences (person_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(person_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(personId, name, stored, updatedAt);
    return { key: name, value: stored, updatedAt };
  }

  /** The newest-updated preferences of a person. */
  list(personId: string): PersonPreference[] {
    return databaseRows(
      this.#database.connection
        .prepare(
          "SELECT key, value, updated_at FROM person_preferences WHERE person_id = ? ORDER BY updated_at DESC, key",
        )
        .all(personId),
    ).map((row) => ({
      key: requiredStringColumn(row, "key"),
      value: requiredStringColumn(row, "value"),
      updatedAt: requiredStringColumn(row, "updated_at"),
    }));
  }

  /**
   * The preferences of a person that the developer instructions state: the newest within the budget. Each one
   * is a line `key: value`, and the values were stored after redaction.
   */
  instructionPreferences(personId: string): PersonPreference[] {
    const chosen: PersonPreference[] = [];
    let characters = 0;
    for (const preference of this.list(personId)) {
      if (chosen.length === INSTRUCTION_PREFERENCES) break;
      characters += Array.from(`${preference.key}: ${preference.value}`).length;
      if (characters > INSTRUCTION_CHARACTERS) break;
      chosen.push(preference);
    }
    return chosen;
  }
}
