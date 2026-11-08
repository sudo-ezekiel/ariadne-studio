// Whether a folder in %ProgramData% belongs to this user alone. The SDDL parser is
// pure and runs everywhere; the rest uses real folders and the real icacls.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimFolder, folderIsPrivate, onlyTrustedCanChange, sharedFolderSafe } from '../src/replay/shared-folder.ts';

const ME = 'S-1-5-21-1-2-3-1001';
const CLEAN = `(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${ME})`;

function sddl(owner: string | undefined, rest: string): string {
  return `${owner === undefined ? '' : `O:${owner}`}${rest}`;
}

describe('onlyTrustedCanChange', () => {
  it.each([
    ['this user', ME],
    ['the Administrators group', 'BA'],
    ['the system', 'SY'],
  ])('passes a clean folder owned by %s', (_name, owner) => {
    expect(onlyTrustedCanChange(sddl(owner, `D:PAI${CLEAN}`), ME)).toBe(true);
  });

  it('passes the shape Windows CI gave after a claim, where the built-in Administrator is LA and this user is another SID', () => {
    const real = 'O:BAG:S-1-5-21-111-222-333-513D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)';
    expect(onlyTrustedCanChange(real, 'S-1-5-21-111-222-333-500')).toBe(true);
  });

  it('passes a folder owned by the built-in Administrator, written LA', () => {
    expect(onlyTrustedCanChange(sddl('LA', `D:PAI${CLEAN}`), ME)).toBe(true);
  });

  it('fails when the guest account, LG, owns it', () => {
    expect(onlyTrustedCanChange(sddl('LG', `D:PAI${CLEAN}`), ME)).toBe(false);
  });

  it('fails when the guest account, LG, has full control', () => {
    expect(onlyTrustedCanChange(sddl(ME, `D:PAI${CLEAN}(A;OICI;FA;;;LG)`), ME)).toBe(false);
  });

  it('passes with or without a group section', () => {
    expect(onlyTrustedCanChange(sddl(ME, `G:SYD:PAI${CLEAN}`), ME)).toBe(true);
    expect(onlyTrustedCanChange(sddl(ME, `D:PAI${CLEAN}`), ME)).toBe(true);
  });

  it.each(['(A;OICI;0x1200a9;;;BU)', '(A;OICI;FR;;;BU)', '(A;OICI;GRGX;;;BU)'])('passes a read-only entry for Users, %s', (entry) => {
    expect(onlyTrustedCanChange(sddl(ME, `D:PAI${CLEAN}${entry}`), ME)).toBe(true);
  });

  it('passes a deny entry for someone else, which can only take rights away', () => {
    expect(onlyTrustedCanChange(sddl(ME, `D:PAI${CLEAN}(D;;FA;;;WD)`), ME)).toBe(true);
  });

  it('passes an inherit-only entry for the creator owner', () => {
    expect(onlyTrustedCanChange(sddl(ME, `D:PAI${CLEAN}(A;OICIIO;GA;;;CO)`), ME)).toBe(true);
  });

  it('passes a folder with a trailing audit section', () => {
    expect(onlyTrustedCanChange(sddl(ME, `D:PAI${CLEAN}S:AI(AU;FA;FA;;;WD)`), ME)).toBe(true);
  });

  it('fails when another account owns it, even with a clean DACL', () => {
    expect(onlyTrustedCanChange(sddl('S-1-5-21-1-2-3-1002', `D:PAI${CLEAN}`), ME)).toBe(false);
    expect(onlyTrustedCanChange(sddl('BU', `D:PAI${CLEAN}`), ME)).toBe(false);
  });

  it.each([
    ['the default ProgramData grant', '(A;CI;0x100116;;;BU)'],
    ['full control for Users', '(A;OICI;FA;;;BU)'],
    ['write for Everyone', '(A;;FW;;;WD)'],
    ['generic all for Authenticated Users', '(A;;GA;;;AU)'],
    ['hex with one write bit', '(A;OICI;0x1200ab;;;BU)'],
    ['DELETE', '(A;OICI;0x10000;;;BU)'],
    ['WRITE_DAC', '(A;OICI;0x40000;;;BU)'],
  ])('fails when an entry lets someone else change it: %s', (_name, entry) => {
    expect(onlyTrustedCanChange(sddl(ME, `D:PAI${CLEAN}${entry}`), ME)).toBe(false);
  });

  it('fails a folder with no access control at all', () => {
    expect(onlyTrustedCanChange(sddl(ME, 'D:NO_ACCESS_CONTROL'), ME)).toBe(false);
  });

  it('fails when there is no DACL section', () => {
    expect(onlyTrustedCanChange(sddl(ME, 'G:SY'), ME)).toBe(false);
  });

  it('fails when there is no owner', () => {
    expect(onlyTrustedCanChange(sddl(undefined, `D:PAI${CLEAN}`), ME)).toBe(false);
  });

  it('fails an empty string', () => {
    expect(onlyTrustedCanChange('', ME)).toBe(false);
  });

  it('fails a conditional entry it cannot read, rather than guess', () => {
    expect(onlyTrustedCanChange(sddl(ME, `D:PAI${CLEAN}(XA;;FA;;;BU;(@USER.x == 1))`), ME)).toBe(false);
  });

  it('fails a right it does not know', () => {
    expect(onlyTrustedCanChange(sddl(ME, `D:PAI${CLEAN}(A;;ZZ;;;BU)`), ME)).toBe(false);
  });
});

// The first test starts PowerShell for the first time on the machine: 2.8 to 10.9 s on GitHub's Windows runners.
describe.runIf(process.platform === 'win32')('folders in %ProgramData%', { timeout: 30_000 }, () => {
  const made: string[] = [];

  function icacls(...args: string[]): string {
    const file = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
    return execFileSync(file, args, { encoding: 'utf8', windowsHide: true });
  }

  /** A name nobody else is using, directly under %ProgramData%, so it inherits what a fresh folder there gets. */
  function freshPath(): string {
    const dir = join(process.env.ProgramData!, `Ariadne-test-${randomUUID()}`);
    made.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('are open to Users when freshly made, which is why they are not trusted', async () => {
    const dir = freshPath();
    await mkdir(dir);
    expect(folderIsPrivate(dir)).toBe(false);
  });

  it('become private once claimed', async () => {
    const dir = freshPath();
    await mkdir(dir);
    await claimFolder(dir);
    expect(folderIsPrivate(dir)).toBe(true);
  });

  it('lose what was planted in them when claimed', async () => {
    const dir = freshPath();
    await mkdir(dir);
    const planted = join(dir, 'planted.exe');
    await writeFile(planted, 'x');
    await claimFolder(dir);
    expect(existsSync(planted)).toBe(false);
  });

  it('are made, private, when claimed before they exist', async () => {
    const dir = freshPath();
    await claimFolder(dir);
    expect(existsSync(dir)).toBe(true);
    expect(folderIsPrivate(dir)).toBe(true);
  });

  it('stop being private when Users are granted modify', async () => {
    const dir = freshPath();
    await claimFolder(dir);
    icacls(dir, '/grant', '*S-1-5-32-545:(OI)(CI)M');
    expect(folderIsPrivate(dir)).toBe(false);
  });

  it('count as private when they are not there, but that answer is not remembered', async () => {
    const dir = freshPath();
    expect(sharedFolderSafe(dir)).toBe(true);
    await mkdir(dir);
    expect(sharedFolderSafe(dir)).toBe(false);
  });
});
