import { claudeCodeParser } from './claude-code.js';
import { codexParser } from './codex.js';
import type { Parser } from './types.js';

/** Registry of supported agents. Add new parsers here. */
export const parsers: Parser[] = [claudeCodeParser, codexParser];

export { claudeCodeParser, codexParser };
export type { Parser, LoadOptions } from './types.js';
