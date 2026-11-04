// Small inline icons. They take the text colour, so a parent's colour decides theirs.
import type { ReactNode } from 'react';

type IconProps = { size?: number };

function Svg({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className="icon"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Files sidebar switch: a window with a column on the right. */
export function SidebarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.5" />
      <path d="M10 2.8V13.2" />
    </Svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 12.2V4a1 1 0 0 1 1-1h3.1l1.6 1.8H13a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </Svg>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.8 1.8h5.4l3 3v9.4H3.8z" />
      <path d="M9 2v3h3" />
    </Svg>
  );
}

/** Points right; the Files tree turns it down for an open folder. */
export function ChevronIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3.5L10.5 8L6 12.5" />
    </Svg>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.1" />
      <path
        strokeWidth="1.3"
        d="M13.2 6.56L14.92 6.95L14.92 9.05L13.2 9.44L12.7 10.66L13.64 12.15L12.15 13.64L10.66 12.7L9.44 13.2L9.05 14.92L6.95 14.92L6.56 13.2L5.34 12.7L3.85 13.64L2.36 12.15L3.3 10.66L2.8 9.44L1.08 9.05L1.08 6.95L2.8 6.56L3.3 5.34L2.36 3.85L3.85 2.36L5.34 3.3L6.56 2.8L6.95 1.08L9.05 1.08L9.44 2.8L10.66 3.3L12.15 2.36L13.64 3.85L12.7 5.34z"
      />
    </Svg>
  );
}

/** Light theme: shown on the switch while the studio is dark. */
export function SunIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.5v1.4M8 13.1v1.4M14.5 8h-1.4M2.9 8H1.5M12.6 3.4l-1 1M4.4 11.6l-1 1M12.6 12.6l-1-1M4.4 4.4l-1-1" />
    </Svg>
  );
}

/** Dark theme: shown on the switch while the studio is light. */
export function MoonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" />
    </Svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M13 2.5v2.8h-2.8" />
    </Svg>
  );
}

/** A jigsaw piece: the shape every setup block wears, wherever it appears. */
export function PuzzleIcon({ size = 16 }: IconProps) {
  return (
    <svg className="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z" />
    </svg>
  );
}

/** Where a case begins: a fresh start of the app or the end of another case. */
export function StartIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 3.5v9l7-4.5z" />
    </Svg>
  );
}

/** Six dots: something that can be dragged. */
export function GripIcon(props: IconProps) {
  return (
    <svg className="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width={props.size ?? 16} height={props.size ?? 16} fill="currentColor" aria-hidden="true">
      <circle cx="6" cy="4" r="1.2" />
      <circle cx="10" cy="4" r="1.2" />
      <circle cx="6" cy="8" r="1.2" />
      <circle cx="10" cy="8" r="1.2" />
      <circle cx="6" cy="12" r="1.2" />
      <circle cx="10" cy="12" r="1.2" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m3.5 8.5 3 3 6-7" />
    </Svg>
  );
}

export function CrossIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 4.5v4.5M8 11.6v.1" />
      <circle cx="8" cy="8" r="6.3" />
    </Svg>
  );
}

// The phone buttons under the screen, drawn like Android's navigation bar.

export function NavBackIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M11 3.5v9L4.5 8z" />
    </Svg>
  );
}

export function NavHomeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="4.5" />
    </Svg>
  );
}

export function NavRecentsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </Svg>
  );
}

export function VolumeDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5z" />
      <path d="M10.5 8h3.5" />
    </Svg>
  );
}

export function VolumeUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5z" />
      <path d="M10.5 8h3.5M12.25 6.25v3.5" />
    </Svg>
  );
}

export function PowerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2v5.5" />
      <path d="M4.8 4.4a5 5 0 1 0 6.4 0" />
    </Svg>
  );
}

export function RotateIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2" />
      <path d="M11.5 2.2v2.8H8.7" />
    </Svg>
  );
}

export function EnterIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 3.5v4.5a1.5 1.5 0 0 1-1.5 1.5H3.5" />
      <path d="m6 7-2.5 2.5L6 12" />
    </Svg>
  );
}

export function ZoomInIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3M5 7h4M7 5v4" />
    </Svg>
  );
}

export function ZoomOutIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3M5 7h4" />
    </Svg>
  );
}
