# ariadne-studio

**Ariadne Studio, a recorder for Maestro.** A business analyst or product manager records
Android tests by using the app, and Ariadne writes plain Maestro YAML that runs on a laptop
and in CI. It runs on your own computer, with no account.

## Install and run

```sh
npx ariadne-studio                    # this folder if it is a project, else its .ariadne project, else ./ariadne
npx ariadne-studio path/to/project    # or name the project folder
npx ariadne-studio init               # add Ariadne to the app repository you are in
```

It starts the studio on http://127.0.0.1:4711 and opens it in your browser. Ctrl+C stops it
and closes the device session. `npm install -g ariadne-studio` installs the command for good.

## You need

- Node 22.12 or newer.
- An Android emulator or a USB phone with USB debugging, and `adb` from the Android SDK
  platform-tools.
- To run cases: the
  [Maestro CLI](https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli) and Java 17 or
  newer. Recording works without them.

**Device setup** in the studio checks all of this and walks you through what is missing.
Android only. On Connect, agent-device installs its helper on the phone, and on Run, Maestro
installs its driver. Some phones ask on screen first, so watch the phone.

## More

The guides, the phone support table, known limits and the issue tracker are in the repository:
<https://github.com/sudo-ezekiel/ariadne-studio>.

Keep `.env` and `runs/` out of version control. A new project's `.gitignore` already does.

## Licence

Apache-2.0, in `dist/LICENSE`. The licences of the libraries bundled into this package are in
`dist/THIRD_PARTY_LICENSES.txt`.

Ariadne writes and runs Maestro flows; it does not replace Maestro. Maestro is a trademark of
mobile.dev. Ariadne is an independent tool and is not affiliated with mobile.dev.
