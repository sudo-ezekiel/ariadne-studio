// The mark a row wears on the thread (see step-marks.ts for which one).
import { PuzzleIcon } from './Icons.tsx';
import type { Mark } from './step-marks.ts';

/**
 * The first cell of a row in a step list: the thread runs through it, and the
 * mark sits on the thread. A block with no number carries the puzzle glyph.
 */
export function MarkCell({ mark, number }: { mark: Mark; number?: number | string }) {
  const content = mark === 'start' || mark === 'end' ? null : number !== undefined ? number : mark === 'block' ? <PuzzleIcon size={10} /> : null;
  return (
    <span className="step-mark">
      <span className={`mark mark-${mark}`}>{content}</span>
    </span>
  );
}
