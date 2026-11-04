import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appOpAllowed, allowDriverToOpenApps, readXiaomiPhone, stopDriver, type PhoneShell } from '../src/device/xiaomi.ts';
import { REVIEW_TEXT, describeStep } from '../src/recorder/describe.ts';
import { Recorder, caseToFlow } from '../src/recorder/recorder.ts';
import { runMaestro } from '../src/replay/maestro-run.ts';

/** A phone's shell: answers by the command line, and remembers every call. */
function phone(answers: Record<string, string>): { shell: PhoneShell; calls: string[] } {
  const calls: string[] = [];
  const shell: PhoneShell = async (args) => {
    const line = args.join(' ');
    calls.push(line);
    return answers[line] ?? '';
  };
  return { shell, calls };
}

describe('appOpAllowed', () => {
  it('reads an allowed operation', () => {
    expect(appOpAllowed('MIUIOP(10021): allow; time=+1d')).toBe(true);
    expect(appOpAllowed('MIUIOP(10021): allow')).toBe(true);
  });

  it('reads an ignored operation as not allowed', () => {
    expect(appOpAllowed('MIUIOP(10021): ignore')).toBe(false);
  });

  it('reads no operations as not allowed', () => {
    expect(appOpAllowed('No operations.')).toBe(false);
    expect(appOpAllowed('')).toBe(false);
  });

  it('does not take a word that merely starts with allow', () => {
    expect(appOpAllowed('MIUIOP(10021): allowed_never')).toBe(false);
  });
});

describe('readXiaomiPhone', () => {
  it('gives undefined for a phone that is not Xiaomi\'s, and asks nothing more', async () => {
    const { shell, calls } = phone({});
    expect(await readXiaomiPhone(shell)).toBeUndefined();
    expect(calls).toEqual(['getprop ro.miui.ui.version.name', 'getprop ro.mi.os.version.name']);
  });

  it('reads a MIUI phone with no driver', async () => {
    const { shell } = phone({ 'getprop ro.miui.ui.version.name': 'V14\n' });
    expect(await readXiaomiPhone(shell)).toEqual({ driverInstalled: false, driverOpensApps: false });
  });

  it('reads a HyperOS phone whose driver may not open apps', async () => {
    const { shell } = phone({
      'getprop ro.mi.os.version.name': 'OS3\n',
      'pm list packages dev.mobile.maestro': 'package:dev.mobile.maestro\npackage:dev.mobile.maestro.test\n',
      'appops get dev.mobile.maestro 10021': 'MIUIOP(10021): ignore\n',
    });
    expect(await readXiaomiPhone(shell)).toEqual({ driverInstalled: true, driverOpensApps: false });
  });

  it('reads a Xiaomi phone whose driver may open apps', async () => {
    const { shell } = phone({
      'getprop ro.miui.ui.version.name': 'V14',
      'pm list packages dev.mobile.maestro': 'package:dev.mobile.maestro\npackage:dev.mobile.maestro.test\n',
      'appops get dev.mobile.maestro 10021': 'MIUIOP(10021): allow; time=+1d\n',
    });
    expect(await readXiaomiPhone(shell)).toEqual({ driverInstalled: true, driverOpensApps: true });
  });

  it('does not count the driver as installed when only one of its two packages is', async () => {
    const { shell, calls } = phone({
      'getprop ro.miui.ui.version.name': 'V14',
      'pm list packages dev.mobile.maestro': 'package:dev.mobile.maestro\n',
      'appops get dev.mobile.maestro 10021': 'MIUIOP(10021): allow\n',
    });
    expect(await readXiaomiPhone(shell)).toEqual({ driverInstalled: false, driverOpensApps: false });
    expect(calls.some((line) => line.startsWith('appops'))).toBe(false);
  });

  it('does not count the test package alone as the driver', async () => {
    const { shell } = phone({ 'getprop ro.miui.ui.version.name': 'V14', 'pm list packages dev.mobile.maestro': 'package:dev.mobile.maestro.test\n' });
    expect((await readXiaomiPhone(shell))?.driverInstalled).toBe(false);
  });

  it('does not count a different package as the driver', async () => {
    const { shell } = phone({ 'getprop ro.miui.ui.version.name': 'V14', 'pm list packages dev.mobile.maestro': 'package:dev.mobile.other\n' });
    expect(await readXiaomiPhone(shell)).toEqual({ driverInstalled: false, driverOpensApps: false });
  });
});

