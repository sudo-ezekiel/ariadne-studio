# Ariadne: brand and UI language

Decided 2026-11-02. This file is the source of truth for the product name, the logo, the
palette, the type, and the words the studio uses. `apps/studio/src/ui/styles.css` carries
the same colours as CSS custom properties; change them here first, then there.

## 1. Name

**Ariadne.** The local app is **Ariadne Studio**; in the top bar it is just "Ariadne".
Packages are `@ariadne/core` and `@ariadne/studio`. Environment variables start with
`ARIADNE_`. The repository folder keeps its old name.

Why this name. In the myth, Ariadne gives Theseus a thread so he can find his way back out
of the labyrinth. "Ariadne's thread" is an everyday idiom in most European languages
(Greek: ο μίτος της Αριάδνης, French: fil d'Ariane, German: Ariadnefaden, Italian: filo di
Arianna) for a guide through something complicated. That is what the product does: a
business analyst walks through the app once, Ariadne keeps the thread (every step, its
selector, its screenshot) and retraces it on every run. A case can pick up where another
case's thread ends.

Tagline, long: "Walk through your app once. Ariadne retraces your steps on every run."
Tagline, short: "The thread through your app."

Descriptor: "Ariadne, a recorder for Maestro" ("Ariadne Studio, a recorder for Maestro" for
the app). Use it wherever the name needs explaining: title tags, package descriptions, the
first line of a README. Section 8 has the rules.

Say "Ariadne", never "the Ariadne", never "ARIADNE". Pronounced a-ree-AD-nee.

## 2. Logo

The mark is a square labyrinth drawn as one thread. It starts at the ring in the corner,
the entrance, runs the corridors at an even spacing and ends in the knot at the centre.
Round caps, round joins, one stroke weight. Files in `assets/`:

| File | Use |
|---|---|
| `icon.svg` | Navy tile, ochre thread. App icon, favicon, avatars, anything on a coloured or dark surface. |
| `mark.svg` | Bare mark: navy thread, ochre dot. Inline on paper or white, next to text. |
| `wordmark.svg` | Lockup: tile plus the word "Ariadne" in the system sans at weight 650. |

Rules. Minimum size 16 px (the favicon uses a slightly thicker stroke for that). The ring is
always where the thread starts and the knot where it ends. Clear
space around the tile of at least half its width. The thread is ochre on navy or navy on
paper; never red or green, because those mean failed and passed in the studio. Do not
rotate, outline, add a gradient, or put the dot somewhere else.

## 3. Colours

Two brand hues on warm neutrals. Navy is the labyrinth and the primary action colour.
Ochre is the thread: the one thing that is highlighted, where you are, what a click will
hit. Semantic colours stay semantic.

| Token | Hex | Role |
|---|---|---|
| `--navy` | `#1c2b4a` | Primary buttons, wordmark, logo tile |
| `--navy-hover` | `#142038` | Primary button hover |
| `--thread` | `#e8b43a` | Logo thread, focus ring, hover outline and tap flash on the mirror, recording dot |
| `--thread-strong` | `#c48a0e` | Text and borders on `--thread-soft` |
| `--thread-soft` | `#fdf3d0` | Highlighted row or panel background |
| `--sea` | `#1f6f9f` | Links, replayed-screen thumbnail border |
| `--ink` | `#1a2233` | Text |
| `--ink-2` | `#5b6474` | Secondary text, labels, captions |
| `--ink-3` | `#8a93a3` | Placeholders, disabled text, tertiary meta |
| `--line` | `#dcdfe6` | Borders of controls and cards |
| `--line-2` | `#ebedf2` | Hairlines, row dividers |
| `--paper` | `#f4f3ee` | App background (warm stone) |
| `--panel` | `#ffffff` | Cards and panels |
| `--panel-2` | `#f7f7f9` | Insets: YAML blocks, summaries, chips, hovered rows |
| `--stage` | `#0f1627` | Backdrop behind the mirrored phone screen |
| `--pass` / `--pass-soft` | `#1e7d3c` / `#e6f4ea` | Passed, check mode, saved |
| `--fail` / `--fail-soft` | `#b3261e` / `#fdecea` | Failed, errors, destructive actions |
| `--warn` / `--warn-soft` | `#9a5b00` / `#fdebd3` | Flaky, "looks different", fragile point selectors |
| `--info` / `--info-soft` | `#1f6f9f` / `#e8f2f9` | Informational toasts |
| `--block` / `--block-soft` / `--block-line` | `#5b4b9a` / `#f1eefa` / `#d9d2f0` | Setup blocks: the jigsaw pieces, block rows in a case, the `block` chip |

