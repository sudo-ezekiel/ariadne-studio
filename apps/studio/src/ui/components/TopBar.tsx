import { useEffect, useRef, useState } from 'react';
import type { SessionInfo } from '../../shared/api-types.ts';
import type { Theme, ThemeChoice } from '../theme.ts';
import { GearIcon, MoonIcon, SidebarIcon, SunIcon } from './Icons.tsx';
import { Logo } from './Logo.tsx';

type Props = {
  session: SessionInfo;
  busy: string | null;
  theme: Theme;
  themeChoice: ThemeChoice;
  onThemeChoice: (choice: ThemeChoice) => void;
  onOpenSetup: () => void;
  filesOpen: boolean;
  onToggleFiles: () => void;
  runVideo: boolean;
  videoHasSteps: boolean;
  onRunVideo: (on: boolean) => void;
  evidencePack: boolean;
  onEvidencePack: (on: boolean) => void;
};

const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** The gear: Device setup and the appearance choice, in a menu that closes on Escape or a click outside. */
function SettingsMenu({
  themeChoice,
  onThemeChoice,
  onOpenSetup,
  runVideo,
  videoHasSteps,
  onRunVideo,
  evidencePack,
  onEvidencePack,
}: Pick<Props, 'themeChoice' | 'onThemeChoice' | 'onOpenSetup' | 'runVideo' | 'videoHasSteps' | 'onRunVideo' | 'evidencePack' | 'onEvidencePack'>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu-anchor" ref={root}>
      <button
        type="button"
        className={`icon-button ${open ? 'icon-button-on' : ''}`}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Settings"
        title="Settings"
      >
        <GearIcon />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onOpenSetup();
            }}
          >
            Device setup
            <span className="menu-item-hint">Check adb, Maestro and Java, start an emulator</span>
          </button>
          <label className="menu-check">
            <input type="checkbox" checked={runVideo} onChange={(event) => onRunVideo(event.target.checked)} />
            <span>
              Keep a video of each run
              <span className="menu-item-hint">The steps beside the phone. It stays on this computer and shows whatever is on the screen.</span>
              {!videoHasSteps && <span className="menu-item-hint">Install ffmpeg to see the steps; without it the video shows only the phone.</span>}
            </span>
          </label>
          <label className="menu-check">
            <input type="checkbox" checked={evidencePack} onChange={(event) => onEvidencePack(event.target.checked)} />
            <span>
              Offer an evidence pack after Run all
              <span className="menu-item-hint">A test results report to print or save as PDF, for whoever accepts the release.</span>
            </span>
          </label>
          <div className="menu-section" role="group" aria-label="Appearance">
            <span className="menu-label">Appearance</span>
            <span className="segmented">
              {THEME_CHOICES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={themeChoice === option.value}
                  className={themeChoice === option.value ? 'segmented-on' : ''}
                  onClick={() => onThemeChoice(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function TopBar(props: Props) {
  const { session, busy, theme } = props;
  const status = busy
    ? `${busy}...`
    : session.open
      ? `Connected to ${session.deviceId} · ${session.appId}`
      : 'No device connected';
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="Ariadne">
        <Logo />
        <span className="brand-name">Ariadne</span>
        <span className="brand-sub">Studio</span>
      </a>
      <span className={`status ${session.open ? 'status-on' : ''} ${busy ? 'status-busy' : ''}`} title={status}>
        <span className="status-dot" aria-hidden="true" />
        <span className="status-text">{status}</span>
      </span>
      <button
        type="button"
        className={`icon-button ${props.filesOpen ? 'icon-button-on' : ''}`}
        onClick={props.onToggleFiles}
        aria-pressed={props.filesOpen}
        aria-label="Files"
        title={props.filesOpen ? 'Hide files' : 'Show files'}
      >
        <SidebarIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        onClick={() => props.onThemeChoice(next)}
        aria-label={`Switch to ${next} mode`}
        title={`Switch to ${next} mode`}
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
      <SettingsMenu
        themeChoice={props.themeChoice}
        onThemeChoice={props.onThemeChoice}
        onOpenSetup={props.onOpenSetup}
        runVideo={props.runVideo}
        videoHasSteps={props.videoHasSteps}
        onRunVideo={props.onRunVideo}
        evidencePack={props.evidencePack}
        onEvidencePack={props.onEvidencePack}
      />
    </header>
  );
}
