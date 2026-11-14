import { ampParser } from './amp.js';
import { claudeCodeParser } from './claude-code.js';
import { clineParser, kiloCodeParser, rooParser } from './cline.js';
import { codexParser } from './codex.js';
import { copilotParser } from './copilot.js';
import { droidParser } from './droid.js';
import { geminiParser } from './gemini.js';
import { qwenParser } from './qwen.js';
import { kiloCliParser, openCodeParser } from './opencode.js';
import type { Parser } from './types.js';

/** Registry of supported agents, roughly by popularity. Add new parsers here. */
export const parsers: Parser[] = [
  claudeCodeParser,
  codexParser,
  geminiParser,
  openCodeParser,
  kiloCliParser,
  qwenParser,
  clineParser,
  rooParser,
  kiloCodeParser,
  copilotParser,
  droidParser,
  ampParser,
];

export {
  ampParser,
  claudeCodeParser,
  clineParser,
  codexParser,
  copilotParser,
  droidParser,
  geminiParser,
  kiloCliParser,
  kiloCodeParser,
  openCodeParser,
  qwenParser,
  rooParser,
};
export type { Parser, LoadOptions } from './types.js';
