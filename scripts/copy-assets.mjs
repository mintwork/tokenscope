// Copies non-TS assets into dist/ (tsc only emits .ts output).
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/pricing', { recursive: true });
cpSync('src/pricing/pricing.json', 'dist/pricing/pricing.json');
cpSync('src/render/assets', 'dist/render/assets', { recursive: true });
