import { useEffect, useRef } from 'react';

export type ScreenMenuChoice = 'tap' | 'doubleTap' | 'longPress' | 'check';

type Props = {
  /** Where the right click was, in client pixels. */
  at: { x: number; y: number };
  /** Offer "Check that it is visible" (only while recording). */
  canCheck: boolean;
  onChoose: (choice: ScreenMenuChoice) => void;
  onClose: () => void;
};

/** The right-click menu on the screen. Escape, or a click anywhere else, closes it. */
export function ScreenMenu({ at, canCheck, onChoose, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  // The listeners stay for as long as the menu is open, whatever the parent passes on each render.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
    };
    const onPointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    menu.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, []);

  const item = (choice: ScreenMenuChoice, label: string) => (
    <button type="button" role="menuitem" onClick={() => onChoose(choice)}>
      {label}
    </button>
  );
  return (
    <div
      ref={menu}
      className="screen-menu"
      role="menu"
      style={{ left: at.x, top: at.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {item('tap', 'Tap')}
      {item('doubleTap', 'Double tap')}
      {item('longPress', 'Long press')}
      {canCheck && item('check', 'Check that it is visible')}
    </div>
  );
}
