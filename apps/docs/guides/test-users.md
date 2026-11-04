---
title: Test users and secrets in .env
description: Run a setup block as a different user, with values kept in .env and only references in the case.
---

# Test users

Record the same journey as a clerk and as a supervisor without changing a block or touching a password.

A block's `${KEY}` variables are its settings, and a BA sets them per case in the studio. When a block is placed under **Before recording**, a **Test user** row appears under it. Blocks whose settings are not about logging in show **Values** instead.

![The Test user row under a Log in block, set to Supervisor](/shots/blocks-before-recording.png)

## Choose a test user

- **Default user** uses the project's own `USERNAME`, `PASSWORD` and so on.
- **A test user such as Supervisor** is offered when the project has a saved value `SUPERVISOR_<SETTING>` for every setting the block uses, here `SUPERVISOR_USERNAME` and `SUPERVISOR_PASSWORD`.
- **Add a test user...** asks for a name and a value per setting and saves them to `.env` as `<NAME>_<SETTING>`, so a BA can add one without editing files. "Agent Maria" becomes `AGENT_MARIA_USERNAME`. It refuses a name that is already saved rather than overwrite a value you cannot see.
- **Set each value...** points each setting at any saved value, or at typed text for settings that are not secret.

Anything whose name looks like a secret (`PASS`, `PWD`, `SECRET`, `TOKEN`, `PIN`, `OTP`, `API_KEY`, `PRIVATE`) only takes saved values, and typed text that equals a saved value is stored as a reference to it.

If a setting has no saved value, the row says so: "USERNAME is not saved yet, so the default user will not work."

## What the case stores

The case stores and emits references only, so the flow stays free of secrets:

```yaml
- runFlow:
    file: ../blocks/login.yaml
    env:
      USERNAME: "${SUPERVISOR_USERNAME}"
      PASSWORD: "${SUPERVISOR_PASSWORD}"
```

Step rows show who a block ran as, such as "as Supervisor".

## In the middle of a recording

Each block under **Run a setup block now** has the same **Test user** row, so a case can log in as one user, do something, and log in as another.

## For developers: no defaults in a block's header

Do not give a setting a default in the block's own `env:` header. Maestro keeps a block's header default over the value a case passes to `runFlow`, while agent-device takes the passed value, so the recording and the run would type different text (checked with Maestro 2.12 and agent-device 0.21.35).

The studio only offers settings without a header default. Put defaults in `.env` or `project.json` instead.

## Where the files go

Test users are lines in the project's `.env`:

```
USERNAME=ba@example.com
PASSWORD=...
SUPERVISOR_USERNAME=lead@example.com
SUPERVISOR_PASSWORD=...
```

## Privacy

`.env` stays on this computer and out of version control. Each person keeps their own copy, and a case only ever names the saved value it uses.
