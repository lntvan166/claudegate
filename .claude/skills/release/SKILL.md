---
name: release
description: Cut and publish a new ClaudeGate release to the VS Code Marketplace and Open VSX. Use whenever the user asks to "make a release", "publish", "ship", "cut a version", "release vX.Y.Z", "push a new version to the marketplace", or bump the version after landing a change. Handles semver bump, CHANGELOG, tests, bundle, commit, tag, and publishing to both registries (`vsce` + `ovsx`) — pausing for confirmation before the irreversible publish. Trigger even if the user only says "publish this" or "ship it" after finishing a change.
---

# Release ClaudeGate

ClaudeGate is a VS Code extension (`publisher: lntvan166`, `name: claudegate`). A release means: bump the version, record it in the CHANGELOG, verify it builds and tests pass, commit + tag it in git, and publish the `.vsix` to **two** registries — the VS Code Marketplace with `vsce`, and [Open VSX](https://open-vsx.org) with `ovsx`. Open VSX is the registry Cursor, VSCodium, and Windsurf pull from, so shipping there is what lets the extension **auto-update** in those editors — the Marketplace alone doesn't reach them.

The publish step is **irreversible on both registries** — you cannot unpublish or overwrite a version number on either, and neither lets you re-push a version that's already up. So the flow front-loads every check that can fail (tests, bundle, auth) *before* committing anything, and **pauses for the user's explicit go-ahead** before publishing.

Publish the **same `.vsix` artifact** to both registries — build it once with `vsce package`, then hand that one file to `vsce publish` and `ovsx publish`. That guarantees the two registries carry byte-identical builds instead of two independently-bundled ones.

## Before you start

Confirm you're on `main` with a clean-enough tree, and gather the current state so you pick the right version:

```bash
git branch --show-current                       # expect: main
node -p "require('./package.json').version"      # current version
git tag --sort=-v:refname | head -5              # recent tags
git status --short                               # what's uncommitted
```

The uncommitted change being released is usually already in the working tree (like the fix we just made). Note any **untracked** files — they must NOT end up in the release commit (see step 6).

> The zsh line `compdef:153: _comps: assignment to invalid subscript range` is harmless shell-init noise on this machine — ignore it in command output.

## Tooling — install what's missing

The release needs `vsce` and `ovsx` (both required — one per registry) and optionally `gh` (only if the user wants a GitHub Release too). If a required tool is missing, install it rather than stopping — that's expected, not a blocker. Check first, install only the gap:

```bash
vsce --version   # if "command not found": npm install -g @vscode/vsce
ovsx --version   # if "command not found": npm install -g ovsx
gh --version     # only needed for the optional GitHub Release step below
```

- **vsce** — `npm install -g @vscode/vsce`. Publishes to the VS Code Marketplace.
- **ovsx** — `npm install -g ovsx`. Publishes to Open VSX. Note the package is `ovsx`, *not* `@vscode/ovsx`.
- **gh** — install with the platform's package manager (this machine is Debian/Ubuntu Linux: `sudo apt-get install -y gh`; macOS: `brew install gh`). It may prompt for a sudo password — if so, tell the user to run it themselves via `! sudo apt-get install -y gh`. After install, `gh auth login` is needed once before it can create releases.

Installing a global CLI tool modifies the user's system, so mention what you're about to install before doing it. Never install tools the release doesn't actually need.

## Pick the version bump (semver)

Base the bump on the nature of the change being shipped:

- **patch** (`1.3.1 → 1.3.2`) — bug fix, UX/message tweak, docs, internal-only change. Most releases.
- **minor** (`1.3.2 → 1.4.0`) — new command or feature, or a backward-compatible behavior change.
- **major** (`1.4.0 → 2.0.0`) — a breaking change to how users interact with the extension.

If it's ambiguous, state your reasoning and pick the lower bump — under-bumping is cheaper to correct than a premature major.

## Steps

Do 1–5 first (all reversible). Then **stop and ask before 6 onward.**

### 1. Run the full test suite — green baseline before anything else

```bash
npm test
```

This runs the TS unit tests (`test:unit`) and the Python hook tests (`test:hook`). If anything fails, stop and fix it — never publish on red. This is why we test before bumping: no point versioning a broken build.

### 2. Bump the version

```bash
npm version <new-version> --no-git-tag-version
```

`--no-git-tag-version` bumps `package.json` (and `package-lock.json`) without letting npm create its own commit/tag — you control those in steps 6–7 so the message and trailer are right.

Note: `package-lock.json` has historically drifted (it sat at `1.1.7` for many releases). `npm version` re-syncs it, so **include it in the commit** even though it looks unrelated.

### 3. Add the CHANGELOG entry

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/) + semver. Insert a new section above the previous version's, using today's date and the `### Added / ### Changed / ### Fixed / ### Internal / ### Notes` headings that apply. Match the existing voice: each bullet leads with a **bold plain-English summary of the user-visible effect**, then explains the mechanism and the *why*. Look at the top two existing entries and mirror their density.

