---
title: How clicks become Maestro selectors
description: How Ariadne turns a click into a Maestro id, text, index or point selector.
---

# How clicks become selectors

Selectors decide whether a case survives the next build, so Ariadne prefers the ones least likely to break. The facts below were measured on the Android 16 emulator with agent-device 0.21.35 and Maestro 2.12.

## What the device reports

- agent-device's `identifier` is the full Android resource-id (`android:id/title`, `com.android.settings:id/search_bar_title`). Maestro's `id` matches the full resource-id, so it is emitted as is. Verified by a run.
- agent-device has no `text` field. Visible text is in `label`, which falls back to the content description when a view has no text. `contentDescription` appears only when it differs from `label`. Maestro's `text` matches visible text and content description.
- Maestro treats `id` and `text` as whole-value, case-insensitive regular expressions, so `. * + ? ^ $ { } ( ) | [ ] \` are escaped. Verified by running a tap on `Ultra-Wideband (UWB)`, emitted as `text: "Ultra-Wideband \\(UWB\\)"`.
- Framework ids are shared: every Settings row title is `android:id/title`.

## The rules

A click resolves to the smallest visible element under the pointer that is tappable or named, system bars excluded. Its selector is the first of these that applies:

1. its resource-id, if no other element on screen has it: `id`
2. its name (`label`, else `contentDescription`, trimmed, under 80 characters), if unique: `text`
3. for a container such as a list row, the first element inside it with a unique id or name, skipping anything inside another tappable element: `id` or `text`
4. its resource-id with an `index`, if the id is shared
5. its name with an `index`, if the name is shared
6. otherwise the click position as percentages: `point: "x%,y%"`

A unique name beats a shared id with an index, because shared framework ids would turn every list tap into a positional selector that breaks as soon as a row is added.

Indexes follow Maestro's order: top to bottom, then left to right.

## Fragile steps

Steps shown as `point` in the case panel are the ones most likely to break on a run. They are drawn in the warning colour there.

## Checks and end checks

Check and the end-of-case picker use the same rules but never accept a `point`. The picker offers only unique `id` and `text` selectors that belong to the element itself.

## Long presses and double taps

A long press or a double tap resolves its element and selector exactly like a tap.

## Swipes

A swipe has no element. It keeps its two ends as whole percentages of the screen. See [Known limits](/reference/known-limits).
