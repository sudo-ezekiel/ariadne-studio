---
title: Troubleshooting Maestro and device problems
description: Fix device, adb, Maestro, Java, block and permission problems in Ariadne, with the messages the studio shows.
---

# Troubleshooting

Start with **Device setup**, from the Settings gear or the link under Device. It checks adb, your devices, Maestro and Java, and rechecks every few seconds. In the desktop app, **Help > Show logs** opens the studio's log.

## Device

### No device in the list

**Device setup** says what is missing. A device must show as `device` in `adb devices`. Use the reload button beside the list after you start an emulator or plug in a phone.

### "No device connected. Pick a device, enter the app id and click Connect first."

Connect before recording. Pick the device under Device, enter the app id and click **Connect**. Not sure of the app id? See [Which app id?](/guides/install#which-app-id)

### "Device emulator-5554 is not connected. Boot or connect it, then try again."

Run uses the open session's device, else the project's last device, else the one the case was recorded on. Start that device, or connect another and run again.

### The phone says "waiting" or "unauthorized"

Unlock the phone and press Allow on the "Allow USB debugging?" prompt. No prompt? Unplug and plug in again, or press "Revoke USB debugging authorizations" in Developer options and plug in again.

### The device is "offline"

An emulator may still be starting; if it stays offline, close it and start it again. For a phone, unplug the cable and plug it back in.

### "This computer may not use the phone yet" on Linux

adb reports `no permissions`. Install your distribution's Android udev rules (`android-udev` on Arch, `android-sdk-platform-tools-common` on Debian and Ubuntu), add yourself to the `adbusers` or `plugdev` group, then log out and back in.

### No prompt and no device on a USB cable

Use a cable that carries data, because some only charge. On Windows, install the phone maker's USB driver.

### The first start on Windows takes over a minute

Ariadne's device helper sometimes stalls while starting on Windows. The studio notices after a minute, ends it and starts it again, so wait. It was seen on about one fresh machine in five, and the log says so when it happens.

### "The phone did not allow the install Ariadne needs"

The phone refused the helper app Ariadne installs on Connect. On Xiaomi, Redmi and POCO phones it asks first: watch the phone, tap **Install**, and press Connect again. If there is no prompt, turn on Install via USB in Developer options.

### "This Xiaomi phone stops Maestro from opening apps"

Open **Device setup** and press **Prepare this phone**, then tap **Install** on the phone if it asks. See [Xiaomi, Redmi and POCO phones](/guides/install#xiaomi-redmi-and-poco-phones). After updating Maestro, uninstall its driver from the phone (`adb uninstall dev.mobile.maestro` and `adb uninstall dev.mobile.maestro.test`) and prepare the phone again, because it stays installed between runs.

### "The phone stopped Maestro from opening the app"

Android and some phone makers stop an app opening another app from the background. Maestro still reports the launch as done, so without this message the run would seem to fail on its first tap. See [Phone makers](/guides/install#phone-makers).

### "The phone blocks simulated touches from this computer"

The phone refuses input sent over USB. On Xiaomi, Redmi and POCO phones turn on USB debugging (Security settings); on OPPO, Realme and OnePlus phones turn on Disable permission monitoring. See [Phone makers](/guides/install#phone-makers).

### "Ariadne cannot read the touchscreen of this device"

**Use the phone** needs to read the phone's touchscreen through `adb`, and this device does not show one. Record on the screen here instead.

### Use the phone stopped by itself

The phone was unplugged, or it locked and the screen could not be read for a few seconds. Turn on Stay awake in Developer options, check the cable, and click **Use the phone** again. The steps so far are kept.

### "The connection to the device dropped during the run"

adb reported the device offline or gone. This is not a test failure: run it again. Run and Run all retry it once for you.

### "Maestro's driver did not start on the device"

Another tool may be holding the device, and only one driver can own it. Stop any other Maestro run or second studio on that device. Run and Run all retry it once.

### "The device has no room to install Maestro's driver"

Free storage on the device, or wipe the emulator's data in Android Studio.

### Rotation fails with an error

The screen only runs in portrait, such as the launcher. Rotate on a screen that allows landscape.

## adb and the Android SDK

### Android tools (adb) not found

Install Android Studio, then restart Ariadne. If the Android SDK is somewhere unusual, set `ANDROID_HOME` to it. Ariadne also reads `ANDROID_SDK_ROOT`, and looks in `~/Android/Sdk` on Linux, `~/Library/Android/sdk` on macOS and `%LOCALAPPDATA%\Android\Sdk` on Windows.

### "The Android emulator is not installed."

Install Android Studio, or set `ANDROID_HOME` to your Android SDK.

### The desktop app cannot find adb or Maestro

Started from the Dock or a launcher, an app gets a bare `PATH`, so the app adds the login shell's `PATH` and the usual adb and Maestro folders. If yours are elsewhere, set `ANDROID_HOME` and `MAESTRO_BIN` where your login shell reads them.

## Maestro

### "Maestro CLI not found"

Install it from [Maestro's guide](https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli). The studio looks in `~/.maestro/bin` and on `PATH`, and on Windows in `C:\maestro\bin` too. Set `MAESTRO_BIN` to name the file. Recording works without Maestro.

### "Could not run Maestro"

The studio found Maestro but could not start it. The message says why. Run `maestro --version` in a terminal to see the same problem directly, which is often Java.

### "Maestro did not finish in time and was stopped."

A run has a limit of 5 minutes. Split a long case, see [Split after this step](/guides/edit-and-chain#split-after-this-step).

### "Maestro stopped during step N without saying why"

Often the device disconnected. Read `output.txt` and `maestro.log` in `runs/<runId>/`.

### "Maestro wrote no command results"

Maestro stopped before it ran anything, so read `runs/<runId>/output.txt`.

### A step fails on a run but worked while recording

Look at the replayed screen beside the recorded one. Common causes:

- Something on the screen changed, such as a dialog. **Re-record from here** fixes the case when the app changed.
- A one-time prompt was answered in the case. Answer it before recording, or in a block.
- The step is a `point`, which depends on layout.
- A plain `scroll` ran before the list was drawn, see [Known limits](/reference/known-limits).

## Java

### Java not found, or "too old"

Maestro needs Java 17 or newer. Install Temurin 17 from adoptium.net, then restart Ariadne. Device setup shows the version it found. It runs `java` from `PATH`, so a newer Java that is not first on `PATH` still counts as too old.

## Blocks

### A block is greyed out

The file is not a Maestro flow. The tooltip gives the reason: invalid YAML, no header and `---`, or no `appId`.

### "It runs ..., which does not exist."

The block's `runFlow` names a file that is not there. Paths are relative to the block.

### "The block ... failed in Maestro"

A block tagged **Runs with Maestro** failed. The message quotes Maestro, and its output is in `runs/_partial/<caseId>-maestro/`.

### "Start from a saved case or from blocks, not both"

The saved case runs its own blocks. Remove the blocks, or set **Start from** back to a fresh start.

### "X is not saved yet, so the default user will not work"

The block needs a value that is in neither `.env` nor `project.json`. Pick or add a [test user](/guides/test-users), or ask a developer.

### "A saved value called X already exists."

A test user would overwrite a saved value. Pick another name, or edit `.env` yourself.

### The recording and the run type different text

The block sets a default in its own `env:` header. Remove it, see [Test users](/guides/test-users#for-developers-no-defaults-in-a-block-s-header).

## Permissions

### A permission prompt appeared during recording

Do not record the answer. Maestro's `launchApp` allows all permissions by default, so the prompt is likely missing on a run and a tap on **Allow** would fail there. Answer it while not recording, then start the case.

A block can set permissions itself with Maestro's `launchApp` `permissions` option. That option is outside Ariadne's subset, so the block [runs with Maestro](/guides/setup-blocks#blocks-that-run-with-maestro).

### "This is a password field."

Put the password in `.env`, for example `PASSWORD=...`, and type exactly that value. The case then records `${PASSWORD}` instead of the secret.

## The studio

### "Port 4711 is in use by another program."

Start it on another port, with its own device session. The CLI prints the command to use: `ariadne-studio <folder> --port 4712 --session studio-2`.

### "Ariadne Studio is already running at ... for another project"

The same fix applies: another port and another session. Sessions are shared by name across the machine.

### "The UI is not built, so only the API is served."

Run `pnpm build` at the repository root.

### The desktop app says it "could not open" a folder

It offers **Try again**, **Choose another folder…** and **Quit**, and names the log folder.

### `project.json: "paths" must be an object ...`

`project.json` has a malformed `paths`. See [project.json](/reference/project-json#paths).

### Electron starts as plain Node in my terminal

A terminal inside VS Code or another Electron-based editor inherits `ELECTRON_RUN_AS_NODE=1`. `pnpm desktop` removes it.
