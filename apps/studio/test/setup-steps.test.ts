// Which step the device setup guide is on, worked out from the live checks.
import { describe, expect, it } from 'vitest';
import type { AdbDevice, SetupInfo } from '../src/shared/api-types.ts';
import { javaIsUsable, missingTools, opensByItself, walkthrough } from '../src/shared/setup-steps.ts';

function setup(overrides: Partial<SetupInfo> = {}): SetupInfo {
  return {
    os: 'windows',
    adb: { found: true, path: 'adb.exe' },
    emulator: { found: false },
    maestro: { found: true, path: 'maestro.bat' },
    java: { found: true, version: '17.0.21', major: 17 },
    avds: [],
    devices: [],
    ...overrides,
  };
}

const phone = (state: string): AdbDevice => ({ serial: '9afaa359', state, emulator: false });
const emulator = (state: string): AdbDevice => ({ serial: 'emulator-5554', state, emulator: true });

describe('missingTools', () => {
  it('lists nothing on a computer that has everything', () => {
    expect(missingTools(setup())).toEqual([]);
  });

  it('lists everything on a bare computer, the Android tools first', () => {
    expect(missingTools(setup({ adb: { found: false }, java: { found: false }, maestro: { found: false } }))).toEqual(['adb', 'java', 'maestro']);
  });

  it('counts a Java that is too old as missing', () => {
    expect(missingTools(setup({ java: { found: true, version: '1.8.0_281', major: 8 } }))).toEqual(['java']);
  });
});

describe('javaIsUsable', () => {
  it('trusts a Java whose version could not be read, as the checks do', () => {
    expect(javaIsUsable({ found: true })).toBe(true);
  });

  it('wants 17 or newer', () => {
    expect(javaIsUsable({ found: true, major: 16 })).toBe(false);
    expect(javaIsUsable({ found: true, major: 21 })).toBe(true);
    expect(javaIsUsable({ found: false })).toBe(false);
  });
});

describe('walkthrough', () => {
  it('starts with the tools while adb is missing', () => {
    expect(walkthrough(setup({ adb: { found: false } }))).toEqual({ step: 'tools' });
  });

  it('asks for the phone once adb is there, whatever Java and Maestro are doing', () => {
    expect(walkthrough(setup({ java: { found: false }, maestro: { found: false } }))).toEqual({ step: 'phone' });
  });

  it('moves on to Allow when the phone shows up unauthorized', () => {
    const device = phone('unauthorized');
    expect(walkthrough(setup({ devices: [device] }))).toEqual({ step: 'allow', device });
  });

  it('keeps a phone that is offline on the same step, whose text says what to do', () => {
    const device = phone('offline');
    expect(walkthrough(setup({ devices: [device] }))).toEqual({ step: 'allow', device });
  });

  it('is ready when a device is', () => {
    const device = phone('device');
    expect(walkthrough(setup({ devices: [device] }))).toEqual({ step: 'ready', device });
  });

  it('prefers a ready device to one that is still waiting', () => {
    const device = emulator('device');
    expect(walkthrough(setup({ devices: [phone('unauthorized'), device] }))).toEqual({ step: 'ready', device });
  });

  it('talks about the phone, not an emulator that is still starting', () => {
    const device = phone('unauthorized');
    expect(walkthrough(setup({ devices: [emulator('offline'), device] }))).toEqual({ step: 'allow', device });
  });

  it('talks about an emulator when that is all there is', () => {
    const device = emulator('offline');
    expect(walkthrough(setup({ devices: [device] }))).toEqual({ step: 'allow', device });
  });
});

describe('opensByItself', () => {
  it('opens when Ariadne cannot work yet, even for someone who connected before', () => {
    expect(opensByItself(setup({ adb: { found: false } }), false, '9afaa359')).toBe(true);
  });

  it('opens the first time, with nothing ready', () => {
    expect(opensByItself(setup(), false, undefined)).toBe(true);
  });

  it('stays closed for someone who has connected before and has not plugged in yet', () => {
    expect(opensByItself(setup(), false, '9afaa359')).toBe(false);
  });

  it('stays closed when a device is ready', () => {
    expect(opensByItself(setup({ devices: [phone('device')] }), false, undefined)).toBe(false);
  });

  it('stays closed while connected', () => {
    expect(opensByItself(setup({ adb: { found: false } }), true, undefined)).toBe(false);
  });
});
