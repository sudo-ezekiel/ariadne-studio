import { useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { resolveNodeAt, type Point, type Rect } from '@ariadne/core/hit-test';
import type { PhoneKey, ScreenOrientation, ScrollDirection } from '@ariadne/core/types';
import { DEFAULT_WAIT_SECONDS, type PhoneStatus, type ScreenState, type SnapshotNodeLite } from '../../shared/api-types.ts';
import { RefreshIcon } from './Icons.tsx';
import { count } from './format.ts';
import { classifyPointer, distance, DRAG_PX } from './gestures.ts';
import { PhoneButtons } from './PhoneButtons.tsx';
import { ScreenMenu, type ScreenMenuChoice } from './ScreenMenu.tsx';

type Props = {
  screen: ScreenState | null;
  busy: boolean;
  /** Rect of the node the last tap resolved to, drawn briefly after the tap. */
  highlight: Rect | null;
  sessionOpen: boolean;
  caseActive: boolean;
  /** The case being recorded, for the bar above the screen. */
  recording: { name: string; steps: number } | null;
  /** Recording from a finger on the phone: this screen follows along and only Check works here. */
  phone: PhoneStatus;
  onTogglePhone: () => void;
  /** A real phone may be asking about an install: while connecting, or while Maestro's driver goes on for a run. */
  phonePrompt: 'connect' | 'run' | null;
  /** The end-check picker is open, so the recording is about to be saved. */
  picking: boolean;
  suiteRunning: boolean;
  /** At least one device is booted, so Connect is the next step rather than setup. */
  devicesFound: boolean;
  appId: string | undefined;
  onRecord: () => void;
  onFinish: () => void;
  onOpenSetup: () => void;
  /** While on, a click records an assertVisible instead of tapping. */
  expectMode: boolean;
  /** While on, a click records a wait until that element shows; nothing is pressed. */
  waitUntilMode: boolean;
  /** While on, a click chooses an element for a step of a block; nothing is pressed. */
  choosing: boolean;
  onChoose: (point: Point) => void;
  onTap: (point: Point) => void;
  onExpect: (point: Point) => void;
  onToggleExpect: () => void;
  onWaitUntil: (point: Point) => void;
  onToggleWaitUntil: () => void;
  onType: (text: string) => void;
  onBack: () => void;
  onScroll: (direction: ScrollDirection) => void;
  onRelaunch: () => void;
  onRefresh: () => void;
  onHideKeyboard: () => void;
  onOpenLink: (url: string) => void;
  onLongPress: (point: Point) => void;
  onDoubleTap: (point: Point) => void;
  /** A drag across the screen, in viewport pixels, and how long it took. */
  onSwipe: (from: Point, to: Point, durationMs: number) => void;
  onKey: (key: PhoneKey | 'appSwitch') => void;
  onRotate: (orientation: ScreenOrientation) => void;
  onZoom: (zoom: 'in' | 'out') => void;
};

/** A press on the screen while the pointer is down: where it started and how far it got. */
type Press = { pointerId: number; client: Point; point: Point; startedAt: number; maxDistance: number };

function toViewport(event: MouseEvent<HTMLElement>, screen: ScreenState): Point {
  const box = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.round(((event.clientX - box.left) / box.width) * screen.width),
    y: Math.round(((event.clientY - box.top) / box.height) * screen.height),
  };
}

function boxStyle(rect: Rect, screen: ScreenState) {
  return {
    left: `${(rect.x / screen.width) * 100}%`,
    top: `${(rect.y / screen.height) * 100}%`,
    width: `${(rect.width / screen.width) * 100}%`,
    height: `${(rect.height / screen.height) * 100}%`,
  };
}

/** Browsers by the name people know them by; any other app is shown by its package. */
const BROWSERS: Record<string, string> = {
  'com.android.chrome': 'Chrome',
  'com.sec.android.app.sbrowser': 'Samsung Internet',
  'org.mozilla.firefox': 'Firefox',
  'com.microsoft.emmx': 'Edge',
  'com.opera.browser': 'Opera',
};

/** Above the screen: when the phone is not on the app the case starts from. The app id is where a case starts, not a limit. */
function ElsewhereNote({ elsewhere, appId }: { elsewhere: NonNullable<ScreenState['elsewhere']>; appId: string | undefined }) {
  return (
    <p className="phone-banner" role="status">
      {elsewhere.home ? (
        <>The phone is on its home screen, not in {appId}. Relaunch app brings it back.</>
      ) : (
        <>
          {BROWSERS[elsewhere.app] ?? elsewhere.app} is in front, which is fine: an app that hands over to a website or another app is part of the case, so carry on here. The app id is only
          where a case starts.
        </>
      )}
    </p>
  );
}