Four helper tokens carry the roles that change between themes: `--navy-text` (navy used for
text, borders and the active tab; `#1c2b4a` in light), `--on-navy`, `--on-block` and
`--on-stage` (text on a primary button, a block chip and the stage).

**Dark theme.** The studio has a light and a dark theme (the moon or sun in the top bar,
or Settings > Appearance: System, Light or Dark; System follows the computer). Dark keeps
the roles and the ochre thread, puts the panels on deep navy-grey, keeps the stage as the
darkest surface, and lifts navy and the semantic colours so they read on dark panels:

| Token | Dark | Token | Dark |
|---|---|---|---|
| `--paper` | `#12161f` | `--navy` / `--navy-hover` | `#3d5a96` / `#4a69a8` |
| `--panel` | `#1a202b` | `--navy-text` | `#9db6e8` |
| `--panel-2` | `#232a37` | `--thread` / `--thread-strong` / `--thread-soft` | `#e8b43a` / `#f0c45a` / `#3a3014` |
| `--stage` | `#080b12` | `--sea`, `--info` / `--info-soft` | `#6cb4e0` / `#16293a` |
| `--ink` / `--ink-2` / `--ink-3` | `#e6e9ef` / `#a9b1bf` / `#7a8394` | `--pass` / `--pass-soft` | `#5cc27a` / `#15301f` |
| `--line` / `--line-2` | `#343d4f` / `#2a3141` | `--fail` / `--fail-soft` | `#f2766b` / `#3a1a18` |
| `--on-block` | `#15121f` | `--warn` / `--warn-soft` | `#f0a640` / `#3a2a12` |
| | | `--block` / `--block-soft` / `--block-line` | `#a796e6` / `#252040` / `#3e3566` |

Meaning of colour in the studio, in one line each. Green: it passed, or you are recording a
check. Red: it failed, or this deletes something. Amber: look at this before trusting it.
Ochre: this is the thread, where you are and what you are about to tap. Navy: the main
thing to do on this screen. Violet: a setup block, never a recorded
step. Everything else is neutral.

## 4. Type and spacing