If the change requires users to re-run **Setup Hook** (any `hooks/hook.py` change), add a `### Notes` bullet saying so.

### 4. Verify the production bundle builds

```bash
npm run bundle
```

This is exactly what `vsce publish` runs via `vscode:prepublish`. Running it now surfaces esbuild/bundling failures while they're still cheap to fix, not mid-publish. Confirm `out/extension.js` is produced.

### 5. Verify publish auth (both registries) — before committing

```bash
vsce verify-pat lntvan166
```

Checking the Marketplace Personal Access Token now means you won't get halfway through (commit + tag pushed) only to discover you can't publish. If it fails, the PAT has expired — the user must refresh it in Azure DevOps (Marketplace → Manage scope) and re-run `vsce login lntvan166`; suggest they do this via `! vsce login lntvan166` so the interactive prompt lands in the session.

**Open VSX auth is different — there's no `verify-pat` equivalent**, so the token is only validated at publish time (step 9). Confirm the two one-time prerequisites are in place before you rely on it:

- **Eclipse Foundation Open VSX Publisher Agreement** must be signed once, via the maintainer's open-vsx.org account (log in with GitHub → user settings → Publisher Agreement). This is the most common first-time failure — `ovsx publish` rejects an unsigned account.
- **Namespace `lntvan166`** must exist. It does (created once with `ovsx create-namespace lntvan166 -p <token>`); re-running that just reports "Namespace already exists", which is fine.

The **access token** comes from https://open-vsx.org/user-settings/tokens. Treat it as a secret: pass it as `-p <token>` on the publish command or via the `OVSX_PAT` env var, and **never write it into a committed file or this skill**. If the user hasn't provided one, ask them to run the publish step themselves via `! ovsx publish … -p <token>` so the secret stays in their session rather than being echoed back through you.

### — PAUSE HERE —

Summarize what's about to happen: new version, the CHANGELOG bullets, test/bundle/auth all green. Then ask the user to confirm before you commit, tag, and publish. Publishing cannot be undone, so this gate is deliberate.

### 6. Commit — only the release files

Stage the version files, the CHANGELOG, and the actual code/hook change being released. **Never `git add -A`** — the working tree often has unrelated untracked files (stray `.release-notes-*.md`, draft docs) that must not enter the release commit or the package.

```bash
git add package.json package-lock.json CHANGELOG.md <changed-source-files>
git commit -F - <<'EOF'
release: vX.Y.Z — <one-line summary of the change>

<optional short body explaining the why>

Co-Authored-By: Claude <noreply@anthropic.com>   # use the model that did the work
EOF
```

Then re-check `git status --short`: only your intended files should be committed; untracked strays should still be sitting there untracked.

### 7. Tag the release

```bash
git tag -a vX.Y.Z -m "release: vX.Y.Z — <same summary>

Co-Authored-By: Claude <noreply@anthropic.com>   # use the model that did the work"
```

Annotated (`-a`) tags carry a message and author — the project uses these, not lightweight tags.

### 8. Push commit and tag to GitHub — BEFORE publishing

```bash
git push origin main
git push origin vX.Y.Z
```

**This must happen before the publish, not after.** The VSIX no longer ships the
README's images (`.vscodeignore` excludes `media/*.mp4`, `media/demo.gif` and the
screenshot PNGs — that's what took the package from 1.41 MB to 81 KB). Both
registries render the README by fetching its images from GitHub over HTTPS, so the
listing has **no packaged fallback**: publish before pushing and the store page
shows broken images until the push lands.

Confirm they resolve before you publish — a 404 here means something is unpushed:

```bash
for u in demo.gif ClaudeGateDemo.png ReviewAllPending.png; do
  printf "%-22s %s\n" "$u" \
    "$(curl -s -o /dev/null -w '%{http_code}' https://raw.githubusercontent.com/lntvan166/claudegate/main/media/$u)"
done   # expect 200 for every line
```

