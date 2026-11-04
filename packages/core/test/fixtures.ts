import type { SelectorNode } from '../src/maestro/selector.ts';

/**
 * Shaped like a real agent-device snapshot of the Android 16 Settings home
 * screen: no `text`, visible text in `label`, framework ids shared by rows.
 */
export function settingsHome(): SelectorNode[] {
  const nodes: SelectorNode[] = [
    { index: 0, depth: 0, rect: { x: 11, y: 39, width: 104, height: 43 }, label: '8:51', contentDescription: '8:51 PM', identifier: 'com.android.systemui:id/clock', systemBar: 'status' },
    { index: 1, depth: 0, rect: { x: 0, y: 0, width: 1080, height: 2400 } },
    { index: 2, depth: 1, parentIndex: 1, rect: { x: 42, y: 142, width: 996, height: 189 }, identifier: 'com.android.settings:id/search_action_bar', hittable: true },
    { index: 3, depth: 2, parentIndex: 2, rect: { x: 189, y: 201, width: 389, height: 71 }, label: 'Search Settings', identifier: 'com.android.settings:id/search_bar_title' },
    { index: 4, depth: 1, parentIndex: 1, rect: { x: 0, y: 373, width: 1080, height: 1964 }, identifier: 'com.android.settings:id/recycler_view', hittable: true },
  ];
  const rows = [
    { title: 'Network & internet', summary: 'Mobile, Wi‑Fi, hotspot', y: 621 },
    { title: 'Connected devices', summary: 'Bluetooth, pairing', y: 827 },
    { title: 'Storage (64 GB)', summary: 'Used 12 GB', y: 1033 },
  ];
  let index = 5;
  for (const row of rows) {
    const rowIndex = index++;
    nodes.push({ index: rowIndex, depth: 2, parentIndex: 4, rect: { x: 0, y: row.y, width: 1080, height: 206 }, hittable: true });
    nodes.push({ index: index++, depth: 3, parentIndex: rowIndex, rect: { x: 84, y: row.y + 50, width: 105, height: 105 }, identifier: 'android:id/icon' });
    nodes.push({ index: index++, depth: 3, parentIndex: rowIndex, rect: { x: 210, y: row.y + 42, width: 436, height: 71 }, label: row.title, identifier: 'android:id/title' });
    nodes.push({ index: index++, depth: 3, parentIndex: rowIndex, rect: { x: 210, y: row.y + 113, width: 351, height: 51 }, label: row.summary, identifier: 'android:id/summary' });
  }
  return nodes;
}

export function byLabel(nodes: SelectorNode[], label: string): SelectorNode {
  const node = nodes.find((candidate) => candidate.label === label);
  if (!node) throw new Error(`no node labelled ${label}`);
  return node;
}

export const viewport = { width: 1080, height: 2400 };
