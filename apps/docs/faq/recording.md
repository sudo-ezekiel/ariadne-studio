---
title: Recording FAQ
description: Frequently asked questions about recording cases, gestures, checks and secrets in Ariadne.
---

# Recording

Frequently asked questions about recording.

## Does recording make a video?

No. Recording captures steps: each action becomes a Maestro command with a selector and a screenshot. For a video of a run, see [Run video](/guides/run-video).

## Do I need Maestro installed to record?

No. Recording works without it, because agent-device drives the device. Run needs Maestro, and so does starting a recording after a block that [runs with Maestro](/guides/setup-blocks#blocks-that-run-with-maestro).

## Does clicking the screen record anything before I press Start recording?

No. While you are connected and not recording, clicks and buttons act on the device and nothing is saved. Use this to get the app to where you want it, or to clear a first-run prompt.

## Why can I not check something I can see on the screen?

Some apps draw parts of a screen as a picture, so there is no element there. The studio refuses with "Nothing with a name or id here. Click on a text or a control." Find a screen that shows the same thing as real text. In the [first case](/guides/first-case), the month view draws events, so the case uses search.

## Why is a step shown in amber with a position?

A step shown as `point` has no usable id or text, so it taps a place on the screen by percentages. These steps are the ones most likely to break on a run. See [How clicks become selectors](/reference/selectors).

## How do I record a password?

Put it in the project's `.env`, or add a [test user](/guides/test-users), then type exactly that value. The case records `${PASSWORD}` and the device receives the real text. In a password field, anything else is refused.

## How do I swipe, long press or double tap?

Drag for a swipe, press and hold for a long press, and right-click for **Double tap**. See [Recording](/guides/recording#gestures-on-the-screen).

## Why does scrolling with the mouse wheel do nothing?

On purpose: scrolling the page must never record a step. Use **Scroll down** and **Scroll up**, or drag on the screen.

## Why are Recents and Zoom off?

They are live-only. Maestro has no key for the Recent apps button and no pinch command, so a step for them could never run. They work while you are not recording.

## Can a recording start logged in?

Yes. Add a [setup block](/guides/setup-blocks) that logs in under **Before recording**, or start from the end of a saved case that does.

## Can I add a step later?

Yes. Open the case and use **Add steps after this one**, or **Re-record from here** to replace the end of it. See [Edit and chain cases](/guides/edit-and-chain).

## Does Ariadne use my real keyboard?

Yes. The studio keeps the device's real keyboard, because Maestro runs with the real keyboard and Back behaves differently when a keyboard is showing.
