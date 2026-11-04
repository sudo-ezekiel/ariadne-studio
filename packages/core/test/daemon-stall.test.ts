// agent-device's daemon sometimes stalls at start on Windows and then holds its
// lock, so every retry fails until the process is ended. These tests give the
// session a stub client and a stub for ending a process: nothing here starts a
// daemon, and no real process is ever signalled (process.kill is stubbed, and on
// Windows taskkill goes through a stubbed execFile).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, type AgentDeviceClient } from 'agent-device';

const killed = vi.hoisted(() => ({ taskkill: [] as Array<{ file: string; args: string[] }> }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = (file: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
    killed.taskkill.push({ file, args });
    done(null, '', '');
  };
  return { ...actual, execFile };
});

import { DeviceSession, stalledDaemon } from '../src/device/session.ts';

/** A pid no real process has (above any operating system's limit on pids). */
const NO_SUCH_PID = 2_147_480_001;

const stallDetails = (pid: unknown = 4368, reason = 'startup-stalled', kind = 'daemon_startup_failed') => ({ kind, reason, daemonProcess: { pid } });
const stalled = (pid: unknown = NO_SUCH_PID) => new AppError('COMMAND_FAILED', 'Failed to start daemon', stallDetails(pid));

describe('stalledDaemon', () => {
  it('returns the pid for agent-device\'s stalled startup error', () => {
    expect(stalledDaemon(new AppError('COMMAND_FAILED', 'Failed to start daemon', stallDetails(4368)))).toBe(4368);
  });

  it.each(['startup-exited', 'startup-ceiling', '', 'startup-stalled-ish'])('returns undefined for reason %j', (reason) => {
    expect(stalledDaemon(new AppError('COMMAND_FAILED', 'Failed to start daemon', stallDetails(4368, reason)))).toBeUndefined();
  });

  it('returns undefined for another kind of failure', () => {
    expect(stalledDaemon(new AppError('COMMAND_FAILED', 'Failed to start daemon', stallDetails(4368, 'startup-stalled', 'daemon_connect_failed')))).toBeUndefined();
  });

  it.each([
    ['no daemonProcess', { kind: 'daemon_startup_failed', reason: 'startup-stalled' }],
    ['no pid', { kind: 'daemon_startup_failed', reason: 'startup-stalled', daemonProcess: {} }],
    ['a pid that is a string', stallDetails('4368')],
    ['a null pid', stallDetails(null)],
    ['a pid that is an object', stallDetails({ value: 4368 })],
  ])('returns undefined for %s', (_name, details) => {
    expect(stalledDaemon(new AppError('COMMAND_FAILED', 'Failed to start daemon', details))).toBeUndefined();
  });

  it('returns undefined for an error with no details', () => {
    expect(stalledDaemon(new AppError('COMMAND_FAILED', 'Failed to start daemon'))).toBeUndefined();
  });

  it('returns undefined for a plain Error, even one whose message says the daemon stalled', () => {
    expect(stalledDaemon(new Error('Failed to start daemon: startup-stalled'))).toBeUndefined();
  });

  it.each([undefined, null, 'startup-stalled', 42])('returns undefined for %j, which is not an error', (value) => {
    expect(stalledDaemon(value)).toBeUndefined();
  });

  // KNOWN GAP: any number is taken for a pid, and startingDaemon passes it to
  // process.kill (or taskkill). 0 signals this process's own group, -1 signals
  // every process the user may, NaN and 1.5 throw. agent-device reports real
  // pids, so this is a guard, not a live fault. Left failing on purpose.
  it.each([0, -1, -4368, Number.NaN, 1.5, Number.POSITIVE_INFINITY])('returns undefined for a pid that cannot be a process: %s', (pid) => {
    expect(stalledDaemon(new AppError('COMMAND_FAILED', 'Failed to start daemon', stallDetails(pid)))).toBeUndefined();
  });
});

