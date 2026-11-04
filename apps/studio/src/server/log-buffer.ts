// Keeps the end of the studio's log, for a diagnostics report. Touches are
// never logged, so nothing here can hold where a key was pressed.
import { format } from 'node:util';

/** About an hour of busy recording. */
const KEPT_LINES = 3000;

export type LogBuffer = { lines: () => string[]; stop: () => void };

/** Copies console output into a buffer while the studio runs; it still reaches the terminal. */
export function captureLog(limit = KEPT_LINES): LogBuffer {
  const kept: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      kept.push(`${new Date().toISOString()} ${level === 'log' ? '' : `${level.toUpperCase()} `}${format(...args)}`);
      if (kept.length > limit) kept.shift();
      original[level](...args);
    };
  }
  return {
    lines: () => [...kept],
    stop: () => Object.assign(console, original),
  };
}
