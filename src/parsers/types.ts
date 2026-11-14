import type { Session, SourceId } from '../types.js';

/**
 * A pluggable log parser. Adding support for a new agent (Cursor, Aider,
 * Gemini CLI, ...) means implementing this interface and registering it in
 * `parsers/index.ts`.
 */
export interface Parser {
  id: SourceId;
  /** Display name, e.g. "Claude Code". */
  name: string;
  /** Default log directory on this machine (may not exist). */
  defaultDir(): string;
  /** Load every top-level session under `dir`. Subagents are attached to their parents. */
  load(dir: string, opts?: LoadOptions): Promise<Session[]>;
}

export interface LoadOptions {
  /** Ignore files whose mtime is older than this epoch ms (fast pre-filter). */
  since?: number;
  /** Replace prompts / paths with placeholders. */
  redact?: boolean;
}
