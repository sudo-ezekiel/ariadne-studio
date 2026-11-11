// The "..." menu at the end of a step row. It closes when one of its items is
// pressed, when the pointer goes down anywhere else, and on Escape.
import { useEffect, useRef, type ReactNode } from 'react';

export function RowMenu({ label = 'Step actions', children }: { label?: string; children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const element = menu.current;
      if (element?.open && !element.contains(event.target as Node)) element.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  const shut = () => {
    if (menu.current) menu.current.open = false;
  };
  return (
    <details
      ref={menu}
      className="row-menu"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('.row-menu-items button')) shut();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && menu.current?.open) {
          event.stopPropagation();
          shut();
          menu.current.querySelector('summary')?.focus();
        }
      }}
    >
      <summary aria-label={label}>⋯</summary>
      <div className="row-menu-items">{children}</div>
    </details>
  );
}
