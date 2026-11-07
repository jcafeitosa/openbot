import { randomUUID } from "node:crypto";
import { type FSWatcher, realpathSync, watch } from "node:fs";
import { join, relative } from "node:path";
import type { RoutineFileWatchInput } from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import type { OpenBotDatabase } from "../openbot-database";
import { isWithin, workspacePathFromInput } from "../workspace-paths";

const logger = createOpenBotLogger("file-watch");

/** The quiet time after the last change, in seconds, before a file trigger runs its routine. */
const FILE_WATCH_DEBOUNCE_MIN_SECONDS = 1;
const FILE_WATCH_DEBOUNCE_MAX_SECONDS = 60;

/** A declaration the person refused: the text is already a sentence for them. */
class FileWatchRefused extends Error {}

interface FileWatchTriggersOptions {
  database: OpenBotDatabase;
  /** The workspace root of an agent, read each time: an agent rename moves it. Null when the agent is gone. */
  workspaceRoot(agentId: string): string | null;
  /** Whether the routine exists, is active and its agent may run it. Only then does its watcher run. */
  runnable(agentId: string, routineId: string): boolean;
  /** Starts one run of the routine, through the same path as a script trigger. */
  fire(agentId: string, routineId: string): void;
}

interface StoredFileWatch {
  agentId: string;
  /** Relative to the workspace root; the root itself is ".". */
  path: string;
  debounceSeconds: number;
}

interface OpenFileWatch extends StoredFileWatch {
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Owns the file-change triggers of routines: their rows in `file_watch_triggers` and the watchers that
 * follow them. A routine has at most one trigger. Its watcher runs only while the routine is active,
 * and it closes at once when the routine is paused or deleted, so `reconcile` is called on every change.
 *
 * A change starts one run after the quiet time has passed, so a burst of writes starts one run. A path
 * is stored relative to the workspace, so renaming the agent does not orphan it, and it is checked again
 * each time a watcher opens. It never imports the agent service facade.
 */
export class FileWatchTriggers {
  readonly #database: OpenBotDatabase;
  readonly #options: FileWatchTriggersOptions;
  readonly #open = new Map<string, OpenFileWatch>();

  constructor(options: FileWatchTriggersOptions) {
    this.#database = options.database;
    this.#options = options;
  }

  /**
   * The path to store for a person's input: it must exist and resolve inside the agent's workspace after
   * symlinks are followed, so a link cannot reach outside it. Refuses anything else before a row is written.
   */
  storedPath(agentId: string, inputPath: string): string {
    const root = this.#rootOf(agentId);
    const candidate = workspacePathFromInput(root, agentId, inputPath);
    let rootReal: string;
    let target: string;
    try {
      rootReal = realpathSync(root);
      target = realpathSync(candidate);
    } catch {
      throw new FileWatchRefused(sourceText("error.backend.workspacePathMissing", { path: inputPath, root }));
    }
    if (target !== rootReal && !isWithin(rootReal, target)) {
      throw new FileWatchRefused(sourceText("error.backend.workspaceFileOutside"));
    }
    return target === rootReal ? "." : relative(rootReal, target);
  }

  /** Stores the trigger of a routine in place of its previous one, or removes it, then follows the routine. */
  set(agentId: string, routineId: string, watch: RoutineFileWatchInput | null): void {
    const connection = this.#database.connection;
    if (watch === null) {
      connection.prepare("DELETE FROM file_watch_triggers WHERE routine_id = ?").run(routineId);
    } else {
      this.check(agentId, watch);
      // One statement, so a failed write keeps the previous trigger of the routine.
      connection
        .prepare(
          `INSERT INTO file_watch_triggers (trigger_id, routine_id, agent_id, path, debounce_seconds, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(routine_id) DO UPDATE SET path = excluded.path, debounce_seconds = excluded.debounce_seconds`,
        )
        .run(
          randomUUID(),
          routineId,
          agentId,
          this.storedPath(agentId, watch.path),
          watch.debounceSeconds,
          new Date().toISOString(),
        );
    }
    this.reconcile(agentId, routineId);
  }

  /** Refuses a declaration that is not a valid file trigger, before any row is written. */
  check(agentId: string, watch: RoutineFileWatchInput): void {
    if (
      !Number.isInteger(watch.debounceSeconds) ||
      watch.debounceSeconds < FILE_WATCH_DEBOUNCE_MIN_SECONDS ||
      watch.debounceSeconds > FILE_WATCH_DEBOUNCE_MAX_SECONDS
    ) {
      throw new FileWatchRefused(
        `debounceSeconds must be a whole number from ${FILE_WATCH_DEBOUNCE_MIN_SECONDS} to ${FILE_WATCH_DEBOUNCE_MAX_SECONDS}.`,
      );
    }
    this.storedPath(agentId, watch.path);
  }

