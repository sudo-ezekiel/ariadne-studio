// The device setup guide: one step at a time from a bare computer to a phone
// that is ready, then a live check of what this computer has and the manual
// steps for a phone on USB or an emulator. It re-checks every few seconds while
// open, so plugging a phone in or allowing USB debugging moves it on without a
// click.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AdbDevice, SetupInfo, ToolId, ToolInstallStatus, ToolProgress } from '../../shared/api-types.ts';
import { ALLOW_HELP_AFTER_MS, MIN_JAVA, javaIsUsable, missingTools, walkthrough, type WalkthroughStep } from '../../shared/setup-steps.ts';
import { api, ApiError } from '../api.ts';
import { AlertIcon, CheckIcon, CrossIcon } from './Icons.tsx';

const RECHECK_MS = 4000;
const INSTALL_POLL_MS = 1000;
const SDK_TERMS_URL = 'https://developer.android.com/studio/terms';

type Props = {
  open: boolean;
  onClose: () => void;
  /** The set of ready devices changed, so the device picker should reload. */
  onDevicesChanged: () => void;
};

type Level = 'ok' | 'missing' | 'warn';

function Mark({ level }: { level: Level }) {
  return (
    <span className={`check-mark check-${level}`}>
      {level === 'ok' ? <CheckIcon size={14} /> : level === 'missing' ? <CrossIcon size={14} /> : <AlertIcon size={14} />}
    </span>
  );
}

function CheckRow({ level, title, children }: { level: Level; title: string; children: ReactNode }) {
  return (
    <li className="check-row">
      <Mark level={level} />
      <div>
        <div className="check-title">{title}</div>
        <div className="check-detail">{children}</div>
      </div>
    </li>
  );
}

/** What a device's adb state means for the person holding it. */
function deviceState(device: AdbDevice, os: SetupInfo['os']): { level: Level; text: string } {
  switch (device.state) {
    case 'device':
      return { level: 'ok', text: 'ready' };
    case 'unauthorized':
      return { level: 'warn', text: 'waiting: unlock the phone and press Allow on the "Allow USB debugging?" prompt' };
    case 'offline':
      return {
        level: 'warn',
        text: device.emulator ? 'offline: it may still be starting; if it stays offline, close the emulator and start it again' : 'offline: unplug the cable and plug it back in',
      };
    case 'no permissions':
      return {
        level: 'warn',
        text: os === 'linux' ? 'this computer may not use the phone yet: see step 5 of "Phone over USB" below' : 'this computer may not use the phone yet: unplug it and plug it back in',
      };
    default:
      return { level: 'warn', text: device.state };
  }
}

function Command({ children }: { children: string }) {
  return <code className="command">{children}</code>;
}

type XiaomiProps = { preparing: string[]; onPrepare: (serial: string) => void };

