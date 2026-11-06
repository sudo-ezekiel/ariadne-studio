---
title: Test Ariadne on your phone
description: A checklist for a company tester. Install Ariadne, connect a real Android phone, try what is unproven, and send back one diagnostics file.
---

# Test on your phone

This page is for a tester at a company, with no development background needed. You will connect your phone, try a short list of things, and send back one file.

So far Ariadne has been tested with real fingers on one Xiaomi phone, and over a remote link on one Samsung phone. Your phone is new information, so a failure is a useful result. Set aside about 30 minutes.

You need:

- a computer and an Android phone, with a USB cable that carries data
- an app you are allowed to test, already on the phone, and a test account for it, if it has logins
- the app's id, such as `com.example.claims`; a developer can tell you

Use test data. Screenshots show whatever is on the phone, and passwords here should be made up.

## Install

Install the desktop app and start it. If someone gave you an installer, use that one; otherwise see [Install and set up](/guides/install#desktop-app).

The app is not code signed, so your computer warns on first start. On Windows the warning reads "Windows protected your PC": choose **More info > Run anyway**. Your company may need to allow it first.

Windows has been tried on one computer and one phone so far. If you are on Windows and something fails, that is worth reporting too.

**Device setup** opens by itself the first time and takes you through it one step at a time. You can also open it from the Settings gear in the top bar, or from the link under Device. On Windows it fetches the Android tools, Java and Maestro for you. Elsewhere, Run needs Maestro and Java 17 or newer, so ask for help if those two are missing.

Turn on **Stay awake** in Developer options, so the phone does not lock in the middle of a recording.

## Connect

1. Plug the phone in and press **Allow** on the "Allow USB debugging?" prompt.
2. In **Device**, pick your phone and enter the app id.
3. Press **Connect**, and watch the phone.

## Watch the phone for install prompts

Two helpers are installed on every phone, automatically: agent-device's helper on Connect, and Maestro's driver on Run. Some phones say nothing. Others ask on screen, and the prompt can time out within seconds.

- If the phone asks, tap **Install** or **Allow**.
- If you miss it, press **Connect** again.
- Write down any message you see that is not one of these, and which maker's wording it used.

Xiaomi, Redmi and POCO phones ask before every install, and need the extra steps in [Xiaomi, Redmi and POCO phones](/guides/install#xiaomi-redmi-and-poco-phones). For other makers, see [Phone makers](/guides/install#phone-makers).

## Record with Use the phone

In the **Record** tab, name the case `Phone test` and press **Start recording**. Then press **Use the phone** in the bar above the screen, and use the app with your own fingers. Steps appear in the Record tab as you go, and the screen here catches up about a second after each one.

Work through the list, and note anything that looks wrong. Skip what your app does not have.

1. **Tap** a few buttons. Check each step names what you tapped.
2. **Press and hold** something.
3. **Swipe** a list or a page.
4. Type **a number** in a number field.
5. Type **some text** in a text field.
6. Press the keyboard's **Enter key**, or its Go or Search key.
7. Type in a **password field**, with a made-up password. Never use a real one. The step gets the note "You typed in a password field", because Ariadne does not read it.
8. **Change text already in a field**: tap into it, delete part of it, type something else. The step gets the note "You changed text already in the field".
9. **Leave the app and come back**: go to the home screen, then reopen the app. Recording pauses while you are away, and the first step back gets the note "You left the app".
10. If the phone uses **gesture navigation**, swipe for **Back**, and swipe for **Home** and come back. These are proven only on an emulator so far.
11. **Rotate the phone**, if the app allows it, then tap something. Turning the phone records no step of its own, so look at whether the tap names the right element. Turn it back before you go on.

On a Samsung phone, also note two things:

- whether USB debugging stayed on, or turned itself off
- any **Auto Blocker** message, and whether it stopped anything

## Finish recording and Run

1. Press **Finish recording**, which stops Use the phone as well, then **Save case**.
2. A password step needs a value on a run. Delete the step in the **Cases** tab, or add your made-up password to the project's `.env` file under the name the step shows, for example `PASSWORD=made-up-password`.
3. Open the case in the **Cases** tab and press **Run**. Watch the phone again, because Maestro's driver installs now.

On Xiaomi, Redmi and POCO phones, press **Prepare this phone** in **Device setup** before the first run.

A step that fails is fine: note which one. Steps recorded from touches can need a look, and a failure here is what we want to learn about.

## Send back one file

1. Open the **Set up a device** dialog, from the Settings gear in the top bar or the **Device setup** link under the device card.
2. Under **Something not working?**, leave **Include screenshots** unticked unless you were asked for them.
3. Press **Export diagnostics**. It saves one `.zip` file.
4. Send that file back, with your notes from the list above.

Press it even if everything worked: a clean result on a new phone is just as useful.

If you were asked to report on GitHub, use the [phone report](https://github.com/sudo-ezekiel/ariadne-studio/issues/new?template=phone_report.yml). GitHub issues are public, so look through the file first.

## What is in the file

It is an ordinary `.zip` of text files, with a `README.txt` that lists them, so you can look through it before you send it.

It contains:

- facts about the phone: maker, model, Android version, navigation type and keyboard app
- versions of Ariadne and its tools, and this computer's system
- the studio's log
- your case steps, with the names of the elements tapped
- run results, and Maestro's output from recent runs
- counts of what was recorded, such as how many taps and swipes

It never contains:

- `.env` values: they are removed wherever they appear
- passwords
- where keys were pressed on the keyboard: Ariadne never keeps that
- the phone's serial number or a list of its apps

Names in the steps and in Maestro's output come from your app's screen, so they can show what was on the phone. Text you typed is reduced to its length in the steps and removed from Maestro's output, though a very short entry, such as two digits, can only be removed where Maestro says it typed something.

Screenshots are only included if you tick **Include screenshots**, because they can show anything on the phone. Check them before you send them.

## Where the files go

The zip is saved where your browser or the desktop app saves downloads. Your cases stay in the project folder, `Documents/Ariadne` for the desktop app. See [Your project files](/guides/project-files).

## Privacy

Nothing leaves your computer unless you send it. Ariadne has no account and no upload of its own. While connected, the helpers can read and operate the phone's screen, so disconnect when you finish.
