import os from 'node:os';
import path from 'node:path';

/** Cross-platform base directories used by agent log discovery. */

export const home = (): string => os.homedir();

/** $XDG_DATA_HOME or ~/.local/share (also used by many CLIs on macOS). */
export function xdgData(): string {
  return process.env.XDG_DATA_HOME || path.join(home(), '.local', 'share');
}

export function xdgConfig(): string {
  return process.env.XDG_CONFIG_HOME || path.join(home(), '.config');
}

/** Roaming app data: %APPDATA% on Windows, ~/Library/Application Support on macOS, ~/.config on Linux. */
export function appData(): string {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(home(), 'Library', 'Application Support');
  return xdgConfig();
}

/** %LOCALAPPDATA% on Windows (falls back to appData elsewhere). */
export function localAppData(): string {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local');
  return appData();
}

/** VS Code-family editors whose globalStorage may hold extension data. */
export const VSCODE_FLAVORS = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium', 'Positron', 'Antigravity', 'Trae', 'Kiro'];

/** `<appData>/<editor>/User/globalStorage/<extensionId>` for every VS Code flavor. */
export function vscodeGlobalStorage(extensionId: string): string[] {
  return VSCODE_FLAVORS.map((f) => path.join(appData(), f, 'User', 'globalStorage', extensionId));
}

export const uniq = <T>(a: T[]): T[] => [...new Set(a)];
