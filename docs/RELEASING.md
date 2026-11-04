# Releasing Ariadne Studio

A release is one tag, one draft GitHub release and one manual `npm publish`. Tagging publishes
nothing: `.github/workflows/release.yml` only builds, so nothing goes out by accident.

There are two repositories. The public one is
[sudo-ezekiel/ariadne-studio](https://github.com/sudo-ezekiel/ariadne-studio). The old
`sudo-ezekiel/ariadne` stays private as an archive, and the local `origin` remote still points at
it on purpose, so an ordinary `git push` cannot reach the public repository. Every push to the
public repository below names its address.

## Before the first public release

**Never push the existing history to the public repository.** The current local `main` and the
`origin` remote contain internal notes, so pushing them would publish all of it. Taking the files
out in a later commit does not help, because they stay in the history. The public repository
starts from one fresh commit, made from a clean tree with the private files left out.

The private paths are listed in `.git/info/exclude` on the owner's machine, which keeps them out
of every `git add` without naming them in this public tree.

### Settle these first

1. **Confirm the licence.** Apache-2.0 is proposed and not yet confirmed by the owner. It is in
   `LICENSE`, `apps/cli/package.json`, `apps/desktop/package.json`, `README.md`,
   `apps/cli/README.md` and `CONTRIBUTING.md`.
2. **Accept that code signing is not done.** Users see warnings: Windows SmartScreen says "Windows
   protected your PC", and macOS Gatekeeper refuses until the user allows the app. Signing needs an
   Apple Developer ID with notarization and a Windows code signing certificate. Say so in the
   release notes.

### Make the fresh commit

Wait until no one else is working in the tree. Then make a branch with no history. These commands
keep every file on disk, and `git add -A` follows `.git/info/exclude`, so the private paths stay
out:

```sh
git checkout --orphan public-main
git read-tree --empty
git add -A
```

Confirm that none of the private paths are tracked. This must print nothing:

```sh
git ls-files -ci --exclude-from=.git/info/exclude
```

Read the rest of the list with `git ls-files` too, in case something new has appeared. If anything
is wrong, stop: `git symbolic-ref HEAD refs/heads/main && git reset` returns to `main` and leaves
the files alone. If the list is right, commit:

```sh
git commit -m "Ariadne Studio 0.1.0"
```

### Check, then push

Run all three checks, and push only if each one gives the expected result:

```sh
git rev-list --count public-main                 # must print 1
git ls-tree -r --name-only public-main | git check-ignore --no-index --stdin
                                                 # must print nothing
git log -1 --format='%an <%ae>' public-main      # must show sudo-ezekiel and the noreply address
```

Push that one branch, by address, as `main`:

```sh
git push git@github.com:sudo-ezekiel/ariadne-studio.git public-main:main
```

Do not use `--all`, `--tags` or `--mirror`: each would send other refs, and a tag or a branch from
the old history carries all of it, as would the local `refs/t3/*` checkpoint refs. Leave `origin` as
it is. On GitHub, check that the public repository shows 1 commit.

From now on, work on `public-main`. Never merge `main` into it.

### After the first push

1. **Set up GitHub.** Turn on private vulnerability reporting (Settings, Advanced Security),
   because `SECURITY.md` and `CODE_OF_CONDUCT.md` send people there. Create the `bug` and
   `phone-report` labels.
2. **Check the release workflow** on the next tag. For v0.1.0 its macOS job never got a machine and
   the draft step was skipped, so the release was made by hand from that run's files. macOS is now
   out of the matrix, and the draft step has not yet run for real.
3. **Remove the "not published" notes** once the first release is out, in `README.md`,
   `site/index.html`, `apps/docs/guides/install.md` and `apps/docs/guides/introduction.md`. In
   `site/index.html`, point the download link and `downloadUrl` back at `releases/latest`, then
   publish the site with `pnpm site:deploy`.

## Every release

1. **Start from a clean `public-main`.** CI must be green, and any real phone reports read.
2. **Run the checks.** `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, and with a
   device or emulator `pnpm smoke`, `pnpm smoke:studio`, `pnpm smoke:gestures` and
   `pnpm smoke:phone`.
3. **Bump the versions.** Set the same `version` in `apps/cli/package.json` and
   `apps/desktop/package.json`. The release workflow fails if either differs from the tag.
4. **Update `CHANGELOG.md`.** Move the changes under the new version and set its date, replacing
   `Unreleased`.
5. **Check the npm package.** From `apps/cli`:

   ```sh
   npm pack --dry-run
   ```

   It builds everything first, through `prepack`, then lists the files. The list must include
   `README.md`, `dist/LICENSE`, `dist/THIRD_PARTY_LICENSES.txt`, `dist/cli.mjs` and `bin/`. To try
   it for real, run `pnpm pack`, then from another folder
   `npx --package /path/to/ariadne-studio-<version>.tgz ariadne-studio --version`.
6. **Commit, tag and push.**

   ```sh
   git commit -am "Release 0.1.1"
   git tag v0.1.1
   git push git@github.com:sudo-ezekiel/ariadne-studio.git public-main:main v0.1.1
   ```

   Name the address: a push to `origin` goes to the private archive, and no workflow runs for
   this release. Make the tag on `public-main`, because a tag on the old history would carry all
   of it.

7. **Wait for the Release workflow.** It builds the desktop app on Ubuntu and Windows, then attaches
   the installers to a draft release.
8. **Check the draft.** On the Releases page, download each installer and start it on the system it
   is for. Edit the notes to match the changelog, and repeat that the builds are unsigned.
9. **Publish the draft.** This is the point where the desktop app goes public.
10. **Publish to npm, by hand.** Use the tarball the workflow packed, so what you checked is what
    ships. It is the `npm-tarball` artifact of the workflow run:

    ```sh
    gh run download <run-id> --name npm-tarball
    npm publish ariadne-studio-0.1.1.tgz
    ```

    This needs an npm login on the `ariadne-studio` package.
11. **Check it landed.** `npx ariadne-studio@0.1.1 --version` from an empty folder.
