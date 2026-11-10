# Steps redesign: the list is the thread

Designed 2026-11-09 for the owner's request: "a better design for the blocks/steps, no common AI
UI/UX (the border on the side with the little radius), can we remove steps, can we wait somewhere
instead of expecting something, can we drag and drop a wait that does not look like a subflow."

The one idea. Ariadne's thread is the product (docs/brand.md section 1 and 2: the logo is one
thread that starts at a ring and ends at a knot). The step list becomes that thread: a hairline
running down the index column, with a different marker on it for each kind of step. Nothing in the
list is a card any more. No side stripes, no tinted backgrounds, no chips, no dashed boxes at rest.
What tells a tap from a check from a wait from a block is the marker on the thread, the colour of
one word, and the height of the row.

## 1. Decisions

1. Every card in the step world goes: `.piece`, `.piece-block`, `.piece-start`, `.step-block`,
   `.draft-step`, `.drop-slot`. Rows are plain, separated by hairlines, with radius 0. Reason: the
   coloured side stripe on a rounded tinted card is the pattern the owner reads as generated.
2. The thread replaces the cards as the structure: a 1 px `--line` vertical through the index
   column from the start marker to the last row. Reason: it is the brand's own image, and it gives
   the list a spine without boxes.
3. Markers by kind: start is a hollow navy ring, a recorded action is a numbered ring, a check is a
   numbered green ring, an end check is a filled green dot (the knot), a block is a numbered violet
   square, a wait has no ring and the thread turns dotted for its row. Reason: shape says kind at a
   glance; round means "a point on the thread", square means "a box of other steps", dotted means
   "the thread pauses here".
4. Kind labels become plain lowercase words in a fixed column, no background. Colour on the word
   only where colour already means something: green for check, violet for block, `--ink-3` for
   timing. Reason: chips everywhere is on the owner's list of tells; a ledger column reads cleaner.