describe('allowDriverToOpenApps', () => {
  it('allows the operation for the two driver packages and touches nothing else', async () => {
    const { shell, calls } = phone({});
    await allowDriverToOpenApps(shell);
    expect(calls).toEqual(['appops set dev.mobile.maestro 10021 allow', 'appops set dev.mobile.maestro.test 10021 allow']);
  });
});

describe('stopDriver', () => {
  it('force-stops the two driver packages and nothing else', async () => {
    const { shell, calls } = phone({});
    await stopDriver(shell);
    expect(calls).toEqual(['am force-stop dev.mobile.maestro', 'am force-stop dev.mobile.maestro.test']);
  });
});

describe('erase steps', () => {
  const now = () => new Date('2026-11-04T10:00:00.000Z');
  function started(): Recorder {
    const recorder = new Recorder({ now });
    recorder.start({ id: 'c-1', name: 'C', appId: 'com.example', deviceId: 'emulator-5554' });
    return recorder;
  }

  it('records the characters erased', () => {
    expect(started().recordErase(3, 'evidence/c-1/step-001.png')).toEqual({
      index: 1,
      kind: 'erase',
      chars: 3,
      screenshot: 'evidence/c-1/step-001.png',
      at: '2026-11-04T10:00:00.000Z',
    });
  });

  it('flags a step for review and the flag survives into the case', () => {
    const recorder = started();
    const step = recorder.recordErase(1);
    recorder.flagForReview(step, 'edited-text');
    expect(recorder.toCase().steps[0]).toMatchObject({ kind: 'erase', review: 'edited-text' });
  });

  it('flags a step with a review reason that can be changed again', () => {
    const recorder = started();
    const step = recorder.recordPressKey('home');
    recorder.flagForReview(step, 'screen-moving');
    recorder.flagForReview(step, 'left-app');
    expect(step.review).toBe('left-app');
  });

  it('emits eraseText with the same count', () => {
    const recorder = started();
    recorder.recordErase(4);
    expect(caseToFlow(recorder.toCase()).steps.at(-1)).toEqual({ kind: 'eraseText', chars: 4 });
  });

  it('describes an erase, with singular and plural', () => {
    const recorder = started();
    expect(describeStep(recorder.recordErase(1))).toBe('Erase 1 character');
    expect(describeStep(recorder.recordErase(5))).toBe('Erase 5 characters');
  });

  it('has plain-language text for every review reason', () => {
    for (const reason of ['screen-moving', 'no-element', 'password', 'edited-text', 'left-app'] as const) {
      expect(REVIEW_TEXT[reason].length).toBeGreaterThan(20);
    }
  });
});

describe('runMaestro keepDriver', () => {
  let dir: string;
  let fake: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ariadne-maestro-args-'));
    fake = join(dir, 'maestro');
    // A stand-in for the Maestro CLI that writes the arguments it got, one per line.
    await writeFile(fake, `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${join(dir, 'args.txt')}"\n`);
    await chmod(fake, 0o755);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function argsFor(keepDriver: boolean | undefined): Promise<string[]> {
    await runMaestro({
      maestroBin: fake,
      deviceId: 'R58M123',
      flowPath: join(dir, 'flow.yaml'),
      debugDir: join(dir, 'debug'),
      env: {},
      cwd: dir,
      timeoutMs: 10_000,
      ...(keepDriver === undefined ? {} : { keepDriver }),
    });
    return (await readFile(join(dir, 'args.txt'), 'utf8')).trim().split('\n');
  }

  it.skipIf(process.platform === 'win32')('adds --no-reinstall-driver when the driver is kept', async () => {
    const args = await argsFor(true);
    expect(args).toContain('--no-reinstall-driver');
    expect(args.at(-1)).toBe(join(dir, 'flow.yaml'));
  });

  it.skipIf(process.platform === 'win32')('leaves it out otherwise', async () => {
    expect(await argsFor(undefined)).not.toContain('--no-reinstall-driver');
    expect(await argsFor(false)).not.toContain('--no-reinstall-driver');
  });
});
