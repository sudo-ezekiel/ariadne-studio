// Pure: shared by the recorder and the expectation picker, and free of Node
// imports so it can sit behind a browser-safe entry point.
import type { HitTestNode } from '../device/hit-test.ts';
import type { RecordedNode } from './case-types.ts';

/** The parts of a snapshot node worth keeping in the case file for later review. */
export function recordedNode(node: HitTestNode): RecordedNode {
  const recorded: RecordedNode = {};
  if (node.text) recorded.text = node.text;
  if (node.label) recorded.label = node.label;
  if (node.contentDescription) recorded.contentDescription = node.contentDescription;
  if (node.identifier) recorded.identifier = node.identifier;
  if (node.rect) recorded.rect = { ...node.rect };
  return recorded;
}