### 9. Package once, then publish to both registries

Build the artifact a single time so both registries get an identical `.vsix`:

```bash
vsce package                                       # → claudegate-X.Y.Z.vsix (runs vscode:prepublish)
```

**Expected output: 13 files, ~82 KB.** That is the regression check — the package
is code + hook + two icons + walkthrough markdown and nothing else. If it comes out
in the hundreds of KB or megabytes, media has crept back in; fix `.vscodeignore`
before publishing rather than shipping a bloated download.

Then publish that same file to each registry:

```bash
vsce publish --packagePath claudegate-X.Y.Z.vsix   # VS Code Marketplace
ovsx publish  claudegate-X.Y.Z.vsix -p <token>     # Open VSX (or set OVSX_PAT and drop -p)
```

Report the version and the Marketplace URL.

**Both registries index AFTER the CLI reports success — poll, don't panic.** A
verification run immediately after publishing returns the **previous** version, and
`https://open-vsx.org/api/.../X.Y.Z` returns **404**. That is propagation delay, not
a failed release. Measured on v1.12.0: Open VSX went live ~75 s after `ovsx` printed
success, the Marketplace ~3.5 min after `vsce` did. Wrap the check in a loop rather
than reading it once:

```bash
for i in $(seq 1 25); do
  o=$(curl -s https://open-vsx.org/api/lntvan166/claudegate | python3 -c "import sys,json;print(json.load(sys.stdin).get('version','?'))" 2>/dev/null)
  m=$(vsce show lntvan166.claudegate 2>/dev/null | grep "^  Version:" | awk '{print $2}')
  echo "t+$((i*20))s  openvsx=$o  marketplace=$m"
  [ "$o" = "X.Y.Z" ] && [ "$m" = "X.Y.Z" ] && echo "BOTH LIVE" && break
  sleep 20
done
```

Before concluding anything is wrong, check how much time has actually passed —
against the release commit's own timestamp (`git log -1 --format=%ci`), not a
session clock. Misjudging that turned a normal 90-second wait into a false alarm once.

**"Already published" on Open VSX is a success, not a failure.** The maintainer also
publishes to Open VSX by a parallel route (an automated/mirror path under the same
`lntvan166` account), so `ovsx publish` may report `Extension lntvan166.claudegate
X.Y.Z is already published` — the version is already live; don't force it. Either
outcome is fine: a clean `🚀 Published` means the manual path won the race. Neither
registry can overwrite an existing version, so a duplicate error is confirmation.

### 10. (Optional) GitHub Release

This project's flow is tags-only, so skip this unless the user asks for a GitHub Release. If they do and `gh` isn't installed, install and authenticate it (see **Tooling** above), then:

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "<paste the CHANGELOG section>"
```

## After publishing

- Confirm the published version on **both** registries and link them:
  - Marketplace: `https://marketplace.visualstudio.com/items?itemName=lntvan166.claudegate`
  - Open VSX: `https://open-vsx.org/extension/lntvan166/claudegate`
- **Check the package file list** that `vsce package` printed. Files under `src/`, `.claude/`, `docs/`, `.github/`, `CLAUDE.md`, and `CHANGELOG.md` are excluded via `.vscodeignore`. If a stray untracked file (e.g. a leftover `.release-notes-*.md`) shows up in the listing, it means `.vscodeignore` is missing a pattern — flag it and offer to add the exclusion before the next release.
- **Delete the local `.vsix`** once both publishes are done (`rm claudegate-X.Y.Z.vsix`) — it's a build artifact, not something to commit.

## What NOT to do

- Don't publish on failing tests or a failing bundle.
- Don't `git add -A` / `git add .` — you'll sweep in untracked strays.
- Don't hardcode the Open VSX token into this skill, a script, or any committed file — it's a secret; pass it at publish time or via `OVSX_PAT`.
- Don't treat an Open VSX "already published" error as a failure — the version is live; a duplicate can't be overwritten on either registry (verify via the API and move on).
- Don't let `vsce` and `ovsx` each build their own package — `vsce package` once and publish that one `.vsix` to both, so the registries stay byte-identical.
- Don't create a GitHub Release unless the user asks — this project's flow is tags-only (step 10 covers it if they want one).
- Don't skip the confirmation pause. Neither registry has an undo.
