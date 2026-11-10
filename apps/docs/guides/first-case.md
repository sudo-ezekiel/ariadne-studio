---
title: Record your first Maestro test
description: "Record a Maestro test without writing YAML: create an event in Fossify Calendar, check it exists, read the flow and run it."
---

# Record your first case

Record one real case from start to finish, so you know the whole loop before you use it on your own app.

You will create an event called Dentist in a calendar app, check that it exists, read the Maestro flow Ariadne wrote, and run it. It takes about ten minutes.

This walkthrough uses [Fossify Calendar](https://github.com/FossifyOrg/Calendar) (`org.fossify.calendar`), a calendar app licensed under GPL-3.0. It needs no account and no server. Fossify Calendar is an independent project with no connection to Ariadne.

## Before you start

Follow [Install and set up](/guides/install) until `adb devices` lists your emulator or phone as `device`.

## Install the app

Download `calendar-24-foss-release.apk` from the [1.12.1 release](https://github.com/FossifyOrg/Calendar/releases/tag/1.12.1) and install it:

```sh
adb install calendar-24-foss-release.apk
```

With more than one device attached, name the one you want: `adb -s emulator-5554 install calendar-24-foss-release.apk`.

## Connect

Open the studio: the desktop app, the page `npx ariadne-studio` opened, or the Vite UI with `pnpm dev`.

In **Device**, above the Record and Cases tabs, pick your device, enter the app id `org.fossify.calendar` and click **Connect**. Device shrinks to one line with **Change** and **Disconnect**, and the screen appears.

No device in the list? **Device setup** explains what is missing.

## Clear the one-time prompts

Fossify Calendar asks two questions the first time you save an event, and never again on that device. A step that answers them would fail on every later run, so answer them now, before recording. Nothing is recorded until you press Start recording.

1. Click the **+** button at the bottom right of the screen, then click **Event**.
2. Click **Title**. Type anything in the **Text to type** box under the screen and press **Type**.
3. Click the save icon at the top right.
4. A dialog titled "Disclaimer" appears. Click **OK**.
5. Android asks "Allow Calendar to send you notifications?". Click **Allow**.

6. You are back on the month view. Click the grid icon at the top, **Change view**, and choose **Simple event list**.

The month view draws its events as a picture, so a check could not select one. The event list shows each event as real text, and the app remembers the view.

Do the same for any app of your own: get first-run prompts out of the way, or put them in a [setup block](/guides/setup-blocks).

## Start the case

In the **Record** tab, name the case `Create an event`. Leave **Start from** on "a fresh start of the app" and add no setup blocks.

Click **Start recording**, under the stack or in the bar above the screen. The app restarts, so the recording begins where a run will begin. The screen gets an ochre frame, and the bar above it shows the case name and the step count.

![The Record tab with the New case form, ready to start recording](/shots/first-case-new-case.png)

## Record the steps

Click the elements in the screen. Each click is sent to the device and listed as a step with its selector and a thumbnail. Hovering outlines the element a click would hit.

1. Click **+**, then **Event**. The title field already has focus.
2. Type `Dentist` in the **Text to type** box and press **Type**.
3. Click the save icon at the top right. The event list comes back with Dentist in it.

![Check mode on while recording, with Dentist outlined in the event list and four steps listed](/shots/first-case-recording.png)

## Add a check

Toggle **Check**, under the screen. The outline turns green and dashed. Click **Dentist** in the list. This records that the event is visible, without touching the device. Toggle **Check** off.

## Finish

Click **Finish recording**. A picker lists stable texts and ids on the final screen for end checks. You already have a check, so leave them unticked and click **Save case**. Saving with none ticked is fine.

A note says the case was saved, with **Open case** and the flow folded underneath.

![The saved note with the Maestro flow open under it](/shots/first-case-saved.png)

## Read the YAML

Open the fold to see the flow. This is the file Ariadne wrote for these steps on Fossify Calendar 1.12.1, on an Android 16 emulator:

```yaml
appId: org.fossify.calendar
name: Create an event
---
- launchApp
- tapOn:
    id: "org\\.fossify\\.calendar:id/calendar_fab"
- tapOn:
    id: "org\\.fossify\\.calendar:id/fab_event_label"
- inputText: "Dentist"
- tapOn:
    id: "org\\.fossify\\.calendar:id/save"
- assertVisible:
    id: "org\\.fossify\\.calendar:id/event_item_title"
```

Each step became one Maestro command, and every selector is a resource id, the sturdiest kind. The dots are escaped because Maestro reads `id` as a regular expression. There is nothing here that only Ariadne can read.

## Run it

Click **Open case** (or open the **Cases** tab and find it), then click **Run**. The studio hands the device to Maestro, which runs the flow and adds a screenshot after every step.

When it ends, each step shows passed, how long it took, and the recorded and replayed screens side by side. A step whose screens differ is marked "looks different", which is only a prompt to look. See [Run and Run all](/guides/run).

![A passed run: each step with its result, how long it took and its screenshots](/shots/run-passed.png)

Every run creates one more Dentist event on the device, so the list grows after a few runs. The check still passes, because it only needs one event on screen.

## Where the files went

```
flows/create-an-event-<timestamp>.yaml     the Maestro flow above
cases/create-an-event-<timestamp>.json     the case itself
evidence/create-an-event-<timestamp>/      a screenshot per recorded step
runs/create-an-event-<timestamp>-<time>/   the run: Maestro's output, screenshots, results
```

You can run the flow without Ariadne, from the project folder:

```sh
maestro test flows/create-an-event-<timestamp>.yaml
```

See [Your project files](/guides/project-files) for the whole folder.

## Privacy

The case, its screenshots and its runs stay in your project folder. Screenshots show whatever was on the screen, so treat them as you would the app's data.

## Where to go next

- [Recording](/guides/recording): gestures, phone buttons and typing.
- [Setup blocks](/guides/setup-blocks): start a recording after a log in.
- [Edit and chain cases](/guides/edit-and-chain): fix a case without recording it all again, or start the next case from the end of this one.
