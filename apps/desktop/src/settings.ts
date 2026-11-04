import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type DesktopSettings = {
  /** The project folder opened last; reopened on the next start. */
  projectDir?: string;
};

export function readSettings(file: string): DesktopSettings {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as DesktopSettings;
    return typeof parsed.projectDir === 'string' ? { projectDir: parsed.projectDir } : {};
  } catch {
    return {};
  }
}

export function writeSettings(file: string, settings: DesktopSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The last project if its folder is still there, else Documents/Ariadne (created by the server). */
export function initialProjectDir(settings: DesktopSettings, documentsDir: string): string {
  if (settings.projectDir && isDirectory(settings.projectDir)) return settings.projectDir;
  return join(documentsDir, 'Ariadne');
}

/**
 * The project to open for a folder the user picked: its .ariadne project
 * when it is an app repository set up with `ariadne-studio init` (and not a
 * project itself), else the folder. Same rule as the CLI.
 */
export function projectDirIn(dir: string): string {
  const inner = join(dir, '.ariadne');
  return !existsSync(join(dir, 'project.json')) && existsSync(join(inner, 'project.json')) ? inner : dir;
}
