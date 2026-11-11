---
title: Generate Maestro YAML from your clicks
description: "Generate Maestro YAML from your clicks: gestures, phone buttons, Check mode, typing and secrets, and end checks in the Ariadne recorder."
---

# Recording

Use the whole phone from the mirrored screen. Everything you do while recording becomes a step that Maestro can replay, and Ariadne generates the Maestro YAML from those clicks.

Start a case from the **Record** tab: name it, build **Before recording**, and click **Start recording**, either under the stack or in the bar above the screen. Without a name it asks for one first. The app is restarted, so the recording begins where a run's `launchApp` will begin. See [Setup blocks](/guides/setup-blocks) for what can run first.

While recording, the Record tab reads **Recording**, the Cases tab is closed, the bar above the screen shows the case name and the step count, and the screen has an ochre frame.

![Recording in progress, with a long press, Back, a tap and a check listed as steps, and the phone buttons under the screen](/shots/recording.png)

## Gestures on the screen

The screen takes the gestures a finger would make, and each one is a step. Hovering outlines the element a click would hit.

- **Click**: a tap. It is sent to the device, resolved to an element in the accessibility snapshot, and listed with its selector and a thumbnail.
- **Press and hold** for 600 ms or more without moving: a long press on the element under the pointer, chosen exactly like a tap's. It is held on the device for 3 seconds, as long as Maestro holds it on a run.
- **Drag** 8 px or more: a swipe from where the drag started to where it ended, drawn as an ochre line while you drag. The step keeps both ends as whole percentages of the screen and how long the drag took, from 100 ms to 2 s. The step list says "Swipe left", "Swipe up" and so on when the drag runs mostly along one axis. A drag that starts at the top edge pulls down the notification shade, as on a phone.
- **Right-click**: a small menu with **Tap**, **Double tap**, **Long press** and, while recording, **Check that it is visible**. Escape or a click elsewhere closes it.

The mouse wheel does nothing over the screen, so scrolling the page never records a step.

## Use the phone itself

While you record, you can also do the steps on the phone itself, with your own fingers. There is nothing to switch on: touch the phone and the bar above the screen says **Following the phone**. Steps appear in the Record tab as you go, and the screen here catches up after each one. Click the screen here, or use any control under it, and the studio carries on from there. Text you typed on the phone becomes its step first, so the steps stay in the order you did them.

Tap, press and hold, swipe, the on-screen keyboard, and Back and Home all record. Everything else about the case stays the same: the steps, the screenshots and the Maestro flow are the ones you would get from the screen here. **Check** is done on the screen here, as always.

Ariadne reads the phone's touchscreen only while a recording is on, and reads what a field says, never which keys you pressed. To record from the screen here only, turn off **Record what I do on the phone itself** in Settings (the gear). The choice is kept on this computer, not in the project.

Touches show where your finger went, not what you meant, so some steps come with a note saying why they need a look:

| The note says | What happened | What to do |
|---|---|---|
| The screen was still changing | You touched before the screen had settled, so the step may name what was there a moment earlier | Check the step names the right element |
| No named element here | The touch fell between controls, or on something with no name or a very long one, so the step presses a position | Expect it to miss on another phone; a developer can add an id to the app |
| You typed in a password field | Ariadne did not read it | Save the password as a saved value with the name the step shows |
| You changed text already in the field | The step erases and retypes from the end of the field | Run the case to check the text comes out right |
| You left the app | You went to the home screen and came back, which a run will not do | Run the case to check it still works |

