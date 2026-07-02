# Releasing FediHome

FediHome uses a two-branch model: day-to-day work merges into **`dev`** (one PR
per change, squash-merged), and a release is a **merge of `dev` into `main`**
plus a tag. `main` is what `npm run update` installs, so it only moves when a
release is cut.

## The changelog contract

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com) and CI
enforces its structure (`.github/workflows/changelog.yml`):

- Every PR adds an entry under **`## Unreleased`** (or carries the
  `skip-changelog` label). Section order: Added, Changed, Fixed, Security,
  Schema.
- **Released sections are immutable on `dev`** — the "CHANGELOG in sync" check
  fails any PR whose changelog, after stripping `## Unreleased`, doesn't match
  `main`'s byte-for-byte. That catches a dropped version heading, an edited
  released entry, or a new entry filed under an old version.
- On a PR targeting `main`, no `## Unreleased` may remain and the top version
  heading must equal `package.json`'s version.
- For a *deliberate* edit to released history (typo fix in an old entry),
  apply the **`changelog-resync`** label to that PR.

## Cutting a release

1. **Prep on a branch off `dev`** — never hand-edit the version/heading:

   ```bash
   git checkout dev && git pull
   git checkout -b release/vX.Y.Z
   node scripts/prepare-release.mjs minor   # or major | patch | X.Y.Z
   ```

   The script converts `## Unreleased` → `## X.Y.Z (<today>)` (refusing if the
   section is missing or empty) and bumps `package.json` +
   `package-lock.json`. Commit, PR → `dev`, let CI pass, squash-merge.

2. **Merge dev → main** (a true merge, not a squash, so history is shared):

   ```bash
   gh pr create --base main --head dev --title "release: vX.Y.Z"
   gh pr merge --merge          # NOT --squash, NOT --delete-branch
   ```

3. **Tag + GitHub release**:

   ```bash
   git checkout main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   gh release create vX.Y.Z --title "FediHome vX.Y.Z" \
     --notes "<highlights from the CHANGELOG section>" \
     --discussion-category "Announcements"
   ```

4. **Back-merge** so `dev` shares the merge commit:

   ```bash
   git checkout dev && git merge origin/main && git push
   ```

After this, `dev`'s changelog equals `main`'s exactly; the next feature PR
recreates `## Unreleased` above the freshly released section.

## If the sync check fails on your PR

- *"released sections don't match main"* — you (or a bad conflict resolution)
  touched a released section. Move your entry under `## Unreleased` and
  restore the released text exactly as it is on `main`
  (`git show origin/main:CHANGELOG.md`).
- *"dev is missing a hotfix released on main"* — back-merge: `git checkout dev
  && git merge origin/main`.
- *"new version section doesn't match package.json"* — you renamed
  `## Unreleased` by hand. Revert and use `scripts/prepare-release.mjs`.
