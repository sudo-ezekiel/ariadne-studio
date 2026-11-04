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

## Use the phone

You can do the steps on the phone itself instead of on the screen here. While recording, click **Use the phone** in the bar above the screen, then use the app with your own fingers. Steps appear in the Record tab as you go, and the screen here catches up after each one.

Tap, press and hold, swipe, the on-screen keyboard, and Back and Home all record. Everything else about the case stays the same: the steps, the screenshots and the Maestro flow are the ones you would get from the screen here.

**Check** still works on the screen here: turn it on and click what must be visible. Run a setup block and the other controls under the screen wait until you click **Stop using the phone**. **Finish recording** stops it for you.

Touches show where your finger went, not what you meant, so some steps come with a note saying why they need a look:

| The note says | What happened | What to do |
|---|---|---|
| The screen was still changing | You touched before the screen had settled, so the step may name what was there a moment earlier | Check the step names the right element |
| No named element here | The touch fell between controls, or on something with no name or a very long one, so the step presses a position | Expect it to miss on another phone; a developer can add an id to the app |
| You typed in a password field | Ariadne did not read it | Save the password as a saved value with the name the step shows |
| You changed text already in the field | The step erases and retypes from the end of the field | Run the case to check the text comes out right |
| You left the app | You went to the home screen and came back, which a run will not do | Run the case to check it still works |

Mistakes are recorded too, because a touch looks the same either way. Delete the extra steps in the **Cases** tab after you save. A note goes away when you press **Looks right** there.

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

## Check mode

A check records that something is on screen at this point in the case.

Toggle **Check**. The outline turns green and dashed, and a click records a check for that element without touching the device. Toggle it off to go back to tapping.

Elements with neither a name nor an id are refused: "Nothing with a name or id here. Click on a text or a control." In Check mode holds and drags do nothing.

## Typing and secrets

Use the **Text to type** box plus **Type** to type into the field that has focus on the device.

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
