import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_GITIGNORE } from '@ariadne/core';
import { blockFolders, commonAppId, findMaestroWorkspace, InitError, initProject, initReport } from '../src/init.ts';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ariadne-cli-init-'));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

function flow(appId: string): string {
  return `appId: ${appId}\n---\n- launchApp\n`;
}

describe('findMaestroWorkspace', () => {
  it('prefers .maestro/, then a Maestro config.yaml in the folder, then in a direct subfolder', () => {
    expect(findMaestroWorkspace(repo)).toBeUndefined();
    write('e2e/config.yaml', 'flows:\n  - "flows/*"\n');
    expect(findMaestroWorkspace(repo)).toBe(join(repo, 'e2e'));
    write('config.yml', 'includeTags:\n  - smoke\n');
    expect(findMaestroWorkspace(repo)).toBe(repo);
    mkdirSync(join(repo, '.maestro'));
    expect(findMaestroWorkspace(repo)).toBe(join(repo, '.maestro'));
  });

  it('does not take any config.yaml for a Maestro one', () => {
    write('server/config.yaml', 'port: 8080\ndatabase: x\n');
    expect(findMaestroWorkspace(repo)).toBeUndefined();
  });
});

describe('commonAppId and blockFolders', () => {
  it('picks the appId most flows use, from flow headers only, skipping the config', () => {
    write('.maestro/config.yaml', 'appId: com.not.this\n');
    write('.maestro/login.yaml', flow('com.example.app'));
    write('.maestro/subflows/a.yaml', flow('"com.example.app"'));
    write('.maestro/other/b.yml', flow('com.example.other'));
    write('.maestro/c.yaml', `appId: com.example.other\n---\n- inputText:\n    appId: com.in.body\n`);
    write('.maestro/d.yaml', `appId: \${APP_ID}\n---\n- launchApp\n`);
    write('.maestro/e.yaml', 'appId: com.example.app # main app\n---\n- back\n');
    expect(commonAppId(join(repo, '.maestro'))).toEqual({ appId: 'com.example.app', flowCount: 6 });
  });

  it('finds the usual subflow folders by name, case-insensitively, in a fixed order', () => {
    for (const name of ['Utils', 'subflows', 'flows', 'Helpers']) mkdirSync(join(repo, name));
    writeFileSync(join(repo, 'shared'), 'a file, not a folder');
    expect(blockFolders(repo)).toEqual(['subflows', 'Helpers', 'Utils']);
  });
});

describe('initProject', () => {
  it('sets up .ariadne for a .maestro workspace and creates the recorded folder', () => {
    write('.maestro/login.yaml', flow('com.example.app'));
    write('.maestro/subflows/open.yaml', flow('com.example.app'));
    write('.maestro/Common/x.yaml', flow('com.example.other'));
    const result = initProject(repo);
    const project = join(repo, '.ariadne');
    expect(result.projectDir).toBe(project);
    expect(JSON.parse(readFileSync(join(project, 'project.json'), 'utf8'))).toEqual({
      appId: 'com.example.app',
      platform: 'android',
      paths: { blocks: ['../.maestro/subflows', '../.maestro/Common'], flows: '../.maestro/recorded' },
    });
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe(PROJECT_GITIGNORE);
    expect(existsSync(join(project, 'cases'))).toBe(true);
    expect(existsSync(join(repo, '.maestro', 'recorded'))).toBe(true);
    expect(result.created).toEqual([
      project + sep,
      join(project, 'project.json'),
      join(project, 'cases') + sep,
      join(project, '.gitignore'),
      join(repo, '.maestro', 'recorded') + sep,
    ]);
    const report = initReport(result, repo, repo);
    expect(report[0]).toBe('Found a Maestro workspace in .maestro (3 flow files, most of them for com.example.app).');
    expect(report).toContain('  created .maestro/recorded/');
    expect(report.at(-1)).toBe('Next: ariadne-studio');
    expect(initReport(result, repo, dirname(repo)).at(-1)).toBe(`Next: ariadne-studio ${basename(repo)}`);
  });

  it('leaves blocks unset when no usual subflow folder exists, and keeps an existing .gitignore', () => {
    write('.maestro/login.yaml', flow('com.example.app'));
    write('.ariadne/.gitignore', 'mine\n');
    const result = initProject(repo);
    expect(result.settings.paths).toEqual({ flows: '../.maestro/recorded' });
    expect(readFileSync(join(repo, '.ariadne', '.gitignore'), 'utf8')).toBe('mine\n');
    expect(result.created.some((path) => path.endsWith('.gitignore'))).toBe(false);
  });

  it('makes a plain project when there is no Maestro workspace', () => {
    const result = initProject(repo);
    expect(result.settings).toEqual({ appId: '', platform: 'android' });
    expect(result.workspace).toBeUndefined();
    expect(initReport(result, repo, repo)[0]).toMatch(/^No Maestro workspace found/);
  });

  it('refuses to replace an existing project and changes nothing', () => {
    write('.ariadne/project.json', '{"appId":"kept"}');
    write('.maestro/login.yaml', flow('com.example.app'));
    expect(() => initProject(repo)).toThrow(InitError);
    expect(readFileSync(join(repo, '.ariadne', 'project.json'), 'utf8')).toBe('{"appId":"kept"}');
    expect(existsSync(join(repo, '.maestro', 'recorded'))).toBe(false);
  });
});
