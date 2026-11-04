# Security

Ariadne Studio can read and operate a phone, so this page says how to report a problem and
exactly what the tool can see.

## Report a vulnerability

Use GitHub's private vulnerability reporting:
[open a private report](https://github.com/sudo-ezekiel/ariadne-studio/security/advisories/new).
Please do not open a public issue for a vulnerability.

Say what you found, how to reproduce it and which version you used. Leave out real passwords,
customer data and screenshots of real accounts. Only the latest release gets fixes.

## What the tool can see

**The screen and the phone, while connected.** On Connect, agent-device's helper is installed on
the phone. On Run, Maestro's driver is installed. While connected, these helpers can read
what is on the screen and operate the phone: tap, type, press buttons and open apps. That covers
everything on the phone's screen, including other apps. Disconnect when you finish, and use a test
phone and test accounts where you can.

**The touchscreen, during Use the phone.** Touch capture reads raw touches through `adb`
(`getevent`), and a touch on the keyboard is a key press. Ariadne uses a touch only to tell a key
from a tap. Touches are never logged or stored, keyboard touches are dropped as soon as their
place is known, and text is read from the focused field afterwards. The value of a password field
is never read: typing there records a placeholder such as `${PASSWORD}`.

**Text in other fields.** Text typed into an ordinary field is recorded as typed, in the case
file and the flow. Only text that exactly equals a saved value becomes `${KEY}`. Do not type a
secret into an ordinary field.

**Screenshots and run videos.** Ariadne keeps a screenshot of every step, and they are real
pictures of the device. Nothing in them is blurred, and run videos are the same. Treat them as
you would the app's data.

## `.env` and saved values

Saved values, such as test passwords, live in `.env` in the project folder.

- `.env` is never shown in the Files sidebar and is never returned by the studio's API.
- Values reach Maestro as `-e KEY=VALUE` arguments during a run, so they are on that process's
  command line while it runs.
- After every run the studio replaces `.env` values with `${KEY}` in the text files of the run
  folder, including `maestro.log`, `commands.json` and `output.txt`.
- That clean-up does not cover values shorter than 4 characters, pictures, or Maestro's own
  output under `~/.maestro/tests`, outside the project.
- A new project's `.gitignore` leaves out `.env`, `evidence/`, `runs/`, `exports/` and
  `diagnostics/`.

In CI, Ariadne is not involved, so values passed with `-e` can appear in Maestro's logs.

## What leaves your computer

Nothing leaves the computer unless you send it. Ariadne has no account, no cloud service and no
upload of its own. Projects stay in their folder until you commit or send them.

**Export diagnostics** saves a `.zip` on your computer for you to send to someone. It holds device
facts, versions, the studio's log, case steps, run results and counts of what was recorded. It
never holds `.env` values, passwords or where keys were pressed, and screenshots go in only when
you tick the box. Names in case steps and text in Maestro's run output come from your app, so
look through the file before you share it. The details are in
[Test on your phone](apps/docs/guides/test-on-your-phone.md#what-is-in-the-file).

The Maestro CLI is a separate tool with its own analytics. To turn them off, set
`MAESTRO_CLI_NO_ANALYTICS=true` in the environment you start the studio from. See
[If you know Maestro](apps/docs/guides/if-you-know-maestro.md#privacy).

## The studio's address

The studio serves itself on `127.0.0.1`, so it is reachable only from your computer, and its API
refuses requests made by other websites open in your browser. It has no login. Passing another `--host` exposes the screen, the phone controls and the project to anyone
who can reach that address, so do not do that on a shared network.

Maestro is a trademark of mobile.dev. Ariadne is an independent tool and is not affiliated with
mobile.dev.