Mistakes are recorded too, because a touch looks the same either way. Remove the extra steps as you go, see [Remove a step](#remove-a-step), or delete them in the **Cases** tab after you save. A note goes away when you press **Looks right** there.

Recording pauses by itself when you leave for the home screen or pull down the notifications, and carries on when the app is back. Touches on other apps in between are not recorded. Recent apps and two-finger gestures are not recorded either, because Maestro cannot replay them.

Ariadne reads touches through `adb`, so a key press on the keyboard looks to it like any other touch. It uses them only to tell a key from a tap, keeps no positions, and reads text from the field afterwards. See [Privacy](#privacy).

## When the app hands over to another app or a website

Many journeys leave the app: a login on a website such as gov.gr, an identity check, a payment page. That is fine. The screen here follows the phone by itself, with a new picture every few seconds, so you see the other app or website open. Carry on clicking: what you do there is part of the case. The app id is only where a case starts, not a limit.

If a screen blocks screenshots, as banks and ID apps often do, its picture stays black. Its text and buttons are drawn over it instead, and you click them as usual. The step's screenshot is black.

A step that needs the camera, such as a selfie or a photo of a document, cannot be replayed. Ask the vendor for a test mode that skips it. Keep real passwords out of a case: see [Typing and secrets](#typing-and-secrets).

## Phone buttons

Under the screen, the phone's own buttons sit in a row shaped like Android's navigation bar.

| Button | Step |
|---|---|
| Back | Press Back |
| Home | Press Home |
| Vol down, Vol up | Press Volume down, Press Volume up |
| Power | Press Power: the screen goes off, or on again |
| Rotate | Rotate to landscape, Rotate to portrait |
| Enter | Press Enter, the keyboard's Enter key |
| Recents | None: live-only |
| Zoom in, Zoom out | None: live-only |

After a rotation the screen takes its new shape. Rotation fails with an error on a screen that only runs in portrait, such as the launcher.

## Live-only controls

**Recents**, **Zoom in** and **Zoom out** act on the device while you are connected and not recording. While recording they are off, with "Off while recording: Maestro cannot replay this". Maestro 2.12 has no key for the Recent apps button and no pinch command, so a step for them could never run.

## Other steps

The controls under the screen add these steps:

- **Scroll down** and **Scroll up** scroll the main list by about 60% of the screen height. How a scroll is written depends on what follows it, see [How a case becomes a flow](/reference/case-to-flow).
- **Relaunch app** closes the app and starts it again.
- **Hide keyboard** closes the on-screen keyboard.
- **Open link** opens a web link or an app deep link. The link must look like `scheme://...`. The device opens it with whatever app handles it.

## Check, Wait until and Wait

Three steps record something about time and the screen, and none of them touches the phone:

- **Check** records that something is on the screen now. The run fails if it is missing.
- **Wait until** gives the screen up to 20 seconds to show something. The run goes on as soon as it shows, and fails on this step if it never does.
- **Wait** pauses the run for a fixed number of seconds, whatever the screen shows. It never fails.

All three sit at the end of the steps in the Record tab. Press **Check** or **Wait until**, then click something on the screen; they record what is there now, so they go at the end. **Wait** can also go between two steps, see [Put a Wait between two steps](#put-a-wait-between-two-steps). Right-clicking the screen offers **Check** too.

Use **Wait until** where a page takes a moment to load, for example a website the app has just opened: click the button you are about to tap, and the run waits for it instead of guessing a number of seconds. If it never comes, the run stops on the Wait until, which says what it waited for, instead of on the tap after it. Use **Check** for what the case is meant to prove.

Toggle **Check**, and a click records a check for that element. The outline turns green and dashed. Toggle it off to go back to tapping.

Toggle **Wait until**, and the next click records a wait for that element; the mode then turns itself off. The new row opens its seconds so you can change the 20. A run that finds the element goes on at once.

Elements with neither a name nor an id are refused: "Nothing with a name or id here. Click on a text or a control." In Check and Wait until modes, holds and drags do nothing.

**Wait** is a fixed pause of 1 to 120 seconds. Drag the **Wait** tile from the end of the steps to any place between two steps, or press **Add** beside it, see below. See also [Known limits](/reference/known-limits#a-tap-on-a-page-that-is-still-loading).

## The steps while you record

The steps are listed on one thread, from the start of the app at the top to the last step. The mark on the thread says what each row is:

- a numbered ring is a step that acted on the phone; a green ring is a check
- a violet square is a setup block, which runs steps of its own; **What it does** lists them, numbered under the block (4.1, 4.2)
- a row with no ring, where the thread turns dotted, is a wait: the run only pauses there

![A recording with a 3 second wait after step 2, a Wait until for "Check-up" and a check, and the Wait tile at the end of the thread](/shots/recording-wait.png)

### Put a Wait between two steps

At the end of the thread sits a **Wait** tile. Drag it between any two steps: an ochre line shows where it will land. The new wait starts at 20 seconds with its seconds open; type another number and press Enter, or leave it. **Add** beside the tile puts a wait after the last step, and **Add a wait after this step** in a step's menu puts one right there.

A wait can go anywhere because it does nothing on the phone. A setup block runs on the phone the moment you add it, so it only goes at the end: drag it from **Run a setup block now** onto the end of the steps.

### Remove a step

Open the **...** menu at the end of a step and press **Remove step**, or click the row and press Delete. The message that follows has **Undo** for a few seconds.

Removing a step does not move the phone back. If the step acted on the phone, for example a tap that opened a page, the phone stays where that step left it, and a note above **Finish recording** says so until you finish. Run the case after saving to check that the later steps still work. Removing a wait or a check changes nothing on the phone.

Steps kept from a saved case while you **Re-record from here** or **Add steps after this one** cannot be removed here; delete them in the case afterwards.

## Typing and secrets

Click a field on the screen, and a text box appears right over it with the cursor in it. Type, then press Enter (or Tab) to send the text to the phone as one type step. Escape clears the box and leaves the field. Clicking somewhere else on the screen with text still in the box sends the text first, then makes the click, so the steps stay in that order. Over a password field the box shows dots, not the text.

Some fields do not tell Ariadne they have focus, for example inside a web page or a custom drawn control, so no box appears. For those, click the field, then use the **Text to type** box under the screen and press **Type**.

Consecutive plain typing merges into one step. A placeholder is always a step of its own.

Typed text that equals the value of a saved value exactly is recorded as that value's placeholder. Typing your test password records `inputText: "${PASSWORD}"`, while the device receives the real text.

In a password field, anything that is not a saved value is refused, with a message that says where the `.env` file is. Other text is recorded as typed, so do not type a secret into an ordinary field unless it matches a saved value.

## End checks

Click **Finish recording**. A picker lists up to 12 stable texts and ids on the final screen, top of the screen first. It leaves out system bars, input fields, numbers, dates, times, amounts and percentages, because those change between runs.

Tick up to three that must be visible at the end and click **Save case**. Saving with none ticked is fine. A note says the case was saved, with **Open case** and the flow YAML folded underneath.

**Discard** drops the case and its screenshots. While [re-recording or adding steps](/guides/edit-and-chain), Discard leaves the saved case exactly as it was.

![The end checks picker after Finish recording, listing stable texts and ids on the final screen](/shots/end-checks.png)

## Blocks in the middle of a recording

**Run a setup block now**, under the steps, runs a block on the device at this point, for things such as dismissing a popup. See [Setup blocks](/guides/setup-blocks#blocks-in-the-middle-of-a-recording).

## Where the files go

A saved case writes `cases/<caseId>.json`, `flows/<caseId>.yaml` and a screenshot per step in `evidence/<caseId>/`. See [Your project files](/guides/project-files).

## Privacy

Passwords stay out of case files and flows when they come from `.env`. Screenshots are real pictures of the device, and Ariadne does not blur anything in them.
