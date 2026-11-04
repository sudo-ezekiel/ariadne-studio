---
title: Install Ariadne and set up a device
description: Install Ariadne Studio as a desktop app or from npm, and get adb, Maestro, Java and a device ready.
---

# Install and set up

Get the studio running and a device it can see. This takes a few minutes if Android Studio is already on your machine.

Ariadne Studio comes three ways. All three run the same studio and read and write the same project folders, so a BA on the desktop app and a developer on the command line can share one project.

| You are | Use |
|---|---|
| A BA or PM | the [desktop app](#desktop-app) |
| A developer who wants to try it | the [npm package](#npm-package): `npx ariadne-studio` |
| Working on Ariadne itself | [the repository](/contribute/develop): `pnpm dev` |

::: info Not published yet
Neither the npm package nor the desktop installers are published. Until they are, build them from the repository: `pnpm cli` for the command line, `pnpm desktop:dist` for an installer. See [Packaging and releases](/contribute/packaging).
:::

## Prerequisites

- **An Android emulator or a USB phone** with USB debugging, visible in `adb devices`.
- **The Android SDK platform-tools (`adb`)**, on `PATH` or in the Android SDK folder. Ariadne looks at `ANDROID_HOME` (or `ANDROID_SDK_ROOT`), then where Android Studio puts the SDK: `~/Android/Sdk` on Linux, `~/Library/Android/sdk` on macOS, `%LOCALAPPDATA%\Android\Sdk` on Windows.
- **Java 17 or newer and the [Maestro CLI](https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli)**, to run cases. Recording works without them.
- **[ffmpeg](https://ffmpeg.org/download.html)**, optional, to show the steps in a [run video](/guides/run-video). Without it a run video shows only the phone.
- **Node 22.12 or newer**, for the npm package and the repository. The desktop app brings its own.

### Where Ariadne looks for Maestro

On Linux and macOS the Maestro installer puts it in `~/.maestro/bin/maestro`, which is not on `PATH` by default. The studio looks there, or set `MAESTRO_BIN`.

On Windows you extract Maestro's `maestro.zip` and add its `bin` folder to `PATH`. The studio also looks in `C:\maestro\bin`, the folder Maestro's guide uses, and `MAESTRO_BIN` can name the `maestro.bat`.

### agent-device

[agent-device](https://agent-device.dev) drives the device. It comes with every way of installing Ariadne. On first use it installs a small helper app on the device, "Agent Device Snapshot Helper".

## Desktop app

Install the app for your system and start it. The first time, it opens the project folder `Documents/Ariadne`, created if missing. The window title shows which folder is open, and the app reopens the last folder on the next start.

**File > Open project folder...** switches to another folder, for example the one a developer keeps in the app's repository. Picking a repository root that has a `.ariadne` project opens that project.

**Help > Show logs** opens the folder with the studio's log when something goes wrong.

The installers are named `Ariadne-Studio-<version>-linux-x86_64.AppImage`, `Ariadne-Studio-<version>-mac-<arch>.dmg` and `Ariadne-Studio-<version>-win-x64.exe`. The Windows installer asks whether to install for everyone or only for you, and only for you needs no admin rights.

None are code signed yet, so macOS Gatekeeper and Windows SmartScreen warn on first start. On Windows the warning reads "Windows protected your PC"; choose **More info > Run anyway**.

### Windows and macOS status

The Linux AppImage is tested end to end.

The Windows build has only been run under Wine so far. The installer, the window, the studio server, Maestro's `maestro.bat` with awkward `.env` values, and stopping a run that timed out all work there. Wine lacks PowerShell, which agent-device uses on Windows to manage its background process, so connecting to a device and recording on Windows still need a real Windows machine to confirm.

The macOS build is configured but has not been built or tried.

## npm package

```sh
npx ariadne-studio                    # this folder if it is a project, else its .ariadne project, else ./ariadne
npx ariadne-studio path/to/project    # or name the project folder
npx ariadne-studio init               # add Ariadne to the app repository you are in
```

It starts the studio on `http://127.0.0.1:4711` and opens it in the browser. Ctrl+C stops it and closes the device session. Run it again while it is running and it opens the running studio instead of failing.

`npm install -g ariadne-studio` installs the `ariadne-studio` command for good. Every option is in the [CLI reference](/reference/cli), and `init` is covered in [Use with an existing Maestro project](/guides/existing-maestro-project).

## Device setup

**Device setup** checks everything above and walks you through what is missing. Open it from the Settings gear in the top bar, or from the link under Device. It checks again every few seconds while it is open, so plugging a phone in or allowing USB debugging shows up without a click.

![The Device setup dialog with its checks](/shots/device-setup.png)

It lists:

- Android tools (`adb`), with the path it found.
- Devices: each phone or emulator adb sees, and what its state means. "ready" is the one you want.
- Emulators on this computer, with **Start** beside the ones not running. Creating an emulator is done in Android Studio.
- Maestro, with the path it found. Recording works without it; Run needs it.
- Java 17 or newer, for Maestro.

Below the checks are two guides, **Emulator** and **Phone over USB**.

### Emulator

1. Install Android Studio from [developer.android.com/studio](https://developer.android.com/studio). It brings the Android tools and the emulator.
2. Create a virtual phone. In Android Studio open the Device Manager (on the welcome screen: More Actions, then Virtual Device Manager). Press Create device, pick a phone, pick a recent system image, then Finish.
3. Start it with **Start** in Device setup, or with the play button in the Device Manager. The first start takes a minute or two.
4. Install the app you want to test: drag its `.apk` file onto the emulator window, or run `adb install path/to/app.apk`.
5. Close the guide, pick the emulator under Device, type the app id and press **Connect**.

### Phone over USB

1. Turn on developer options: in Settings, About phone, tap Build number seven times. On Samsung phones it is under About phone, then Software information.
2. Turn on USB debugging in Settings, System, Developer options. Turn on Stay awake there too, so the screen does not lock in the middle of a recording.
3. Plug the phone in with a cable that carries data. If the phone asks what the connection is for, choose File transfer.
4. On the "Allow USB debugging?" prompt, tick "Always allow from this computer" and press Allow.
5. Linux only: if Devices says the computer may not use the phone yet, install your distribution's Android udev rules (`android-udev` on Arch, `android-sdk-platform-tools-common` on Debian and Ubuntu), add yourself to the `adbusers` or `plugdev` group, then log out and back in. Windows needs the phone maker's USB driver. macOS needs nothing.
6. Install the app, close the guide, pick the phone under Device, type the app id and press **Connect**. Keep the phone unlocked while you record.

### Xiaomi, Redmi and POCO phones

These phones need more than the steps above.

1. In Developer options, turn on **Install via USB** and **USB debugging (Security settings)**.
2. Watch the phone when you press Connect: it asks before each install from this computer. Tap **Install**. If you miss it, Connect fails; press it again.
3. Before your first run, open **Device setup** and press **Prepare this phone**. It installs Maestro's driver, which stays on the phone, and lets the driver open apps. Without this a run stops at its first step, because the phone stops Maestro from opening the app. The phone asks twice and each prompt times out within seconds, so keep the phone in your hand; if it fails, press the button again.

Those switches may ask you to sign in to a Mi Account first. Tested on a POCO F5 Pro with HyperOS 3.

### Phone makers

Every phone gets the same two installs, whatever the brand: agent-device's helper on Connect, and Maestro's driver on Run. Makers add their own switches on top. Nothing shows those switches from a computer ahead of time, so Ariadne recognises them when something fails and says so.

Two phones have been tested with Ariadne: the POCO above, and a Samsung Galaxy A16 with One UI 6.1, which needed none of these steps. The rest of this table comes from other Android tools' documentation and user reports, so treat it as where to look first.

| Phone | What to check |
|---|---|
| Samsung | Nothing was needed on a Galaxy A16 in Samsung's Remote Test Lab: Connect, recording and Run all worked. On your own phone, if USB debugging is greyed out or commands fail, turn off **Auto Blocker** in Settings, Security and privacy. |
| OPPO, Realme, OnePlus | In Developer options, turn on **Disable permission monitoring**, which can turn itself off again, and turn off **Verify apps over USB**. Allow background activity and auto launch for Maestro's driver in its app settings. |
| vivo, iQOO | Turn off **Security Care** in Settings, Safe, More security settings, App installation. Allow **Background pop-ups** for Maestro's driver. |
| Huawei, Honor | Turn off **Monitor apps installed by ADB**, and turn on **Allow ADB debugging in charge only mode**. Phones on HarmonyOS NEXT may not run Android apps at all. |
| Google Pixel | No extra switches known. If Maestro's driver will not install over USB, set the USB mode to File transfer. |
| Motorola, Nothing, Tecno, Infinix | Nothing known either way. |

Testing on your company's phones? [Test on your phone](/guides/test-on-your-phone) is a checklist for a tester, and it ends with one file to send back.

### Which app id?

The app id is the app's package name, such as `com.example.claims`. A developer knows it (it is the `applicationId` in the app's build file), or list the apps on the device with `adb shell pm list packages`.

## Look and feel

The studio has a light and a dark theme: the moon or sun in the top bar, or **Settings > Appearance** with System, Light and Dark. System follows the computer.

## Where the files go

The studio keeps everything in a project folder: `Documents/Ariadne` for the desktop app, the folder you name for the npm package, and `workspace/` in the repository. See [Your project files](/guides/project-files).

## Privacy

Installing Ariadne creates no account. The studio serves itself on `127.0.0.1`, so it is reachable only from your machine unless you pass another `--host`.

Next: [Record your first case](/guides/first-case).