describe('a session whose daemon stalls at start', () => {
  type Stub = {
    client: AgentDeviceClient;
    list: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    snapshot: ReturnType<typeof vi.fn>;
  };

  function stub(): Stub {
    const list = vi.fn();
    const open = vi.fn();
    const snapshot = vi.fn(async () => ({ nodes: [] }));
    return { client: { devices: { list }, apps: { open }, capture: { snapshot } } as unknown as AgentDeviceClient, list, open, snapshot };
  }

  const DEVICES = [
    { id: 'R58M123', name: 'Phone', platform: 'android', kind: 'device', booted: true },
    { id: 'emulator-5554', name: 'Off', platform: 'android', kind: 'emulator', booted: false },
  ];
  const OPTIONS = { deviceId: 'R58M123', appId: 'com.example' };
  const REPLY = { snapshot: { viewport: { width: 1080, height: 2400 } } };

  let kill: { mock: { calls: unknown[][] } };
  let error: { mock: { calls: unknown[][] }; (...args: never[]): unknown };

  beforeEach(() => {
    killed.taskkill.length = 0;
    kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined) as unknown as typeof error;
  });
  afterEach(() => vi.restoreAllMocks());

  /** What ending a process looked like, on whichever system the tests run. */
  function ended(): Array<number> {
    if (process.platform === 'win32') {
      return killed.taskkill.map((call) => {
        expect(call.file).toBe('taskkill');
        expect(call.args).toEqual(['/pid', String(call.args[1]), '/t', '/f']);
        return Number(call.args[1]);
      });
    }
    return kill.mock.calls.map(([pid, signal]: unknown[]) => {
      expect(signal).toBe('SIGKILL');
      return pid as number;
    });
  }

  describe('listDevices', () => {
    it('ends the stalled process, calls again once and returns the second result', async () => {
      const s = stub();
      s.list.mockRejectedValueOnce(stalled()).mockResolvedValueOnce(DEVICES);
      const devices = await new DeviceSession({ client: s.client }).listDevices();
      expect(devices).toEqual([{ id: 'R58M123', name: 'Phone', platform: 'android', kind: 'device', booted: true }]);
      expect(s.list).toHaveBeenCalledTimes(2);
      expect(ended()).toEqual([NO_SUCH_PID]);
    });

    it('ends the process before the second call', async () => {
      const s = stub();
      s.list.mockRejectedValueOnce(stalled()).mockImplementationOnce(async () => {
        expect(ended()).toEqual([NO_SUCH_PID]);
        return DEVICES;
      });
      await new DeviceSession({ client: s.client }).listDevices();
      expect(s.list).toHaveBeenCalledTimes(2);
    });

    it('lets the second error reach the caller and makes no third call', async () => {
      const s = stub();
      const second = new AppError('COMMAND_FAILED', 'Daemon registration busy');
      s.list.mockRejectedValueOnce(stalled()).mockRejectedValueOnce(second);
      await expect(new DeviceSession({ client: s.client }).listDevices()).rejects.toBe(second);
      expect(s.list).toHaveBeenCalledTimes(2);
      expect(ended()).toEqual([NO_SUCH_PID]);
    });

    it('lets a second stall reach the caller too, ending only the first process', async () => {
      const s = stub();
      const again = stalled(NO_SUCH_PID + 1);
      s.list.mockRejectedValueOnce(stalled()).mockRejectedValueOnce(again);
      await expect(new DeviceSession({ client: s.client }).listDevices()).rejects.toBe(again);
      expect(s.list).toHaveBeenCalledTimes(2);
      expect(ended()).toEqual([NO_SUCH_PID]);
    });

    it.each([
      ['another agent-device error', new AppError('COMMAND_FAILED', 'adb not found')],
      ['a daemon that exited', new AppError('COMMAND_FAILED', 'Failed to start daemon', stallDetails(NO_SUCH_PID, 'startup-exited'))],
      ['a daemon past its ceiling', new AppError('COMMAND_FAILED', 'Failed to start daemon', stallDetails(NO_SUCH_PID, 'startup-ceiling'))],
      ['a plain Error', new Error('boom')],
    ])('does not retry or kill anything for %s', async (_name, failure) => {
      const s = stub();
      s.list.mockRejectedValue(failure);
      await expect(new DeviceSession({ client: s.client }).listDevices()).rejects.toBe(failure);
      expect(s.list).toHaveBeenCalledTimes(1);
      expect(ended()).toEqual([]);
    });

    it('calls once and kills nothing when the first call works', async () => {
      const s = stub();
      s.list.mockResolvedValue(DEVICES);
      await new DeviceSession({ client: s.client }).listDevices();
      expect(s.list).toHaveBeenCalledTimes(1);
      expect(ended()).toEqual([]);
    });
  });

  describe('open', () => {
    it('ends the stalled process and opens again once', async () => {
      const s = stub();
      s.open.mockRejectedValueOnce(stalled()).mockResolvedValueOnce(REPLY);
      await new DeviceSession({ client: s.client }).open(OPTIONS);
      expect(s.open).toHaveBeenCalledTimes(2);
      expect(s.open.mock.calls[1]).toEqual(s.open.mock.calls[0]);
      expect(ended()).toEqual([NO_SUCH_PID]);
    });

    it('still records the target and the viewport after a retry', async () => {
      const s = stub();
      s.open.mockRejectedValueOnce(stalled()).mockResolvedValueOnce(REPLY);
      const session = new DeviceSession({ client: s.client });
      await session.open(OPTIONS);
      expect(session).toMatchObject({ isOpen: true, deviceId: 'R58M123', appId: 'com.example' });
      // The screen size came from the open reply: the snapshot below carries none.
      expect((await session.snapshot()).viewport).toEqual({ width: 1080, height: 2400 });
    });

    it('lets the second error reach the caller, makes no third call and records no target', async () => {
      const s = stub();
      const second = new AppError('COMMAND_FAILED', 'Daemon registration busy');
      s.open.mockRejectedValueOnce(stalled()).mockRejectedValueOnce(second);
      const session = new DeviceSession({ client: s.client });
      await expect(session.open(OPTIONS)).rejects.toBe(second);
      expect(s.open).toHaveBeenCalledTimes(2);
      expect(session.isOpen).toBe(false);
    });

    it('does not retry or kill anything for a different error', async () => {
      const s = stub();
      const failure = new AppError('APP_NOT_INSTALLED', 'No such app');
      s.open.mockRejectedValue(failure);
      const session = new DeviceSession({ client: s.client });
      await expect(session.open(OPTIONS)).rejects.toBe(failure);
      expect(s.open).toHaveBeenCalledTimes(1);
      expect(ended()).toEqual([]);
      expect(session.isOpen).toBe(false);
    });

    it('retries a relaunch the same way', async () => {
      const s = stub();
      s.open.mockResolvedValueOnce(REPLY).mockRejectedValueOnce(stalled()).mockResolvedValueOnce(REPLY);
      const session = new DeviceSession({ client: s.client });
      await session.open(OPTIONS);
      await session.relaunchApp();
      expect(s.open).toHaveBeenCalledTimes(3);
      expect(s.open.mock.calls[2]![0]).toMatchObject({ relaunch: true });
      expect(ended()).toEqual([NO_SUCH_PID]);
    });
  });

  describe('the log line', () => {
    it('holds only the error message and the pid, nothing from the device', async () => {
      const s = stub();
      const failure = new AppError('COMMAND_FAILED', 'Failed to start daemon', {
        ...stallDetails(NO_SUCH_PID),
        serial: 'SERIAL-PRIVATE-77',
        deviceName: 'Maria\'s phone',
        logTail: 'screen text: account 123456',
        stderr: 'adb -s SERIAL-PRIVATE-77 failed',
      }, new Error('cause naming SERIAL-PRIVATE-77'));
      s.list.mockRejectedValueOnce(failure).mockResolvedValueOnce(DEVICES);
      await new DeviceSession({ client: s.client }).listDevices();
      const lines = error.mock.calls.map((args: unknown[]) => args.map(String).join(' '));
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(line).toContain('Failed to start daemon');
      expect(line).toContain(String(NO_SUCH_PID));
      for (const secret of ['SERIAL-PRIVATE-77', 'Maria', 'account 123456', 'adb -s', 'cause naming']) expect(line).not.toContain(secret);
    });

    it('is not written when nothing stalled', async () => {
      const s = stub();
      s.list.mockRejectedValue(new Error('boom'));
      await expect(new DeviceSession({ client: s.client }).listDevices()).rejects.toThrow('boom');
      expect(error).not.toHaveBeenCalled();
    });
  });
});