/** A secure screen's picture is black, so its elements are drawn where the picture would be. */
function SecureElements({ screen }: { screen: ScreenState }) {
  const shown = screen.nodes.filter((node) => node.rect && !node.systemBar && (node.label ?? node.contentDescription));
  return (
    <>
      {shown.map((node, index) => (
        <div key={node.ref ?? index} className="secure-element" style={boxStyle(node.rect!, screen)}>
          <span>{node.label ?? node.contentDescription}</span>
        </div>
      ))}
    </>
  );
}

function caption(node: SnapshotNodeLite): string {
  const name = node.label ?? node.contentDescription;
  const parts = [name ? `"${name}"` : undefined, node.identifier, node.role].filter(Boolean);
  return parts.join('  ') || 'unnamed element';
}

/** Above the screen: whether a recording is going, and the one button that starts or finishes it. */
function StageBar(props: Props) {
  const { recording, sessionOpen, busy, picking, suiteRunning, phone } = props;
  if (recording) {
    return (
      <div className="stage-bar">
        <span className="stage-state">
          <span className="rec-dot rec-dot-lg" aria-hidden="true" />
          <span className="stage-state-word">Recording</span>
          <span className="stage-state-name">{recording.name}</span>
          <span className="stage-state-meta">{count(recording.steps, 'step')}</span>
        </span>
        {picking ? (
          <span className="hint">Choose the end checks on the right, then Save case.</span>
        ) : (
          <span className="stage-actions">
            <button
              type="button"
              className={phone.active ? 'toggle-on' : ''}
              aria-pressed={phone.active}
              onClick={props.onTogglePhone}
              disabled={busy}
              title={phone.active ? 'Go back to using the screen here' : 'Do the steps on the phone itself, with your own fingers'}
            >
              {phone.active ? 'Stop using the phone' : 'Use the phone'}
            </button>
            <button type="button" className="primary" onClick={props.onFinish} disabled={busy}>
              Finish recording
            </button>
          </span>
        )}
      </div>
    );
  }
  const state = suiteRunning
    ? 'Run all is using the device'
    : sessionOpen
      ? `Not recording · ${props.appId ?? ''}`
      : 'Connect a device to record';
  return (
    <div className="stage-bar">
      <span className="stage-state stage-state-idle">{state}</span>
      <button
        type="button"
        className="primary record-button"
        onClick={props.onRecord}
        disabled={!sessionOpen || busy || suiteRunning}
        title={sessionOpen ? 'Record a new case from this screen' : 'Connect a device first'}
      >
        <span className="record-dot" aria-hidden="true" />
        Start recording
      </button>
    </div>
  );
}

function PhonePrompt({ when }: { when: 'connect' | 'run' }) {
  return (
    <div className="phone-banner phone-banner-prompt" role="status">
      <strong>Look at your phone.</strong> It may ask to allow an install from this computer: tap <strong>Install</strong> or <strong>Allow</strong>. The prompt closes by
      itself within seconds, so if you miss it, {when === 'connect' ? 'press Connect again' : 'press Run again'}.
      <details>
        <summary>What is being installed?</summary>
        {when === 'connect'
          ? " Ariadne's helper, which lets it read the phone's screen. It has no icon and does nothing unless Ariadne is connected."
          : " Maestro's driver, which runs the test on the phone. It has no icon and does nothing unless a run is going."}{' '}
        It only works while the phone is plugged in with USB debugging on. Every phone needs it, and only some ask first.
      </details>
    </div>
  );
}

function EmptyScreen({ sessionOpen, devicesFound, onOpenSetup }: Pick<Props, 'sessionOpen' | 'devicesFound' | 'onOpenSetup'>) {
  if (sessionOpen) return <div className="mirror-empty">Waiting for the first screen.</div>;
  if (!devicesFound) {
    return (
      <div className="mirror-empty">
        <strong>No Android device found.</strong>
        <span>Start an emulator or plug in a phone with USB debugging on.</span>
        <button type="button" className="thread-button" onClick={onOpenSetup}>
          Set up a device
        </button>
      </div>
    );
  }
  return (
    <div className="mirror-empty">
      <strong>Connect to see the screen here.</strong>
      <span>Pick the device and the app id on the right, then press Connect.</span>
      <button type="button" className="link link-on-dark" onClick={onOpenSetup}>
        Device not listed? Set up a device
      </button>
    </div>
  );
}

