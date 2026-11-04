---
title: Edit recorded tests and chain cases
description: Start a case from the end of another, re-record from a step, add steps, split, duplicate, mute and rename.
---

# Edit and chain cases

When the app changes, fix the step that changed. Nothing here makes you record the case again from the top.

## Start from another case

Pick "the end of" a saved case under **Start from**, and the studio relaunches the app, replays that case through agent-device (its blocks, steps and end checks), and hands you the screen where it ends.

The new case's flow begins with `runFlow: { file: <that case>.yaml }` instead of `launchApp` and blocks, because the other flow already starts the app. Chains can be as long as you like. When the first case changes, every case that starts from it picks up the change on its next run.

A typical tree: "Log in" (block `login.yaml`, then the home screen check), "Open claims" starting from it, and "Submit claim" and "Cancel claim" both starting from "Open claims".

![The Cases tab, with Rename the event listed under the case it starts from](/shots/cases-list.png)

A case runs the flow of the case it starts from in full, end checks included, so a long chain replays every parent each time. Split long cases where a shared starting point makes sense.

A case that others start from cannot be deleted until they are deleted or split off.

## The Cases tab

The **Cases** tab is a tree: a case that starts from another is listed under it. Each row shows its last ten runs as dots, oldest on the left, and tags it `failing`, `flaky` or `muted`.

**Open** shows a case with its steps, the recorded and the replayed screen of each step, the result of the latest run or an earlier one, and the edits below.

## Edit a step

**Open** a case, then use the `⋯` menu on a step.

### Title and note

Replace the generated description (`Tap "Internet"`) with your own words, and add the expected result. Both go into the [test case documents](/guides/test-case-documents).

### Re-record from here

The studio replays the case up to the step before, through agent-device, and opens the recorder there with the earlier steps kept. Record the new ending and click **Finish recording**. The picker ticks the old end checks that are still on screen. This is the fix when the app changed after step N.

### Add steps

**Add steps after this one** (or **Add steps before step 1** on the first row) does the same replay, then the new steps go in the middle and the later steps and end checks are kept. **Save changes** skips the picker.

### Split after this step

Steps 1 to N become a new case, "`<name>`, start", which starts the way this one did. This case keeps the rest and now starts from the new one.

### Delete

**Delete step** removes a step, and on an end check, **Delete this check** removes the check. Later steps may not run any more, so run the case to check.

### Discard

**Discard** while re-recording or adding steps leaves the saved case exactly as it was.

Re-record and Add steps need a connected device on the case's own app. Otherwise the studio says which app to open first.

## Edit a case

The case header has:

- **Rename**.
- **Duplicate**, which saves a copy as "`<name>` (copy)".
- **Mute**: Run all skips muted cases. The button then reads **Unmute**.
- **Delete**.

Setup blocks in a case are edited as Maestro YAML files, in your editor.

## What an edit does to history

Changing a case's steps or end checks marks it as edited. Runs from before that are shown as stale and do not count for its status. Changing a title or a note, renaming and muting do not change what the flow does, so runs stay current.

Screenshot files are numbered by a counter that is never reused, so an edit never overwrites the screenshot of another step.

## How the replay gets there

Re-record from here and Add steps replay the start of the case through agent-device. Its Maestro replay does not run `setOrientation`, the Volume and Power keys, or a long press or double tap on a point, so the studio does those steps itself through the device session, in order, between the parts agent-device replays. The same goes for a case that starts from the end of one with such steps.

If a block in the replayed part needs Maestro, see [Blocks that run with Maestro](/guides/setup-blocks#blocks-that-run-with-maestro).

## Where the files go

While re-recording or adding steps, the studio briefly writes `runs/_partial/<caseId>.yaml`, the steps it replays to get there, and deletes it when the replay ends. It is never in the flows folder, so `maestro test` on that folder does not pick it up.
