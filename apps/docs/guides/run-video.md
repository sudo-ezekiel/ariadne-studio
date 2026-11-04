---
title: "Run video: the steps beside the phone"
description: Keep a video of each run, with the case's steps beside the phone. Made locally, off by default, and never uploaded.
---

# Run video

See how a run moved between the screenshots, for the failures a still image does not explain, or to show a run to someone who was not there.

A run video fills a 1920 by 1080 frame. The case's steps are on the left and tick off as they ran, each with its time, and the phone is on the right. It is the layout of `maestro record`, in Ariadne's colours and with your case's own step names.

![A run video: the steps of Create an event on the left, the calendar app on the right](/shots/run-video.png)

Run video is optional and off by default. It is made locally and never uploaded: Maestro's own `startRecording` and `stopRecording` capture the phone, and `ffmpeg` on your machine puts the steps beside it.

## Turn it on

Open **Settings** (the gear in the top bar) and tick **Keep a video of each run**.

The setting belongs to the project and is saved as `runVideo` in [`project.json`](/reference/project-json). It applies to Run and to every case in Run all.

## ffmpeg

The steps come from [ffmpeg](https://ffmpeg.org/download.html). The studio finds it on your `PATH`, or at the path in `ARIADNE_FFMPEG`. Without it, the video shows only the phone, and Settings says so under the option. Anything else that stops the frame from being made has the same result: the run keeps the phone video and the reason goes to the studio's log.

## Watch a video

After a run, the case view shows **Video** beside **Shareable report**. The run report links to it too.

A failed run keeps its video, usually the one you want most. Its last frame shows the step that failed with Maestro's message, and the steps after it as not run.

![The last frame of a failed run video, with Maestro's message under the step that failed](/shots/run-video-failed.png)

![The Settings menu with Keep a video of each run ticked](/shots/settings-run-video.png)

## How long it can be

A run can last up to 5 minutes. On Android 16, a 203-second run kept its whole video. Android's screen recorder has a 3-minute limit on some older versions, so the end of a long case can be missing there.

If a video cannot start, the run goes on without one. The video never fails a test.

## What it costs

Keep it off when you do not need it. Saving the video adds about 3 seconds at the end of a run, and capturing the screen can slow the steps down: on a software-rendered emulator on a busy machine, they took up to twice as long in two runs out of three. Adding the steps took 2 to 4 seconds for videos of 12 to 20 seconds here, and the file is usually under 1 MB.

## Where the file goes

The video is `runs/<runId>/video.mp4`, beside the run's report. It is a separate file: the report links to it and does not embed it.

Step names longer than a row are cut short. The text is drawn in Noto Sans Mono, which covers Latin, Greek and Cyrillic; other scripts show as boxes in the step list, and the phone itself is unaffected.

## What changes in your flows

Nothing that you commit. Run video adds `startRecording` at the start and `stopRecording` at the end of the run copy at `runs/<runId>/flow.yaml` only. `flows/<caseId>.yaml` stays as it is, so a developer or CI running the flow gets no video from this setting.

```yaml
- startRecording:
    path: run-video
    optional: true
# the case's commands, each followed by its screenshot
- stopRecording
```

Maestro's documentation covers [startRecording](https://docs.maestro.dev/reference/commands-available/startrecording) and [stopRecording](https://docs.maestro.dev/reference/commands-available/stoprecording). Ariadne does not call `maestro record`, a different command described under [If you know Maestro](/guides/if-you-know-maestro#record-and-maestro-record).

## Privacy

The video is made locally and never uploaded. The step list comes from your case, so a step that types `${PASSWORD}` shows the name, and Maestro's message on a failed step has `.env` values replaced first. The phone is different: it shows whatever is on the screen. Ariadne cannot replace values in a picture, so a value the app displays stays visible in the video. `runs/` is out of version control in a new project, so keep it that way.