export function Mirror(props: Props) {
  const { screen, busy, highlight, sessionOpen, caseActive, expectMode, waitUntilMode, choosing } = props;
  /** Check and Wait until both read an element off the screen and press nothing. */
  const looking = expectMode || waitUntilMode;
  const usingPhone = props.phone.active;
  /** Everything but Check waits while the phone is the input. */
  const inputOff = !sessionOpen || busy || usingPhone;
  const [hover, setHover] = useState<SnapshotNodeLite | undefined>();
  const [text, setText] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const press = useRef<Press | null>(null);
  /** The drag being drawn, in viewport pixels. */
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const [menu, setMenu] = useState<{ at: Point; point: Point } | null>(null);

  // A press becomes a tap, a long press or a swipe when it ends (classifyPointer).
  // Check mode keeps priority: a tap records a check, holds and drags do nothing.
  // The mouse wheel is left alone, so scrolling the page never records a step.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (busy || !screen || event.button !== 0 || (usingPhone && !looking)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = {
      pointerId: event.pointerId,
      client: { x: event.clientX, y: event.clientY },
      point: toViewport(event, screen),
      startedAt: event.timeStamp,
      maxDistance: 0,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = press.current;
    if (!current || !screen || event.pointerId !== current.pointerId) return;
    current.maxDistance = Math.max(current.maxDistance, distance(current.client, { x: event.clientX, y: event.clientY }));
    if (!looking && !choosing && current.maxDistance >= DRAG_PX) setDrag({ from: current.point, to: toViewport(event, screen) });
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = press.current;
    press.current = null;
    setDrag(null);
    if (!current || !screen || busy || event.pointerId !== current.pointerId) return;
    const durationMs = event.timeStamp - current.startedAt;
    const gesture = classifyPointer({ durationMs, maxDistancePx: current.maxDistance });
    if (choosing) {
      if (gesture === 'tap') props.onChoose(current.point);
    } else if (waitUntilMode) {
      if (gesture === 'tap') props.onWaitUntil(current.point);
    } else if (expectMode) {
      if (gesture === 'tap') props.onExpect(current.point);
    } else if (gesture === 'tap') props.onTap(current.point);
    else if (gesture === 'hold') props.onLongPress(current.point);
    else props.onSwipe(current.point, toViewport(event, screen), durationMs);
  };
  const cancelPress = () => {
    press.current = null;
    setDrag(null);
  };
  const chooseFromMenu = (choice: ScreenMenuChoice) => {
    const point = menu?.point;
    setMenu(null);
    if (!point) return;
    if (choice === 'tap') props.onTap(point);
    else if (choice === 'doubleTap') props.onDoubleTap(point);
    else if (choice === 'longPress') props.onLongPress(point);
    else props.onExpect(point);
  };

  const submitText = () => {
    if (!text) return;
    props.onType(text);
    setText('');
  };

  const captionText = choosing
    ? `Click the element for this step${hover && !busy ? `: ${caption(hover)}` : ''}`
    : waitUntilMode
    ? `Wait until mode: click what the run should wait for${hover && !busy ? `: ${caption(hover)}` : ''}`
    : expectMode
    ? `Check mode: click what must be visible${hover && !busy ? `: ${caption(hover)}` : ''}`
    : hover && !busy
      ? caption(hover)
      : ' ';

  return (
    <section className="mirror">
      <StageBar {...props} />
      {props.phonePrompt && <PhonePrompt when={props.phonePrompt} />}
      {props.screen?.hidden && (
        <p className="phone-banner phone-banner-prompt" role="status">
          The phone's screen is off or locked, so there is nothing to record. Wake it and unlock it, and the screen comes back here by itself.
        </p>
      )}
      {screen?.secure && (
        <p className="phone-banner phone-banner-prompt" role="status">
          This screen blocks screenshots, as banks and ID apps often do, so its picture stays black. Its text and buttons are drawn here instead: click them as usual. The step's screenshot will be black.
        </p>
      )}
      {screen?.elsewhere && <ElsewhereNote elsewhere={screen.elsewhere} appId={props.appId} />}
      {usingPhone && (
        <p className={`phone-banner ${props.phone.paused ? 'phone-banner-paused' : ''}`} role="status">
          {props.phone.paused
            ? 'Paused: you left the app. Open it again to carry on recording.'
            : 'Use the phone now. Steps appear on the right as you go, and this screen catches up after each one.'}
        </p>
      )}
      <div className={`stage ${props.recording ? 'stage-live' : ''}`}>
        <div className="mirror-frame">
          {screen ? (
            <div
              className={`screen ${busy ? 'screen-busy' : ''} ${looking ? 'screen-expect' : ''} ${choosing ? 'screen-choose' : ''} ${screen.width > screen.height ? 'screen-landscape' : ''}`}
              style={{ aspectRatio: `${screen.width} / ${screen.height}`, ['--screen-ratio' as string]: screen.width / screen.height }}
              onMouseMove={(event) => setHover(resolveNodeAt(screen.nodes, toViewport(event, screen)))}
              onMouseLeave={() => setHover(undefined)}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={cancelPress}
              onContextMenu={(event) => {
                event.preventDefault();
                cancelPress();
                if (busy || usingPhone || choosing) return;
                setMenu({ at: { x: event.clientX, y: event.clientY }, point: toViewport(event, screen) });
              }}
            >
              <img src={screen.imageUrl} alt="Device screen" draggable={false} />
              {screen.secure && <SecureElements screen={screen} />}
              {hover?.rect && !busy && (
                <div className={`outline ${looking ? 'outline-expect' : 'outline-hover'}`} style={boxStyle(hover.rect, screen)} />
              )}
              {highlight && <div className="outline outline-hit" style={boxStyle(highlight, screen)} />}
              {drag && (
                <svg className="drag-line" viewBox={`0 0 ${screen.width} ${screen.height}`} preserveAspectRatio="none" aria-hidden="true">
                  <line x1={drag.from.x} y1={drag.from.y} x2={drag.to.x} y2={drag.to.y} />
                  <circle cx={drag.from.x} cy={drag.from.y} r="1" />
                </svg>
              )}
            </div>
          ) : (
            <EmptyScreen sessionOpen={sessionOpen} devicesFound={props.devicesFound} onOpenSetup={props.onOpenSetup} />
          )}
        </div>
      </div>
      <div className={`mirror-caption ${looking ? 'mirror-caption-expect' : ''} ${choosing ? 'mirror-caption-choose' : ''}`}>{captionText}</div>
      <PhoneButtons
        disabled={inputOff}
        recording={caseActive}
        landscape={screen !== null && screen.width > screen.height}
        onBack={props.onBack}
        onKey={props.onKey}
        onRotate={props.onRotate}
        onZoom={props.onZoom}
      />
      {menu && screen && (
        <ScreenMenu at={menu.at} canCheck={caseActive} onChoose={chooseFromMenu} onClose={() => setMenu(null)} />
      )}
      <div className="toolbar">
        <form
          className="mirror-controls"
          onSubmit={(event) => {
            event.preventDefault();
            submitText();
          }}
        >
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Text to type"
            title="Typed into the field that has focus on the device"
            disabled={inputOff}
          />
          <button type="submit" disabled={inputOff || !text}>
            Type
          </button>
          <span className="toolbar-sep" aria-hidden="true" />
          <button
            type="button"
            className={expectMode ? 'toggle-on' : ''}
            aria-pressed={expectMode}
            onClick={props.onToggleExpect}
            disabled={!sessionOpen || !caseActive || busy}
            title={caseActive ? 'Record that this is on the screen. The run fails if it is missing.' : 'Start a case first'}
          >
            Check
          </button>
          <button
            type="button"
            className={waitUntilMode ? 'toggle-on' : ''}
            aria-pressed={waitUntilMode}
            onClick={props.onToggleWaitUntil}
            disabled={!sessionOpen || !caseActive || busy}
            title={
              caseActive
                ? `Click something the run should wait for. It gets up to ${DEFAULT_WAIT_SECONDS} seconds to appear; the run fails if it never does.`
                : 'Start a case first'
            }
          >
            Wait until
          </button>
        </form>
        <div className="mirror-controls">
          <button type="button" onClick={props.onRelaunch} disabled={inputOff} title="Close the app and start it again">
            Relaunch app
          </button>
          <button type="button" onClick={props.onHideKeyboard} disabled={inputOff}>
            Hide keyboard
          </button>
          {link === null ? (
            <button
              type="button"
              onClick={() => setLink('')}
              disabled={inputOff}
              title="Open a web link or an app deep link"
            >
              Open link
            </button>
          ) : (
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!link.trim()) return;
                props.onOpenLink(link.trim());
                setLink(null);
              }}
            >
              <input
                autoFocus
                value={link}
                onChange={(event) => setLink(event.target.value)}
                placeholder="https://... or myapp://..."
                disabled={!sessionOpen || busy}
              />
              <button type="submit" disabled={!sessionOpen || busy || !link.trim()}>
                Go
              </button>
              <button type="button" onClick={() => setLink(null)}>
                Cancel
              </button>
            </form>
          )}
          <button type="button" onClick={() => props.onScroll('down')} disabled={inputOff}>
            Scroll down
          </button>
          <button type="button" onClick={() => props.onScroll('up')} disabled={inputOff}>
            Scroll up
          </button>
          <button
            type="button"
            className="icon-button toolbar-refresh"
            onClick={props.onRefresh}
            disabled={!sessionOpen || busy}
            aria-label="Refresh"
            title="Refresh: look at the phone again now. The screen here also follows it by itself."
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
    </section>
  );
}