  /** Brings the watcher of one routine in line with its row and its state: open, replaced, or closed. */
  reconcile(agentId: string, routineId: string): void {
    const stored = this.#storedFor(routineId);
    if (!stored || stored.agentId !== agentId || !this.#options.runnable(agentId, routineId)) {
      this.#close(routineId);
      return;
    }
    const open = this.#open.get(routineId);
    if (open && open.path === stored.path && open.debounceSeconds === stored.debounceSeconds) return;
    this.#close(routineId);
    this.#startWatch(routineId, stored);
  }

  /** Rebuilds the watchers from the rows, on start. A row whose routine is paused opens nothing. */
  restore(): void {
    const rows = this.#database.connection.prepare("SELECT routine_id, agent_id FROM file_watch_triggers").all();
    for (const row of rows) {
      if (!isDynamicRecord(row) || !isString(row.routine_id) || !isString(row.agent_id)) continue;
      this.reconcile(row.agent_id, row.routine_id);
    }
  }

  /** Closes the watchers of one agent, when the agent is deleted. */
  closeForAgent(agentId: string): void {
    for (const [routineId, open] of [...this.#open]) {
      if (open.agentId === agentId) this.#close(routineId);
    }
  }

  /** Whether a watcher is open for this routine. */
  isWatching(routineId: string): boolean {
    return this.#open.has(routineId);
  }

  /** Closes every watcher, when the service stops. The rows stay, so the next start rebuilds them. */
  close(): void {
    for (const routineId of [...this.#open.keys()]) this.#close(routineId);
  }

  #rootOf(agentId: string): string {
    const root = this.#options.workspaceRoot(agentId);
    if (root === null) throw new FileWatchRefused(sourceText("error.agent.unknown", { id: agentId }));
    return root;
  }

  #storedFor(routineId: string): StoredFileWatch | null {
    const row = this.#database.connection
      .prepare("SELECT agent_id, path, debounce_seconds FROM file_watch_triggers WHERE routine_id = ?")
      .get(routineId);
    if (!isDynamicRecord(row)) return null;
    if (!isString(row.agent_id) || !isString(row.path) || !isNumber(row.debounce_seconds)) return null;
    return { agentId: row.agent_id, path: row.path, debounceSeconds: row.debounce_seconds };
  }

  #startWatch(routineId: string, stored: StoredFileWatch): void {
    let target: string;
    try {
      const root = this.#rootOf(stored.agentId);
      const rootReal = realpathSync(root);
      target = realpathSync(join(root, stored.path));
      if (target !== rootReal && !isWithin(rootReal, target)) {
        throw new FileWatchRefused(sourceText("error.backend.workspaceFileOutside"));
      }
    } catch (error) {
      logger.warn("File trigger not watched: its path is missing or leaves the workspace.", toLogValue(error));
      return;
    }
    let watcher: FSWatcher;
    try {
      watcher = watch(target, { persistent: false }, () => this.#changed(routineId));
    } catch (error) {
      logger.warn("File trigger not watched: the watcher could not start.", toLogValue(error));
      return;
    }
    watcher.on("error", (error) => {
      logger.warn("Stopped watching a file trigger.", toLogValue(error));
      this.#close(routineId);
    });
    this.#open.set(routineId, { ...stored, watcher, timer: undefined });
  }

  #changed(routineId: string): void {
    const open = this.#open.get(routineId);
    if (!open) return;
    clearTimeout(open.timer);
    open.timer = setTimeout(() => this.#due(routineId, open), open.debounceSeconds * 1000);
  }

  #due(routineId: string, open: OpenFileWatch): void {
    open.timer = undefined;
    if (this.#open.get(routineId) !== open) return;
    // A pause during the quiet time stops the run here as well as closing the watcher.
    if (!this.#options.runnable(open.agentId, routineId)) {
      this.#close(routineId);
      return;
    }
    try {
      this.#options.fire(open.agentId, routineId);
    } catch (error) {
      logger.error("File trigger run failed to start.", toLogValue(error));
    }
  }

  #close(routineId: string): void {
    const open = this.#open.get(routineId);
    if (!open) return;
    this.#open.delete(routineId);
    clearTimeout(open.timer);
    open.watcher.close();
  }
}
