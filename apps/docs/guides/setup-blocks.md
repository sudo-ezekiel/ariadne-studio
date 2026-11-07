---
title: "Setup blocks: reuse Maestro flows such as a log in"
description: Reusable Maestro flows that bring the app to a known state before a recording, such as logging in or skipping onboarding.
---

# Setup blocks

Write the boring start of a case once, so nobody records a log in by hand again.

A setup block is an ordinary Maestro flow file that brings the app to a known state. Write one in the **Blocks** tab without seeing any YAML, or write the file by hand, then stack it under **Before recording**. Blocks live in `blocks/`, or in the folders `paths.blocks` names in [`project.json`](/reference/project-json).

The repository ships one as an example: `workspace/blocks/open-settings.yaml`, which opens "Network & internet" in Android Settings and is used by the smoke test.

## Write a block in the studio

Open the **Blocks** tab, press **New block** and name it. Then record its steps, or add them one by one: the buttons add the usual steps, and **More steps** has the rest. Use the arrows to reorder a step and the cross to remove it.

- **Pick on the screen.** A step that acts on an element has a **Pick on the screen** button. Press it, then click the element on the screen, and the studio chooses the selector the same way it does while recording. Clicks on the screen work as usual until then, so walk to the screen you need first. You can also type the text the element shows.
- **Start with Start the app** when the block needs a known first screen, and tick **Clear the app's data first** when it needs a clean app.
- **End with a Check** on the screen the block should reach, so a block that goes wrong stops there and says so.

### Record the steps

