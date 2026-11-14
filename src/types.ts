/**
 * Normalized, source-agnostic model of an agent session.
 * Every parser (Claude Code, Codex, ...) produces these shapes; every analyzer
 * and renderer consumes only these shapes.
 */

export type SourceId =
  | 'claude-code'
  | 'codex'
  | 'gemini-cli'
  | 'qwen-code'
  | 'opencode'
  | 'kilo-cli'
  | 'cline'
  | 'roo-code'
  | 'kilo-code'
  | 'copilot-cli'
  | 'droid'
  | 'amp';

/**
 * What a log format can tell us. Waste detectors only run when the data they
 * need is present - missing data must never be reported as "no waste".
 */
export interface Capabilities {
  /** Token usage per model request (false = only session totals, or none). */
  perRequestTokens: boolean;
  /** Cache-read tokens are reported. */
  cacheReads: boolean;
  /** Cache-write tokens are reported (Anthropic-style prompt caching). */
  cacheWrites: boolean;
  /** Tool calls with names and inputs. */
  toolCalls: boolean;
  /** Tool output text (so we can measure its size / identity). */
  toolOutputs: boolean;
  /** File paths for read / edit tools. */
  filePaths: boolean;
  /** Per-request timestamps (needed to reason about idle gaps). */
  timestamps: boolean;
}

export const FULL_CAPS: Capabilities = {
  perRequestTokens: true,
  cacheReads: true,
  cacheWrites: true,
  toolCalls: true,
  toolOutputs: true,
  filePaths: true,
  timestamps: true,
};

export interface Usage {
  /** Uncached input tokens. */
  input: number;
  /** Output tokens (includes reasoning/thinking tokens where the provider bills them as output). */
  output: number;
  /** Tokens served from the prompt cache. */
  cacheRead: number;
  /** Tokens written to the 5-minute cache. */
  cacheWrite5m: number;
  /** Tokens written to the 1-hour cache. */
  cacheWrite1h: number;
  /** Reasoning tokens (subset of output), informational only. */
  reasoning: number;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Short human label for the call target (file path, command, url, ...). */
  target?: string;
  /** Full path of the file this call reads (`read`) or modifies (`edit`), when applicable. */
  file?: string;
  fileOp?: 'read' | 'edit';
  /** Stable key used to detect identical repeated calls. */
  key: string;
  /** Characters returned by the tool (0 when unknown). */
  resultChars: number;
  /** Epoch ms when the tool result came back (when the log records it). */
  resultAt?: number;
  /** Short hash of the tool result, to tell "same call, same answer" from legit re-runs. */
  resultHash?: string;
  isError: boolean;
  /** Subagent session spawned by this call (Claude Code `Agent`/`Task` tool). */
  subagent?: Session;
}

export interface ApiCall {
  id: string;
  /** Epoch ms. */
  timestamp: number;
  model: string;
  usage: Usage;
  toolCalls: ToolCall[];
  /** Filled in by the cost analyzer. */
  cost: number;
  /** Served in fast mode (premium pricing). */
  fast?: boolean;
  /** True when the model is missing from the pricing table and no reported cost exists. */
  unpriced?: boolean;
  /** Cost the agent itself recorded (USD), used when the model is not in our pricing table. */
  reportedCost?: number;
  /** Where `cost` came from. */
  costSource?: 'pricing' | 'reported' | 'none';
}

export interface Turn {
  index: number;
  timestamp: number;
  /** First line of the user prompt (truncated); may be redacted. */
  prompt: string;
  calls: ApiCall[];
}

export interface Session {
  id: string;
  source: SourceId;
  /** What this session's log format provides (set by the parser). */
  caps: Capabilities;
  /** Human project name (usually the last path segment of the cwd). */
  project: string;
  /** Full working directory, when known. */
  projectPath?: string;
  title?: string;
  file: string;
  start: number;
  end: number;
  turns: Turn[];
  /** For subagent sessions: description of the delegated task. */
  agentDescription?: string;
  agentType?: string;
  isSubagent?: boolean;
}

export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite5m += b.cacheWrite5m;
  a.cacheWrite1h += b.cacheWrite1h;
  a.reasoning += b.reasoning;
  return a;
}

export const totalTokens = (u: Usage): number =>
  u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;

/** Rough chars-per-token ratio used to estimate tool output size. */
export const CHARS_PER_TOKEN = 4;
export const estTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);
