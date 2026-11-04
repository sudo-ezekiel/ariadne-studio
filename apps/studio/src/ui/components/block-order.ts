// Where a dragged setup block lands in the "Before recording" stack. Kept out
// of Blocks.tsx so it has no JSX and tests can import it with its types.

/** What a drag carries: the block, and its place in the stack when it is being moved there. */
export type DragData = { file: string; from: number | null };

/**
 * Puts a new piece for `file` at `at`, or moves the piece at `from` there.
 * `at` counts positions before the move. `make` builds the new piece; the
 * stack keeps each block's values beside its file.
 */
export function placeBlock<T = string>(lane: readonly T[], data: DragData, at: number, make: (file: string) => T = (file) => file as T): T[] {
  const next = [...lane];
  if (data.from === null) {
    next.splice(at, 0, make(data.file));
    return next;
  }
  const [moved] = next.splice(data.from, 1);
  if (moved === undefined) return next;
  next.splice(at > data.from ? at - 1 : at, 0, moved);
  return next;
}