The system sans (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`), no web
fonts, because the studio runs offline. Base 14 px, line height 1.45. Headings 18 / 15 /
13 px at weight 600; section titles in the side panel ("Before recording", "Setup blocks")
are 15 px, sentence case, in `--ink`; headings inside dialogs are 13 px, sentence case. No
uppercase labels with letter-spacing anywhere in the studio, dialogs included: the owner
reads them as template. Results and states are words, never pills: "Passed", "Failed",
"Not run", "flaky", "failing", "muted" in the colour that already means something, with no
background.
Meta and captions 12 px. Selectors, ids and YAML in the system mono
(`ui-monospace, "SF Mono", Menlo, Consolas, monospace`) at 12 px.

Spacing on a 4 px scale: 4, 8, 12, 16, 24. Radius 6 px on controls, 10 px on cards, 14 px
on the logo tile. Inside a step list the radius is 0 for everything except the round marks
on the thread (rows, block squares, the Wait tile, insertion marks). Nothing in a list gets
a tinted background, a coloured side stripe or a shadow. One primary button per region, never two side by side.

## 5. Voice

Plain and specific. Sentence case everywhere, including buttons and headings. Buttons are
verbs ("Connect", "Start recording", "Run"). No exclamation marks, no jargon from the
engine (never `assertVisible`, `runFlow`, "viewport", "AUT" in the UI). Error messages say
what happened and what to do next ("Open a device session on this app first"). Numbers
are written as the thing they count ("4 cases", "0 of the last 2 runs failed").

## 6. Vocabulary

These are the words the studio, the exports and the README use. The left column is what
the code and the Maestro files still call things; the right column is what a person sees.

| Concept | Word in the UI | Not this |
|---|---|---|
| The product | Ariadne; Ariadne Studio for the app | E2E Studio, e2e-tool |
| One recorded scenario | case; "test case" in documents | test, flow, script |
| Attaching the studio to a phone or emulator | Connect / Disconnect; "Connected to emulator-5560 · com.example.app"; "No device connected" | Open / Close session |
| The mirrored phone screen | the screen; "the mirror" only in developer docs | viewport, canvas |
| Beginning a case | New case, Start recording | Start case |
| One recorded action | step | command, action, event |
| Ending a case | Finish recording, then Save case; Save changes when adding steps in the middle | Finish case |
| Doing the steps on the phone itself | Use the phone; Stop using the phone | physical mode, hands-on, device capture |
| A step recording could not be sure of | a note on the step; "Looks right" to clear it | warning, error, low confidence |
| Getting a Xiaomi phone ready for Run | Prepare this phone | fix, patch, unlock |
| Recording that something is visible | check; Check mode (the toggle is "Check"); end checks | Expect, expectation, assert |
| Making a run pause at a point in a case | Wait; rows read "Wait 20 seconds"; the tile under the steps is "Wait" | Sleep, delay, pause step |
| Giving the screen time to show something | Wait until; rows read "Wait up to 20 seconds for "Welcome" to appear"; it fails on its own row if the thing never shows | waitFor, extendedWaitUntil, poll, retry |
| Taking a step out of a recording | Remove step (Undo in the message after); Delete step on a saved case | undo step, drop, discard step |
| Running a saved case with Maestro | Run; Run all; "Last run passed"; "Not run yet"; a step's result is "Passed", "Failed" or "Not run" | Replay, PASSED, NOT-RUN |
| The document of one Run all for whoever accepts a release | Evidence pack; its title is "Test results report" | acceptance certificate, audit trail |
| A case's requirement, user story or scenario code | reference; "Add a reference" | requirement id, ticket, tag |
| A Maestro file that brings the app to a state | setup block (the Record tab lists them under "Setup blocks" and stacks the chosen ones under "Before recording"; the Blocks tab writes them); "block" in developer docs | precondition, fixture, subflow |
| Choosing a step's target by clicking the screen | Pick on the screen | inspect, select element, locate |
| Turning recorded steps into a block | Record steps, then Add to block; Save as block for a saved case | capture, import, convert |
| Help with the emulator, the USB phone and the tools | Device setup; the dialog is "Set up a device" | config, settings, preferences |
| A set of saved values a log in block runs with | test user ("Test user: Supervisor", "Add a test user...", "as Supervisor" in step rows) | profile, persona, credentials |
| A block's `${KEY}` variables | settings; "Values" for blocks that are not about logging in | parameters, variables, env |
| A value kept in `.env` or `project.json` | saved value | env var, secret |
| Running a block in the middle of a recording | Run a setup block now; the button is "Run now" | insert block, inject |
| The two halves of the side panel | the Record tab (Recording while a case is recorded) and the Cases tab | builder, library |
| A case that begins where another ends | "starts from"; "the end of 'Log in'" | dependency, parent |
| Re-doing the end of a case on the device | Re-record from here | re-capture |
| A case Run all skips | muted | disabled, skipped |
| Failed then passed on retry | flaky | unstable |
| Replayed screen unlike the recorded one | "looks different (83%)" | diff, mismatch |
| The exports | test case document (Excel, HTML, Markdown); shareable report | artifact, dump |
| Gestures on the screen | tap, long press, double tap, swipe ("Swipe left", "Swipe down from the top edge") | longPressOn, gesture, fling, drag event |
| The row of buttons under the screen | the phone buttons: Back, Home, Recent apps, Volume down, Volume up, Power, Rotate, Enter, Zoom in, Zoom out; steps read "Press Home", "Press Volume up", "Rotate to landscape" | hardware keys, keycodes, pressKey, setOrientation |
| A video of a run, the steps beside the phone | run video; "Keep a video of each run"; "Video" | recording, screen recording, clip, capture |
| The project's folders in a column of the studio | Files; "Show files", "Hide files"; "read only" on an opened file | Explorer, workspace, file browser |
| A control that cannot be recorded because Maestro has no command for it | "Off while recording: Maestro cannot replay this"; "live-only" in developer docs | unsupported, disabled |

Kind labels on step rows are plain lowercase words in a fixed column, never chips: `tap`,
`long press`, `double tap`, `swipe`, `type`, `scroll`, `back`, `key`, `rotate`, `keyboard`,
`relaunch`, `link`, `check`, `wait`, `wait until`, `end`, `block`, `start`. Only meaning
colours them: green for `check` and `end`, violet for `block`, `--ink-3` for the waits.

## 7. UI principles

1. The screen is the stage. The phone sits on a dark backdrop so the app's own colours
   read true, and every control that acts on the phone sits directly under it.
2. The list is the thread. Steps during recording, steps in a saved case, the Before
   recording stack and the block form are the same row on one hairline that runs from a
   ring at the start to a knot at the end checks: the mark on the thread, the kind word,
   what it did in words, the selector in small mono, the screenshot. The mark says the kind:
   a numbered ring for an action, a green ring for a check, a violet square for a block, no
   ring and a dotted thread for a wait, a filled green dot for an end check. The result
   column is the only addition after a run: a tick and Passed in green, a cross and Failed
   in red, Not run in grey, so a result never rests on colour alone.
   docs/steps-redesign.md has the details.
3. Highlight by meaning. Ochre for the thread, green for checks and
   passes, red for failures, amber for doubts. Nothing else is coloured.
4. State is always visible. The status pill in the top bar says connected, busy or idle
   (the top bar holds only the name, that pill, the theme switch and the Settings gear;
   which device and app the studio is on sits in Device, above the Record and Cases tabs);
   a recording shows the word Recording beside a pulsing ochre dot in the bar above the
   screen, and nothing beside the case title; a running suite says which case it is on.
5. Empty states tell you the next click ("Connect a device to see its screen here").
6. Destructive actions are outlined red, never filled, and always confirm, with one
   exception: removing a step from a recording in progress offers Undo instead, because it
   happens after every mis-tap and nothing is lost until Finish.
7. Recording is never hidden. The bar above the screen always holds the record button
   (Start recording, then Finish recording), and a recording frames the screen in ochre.
   The bar itself stays plain: the frame carries the colour.
8. Blocks are marked, not boxed. A setup block wears a violet square with the puzzle glyph
   wherever it appears (the library, the Before recording stack, a case being recorded,
   a saved case), never a card, so a block is never mistaken for a recorded step. A wait
   is the opposite: no mark at all, the thread only pauses. Blocks and the Wait tile drag
   and drop, and every drag has a click path beside it (Add, the arrows, remove, the row
   menu).

## 8. Saying Maestro

Ariadne writes and runs Maestro flows, so Maestro belongs in every descriptor: the title
tag, the H1, the README's first sentence, the npm description and keywords, the GitHub
description. It never belongs in the product name, so nothing reads as an official edition.

Patterns to use: "Ariadne, a recorder for Maestro", "record Maestro flows by using your
app", "writes plain Maestro YAML", "runs with maestro test", "works with Maestro".
Patterns to avoid: "Ariadne Maestro", "Maestro Ariadne", "the Maestro recorder", and any
use of mobile.dev's logo. Every page and README that mentions Maestro carries the line:
"Maestro is a trademark of mobile.dev. Ariadne is an independent tool and is not
affiliated with mobile.dev."
