---
title: How a case becomes a Maestro flow
description: The order of a generated Maestro flow, and which Maestro command each kind of step becomes.
---

# How a case becomes a flow

The case JSON is the source of truth, and the Flow is generated from it on every save. Each item below emits exactly one Maestro command, so a step's position is its index in the Flow and in Maestro's run results.

## The order

1. `launchApp` and one `runFlow` per block under Before recording, or a single `runFlow` of the case it starts from. That other Flow launches the app itself.
2. The recorded steps.
3. The end checks, as `assertVisible`.

## Steps

| Step | Maestro command |
|---|---|
| Tap | `tapOn` |
| Long press | `longPressOn` |
| Double tap | `doubleTapOn` |
| Swipe | `swipe: { start: "80%, 50%", end: "20%, 50%", duration: 400 }` |
| Type | `inputText` |
| Back | `back` |
| Press Home | `pressKey: Home` |
| Press Volume down, up | `pressKey: Volume Down`, `pressKey: Volume Up` |
| Press Power | `pressKey: Power` |
| Press Enter | `pressKey: Enter` |
| Rotate to landscape, portrait | `setOrientation: LANDSCAPE_LEFT`, `setOrientation: PORTRAIT` |
| Check | `assertVisible` |
| Relaunch app | `launchApp` |
| Open link | `openLink` |
| Wait | `extendedWaitUntil`, see below |
| Hide keyboard | `hideKeyboard` |
| Run a setup block now | `runFlow` |
| Scroll | see below |

Maestro's `Lock` key did nothing on Android, so Power is written as `pressKey: Power`, which turns the screen off and on like the phone's button.

Selector values and typed text are always double quoted, so YAML does not turn `yes`, `123` or `${PASSWORD}` into something else.

## Wait

Maestro has no command for a pause, so a Wait is written as a wait for a label that is never on screen. It runs out without failing the flow:

```yaml
- extendedWaitUntil:
    visible: "ariadne-wait"
    timeout: 20000
    optional: true
    label: "Wait 20 seconds"
```

Maestro prints it as `WARNED`, because the label never came. That is how a Wait ends, and it counts as passed.

## Scrolls

A scroll followed by a tap, long press, double tap or check with an `id` or `text` selector, or at the end of the case by an end check, becomes:

```yaml
- scrollUntilVisible:
    element:
      text: "System"
    direction: DOWN
```

The direction is `UP` for Scroll up. Further scrolls in the same direction before it get the same element.

Any other scroll stays a plain `scroll` for down, or `swipe: { direction: DOWN }` for up, because Maestro's `scroll` only goes down. The case panel shows the first kind as, for example, `scroll down until "System" is visible`.

## Blocks and values

A block becomes a `runFlow` with its path from the flows folder. Every saved key in the project is passed through by name, and values set on the block in the studio replace the pass-through of the same name:

```yaml
- runFlow:
    file: ../blocks/login.yaml
    env:
      USERNAME: "${SUPERVISOR_USERNAME}"
      PASSWORD: "${SUPERVISOR_PASSWORD}"
```

A case that starts from another passes the same keys to that `runFlow`.

Text typed that equals a saved value is written as its placeholder: `inputText: "${PASSWORD}"`.

## The run copy

A run does not execute the file above directly. It writes `runs/<runId>/flow.yaml`:

- `takeScreenshot: { path: after-NNN, optional: true }` after each command except `launchApp`, which returns before the app has drawn
- `runFlow` paths rewritten to point back into the flows and block folders
- with [run video](/guides/run-video) on, `startRecording` first and `stopRecording` last

The file in the flows folder never changes for a run. A start being replayed before recording goes to `runs/_partial/<caseId>.yaml` in the same way, and is deleted afterwards.