/** Xiaomi's phones block Maestro from opening apps until the tester lets it, once. */
function XiaomiStep({ device, preparing, onPrepare }: { device: AdbDevice } & XiaomiProps) {
  if (device.state !== 'device' || !device.xiaomi) return null;
  if (device.xiaomi.driverOpensApps) return <div className="device-note">Prepared for Run.</div>;
  const busy = preparing.includes(device.serial);
  return (
    <div className="device-note">
      Xiaomi phones stop Maestro from opening apps, so Run fails until you prepare this one. This installs Maestro's driver, which stays on the phone,
      and lets it open apps. Tap Install if the phone asks.{' '}
      <button type="button" onClick={() => onPrepare(device.serial)} disabled={busy}>
        {busy ? 'Preparing...' : 'Prepare this phone'}
      </button>
    </div>
  );
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

function toolStateText(tool: ToolProgress): string {
  switch (tool.state) {
    case 'waiting':
      return 'Waiting';
    case 'downloading':
      return `Downloading, ${megabytes(tool.received)} of ${megabytes(tool.total)} MB`;
    case 'unpacking':
      return 'Unpacking';
    case 'checking':
      return 'Checking that it starts';
    case 'done':
      return 'Ready';
    case 'failed':
      return 'Did not finish';
  }
}

function ToolRow({ tool }: { tool: ToolProgress }) {
  return (
    <li className="check-row">
      {tool.state === 'done' ? <Mark level="ok" /> : tool.state === 'failed' ? <Mark level="missing" /> : <span className="check-mark tool-busy" />}
      <div className="tool-text">
        <div className="check-title">{tool.name}</div>
        <div className="check-detail">{toolStateText(tool)}</div>
        {tool.state === 'downloading' && <progress className="tool-progress" max={tool.total} value={tool.received} aria-label={`${tool.name} download`} />}
        {tool.error && <p className="run-error">{tool.error}</p>}
      </div>
    </li>
  );
}

/**
 * The tools Ariadne can fetch itself: what is on offer and how big it is, then
 * how it is going. It stays out of the way of the phone steps, so a tester can
 * carry on while Java and Maestro download.
 */
function ToolsPanel({ status, missing, lead, onInstall }: { status: ToolInstallStatus | null; missing: ToolId[]; lead?: string; onInstall: () => void }) {
  if (!status?.available) return null;
  const failed = status.tools.some((tool) => tool.state === 'failed');
  const offered = status.offered.filter((tool) => missing.includes(tool.id));
  if (!status.running && !failed && offered.length === 0) return null;
  const needsTerms = missing.includes('adb');
  const label = failed ? 'Try again' : needsTerms ? 'Agree and set up' : 'Get them';
  const size = megabytes(offered.reduce((total, tool) => total + tool.bytes, 0));
  return (
    <div className="tools-panel">
      {lead && !status.running && !failed && <p>{lead}</p>}
      {(status.running || failed) && (
        <ul className="checks">
          {status.tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </ul>
      )}
      {status.running && <p className="hint">You can carry on with the steps while this downloads.</p>}
      {!status.running && offered.length > 0 && (
        <>
          <p className="tools-offer">
            <button type="button" className="primary" onClick={onInstall}>
              {label}
            </button>
            <span className="hint">About {size} MB to download. No admin rights needed.</span>
          </p>
          {needsTerms && (
            <p className="hint">
              Pressing {label} accepts Google's{' '}
              <a href={SDK_TERMS_URL} target="_blank" rel="noreferrer">
                Android SDK terms
              </a>
              . Ariadne gets each tool from the people who make it and checks the file before using it.
            </p>
          )}
        </>
      )}
    </div>
  );
}

const STEPS: Array<{ id: WalkthroughStep; title: string }> = [
  { id: 'tools', title: 'Set up this computer' },
  { id: 'phone', title: 'Plug in your phone' },
  { id: 'allow', title: 'Allow this computer' },
  { id: 'ready', title: 'Connect' },
];

function PhoneStep() {
  return (
    <>
      <ol className="guide walk-guide">
        <li>
          On the phone, open Settings, then About phone, and tap <strong>Build number</strong> seven times. On Samsung it is under Software information. On Xiaomi,
          Redmi and POCO, tap <strong>OS version</strong>.
        </li>
        <li>
          Find <strong>Developer options</strong> in Settings (search for it if you need to), and turn on <strong>USB debugging</strong> and <strong>Stay awake</strong>.
          On Xiaomi, Redmi and POCO, also turn on <strong>Install via USB</strong> and <strong>USB debugging (Security settings)</strong>.
        </li>
        <li>
          Plug the phone into this computer with a cable that carries data. If the phone asks what the connection is for, choose <strong>File transfer</strong>.
        </li>
      </ol>
      <p className="hint">This moves on by itself when your phone shows up. Nothing yet? Try another cable, then see Phone over USB under All checks and manual steps.</p>
    </>
  );
}

function AllowStep({ device, os, stuck }: { device: AdbDevice; os: SetupInfo['os']; stuck: boolean }) {
  if (device.state !== 'unauthorized') return <p>{deviceState(device, os).text}</p>;
  return (
    <>
      <p>
        Unlock the phone. It asks <strong>"Allow USB debugging?"</strong>. Tick <strong>Always allow from this computer</strong> and press <strong>Allow</strong>.
      </p>
      {stuck ? (
        <div className="device-note">
          No prompt, or nothing happened? In Developer options press <strong>Revoke USB debugging authorizations</strong>, turn USB debugging off and on again, then unplug
          the phone and plug it back in. Keep the phone unlocked: the prompt comes back within a few seconds.
        </div>
      ) : (
        <p className="hint">This moves on by itself when you press Allow.</p>
      )}
    </>
  );
}

function ReadyStep({ device, maestroFound, preparing, onPrepare }: { device: AdbDevice; maestroFound: boolean } & XiaomiProps) {
  return (
    <>
      <p>
        <strong>{device.avd ?? device.model ?? device.serial}</strong> is ready. Press Done, pick it under Device, type the app id and press Connect.
      </p>
      {device.xiaomi && <p className="hint">Watch the phone when you press Connect: it can ask before installing Ariadne's helper. Tap Install.</p>}
      {maestroFound && <XiaomiStep device={device} preparing={preparing} onPrepare={onPrepare} />}
    </>
  );
}

function Walkthrough({ info, install, stuck, onInstall, preparing, onPrepare }: { info: SetupInfo; install: ToolInstallStatus | null; stuck: boolean; onInstall: () => void } & XiaomiProps) {
  const { step, device } = walkthrough(info);
  const current = STEPS.findIndex((item) => item.id === step);
  const missing = missingTools(info);
  const body = (id: WalkthroughStep) => {
    if (id === 'tools') {
      return install && !install.available ? (
        <p>Ariadne needs the Android tools to talk to your phone. Follow the steps under All checks and manual steps.</p>
      ) : (
        <>
          <p>Ariadne needs three free tools: the Android tools, to talk to your phone, and Java and Maestro, to run saved cases. It fetches them for you, into your own folders. You do not need Android Studio.</p>
          <ToolsPanel status={install} missing={missing} onInstall={onInstall} />
        </>
      );
    }
    if (id === 'phone') return <PhoneStep />;
    if (id === 'allow') return device && <AllowStep device={device} os={info.os} stuck={stuck} />;
    return device && <ReadyStep device={device} maestroFound={info.maestro.found} preparing={preparing} onPrepare={onPrepare} />;
  };
  return (
    <>
      <ol className="walk" aria-label="Setup steps">
        {STEPS.map((item, position) => {
          const place = position < current ? 'walk-done' : position === current ? 'walk-now' : 'walk-later';
          return (
            <li key={item.id} className={`walk-step ${place}`} aria-current={position === current ? 'step' : undefined}>
              <span className="walk-mark">{position < current ? <CheckIcon size={14} /> : position + 1}</span>
              <div className="walk-body">
                <div className="walk-title">{item.title}</div>
                {position === current && body(item.id)}
              </div>
            </li>
          );
        })}
      </ol>
      {step !== 'tools' && <ToolsPanel status={install} missing={missing} lead="Recording is ready. To run saved cases, Ariadne also needs these. It fetches them for you." onInstall={onInstall} />}
    </>
  );
}

function Checks({ info, canInstall, starting, onStart, preparing, onPrepare }: { info: SetupInfo; canInstall: boolean; starting: string[]; onStart: (name: string) => void } & XiaomiProps) {
  const javaOk = javaIsUsable(info.java);
  const running = new Set(info.devices.map((device) => device.avd).filter(Boolean));
  const ready = info.devices.filter((device) => device.state === 'device');
  return (
    <ul className="checks">
      <CheckRow level={info.adb.found ? 'ok' : 'missing'} title="Android tools (adb)">
        {info.adb.found ? (
          <span className="path">{info.adb.path}</span>
        ) : canInstall ? (
          <>Not found. The steps above fetch it for you. If the Android SDK is somewhere unusual, set ANDROID_HOME to it instead.</>
        ) : (
          <>Not found. Install Android Studio (step 1 of "Emulator" below), then restart Ariadne. If the Android SDK is somewhere unusual, set ANDROID_HOME to it.</>
        )}
      </CheckRow>
      <CheckRow level={ready.length > 0 ? 'ok' : 'missing'} title="Devices">
        {info.devices.length === 0 ? (
          <>No phone or emulator is connected. Start an emulator, or plug in a phone with USB debugging on.</>
        ) : (
          <ul className="device-states">
            {info.devices.map((device) => {
              const state = deviceState(device, info.os);
              return (
                <li key={device.serial} className={`device-${state.level}`}>
                  <strong>{device.avd ?? device.model ?? device.serial}</strong> <span className="path">{device.serial}</span>: {state.text}
                  <XiaomiStep device={device} preparing={preparing} onPrepare={onPrepare} />
                </li>
              );
            })}
          </ul>
        )}
      </CheckRow>
      {info.emulator.found && (
        <CheckRow level={info.avds.length > 0 ? 'ok' : 'warn'} title="Emulators on this computer">
          {info.avds.length === 0 ? (
            <>None yet. Create one in Android Studio (step 2 of "Emulator" below).</>
          ) : (
            <ul className="avds">
              {info.avds.map((name) => (
                <li key={name}>
                  <span>{name}</span>
                  {running.has(name) ? (
                    <span className="hint">running</span>
                  ) : starting.includes(name) ? (
                    <span className="hint">starting, this can take a minute</span>
                  ) : (
                    <button type="button" onClick={() => onStart(name)}>
                      Start
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CheckRow>
      )}
      <CheckRow level={info.maestro.found ? 'ok' : 'missing'} title="Maestro, to run saved cases">
        {info.maestro.found ? (
          <span className="path">{info.maestro.path}</span>
        ) : canInstall ? (
          <>Not found. Recording works without it; Run needs it. The steps above fetch it for you.</>
        ) : info.os === 'windows' ? (
          <>Not found. Recording works without it; Run needs it. Follow the Windows steps in Maestro's installation guide at maestro.dev.</>
        ) : (
          <>
            Not found. Recording works without it; Run needs it. Install it with <Command>{'curl -fsSL "https://get.maestro.mobile.dev" | bash'}</Command>
          </>
        )}
      </CheckRow>
      <CheckRow level={javaOk ? 'ok' : 'missing'} title={`Java ${MIN_JAVA} or newer, for Maestro`}>
        {javaOk ? (
          <>Java {info.java.version ?? ''}</>
        ) : canInstall ? (
          <>{info.java.found ? `Java ${info.java.version} is too old.` : 'Not found.'} The steps above fetch a new one for you, for Ariadne only.</>
        ) : !info.java.found ? (
          <>Not found. Install Java {MIN_JAVA} or newer, for example Temurin {MIN_JAVA} from adoptium.net.</>
        ) : (
          <>
            Java {info.java.version} is too old. Install Java {MIN_JAVA} or newer, for example Temurin {MIN_JAVA} from adoptium.net.
          </>
        )}
      </CheckRow>
    </ul>
  );
}

function EmulatorGuide({ info }: { info: SetupInfo | null }) {
  return (
    <ol className="guide">
      <li>
        <strong>Install Android Studio</strong> from{' '}
        <a href="https://developer.android.com/studio" target="_blank" rel="noreferrer">
          developer.android.com/studio
        </a>
        . It brings the Android tools and the emulator.
        {info?.adb.found && <span className="guide-done"> Done on this computer.</span>}
      </li>
      <li>
        <strong>Create a virtual phone.</strong> In Android Studio open the Device Manager (on the welcome screen: More Actions, then Virtual Device
        Manager). Press Create device, pick a phone such as Pixel 8, pick a recent system image (download it when asked), then Finish.
        {info && info.avds.length > 0 && <span className="guide-done"> Done: {info.avds.join(', ')}.</span>}
      </li>
      <li>
        <strong>Start it</strong> with Start in "Emulators on this computer" above, or with the play button in the Device Manager. The first start
        takes a minute or two.
      </li>
      <li>
        <strong>Install the app you want to test.</strong> Drag its <code>.apk</code> file onto the emulator window, or run{' '}
        <Command>adb install path/to/app.apk</Command>. A developer can give you the <code>.apk</code>.
      </li>
      <li>
        <strong>Connect.</strong> Close this guide, pick the emulator under Device, above the Record tab (it is called <code>emulator-5554</code> or similar), type
        the app id and press Connect.
      </li>
    </ol>
  );
}

function UsbGuide({ os }: { os: SetupInfo['os'] | undefined }) {
  return (
    <ol className="guide">
      <li>
        <strong>Turn on developer options.</strong> On the phone open Settings, then About phone, and tap Build number seven times until it says you
        are a developer. On Samsung phones Build number is under About phone, then Software information.
      </li>
      <li>
        <strong>Turn on USB debugging</strong> in Settings, System, Developer options (on Samsung, Developer options is at the bottom of Settings).
        Turn on Stay awake there too, so the screen does not lock in the middle of a recording.
      </li>
      <li>
        <strong>Plug the phone in</strong> with a cable that carries data; some cables only charge. If the phone asks what the connection is for,
        choose File transfer.
      </li>
      <li>
        <strong>Allow this computer.</strong> The phone asks "Allow USB debugging?". Tick "Always allow from this computer" and press Allow. Until
        you do, Devices above says the phone is waiting. No prompt? Unplug and plug in again, or press "Revoke USB debugging authorizations" in
        Developer options and plug in again.
      </li>
      <li>
        <strong>{os === 'windows' ? 'Only if the phone does not show up: install its USB driver.' : os === 'mac' ? 'Nothing more on a Mac.' : 'Let your user use the phone (Linux).'}</strong>{' '}
        {os === 'windows' ? (
          <>
            Windows brings a driver that works for some phones. If yours does not show up, install the maker's: the Google USB Driver for Pixel phones, the Samsung USB Driver for
            Samsung phones. Installing a driver needs admin rights, so on a company computer ask your IT team.
          </>
        ) : os === 'mac' ? (
          <>macOS needs no driver.</>
        ) : (
          <>
            If Devices above says "may not use the phone yet", install your distribution's Android udev rules (<code>android-udev</code> on Arch,{' '}
            <code>android-sdk-platform-tools-common</code> on Debian and Ubuntu), add yourself to the <code>adbusers</code> or <code>plugdev</code>{' '}
            group, then log out and back in. Windows needs the phone maker's USB driver; macOS needs nothing.
          </>
        )}
      </li>
      <li>
        <strong>Be ready to look at the phone.</strong> The first time, Ariadne puts two small test helpers on it: one on Connect, which reads the screen, and Maestro's
        driver on Run. Every phone needs them. Some phones ask first, and that prompt closes by itself within seconds, so tap Install or Allow straight away.
      </li>
      <li>
        <strong>On a Xiaomi, Redmi or POCO phone</strong>, also turn on Install via USB and USB debugging (Security settings) in Developer options.
        The phone then asks before each install from this computer: tap Install. If Connect fails, press it again and watch the phone.
      </li>
      <li>
        <strong>Install the app and connect.</strong> Install the app as usual (Play Store, a test link, or <Command>adb install path/to/app.apk</Command>
        ), close this guide, pick the phone under Device, above the Record tab, type the app id and press Connect. Keep the phone unlocked while you record.
      </li>
    </ol>
  );
}

export function SetupDialog({ open, onClose, onDevicesChanged }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'emulator' | 'usb'>('usb');
  const [starting, setStarting] = useState<string[]>([]);
  const [preparing, setPreparing] = useState<string[]>([]);
  const [screenshots, setScreenshots] = useState(false);
  const [install, setInstall] = useState<ToolInstallStatus | null>(null);
  const [allowStuck, setAllowStuck] = useState(false);
  const [checkNow, setCheckNow] = useState(0);
  const readyKey = useRef<string | undefined>(undefined);
  const allowWait = useRef<{ serial: string; since: number } | undefined>(undefined);
  const wasInstalling = useRef(false);
  const devicesChanged = useRef(onDevicesChanged);
  devicesChanged.current = onDevicesChanged;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const check = async () => {
      try {
        const next = await api.setup();
        if (!alive) return;
        setInfo(next);
        setError(null);
        const key = next.devices
          .filter((device) => device.state === 'device')
          .map((device) => device.serial)
          .sort()
          .join(',');
        if (readyKey.current !== undefined && readyKey.current !== key) devicesChanged.current();
        readyKey.current = key;
        const running = new Set(next.devices.map((device) => device.avd));
        setStarting((current) => current.filter((name) => !running.has(name)));
        const { step, device } = walkthrough(next);
        if (step !== 'allow' || device?.state !== 'unauthorized') allowWait.current = undefined;
        else if (allowWait.current?.serial !== device.serial) allowWait.current = { serial: device.serial, since: Date.now() };
        setAllowStuck(allowWait.current !== undefined && Date.now() - allowWait.current.since >= ALLOW_HELP_AFTER_MS);
      } catch (caught) {
        if (alive) setError(caught instanceof ApiError ? caught.message : String(caught));
      }
    };
    void check();
    const timer = setInterval(() => void check(), RECHECK_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, checkNow]);

  // The download goes on with the dialog closed, so ask where it is on every open.
  useEffect(() => {
    if (open) void api.installStatus().then(setInstall, () => undefined);
  }, [open]);

  const installing = install?.running ?? false;
  useEffect(() => {
    if (!open || !installing) return;
    let alive = true;
    const timer = setInterval(() => {
      void api.installStatus().then(
        (next) => {
          if (alive) setInstall(next);
        },
        () => undefined,
      );
    }, INSTALL_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, installing]);

  // What just landed shows in the checks straight away, not at the next tick.
  useEffect(() => {
    if (wasInstalling.current && !installing) setCheckNow((count) => count + 1);
    wasInstalling.current = installing;
  }, [installing]);

  const startInstall = async () => {
    try {
      setInstall(await api.startInstall());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    }
  };

  const preparePhone = async (serial: string) => {
    setPreparing((current) => [...current, serial]);
    try {
      const { ready } = await api.preparePhone(serial);
      if (!ready) setError('The phone did not let Maestro open apps. In its Settings, open Apps, then Maestro Driver, and allow it to open new windows in the background.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setPreparing((current) => current.filter((item) => item !== serial));
    }
  };

  const startEmulator = async (name: string) => {
    setStarting((current) => [...current, name]);
    try {
      await api.startEmulator(name);
    } catch (caught) {
      setStarting((current) => current.filter((item) => item !== name));
      setError(caught instanceof ApiError ? caught.message : String(caught));
    }
  };

  return (
    <dialog ref={dialog} className="setup-dialog" onClose={onClose} aria-labelledby="setup-title">
      <div className="dialog-head">
        <h2 id="setup-title">Set up a device</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          <CrossIcon />
        </button>
      </div>
      <div className="dialog-body">
        <p className="lede">
          Ariadne records on a real Android phone plugged in with USB. Follow the steps here: each one moves on by itself. For a virtual phone on this computer, see Emulator under All
          checks and manual steps.
        </p>
        {error && <p className="run-error">{error}</p>}
        {info ? (
          <Walkthrough info={info} install={install} stuck={allowStuck} onInstall={() => void startInstall()} preparing={preparing} onPrepare={(serial) => void preparePhone(serial)} />
        ) : (
          !error && <p className="hint">Checking...</p>
        )}

        <details className="setup-more" open={Boolean(info && !info.adb.found && install && !install.available)}>
          <summary>All checks and manual steps</summary>
          <h3>This computer</h3>
          {info && (
            <Checks
              info={info}
              canInstall={install?.available ?? false}
              starting={starting}
              onStart={(name) => void startEmulator(name)}
              preparing={preparing}
              onPrepare={(serial) => void preparePhone(serial)}
            />
          )}
          <div className="guide-tabs" role="tablist" aria-label="Kind of device">
            <button type="button" role="tab" aria-selected={tab === 'usb'} className={tab === 'usb' ? 'tab-on' : ''} onClick={() => setTab('usb')}>
              Phone over USB
            </button>
            <button type="button" role="tab" aria-selected={tab === 'emulator'} className={tab === 'emulator' ? 'tab-on' : ''} onClick={() => setTab('emulator')}>
              Emulator
            </button>
          </div>
          {tab === 'emulator' ? <EmulatorGuide info={info} /> : <UsbGuide os={info?.os} />}
        </details>

        <h3>Something not working?</h3>
        <p className="guide-note">
          Export diagnostics saves one file to send to whoever is helping you: versions, facts about the phone, the log, your case steps and recent runs. It never holds
          your saved values, passwords or where keys were pressed, and typed text is reduced to its length. Screenshots can show anything on the phone, so they stay out
          unless you tick the box.
        </p>
        <p className="diagnostics-row">
          <label>
            <input type="checkbox" checked={screenshots} onChange={(event) => setScreenshots(event.target.checked)} /> Include screenshots
          </label>
          <a className="thread-button" href={api.diagnosticsUrl(screenshots)} download>
            Export diagnostics
          </a>
        </p>

        <h3>Which app id?</h3>
        <p className="guide-note">
          The app id is the app's package name, such as <code>com.example.claims</code>. A developer knows it (it is the <code>applicationId</code> in
          the app's build file), or list the apps on the device with <Command>adb shell pm list packages</Command>.
        </p>
      </div>
      <div className="dialog-foot">
        <span className="hint">Checks again every few seconds while this is open.</span>
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </dialog>
  );
}
