// When a Windows user name has letters Java cannot spell, the tools go in
// %ProgramData%. Every account on the computer can reach that folder and, by
// default, add files to what is inside it, and a program planted there would run
// as this user. So it is only used once nobody else can change it.
//
// This goes by SID throughout: account names are translated on a Greek Windows.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { win32 } from 'node:path';

const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const TRUSTED_INSTALLER = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';

/** Who may change a folder besides this user: Windows itself and its administrators, in SDDL's short names. */
const TRUSTED = new Set(['SY', 'BA', 'CO', 'OW', TRUSTED_INSTALLER]);

/** SDDL's names for rights that change nothing. */
const READ_ONLY_CODES = new Set(['FR', 'FX', 'GR', 'GX', 'RC']);
/** The same as bits: read data, attributes and security, run, wait on it. */
const READ_ONLY_BITS = 0xa01200a9;

function onlyReads(rights: string): boolean {
  if (/^0x[0-9a-f]+$/i.test(rights)) return (Number(rights) & ~READ_ONLY_BITS) === 0;
  const codes = rights.match(/../g) ?? [];
  return codes.length > 0 && codes.every((code) => READ_ONLY_CODES.has(code.toUpperCase()));
}

/**
 * Whether a folder's security, in Windows's own SDDL notation, leaves it to `me`
 * and the system alone: they own it, and no entry lets anyone else change it. An
 * owner can always rewrite the rest, so both have to hold. What cannot be read
 * counts as no.
 */
export function onlyTrustedCanChange(sddl: string, me: string): boolean {
  const trusted = (who: string) => who === me || TRUSTED.has(who);
  const owner = /^O:(.+?)(?:G:|D:|S:|$)/.exec(sddl)?.[1];
  const dacl = /D:([A-Z_]*)((?:\([^()]*\))*)(?:S:.*)?$/.exec(sddl);
  if (!owner || !trusted(owner) || !dacl || dacl[1]!.includes('NO_ACCESS_CONTROL')) return false;
  const entries = dacl[2]!.slice(1, -1).split(')(').filter(Boolean);
  return entries.every((entry) => {
    const [type = '', , rights = '', , , who = ''] = entry.split(';');
    return type === 'D' || trusted(who) || onlyReads(rights);
  });
}

/** A Windows tool by its full path, so a file of the same name in this folder cannot stand in for it. */
function runSystemTool(tool: string, args: string[]): string {
  const file = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', tool);
  return execFileSync(file, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}

function mySid(): string {
  const sid = runSystemTool('whoami.exe', ['/user', '/fo', 'csv', '/nh']).match(/S-1-\d+(?:-\d+)+/g)?.at(-1);
  if (!sid) throw new Error('whoami did not say who this is');
  return sid;
}

function folderSddl(dir: string): string {
  const command = `(Get-Acl -LiteralPath '${dir.replaceAll("'", "''")}').Sddl`;
  return runSystemTool(win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command]).trim();
}

/** Whether nobody but this user and the system can change `dir`. A folder that is not there has nothing to distrust. */
export function folderIsPrivate(dir: string): boolean {
  if (!existsSync(dir)) return true;
  try {
    return onlyTrustedCanChange(folderSddl(dir), mySid());
  } catch {
    return false;
  }
}

const privateFolders = new Set<string>();

/** folderIsPrivate, asked once a folder has passed: nobody else can change the answer after that, and asking takes a moment. */
export function sharedFolderSafe(dir: string): boolean {
  if (privateFolders.has(dir)) return true;
  const safe = folderIsPrivate(dir);
  if (safe && existsSync(dir)) privateFolders.add(dir);
  return safe;
}

/** Makes `dir` this user's and the system's alone, or throws. What was in it arrived while others could write there, so none of it stays. */
export async function claimFolder(dir: string): Promise<void> {
  if (existsSync(dir) && folderIsPrivate(dir)) return;
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  await mkdir(dir, { recursive: true });
  runSystemTool('icacls.exe', [dir, '/inheritance:r', '/grant:r', `*${mySid()}:(OI)(CI)F`, `*${SYSTEM}:(OI)(CI)F`, `*${ADMINISTRATORS}:(OI)(CI)F`]);
  if (!folderIsPrivate(dir) || (await readdir(dir)).length > 0) throw new Error(`${dir} is still open to other accounts`);
}