5. The jigsaw stays as a glyph only (the `PuzzleIcon` in the block's kind label and marker), never
   as a card shape with a nub. Reason: the icon is the recognisable bit; the nub-on-a-card is the
   generic bit.
6. Wait is a first-class thing in the step list: a draggable "Wait" tile in a tray under the steps
   that drops between any two steps, plus "Add a wait after this step" in every row menu, plus the
   existing Wait button in the toolbar. Reason: today the Wait exists only as a toolbar button under
   the phone, which is why the owner asked for it.
7. Wait until is in scope, as a second timing step recorded from the screen like Check: click an
   element, the step waits up to 20 seconds for it, then carries on either way. Reason: a fixed wait
   is a guess (the POCO note in api-types.ts says 8 s failed and 16 s worked); waiting for the thing
   you are about to tap is what the owner means by "wait instead of expect".
8. Wait until never fails on its own (Maestro `optional: true`). Reason: the owner asked to wait
   instead of expecting; a wait that fails is a Check, and Check already exists.
9. A step can be removed while recording from its row menu or with the Delete key, with no confirm
   dialog and an 8-second Undo. Reason: mis-taps are frequent and the removal is reversible, so undo
   is the confirm. Saved cases keep their confirm dialog, because that deletion is permanent.
10. Kept steps (the dim ones during Re-record and Add steps) cannot be removed in the live list.
    Reason: they were replayed to reach this screen, and the saved case already has Delete step.
11. Waits can be added and changed directly on a saved case, without a recording. Reason: a wait
    touches nothing on the phone, so "Insert steps after N" (which replays the case) is the wrong
    size of tool for it.
12. Blocks still drop only at the end of a live recording. Reason: a block runs on the device the
    moment it is added, so there is only one place it can truthfully go.

## 2. The row language

### 2.1 Anatomy

One `<ol class="steps">` per list. While recording it holds, in order: the start row, the setup
block rows, the recorded steps, the tray. In a saved case it holds `caseFlowItems` as today (start,
blocks, steps, end checks). The Before recording stack in the Composer is its own `<ol>` with the
same markers.

Columns (live list): `28px 64px minmax(0, 1fr) auto 28px`, column gap 10 px. Marker, kind, detail,
screenshot, row menu. Saved case: `28px 64px minmax(0, 1fr) 92px auto 28px` (the result column
stays, brand principle 2). Block editor: `28px minmax(0, 1fr) auto` (marker, name and fields,
tools).

Row: `padding: 8px 8px; margin: 0 -8px; border: 0; border-radius: 0; background: none;` with
`border-top: 1px solid var(--line-2)` on every row after the first. Hover: `background:
var(--panel-2)` over the bled width, still radius 0. Wait rows: `padding: 5px 8px`, so a pause is a
visibly thinner row (about 30 px against about 80 px for a row with a screenshot).

The thread: `.step::before { content: ''; position: absolute; left: 21px; top: 0; bottom: 0;
border-left: 1px solid var(--line); }` (21 px = 8 px bleed + half of the 28 px column, minus half a
pixel). First row starts at `top: 50%`, last row ends at `bottom: 50%`. Markers have a `--panel`
background so the thread passes behind them.

### 2.2 Markers

| Kind | Marker | CSS |
|---|---|---|
| start (fresh start, or "the end of X") | hollow ring, no number | 22 px, `border: 1.5px solid var(--navy-text)`, `border-radius: 50%`, `background: var(--panel)` |
| recorded action (tap, type, scroll, back, key, swipe, link, relaunch, keyboard) | numbered ring | 22 px, `border: 1.5px solid var(--line)`, number 11 px 600 `--ink-2`, `background: var(--panel)` |
| check (mid-case) | numbered green ring | as above with `border-color: var(--pass); color: var(--pass)` |
| end check | filled green dot, numbered | `background: var(--pass); border-color: var(--pass); color: #fff` (dark: `--on-navy` stays white on the lifted green) |
| block (setup block before step 1, or run mid-case) | numbered violet square | 18 px square, `border-radius: 0`, `background: var(--block)`, number 11 px 600 `--on-block`; in the Composer stack (no numbers) the square carries the `PuzzleIcon` at 12 px |
| wait, wait until | number without a ring; the thread goes dotted for this row | number 11 px 400 `--ink-3` on a `--panel` backing; `.step-wait::before { border-left: 2px dotted var(--ink-3); left: 20.5px }` |
| kept step (during an edit) | as its kind, row at `opacity: .55` | unchanged |

Radius policy, stated once: 50 % for rings and dots, 0 for everything else inside a list (rows,
squares, tiles, insertion marks, nested lists). Controls keep 6 px and panels keep 10 px as brand
section 4 says. Nothing in the list gets a background tint, a shadow or a gradient.

### 2.3 Kind column

Plain text, 11 px, weight 600, lowercase, `color: var(--ink-2)`, no padding, no background. The
labels from brand section 6 stay (`tap`, `long press`, `check`, `block`, `end`, `start`...) with
two additions: `wait` and `wait until`. Colour by meaning only: `.step-check .step-kind { color:
var(--pass) }`, `.step-block .step-kind { color: var(--block) }` with the 12 px `PuzzleIcon` before
the word, `.step-wait .step-kind { color: var(--ink-3) }`. No icon on wait rows: the dotted thread
already says timing, and "wait until" needs the width.

### 2.4 Detail column

13 px `--ink` for what the step did, the selector on its own line in 11 px mono `--ink-3`
(unchanged). Wait rows: "Wait 20 seconds" in `--ink-2` followed by a `Change` link button. Wait
until rows: "Wait up to 20 seconds for "Dentist" to appear", then the selector line, then
`Change`. Block rows: the description, the values in `--ink-2` ("as Supervisor"), and the "What it
does" disclosure in 12 px `--ink-2`. When open, the block's steps are listed under the detail as
`4.1`, `4.2`... in 12 px `--ink-2`, indented to the detail column, with no guide line and no
background. Numbering under the parent is what says "these run inside step 4".

Wait rows show no screenshot, even when one was taken (a pause has no "screen after"). Exports are
untouched.

### 2.5 Insertion mark (where a drop will land)

One mark, used in every list: a 2 px `--thread` rule from the thread to the right edge of the row,
with a 7 px `--thread` dot centred on the thread. `.drop-before::after { content: ''; position:
absolute; left: 21px; right: 8px; top: -1px; height: 2px; background: var(--thread); }` and the dot
via a second pseudo-element or a `box-shadow`. The ochre is the existing meaning: where you are,
what the drop will hit. It replaces today's `box-shadow: 0 -5px 0 -1px var(--thread)`.

At rest, nothing dashed is drawn anywhere. Drop targets appear only while something is being
dragged.

### 2.6 Dark theme

Every value above is a token, and all of them already have dark values in `styles.css`. The violet
square uses `--block` on `--on-block` text (dark: `#a796e6` with `#15121f`). Rings use `--line`
on `--panel`. The thread uses `--line`. Nothing new to add to the token blocks.

## 3. Mockups

Legend: `o` hollow ring, `(n)` numbered ring, `(n)` on a check row is green, `[n]` violet square,
a bare number with `:` on the thread is a wait, `|` the thread, `...` the row menu (shows on hover
and focus), `[shot]` the screenshot.

### 3.1 Recording, with a tap, a wait, a block and a check

```
Submit the form   * Recording
submit-the-form-20261109-1102 / com.wdiodemoapp on emulator-5560

 o   start    Starts with a fresh start of com.wdiodemoapp
 |
[#]  block    Log in  as Supervisor                              What it does
 |
(1)  tap      Tap "Forms"                                              [shot]  ...
 |            text: Forms
 |
 2   wait     Wait 20 seconds  Change                                          ...
 :
(3)  tap      Tap "Active"                                             [shot]  ...
 |            text: Active
 |
[4]  block    Run the block "Dismiss the popup"                  What it does  ...
 |              4.1  Tap "OK"                                          [shot]
 |
(5)  check    Check that "Active" is visible                           [shot]  ...
 |            text: Active
 :
 :   [::] Wait   Drag it between two steps, or press Add to put it at the end.   [Add]
     > Run a setup block now

[Finish recording]  [Discard]
```

Row 2 is the pause: thinner, no ring, no screenshot, the thread dotted through it. Row 4 is the
block: a square, the violet word, and its own steps numbered under it when opened. Row 5 is a
check: the same ring as a tap, in green.

### 3.2 A Wait being dragged from the tray, over the gap between steps 1 and 2

```
(1)  tap      Tap "Forms"                                              [shot]
 |            text: Forms
 *━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
(2)  tap      Tap "Active"                                             [shot]
 |            text: Active
 |
[3]  block    Run the block "Dismiss the popup"                  What it does
 :
 :   [::] Wait   (the tile at half opacity while it is in the air)        [Add]
     > Run a setup block now
```

The ochre rule with its dot on the thread is the only thing that changes while the pointer moves.
The block end slot does not light up for a Wait, because a Wait can go anywhere. Dragging a block
does the opposite: the gaps stay quiet and only the end lights, with the caption "Run it now, as the
next step" at the right end of the rule.

### 3.3 Composer: Before recording and Setup blocks

```
Before recording
 o   Start from   [ a fresh start of com.wdiodemoapp                        v ]
 |
[#]  Log in                                                  10 steps   ^  v  x
 |     Test user   [ Supervisor                                             v ]
 :
 :   Drag another block here, or press Add.

Setup blocks
Steps to reuse, such as logging in. Drag one into "Before recording", or press Add.
Write your own in the Blocks tab.

 [::] [#] Dismiss the popup                                     1 step    [Add]
          blocks/dismiss-popup.yaml  ·  What it does
 ────────────────────────────────────────────────────────────────────────────
 [::] [#] Log in                                              10 steps    [Add]
          blocks/login.yaml  ·  Uses PASSWORD, USERNAME from .env  ·  What it does
```

The palette is a list of rows separated by hairlines: grip, violet square with the puzzle glyph,
name at weight 600, meta in `--ink-2`, the outlined Add. No border around a row, no fill. The stack
is a short thread that ends in a quiet grey line saying what to drag there; during a drag that line
becomes the ochre insertion rule with the caption "Run it first".

### 3.4 Saved case rows (result column present)

```
(3)  tap      Tap "Active"                           passed   [rec][replay]  ...
 |            text: Active                           1.2 s
 |
 4   wait     Wait 20 seconds  Change                passed                  ...
 :                                                   20.0 s
 |
(5)  end      "Active" is visible                    passed   [replay]       ...
```

The last row's marker is the filled green dot: the knot at the end of the thread.

### 3.5 Block editor rows (Blocks tab)

```
(2)  Tap                                                              ^  v  x
 |   [ Text on screen  v ] [ Sign in                      ]  [Pick on the screen]
 |
 3   Wait                                                             ^  v  x
 :   [ 20 ] seconds
 |
(4)  Wait until                                                       ^  v  x
 :   [ Text on screen  v ] [ Welcome                      ]  [Pick on the screen]
 :   up to [ 20 ] seconds
 |
(5)  Check                                                            ^  v  x
 |   [ Text on screen  v ] [ Welcome                      ]  [Pick on the screen]
```

Inside the editor every row belongs to the block, so no violet. Check rows get the green ring, wait
rows the dotted thread, and the fields sit under the name in the detail column. The move and remove
tools stay as they are, at the row's right end.

## 4. Blocks without cards

Palette (Setup blocks): `<ul class="palette">` of rows, `grid-template-columns: 20px 22px
minmax(0, 1fr) auto auto`, hairline between rows, hover `--panel-2`, `cursor: grab` when usable.
The grip stays (`GripIcon`, `--ink-3`). The violet square with the puzzle glyph is the only violet
in the row; "10 steps" moves to `--ink-2`; the Add button is the ordinary outlined button. The
second line (file, variables, "What it does") stays as 12 px `--ink-2` under the name. A broken
block keeps its red line of text and loses the grip.

Before recording stack: a thread with the start ring, then one row per block with the square, the
name, the step count, the move and remove tools, and the block's settings (test user) on an
indented second line in the detail column. The dashed `.block-settings` top border goes; the indent
and the 12 px label are enough. The stack's end is a `--ink-3` text line at rest and the insertion
rule during a drag.

SetupSummary (top of a live recording): the same rows as the stack, read only, inside the same
`<ol>` as the steps so the thread is continuous from the start ring to the tray.

Block as a step: section 2.2. Blocks before step 1 and blocks run mid-case look the same (they do
today too).

Jigsaw: the `PuzzleIcon` stays wherever a block is named. The `::before` nub, the violet fill, the
violet left border and the `14px 8px 8px 8px` start radius are removed. Brand principle 8 is
reworded in the build list.

## 5. Wait, Wait until, Check

One sentence each; these are also the button tooltips.

- Check: records that something is on the screen now; the run fails if it is missing.
- Wait until: gives the screen up to 20 seconds to show something, then carries on either way.
- Wait: pauses the run for a fixed number of seconds, whatever the screen shows.

Maestro. Wait stays `extendedWaitUntil: { visible: "ariadne-wait", timeout, optional: true,
label }` (unchanged). Wait until writes `extendedWaitUntil: { visible: { text: "Welcome" },
timeout: 20000, optional: true }`. The parser reads the `ariadne-wait` form as a wait, an
`optional: true` form with an id or text selector as a wait until, and still refuses any other
`extendedWaitUntil` (a hand-written strict wait stays Maestro's to run, as today).

Defaults: both start at `DEFAULT_WAIT_SECONDS` (20) and are capped at `MAX_WAIT_SECONDS` (120).

Where each is recorded: Check and Wait until from the screen (toolbar toggle, then click an
element; nothing is tapped). Wait from the tray, the row menu, or the toolbar button. Wait until is
not draggable: it needs an element, and the element is on the phone, so it is recorded where the
BA is looking. In a saved case, a Wait until is added with "Add steps after this one" like any step
that needs the screen.

Toolbar: the three sit together after the separator, in this order: Check, Wait until, Wait. Scroll
down and Scroll up move to the second row. If the first row no longer fits 600 px with the 140 px
text field, the whole group moves to the second row instead; the order is what matters.

## 6. Interactions

### 6.1 Remove a step while recording

Where: every recorded row in the live list gets the same `...` row menu the saved case has (the
`<details class="row-menu">`), shown on hover and on focus-within. Items: "Remove step" (danger
colour), "Add a wait after this step", and on wait rows "Change the seconds". Rows are focusable
(`tabindex="0"`); with a row focused, Delete or Backspace removes it, Enter opens the menu.

What happens: `DELETE /api/case/steps/:index`. The row leaves the list, later steps renumber, the
phone is not touched. An info toast appears for 8 seconds: "Step 3 removed." with an Undo button
that calls `POST /api/case/steps/restore`, which puts the most recently removed step back at its
old position. Toasts gain an optional action for this.

Telling the truth about the phone: when the removed step acted on the device (anything except
wait, wait until and check), the toast reads "Step 3 removed. The phone is still where that step
left it." and a line appears above the Finish button, in the `.editing-note` style, that stays
until Finish or Discard: "1 step that acted on the phone was removed. The phone did not go back,
so run the case after saving to check that the later steps still work." (plural with `count`).
Nothing blocks the BA; the note is the warning and Run is the proof. Removing a wait or a check
shows the short toast only.

Kept steps: during Re-record or Add steps, rows below `keptSteps` show the menu with one hint and
no buttons: "A saved step. Finish or discard this recording, then delete it from the case." The
server refuses with 409 `KEPT_STEP` as well.

Why no confirm: brand principle 6 says destructive actions always confirm. Removing a step from a
recording in progress is reversible with Undo and happens after every mis-tap, so the undo is the
confirm. The saved case keeps its dialog because its delete also removes the screenshot for good.

### 6.2 Add a Wait at a position while recording

The tray: the last item of the steps `<ol>`, after the thread goes dotted and ends. One line:
grip, the `WaitIcon` (a clock in the stroke style of `Icons.tsx`), the word "Wait", the hint, and an
outlined Add at the right. The tile (`grip + icon + word`) is the draggable: `display: inline-flex;
gap: 6px; padding: 4px 8px; border: 1px solid var(--line); background: var(--panel); border-radius:
0; cursor: grab`. Under it, the folded "Run a setup block now" palette stays where it is.

Drag: `dataTransfer` type `application/x-ariadne-wait`. While it is in the air every row in the
live list (except kept rows) accepts it; the row under the pointer shows the insertion mark above
or below its midline, and the space after the last row accepts too. Dropping calls `POST
/api/case/wait` with `{ seconds: 20, after }`. Pressing Escape or dropping outside cancels, as the
browser does already.

After the drop: the new wait row appears at once with 20 seconds, and its inline seconds field is
open and focused: `Wait [ 20 ] seconds  [Save] [Cancel]`. Typing a number and Enter (or Save)
calls `PATCH /api/case/steps/:index { seconds }`; Escape or Cancel keeps 20. Doing nothing keeps
20. The BA never has a half-made row.

Click and keyboard paths to the same result: "Add a wait after this step" in any row menu (inserts
after that step and opens the field), Add on the tray (appends, opens the field), the toolbar Wait
button (appends with its own seconds form, unchanged), and "Add a wait before step 1" on the start
row's menu.

The block end slot: drawn only while a block is dragged (the insertion rule after the last row
with the caption "Run it now, as the next step"). At rest there is no dashed box; the folded
palette's hint already says to drag a block onto the end.

### 6.3 Wait until while recording

Toolbar toggle "Wait until", `aria-pressed` like Check. The mirror caption reads "Wait until mode:
click what the run should wait for" plus the hovered element's caption, the same shape as the Check
caption. The screen frame keeps its ochre recording frame; no new colour. A click calls `POST
/api/case/wait-for { x, y }`, which resolves the element the way `/api/case/expect` does (400
`NO_ELEMENT` with the same message if there is nothing named there) and records a `waitFor` step
with 20 seconds and a copy of the current screenshot as its evidence. The row appears with the
inline seconds field open, like an inserted wait. The mode switches off after one click, as Check
does, or the same way Check does if Check stays on.

### 6.4 Saved case (CaseDetail)

Row menu additions: "Add a wait after this step" on every step row, "Add a wait before step 1" on
the launch or start-from row, and "Change the seconds" on wait and wait until rows. Both write the
case directly: `POST /api/cases/:caseId/steps { after, kind: 'wait', seconds }` and
`PATCH /api/cases/:caseId/steps/:index { seconds }`. Both set `editedAt`, so earlier runs show as
stale, exactly like Delete step does. The inline seconds field is the same component as in the live
list. Delete step keeps its confirm; for a wait row the message is just "Delete this wait?", because
nothing after it depends on it.

No drag in the saved case. The menu covers it, and the saved list carries result and screenshot
columns that a drag would have to dodge.

### 6.5 Block editor rows

`StepRow` in `BlockEditor.tsx` becomes a thread row (section 3.5): marker, the step's name at
weight 600 in the detail column, its fields under the name, the move and remove tools in the last
column. `STEP_CHOICES` gains "Wait until" right after "Wait" (a `waitUntilVisible` with an empty
text selector and 20000 ms), with `TargetField` plus "up to [ 20 ] seconds". The `QUICK_STEPS`
count stays 5, so Wait until lives in the "More steps" list. `endsOnCheck` counts a wait until the
way it counts a wait.

## 7. Copy

Every new or changed string. Sentence case, no engine words, no exclamation marks.

| Where | String |
|---|---|
| Live row menu | Remove step |
| Live row menu | Add a wait after this step |
| Start row menu (live and saved) | Add a wait before step 1 |
| Wait row menu (live and saved) | Change the seconds |
| Kept row menu hint | A saved step. Finish or discard this recording, then delete it from the case. |
| Toast after removing a wait or check | Step 3 removed. |
| Toast after removing a device step | Step 3 removed. The phone is still where that step left it. |
| Toast action | Undo |
| Note above Finish, one step | 1 step that acted on the phone was removed. The phone did not go back, so run the case after saving to check that the later steps still work. |
| Note above Finish, more | 2 steps that acted on the phone were removed. The phone did not go back, so run the case after saving to check that the later steps still work. |
| Tray tile | Wait |
| Tray hint | Drag it between two steps, or press Add to put it at the end. A run pauses there; nothing happens on the phone now. |
| Tray button | Add |
| Tray tile title | Drag a pause into the steps |
| Inline seconds field | Wait [ 20 ] seconds, buttons Save and Cancel; `aria-label` "Seconds to wait" |
| Wait until inline field | Wait up to [ 20 ] seconds for "Welcome" to appear, Save and Cancel |
| Wait until row (describe.ts) | Wait up to 20 seconds for "Welcome" to appear |
| Wait until kind label | wait until |
| Toolbar button | Wait until |
| Toolbar title, Check | Record that this is on the screen. The run fails if it is missing. |
| Toolbar title, Wait until | Click something the run should wait for. It gets up to 20 seconds to appear, then the run carries on either way. |
| Toolbar title, Wait | Pause the run for a fixed number of seconds, whatever the screen shows. Nothing happens on the phone now. |
| Mirror caption in Wait until mode | Wait until mode: click what the run should wait for |
| Block end slot caption while dragging | Run it now, as the next step |
| Stack end at rest, empty | Drag a setup block here to run it first, such as a log in, or press Add on one below. |
| Stack end at rest, with blocks | Drag another block here, or press Add. |
| Stack end while dragging | Run it first |
| Run a setup block now hint | Runs on the device as the next step, for example to dismiss a popup or to log in as another test user. Drag a block onto the end of the steps, or press Run now. |
| Saved case delete confirm, wait row | Delete this wait? |
| Block editor choice | Wait until |
| Block editor field | up to [ 20 ] seconds |
| Server 409 `KEPT_STEP` | This step is part of the saved case. Finish or discard the recording, then delete it from the case. |
| Server 400 `NOT_A_WAIT` | Only a wait has seconds to change. |
| Server 404 `NOTHING_REMOVED` | Nothing to put back. |
| Server 400 `BAD_POSITION` | That position is not in the case. |
| brand.md vocabulary row | Giving the screen time to show something: Wait until; rows read "Wait up to 20 seconds for "Welcome" to appear". Not: waitFor, extendedWaitUntil, poll, retry |

Unchanged and reused: "Wait 20 seconds" (`waitName`), "Nothing with a name or id here. Click on a
text or a control." (`NO_ELEMENT`), "Step actions" (menu `aria-label`), "What it does".

## 8. API and core changes

Recording (all go through `enqueue` and `requireRecording`; none touches the device):

- `DELETE /api/case/steps/:index` returns `CurrentCaseView`. 409 `KEPT_STEP` for a kept step.
- `POST /api/case/steps/restore` returns `CurrentCaseView`. 404 `NOTHING_REMOVED`.
- `POST /api/case/wait` body gains optional `after` (0 to step count; at least `keptSteps` during
  an edit). With `after`: no screenshot, inserted. Without: today's behaviour.
- `PATCH /api/case/steps/:index { seconds }` returns `CurrentCaseView`. 400 `NOT_A_WAIT`.
- `POST /api/case/wait-for { x, y, seconds? }` returns `ActionResponse` (step, screen, resolved),
  built on the `/api/case/expect` route.

Saved cases (`cases.ts`, `refuseIfRecording`, `saveEdited(state, case, true)`):

- `POST /api/cases/:caseId/steps { after, kind: 'wait', seconds }` returns `CaseDetailResponse`.
- `PATCH /api/cases/:caseId/steps/:index` accepts `seconds` for wait and wait until rows.

`Recorder` (packages/core/src/recorder/recorder.ts): `removeStep(index)` keeps the step and its
old index on a `removed` stack and renumbers; `restoreRemoved()` puts the last one back at
`min(oldIndex, length + 1)`; `insertWait(seconds, after)`; `setSeconds(index, seconds)`;
`recordWaitFor(node, point, viewport, seconds, screenshot, nodes)` modelled on `recordExpect`;
`removedScreenshots()` so Finish can delete screenshots nothing references (Discard removes the
whole evidence folder already). After any removal or insertion, `mergesIntoLast` returns false
until a new step is pushed, so typed text never merges into a step the BA did not just record.

Core model for Wait until: `CaseStep` gains `{ kind: 'waitFor'; selector; point; node?; seconds }`;
`MaestroStep` gains `{ kind: 'waitUntilVisible'; selector; timeoutMs }`; `emit.ts`, `parse.ts`
(section 5), `describe.ts` (`describeStep`, `describeMaestroStep`, `stepExpected` returns empty),
`recorder.ts` `stepToMaestro`, `flow-layout.ts` `scrollTargets` (a wait until with an id or text is
a scroll target like a check), `device-replay.ts` (`agentDeviceReplays` false, `DirectAction {
kind: 'waitFor'; selector; seconds }`), `apps/studio/src/server/common.ts` (the direct action polls
`freshLatest` every 500 ms until a node's text or id equals the unescaped selector value, or the
time runs out, then continues either way). Grep `case 'wait'` and `'expect'` across
`packages/core/src`, `apps/studio/src/server` and `apps/studio/src/shared` for every switch that
needs the new kind; `shared/block-check.ts` and `ui/components/format.ts` are two of them.

UI: `api.ts` (`removeStep`, `restoreStep`, `insertWait`, `setWaitSeconds`, `waitFor`,
`addCaseWait`, `patchStep` with seconds), `App.tsx` (handlers, the `waitUntilMode` flag beside
`expectMode`, the removed-device-steps count for the note), `Toasts.tsx` (optional action),
`CaseDetail.tsx` `kindLabel` (`waitFor: 'wait until'`).

## 9. Build list

Three stages, each shippable on its own. Stage A changes no API.

Stage A, the look:

1. `apps/studio/src/ui/styles.css`: replace the `.piece*`, `.stack*`, `.drop-slot*`, `.step*`,
   `.step-block`, `.step-kind*`, `.step-index`, `.draft-step*` and `.block-settings` rules with the
   thread rules from section 2 (`.steps`, `.step`, `.step::before`, the marker classes
   `.step-start`, `.step-check`, `.step-end`, `.step-block`, `.step-wait`, `.drop-before::after`,
   `.tray`, `.tray-tile`, `.palette` rows). Keep both themes on tokens only.
2. `apps/studio/src/ui/components/Icons.tsx`: add `WaitIcon` (clock: circle, two hands) in the
   `Svg` stroke style.
3. `apps/studio/src/ui/components/Blocks.tsx`: palette rows, stack rows, `SetupSummary` rows as
   thread rows; drop targets drawn only while dragging; the captions from section 7.
   `BlockDropSlot` becomes the end insertion rule and keeps its props.
4. `apps/studio/src/ui/components/CasePanel.tsx` (`Recording`): one `<ol class="steps">` holding
   the start row, block rows, steps and tray; marker class by kind; `BlockSteps` renders nested
   numbers `n.1`, `n.2`.
5. `apps/studio/src/ui/components/CaseDetail.tsx`: marker class by `FlowItem` kind (`launch` and
   `startFrom` are start, `expectation` is end); kind column as plain text; nested numbering.
6. `apps/studio/src/ui/components/BlockEditor.tsx`: `StepRow` as a thread row; `.draft-step` goes.
7. Check on emulator-5560 in both themes; retake `apps/docs/public/shots/blocks-before-recording.png`,
   `block-mid-recording.png`, `recording.png`, `end-checks.png`; update `docs/brand.md` section 6
   ("lowercase labels in a fixed column, no chips") and principle 8 ("Blocks are marked, not boxed:
   a violet square with the puzzle glyph wherever a block appears, never a card") and principle 2
   (the thread).

Stage B, remove and Wait at a position:

8. `packages/core/src/recorder/recorder.ts`: `removeStep`, `restoreRemoved`, `insertWait`,
   `setSeconds`, `removedScreenshots`, the merge guard. Tests in `packages/core/test/recorder.test.ts`:
   removal renumbers and keeps later indexes dense; restore returns the step to its place, or to the
   end if the list is now shorter; removing a kept step throws; insert at 0, middle and end; set
   seconds on a tap throws; typing after a removal starts a new step.
9. `apps/studio/src/server/routes.ts`: the four recording routes from section 8; Finish deletes
   removed screenshots. `apps/studio/src/server/cases.ts`: the saved-case insert and the `seconds`
   patch. Tests in `apps/studio/test/edit-and-run.test.ts` (or a new `steps-routes.test.ts`): each
   route's happy path and each error code; the saved-case routes set `editedAt` and the flow file
   gains the `extendedWaitUntil`; a removed step's screenshot is gone after Finish and present after
   Undo.
10. `apps/studio/src/ui/api.ts`, `App.tsx`, `Toasts.tsx`, `CasePanel.tsx`, `CaseDetail.tsx`: the
    row menu, the Delete key, the undo toast, the note above Finish, the tray drag with
    `application/x-ariadne-wait`, the inline seconds field (one component, used in both lists), the
    saved-case menu items. Check on the emulator: drop between two steps, drop after the last, undo,
    Delete key, Escape mid-drag.

Stage C, Wait until:

11. Core: `case-types.ts`, `maestro/model.ts`, `emit.ts`, `parse.ts`, `describe.ts`,
    `recorder.ts`, `flow-layout.ts`, `device-replay.ts`. Tests: `emit.test.ts` and
    `block-parse.test.ts` round-trip `waitUntilVisible` and still read the `ariadne-wait` form as a
    wait and still refuse a strict `extendedWaitUntil`; `describe.test.ts` for the sentence;
    `recorder.test.ts` for `recordWaitFor`; a `device-replay` test that `waitUntilVisible` is a
    direct segment; `scrollTargets` picks a wait until as a target.
12. Server: `POST /api/case/wait-for` in `routes.ts`; the polling direct action in `common.ts`.
    Test: `NO_ELEMENT` on empty space, a step with the clicked element's selector and 20 seconds,
    and a replay segment that returns early when the element is present.
13. UI: `Mirror.tsx` toggle and caption, the toolbar regrouping; `App.tsx` mode flag;
    `block-steps.ts` choice and `BlockEditor.tsx` fields (`apps/studio/test/block-steps.test.ts`:
    the choice builds a `waitUntilVisible` and `stepLabel` returns "Wait until"); `kindLabel`,
    `format.ts` `stepSelector`, `block-check.ts`.
14. Docs: `apps/docs/guides/recording.md` (remove a step, Wait, Wait until, the three sentences),
    `apps/docs/guides/setup-blocks.md` (the new look), `apps/docs/reference/case-to-flow.md`
    (`waitFor` to `extendedWaitUntil`), `docs/brand.md` vocabulary row, `docs/spec.md` a short
    "Milestone 10: steps as a thread" section recording these decisions.

Run `pnpm typecheck` and `pnpm test` after each stage.

## 10. For the owner to decide

1. Wait until never fails (decision 8). The other reading is "fail if it never appears within N
   seconds", which gives a better error message in the evidence pack and makes it a Check with
   patience. Say which; the YAML differs by one `optional` key.
2. The toolbar Wait button: keep it beside Check and Wait until (as designed) or drop it now that
   the tray is under the steps. Two paths to the same thing is normal in this codebase; one fewer
   button is also fine.
3. Removing a just-recorded step uses Undo instead of a confirm dialog, a stated exception to brand
   principle 6. Say if you want the dialog instead.
4. The uppercase section labels in the Composer ("BEFORE RECORDING", "SETUP BLOCKS") come from
   brand section 4 and match your list of tells from the landing page. If you want them gone, the
   change is one rule (13 px, weight 600, sentence case) and one line in brand.md; it is not in this
   build list.
