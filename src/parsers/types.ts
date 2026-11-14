import type { Capabilities, Session, SourceId } from '../types.js';

/**
 * A pluggable log parser. Adding support for a new agent (Cursor, Aider,
 * Gemini CLI, ...) means implementing this interface and registering it in
 * `parsers/index.ts`.
 */
export interface Parser {
  id: SourceId;
  /** Display name, e.g. "Claude Code". */
  name: string;
  /** True only when the parser has been validated against real logs (not just docs/source). */
  verified: boolean;
  /** What the log format provides; individual sessions may narrow this. */
  caps: Capabilities;
  /** Candidate default locations on this OS, in priority order (may not exist). */
  defaultDirs(): string[];
  /** Load every top-level session under `dir`. Subagents are attached to their parents. */
  load(dir: string, opts?: LoadOptions): Promise<Session[]>;
}

export interface LoadOptions {
  /** Ignore files whose mtime is older than this epoch ms (fast pre-filter). */
  since?: number;
  /** Parsers push human-readable warnings here (e.g. "needs Node 22.13+ for SQLite"). */
  notes?: string[];
}