The quickest way to a block is to do it once. Press **Record steps** and use the app on the screen, as you do for a case. **Finish recording** offers the same end checks, and **Add to block** puts the steps in the form, where you can change them and turn details into [settings](#settings). No case is created, and nothing is saved until you press **Save block**.

- Recording starts from the screen shown now, because a block can also run in the middle of a case. Press **Relaunch app** first for a block that starts the app; it becomes a **Start the app** step.
- Recorded steps go after the ones already in the form, so you can record part of a block and add the rest later.
- A password typed into a password field is not kept. Its step becomes a setting such as `PASSWORD`, and you save the value under **Settings**.
- The screenshots of the recording are dropped, because a block keeps none.

### Save a case as a block

A case that already does the job can become a block. Open it in the **Cases** tab and press **Save as block**. Its steps open in the form as a new block, with its end checks as **Check** steps, and the case stays as it is.

A case it starts from is written out in full, so the block stands alone. Blocks it runs stay as steps that run them.

### Save and try

**Save block** writes `blocks/log-in.yaml`, named after the block. It is listed under **Setup blocks** in the Record tab straight away, and it is the same kind of file a developer would write.

**Try on the device** runs the saved block from the screen shown now, and records nothing. A block that fails leaves the screen where it stopped, and the message names the step. A block that begins with **Start the app** restarts the app first.

### Settings

A setting is a detail each case chooses for itself, such as which test user logs in or which policy to open. In a **Type** step, or wherever a step finds an element, choose **A setting** and name it, such as `EMAIL`.

Settings are listed under the steps. Give one a saved value and cases use it by default; the value goes in `.env` on this computer, never in the block. Each case can then choose another value on the block's **Test user** or **Values** row. See [Test users](/guides/test-users).

Keep passwords out of the steps: use a setting named `PASSWORD`. If you pick a password field and type into it, the studio will not save until that text is a setting. Typed text that equals a saved value is saved as a reference to it.

### Edit or delete a block

Every block the studio can read fully has an **Edit** button, including ones written by hand. A step the form has no fields for is kept as it is.

- A change reaches every case that uses the block on its next run, and the form lists those cases.
- Saving rewrites the file from its steps, so comments in a hand-written file go. The form says so when a file has any.
- The file name stays when you rename a block, because cases refer to it by file.
- **Delete block** refuses while a case or another block uses it.

A block that uses commands outside the [subset Ariadne reads](#blocks-that-run-with-maestro) has **Show file** instead, and stays a job for a text editor.

## Write a block by hand

A log in block looks like this:

```yaml
appId: com.example.app
name: Log in
---
- launchApp:
    clearState: true
- tapOn:
    id: "com\\.example\\.app:id/email"
- inputText: "${USERNAME}"
- tapOn:
    id: "com\\.example\\.app:id/password"
- inputText: "${PASSWORD}"
- tapOn:
    text: "Sign in"
- assertVisible:
    text: "Welcome"
```

- **Start with `launchApp: { clearState: true }`** when the block needs a clean app. A case's own flow always starts with a plain `launchApp`. Clearing state is the block's decision, so recording (the studio replays the block through agent-device) and a run (Maestro runs it through `runFlow`) see the same state.
- **Escape selectors.** Maestro reads `id` and `text` as regular expressions, so escape `. * + ? ^ $ { } ( ) | [ ] \` in values: `com\\.example\\.app:id/email` in double-quoted YAML.
- **End with an assertion** on the screen the block should reach, so a failing block stops there with a clear message instead of letting the recording start on the wrong screen.
- **Put the values in `.env`,** never in the block. See [Saved values](#saved-values).

## Saved values

Put the values a block uses in the project's `.env`, one `KEY=VALUE` per line. `#` comments and quotes are fine:

```
USERNAME=ba@example.com
PASSWORD=...
```

The studio passes these values when it runs a block before recording, and Run passes every key as `-e KEY=VALUE` to Maestro. A case that uses blocks emits one `runFlow` per block, with the path relative from the flows folder to the block, wherever both are:

```yaml
- runFlow:
    file: ../blocks/login.yaml
    env:
      USERNAME: "${USERNAME}"
      PASSWORD: "${PASSWORD}"
```

So the values reach the block on a run and in CI (`maestro test -e KEY=VALUE ...`).

Values that are not secret can also go in `project.json` as `env`. `.env` wins on conflicts.

To run a block as someone else, or with other values, see [Test users](/guides/test-users).

## Use a block

In the **Record** tab, blocks are listed under **Setup blocks** as violet jigsaw pieces, each with what it does step by step and the `.env` values it uses.

![A Log in block under Before recording, with the blocks a developer prepared listed below](/shots/blocks-before-recording.png)

A block does not have to be a login. Here a Skip first run block takes AnkiDroid past its first-run screen, so the recording starts at the deck list:

![Recording on AnkiDroid with a Skip first run block listed before the first step](/shots/block-real-app.png)

**Before recording** is a stack. It starts with **Start from**, either "a fresh start of the app", the default, or "the end of" a saved case, which replays that case first (see [Edit and chain cases](/guides/edit-and-chain#start-from-another-case)). Below it go any setup blocks:

- Drag a block into the stack, or press **Add**.
- Drag or use the arrows to reorder them. They run top to bottom.
- A case that starts from another case cannot add blocks, because that case runs its own first.

Click **Start recording**. The app is restarted so the recording begins where a run's `launchApp` will begin, then the blocks run in order, and the screen is handed over on the screen the last block ends on.

If a block fails, no case starts. The error says which block and step, and the screen shows where it stopped. The stack stays as it was for the next case.

## Blocks in the middle of a recording

While recording, **Run a setup block now**, under the steps, lists the blocks with a **Run now** button, and a block can be dragged onto the end of the step list.

The block runs on the device straight away and is recorded as one step, a `runFlow` at that point in the flow, for things such as dismissing a popup or logging in as another test user. Each block there has the same **Test user** row as in Before recording.

A block that clears the app's data is flagged there, since it undoes the steps before it.

When a block begins with `launchApp`, the studio restarts the app first. Maestro's `launchApp` stops and starts a running app, while agent-device's only brings it to the front, and the restart keeps the recording on the screen a run will see.

![A block run in the middle of a recording, listed as a violet step after two taps](/shots/block-mid-recording.png)

## Blocks that run with Maestro

The studio replays a block itself, through agent-device, when every command in it, and in any flow it runs with `runFlow`, is in the subset Ariadne reads:

- `launchApp` (with `clearState`), `runFlow`, `tapOn`, `inputText`, `eraseText`, `back`, `hideKeyboard`, `assertVisible`, `assertNotVisible`, `openLink`, `takeScreenshot`, `scroll`
- `swipe` with a `direction`
- `scrollUntilVisible` with an `id` or `text` element (`direction`, `timeout`, `speed`, `visibilityPercentage` and `centerElement` are kept)
- a header with only `appId`, `name` and `env`

The gesture commands count too, with three exceptions agent-device's replay would skip, which make the block a Maestro block: `setOrientation`, `pressKey` other than Home, Back and Enter, and `longPressOn` or `doubleTapOn` at a `point`.

A **Wait** step runs with Maestro too, so a block with one takes longer to start.

Any other block that is a Maestro flow is still listed and usable, tagged **Runs with Maestro, slower start**. Its step list shows what Ariadne can describe and names the rest, for example `runScript (runs in Maestro)`.

When such a block is under Before recording, run in the middle of a recording, part of what a re-record or insert replays, or used anywhere in the chain of a case you start from, the studio runs that whole start with the Maestro CLI instead:

1. It closes its device session.
2. It runs `maestro test` on the same `launchApp` plus `runFlow` steps the case's flow will have, written to `runs/_partial/<caseId>.yaml`, with the `.env` values as `-e`.
3. It reopens the session without restarting the app, so you record from where Maestro left it.

Maestro takes several seconds to start, typically 10 to 20 seconds on an emulator, so this is slower than agent-device. If it fails, the message names the block and quotes Maestro, and Maestro's output stays in `runs/_partial/<caseId>-maestro/` with the `.env` values replaced by `${KEY}`.

The studio decides this from the file, because agent-device 0.21.35 reports success for some commands it does not really run: it "replayed" a `runScript` block.

## Blocks that cannot be used

Only files that are not a Maestro flow at all are greyed out, with the reason as a tooltip: invalid YAML, no header and `---`, or no `appId`.

## Where the files go

Every `*.yaml` and `*.yml` file directly in a block folder is a block, named by its path from the project folder. To use the subflows you already have, see [Use with an existing Maestro project](/guides/existing-maestro-project).

## Privacy

`.env` is gitignored, and its values never appear in flows, case files, logs or the studio's API responses. Maestro writes them in clear into its own debug files (`maestro.log` and the JSON beside it). After every run the studio replaces them there with `${KEY}`. See [Known limits](/reference/known-limits) for what that does not cover.
