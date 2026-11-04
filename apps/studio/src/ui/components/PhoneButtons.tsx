import type { ReactNode } from 'react';
import type { PhoneKey, ScreenOrientation } from '@ariadne/core/types';
import {
  EnterIcon,
  NavBackIcon,
  NavHomeIcon,
  NavRecentsIcon,
  PowerIcon,
  RotateIcon,
  VolumeDownIcon,
  VolumeUpIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from './Icons.tsx';

type Props = {
  /** No device, or the studio is busy. */
  disabled: boolean;
  /** While recording, the controls Maestro cannot replay are off. */
  recording: boolean;
  /** The screen is wider than tall, so Rotate turns it back to portrait. */
  landscape: boolean;
  onBack: () => void;
  onKey: (key: PhoneKey | 'appSwitch') => void;
  onRotate: (orientation: ScreenOrientation) => void;
  onZoom: (zoom: 'in' | 'out') => void;
};

/** Maestro 2.12 has no command for these, so a recorded step could never run. */
const LIVE_ONLY_TITLE = 'Off while recording: Maestro cannot replay this';

/**
 * The phone's own buttons, under the screen like a navigation bar. Every one
 * is a step while recording, except Recent apps and the zoom buttons, which
 * only work while not recording.
 */
export function PhoneButtons({ disabled, recording, landscape, onBack, onKey, onRotate, onZoom }: Props) {
  const button = (label: string, title: string, icon: ReactNode, onClick: () => void, liveOnly = false) => {
    const off = liveOnly && recording;
    return (
      <button
        type="button"
        className="phone-button"
        onClick={onClick}
        disabled={disabled || off}
        title={off ? LIVE_ONLY_TITLE : title}
        aria-label={title}
      >
        {icon}
        <span className="phone-button-label">{label}</span>
      </button>
    );
  };
  const next: ScreenOrientation = landscape ? 'portrait' : 'landscape';
  return (
    <div className="phone-buttons" role="toolbar" aria-label="Phone buttons">
      {button('Back', 'Back', <NavBackIcon />, onBack)}
      {button('Home', 'Home', <NavHomeIcon />, () => onKey('home'))}
      {button('Recents', 'Recent apps', <NavRecentsIcon />, () => onKey('appSwitch'), true)}
      <span className="phone-buttons-sep" aria-hidden="true" />
      {button('Vol down', 'Volume down', <VolumeDownIcon />, () => onKey('volumeDown'))}
      {button('Vol up', 'Volume up', <VolumeUpIcon />, () => onKey('volumeUp'))}
      {button('Power', 'Power button: turns the screen off or on', <PowerIcon />, () => onKey('power'))}
      <span className="phone-buttons-sep" aria-hidden="true" />
      {button('Rotate', `Rotate to ${next}`, <RotateIcon />, () => onRotate(next))}
      {button('Enter', 'Enter key on the keyboard', <EnterIcon />, () => onKey('enter'))}
      <span className="phone-buttons-sep" aria-hidden="true" />
      {button('Zoom in', 'Zoom in: pinch out around the middle of the screen', <ZoomInIcon />, () => onZoom('in'), true)}
      {button('Zoom out', 'Zoom out: pinch in around the middle of the screen', <ZoomOutIcon />, () => onZoom('out'), true)}
    </div>
  );
}
