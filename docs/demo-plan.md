# Demo Plan — README / Marketplace GIF

The goal of this asset is **not** to explain the extension. It is to make a
Claude Code user who runs more than one agent think *"I need that"* within four
seconds. Everything below is in service of that.

## The one idea being sold

> Your agents edited 11 files across 4 worktrees. Here they all are, in one panel,
> reviewable one keystroke at a time.

Git can't show this (nothing is committed, and worktrees are separate checkouts).
Claude Code's in-editor diff can't either (it only knows the session in front of
you). That gap is the entire pitch — the demo should make it *visible* rather than
stated, which is why the first frame is a panel full of grouped, attributed work.

## Build the fixture

Never record a real workspace. The demo seeder builds a throwaway `go.work`-style
repo with generic names, real git worktrees, and one pre-populated ClaudeGate
session per worktree.

**Build it at a path with no username in it.** ClaudeGate's own tooltips — the
worktree group row, every file row — show the **absolute path**, so a fixture under
`~/` puts `/home/<you>/...` into the recording the moment the mouse rests anywhere.
That is the single most likely way a personal identifier ends up in a published GIF,
and it is invisible until you go frame-hunting for it:

```bash
python3 manual-test-seed.py --demo /tmp/demo    # tooltips read "/tmp/demo/..."
code /tmp/demo
```

Tear down the same way: `python3 manual-test-seed.py --demo --clean /tmp/demo`.

What you get:

| Root | Pending | Agent session |
|---|---|---|
| `claudegate-demo/` | 5 (`README.md`, `Makefile`, `scripts/release.sh`, `CONTRIBUTING.md`, `ws-beta/go.work`) | A + B |
| `ws-alpha/service-api` | 3 (incl. a flagged `.env`) | A |
| `ws-alpha/service-core` | 2 | A |
| `ws-beta/service-worker` | 3 | B |
| `ws-beta/service-core` | 2 | B |

15 pending files, 4 worktree groups, 2 agent session IDs. The five workspace-root
files are the ones the shot list actually clicks — enough to build an accept
rhythm without draining the panel. Tear down with
`python3 manual-test-seed.py --demo --clean`.

The fixture is built to record clean:

- **Every Go package type-checks** (`go vet` is clean in all four worktrees).
  Support files that make each package compile are committed *before* the agent's
  edits, so they never show up as pending. A demo full of red squiggles undercuts
  exactly the impression you're trying to create.
- **Each feature directory has its own `go.work`** listing the module worktrees
  inside it — the same shape as a real multi-module setup. Without it, `go` and
  gopls reject every worktree with *"directory prefix does not contain modules
  listed in go.work"*.
- **`.vscode/settings.json` ships with the fixture** and pre-disables the Go
  language server, minimap, breadcrumbs, problem decorations, and the lightbulb —
  most of the "hide the noise" pre-flight below is already done for you.

> Re-run the seeder before **every** take. Accepting files mutates the fixture,
> and a second take starting from a half-reviewed panel looks wrong.

## Pre-flight (do this once, it matters more than the editing)

- **Window size** — resize to roughly **1440×900**. Wider looks cinematic but
  shrinks the text once scaled to 900px.
- **Zoom** — `Cmd/Ctrl +` two or three steps. Text that reads fine on your monitor
  is unreadable in an 900px GIF embedded in a README. This is the single most
  common mistake.
- **Theme** — pick one with a strong diff green/red. Dark themes read better on
  GitHub and both marketplaces.
- **Hide the noise** — the fixture's `.vscode/settings.json` already turns off the
  minimap, breadcrumbs, problem decorations and the Go language server. You still
  need to close the terminal panel and any other sidebar views by hand. The only
  things on screen should be the Claude Gate panel and the diff.
- **Hide your identity** — status bar account badge, any repo name in the title
  bar, notifications. Turn on Do Not Disturb.
- **Cursor** — move deliberately and slowly. Fast erratic mouse movement is the
  tell that separates an amateur capture from a product demo.

## Cut 1 — the hero loop (~11 s, GIF, top of README + both listings)

This is the one that gets reshared. It must loop cleanly and carry no audio,
no narration, and no text overlays.

**Act on workspace-root files; use the worktree groups as scenery.** The panel's
*shape* — four worktree groups, two agent sessions, everything in one tree — is
what makes the point, and it lands in the first frame without clicking anything.
Driving the accept loop through the root files (`README.md`, `Makefile`,
`scripts/release.sh`, …) keeps the take to one simple, reliable path.

| Time | On screen | Why it's there |
|---|---|---|
| 0.0–1.5 | Pending panel, collapsed: 4 worktree groups + root files, badge reads **15** | The hook. "Four worktrees of agent work, one panel." |
| 1.5–3.0 | Expand `ws-alpha/service-api` → 3 files nest under it, `.env` sorted to top with its warning | Shows grouping *and* the secret-flagging — no action needed |
| 3.0–5.5 | Click `README.md` (root) → native side-by-side diff opens, added lines green | "It's the real VS Code diff, not a webview" |
| 5.5–7.0 | `Cmd+Enter` → accepted, panel auto-advances to the next diff | The core loop, and the speed of it |
| 7.0–8.5 | `Cmd+Enter` again → next file | Establishes rhythm; this is what sells it |
| 8.5–11.0 | Accepted view appears, badge drops | The payoff: decisions are logged, not just applied |

End on the reduced badge, not an empty panel — an empty panel reads as "nothing
happening" when the GIF loops back to a full one.

> Accepting *inside* a worktree group works too, and its record now appears under
> a worktree group in the Accepted view. It's deliberately left out of the hero
> loop: one code path, one take, fewer ways for a recording to go wrong.

> **Recorded 2026-07-31 and then withdrawn.** The first take of this cut was shot
> from `~/claudegate-demo`, and hover tooltips put `/home/<username>/...` on screen
> at frames 65, 200, 225, 229 and 259 — five separate leaks spread across the clip.
> Excising them all would have gutted the walkthrough, so it was pulled from the
> README rather than published. Re-shoot from `/tmp/demo`. The hero cut survived
> because it had only three tooltip moments, few enough to cut cleanly.

## Cut 2 — the walkthrough (~35 s, MP4, for a post or the repo)

Same opening, then continue past the hero beats:

7. Reject a file — the editor visibly reverts to the original content.
8. Open the **History** panel — show the accepted/rejected log with the agent
   session IDs attached.
9. Toggle **Group by Session** — the same 11 files regroup by *which agent* made
   them rather than by worktree. This is the "nothing else does this" moment and
   deserves its own beat.
10. End on the Pending panel drained to zero and the "All caught up" welcome view.

Keep this as MP4, not GIF — 35 s of GIF is an unreasonable download.

## Recording

`peek` is already installed and is the shortest path — region-select, record,
GIF out:

```bash
peek &
```

For the sharper two-pass route (better colour on diff syntax highlighting),
record to MP4 first. **Crop before you scale** — a 1440×900 capture of this UI has
content only in the top ~430px, and scaling the dead space down with it wastes the
byte budget on empty editor. Cropping first buys a bigger render (1200px instead of
900px) for the same file size, which is the difference between legible and not:

```bash
# 1. Palette from the CROPPED, scaled frames — see the stats_mode warning below.
ffmpeg -i Cut1.mp4 -vf "crop=1440:430:0:0,fps=10,scale=1200:-1:flags=lanczos,palettegen=stats_mode=full" palette.png
# 2. Apply it. dither=none is both smallest AND crispest on flat UI colours.
ffmpeg -i Cut1.mp4 -i palette.png \
  -lavfi "crop=1440:430:0:0,fps=10,scale=1200:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none" demo.gif
```

Find your own crop height by extracting a late frame (`-vf "select=eq(n\,110)"`)
and measuring where the content actually stops — it differs per cut. The
walkthrough cut needs the full panel height (`crop=1440:886:0:0`) because the
Accepted/Rejected panels at the bottom *are* its payoff.

> **Never use `palettegen=stats_mode=diff` for a screen recording.** It weights the
> palette toward *changing* regions, so on a hard cut (switching to a different
> file's diff) the new content has no good palette entry and the GIF's
> transparency-based frame optimisation leaves **stale pixels from the previous
> screen** — a "black pane" of old content that looks like a rendering bug. The
> default `stats_mode=full` builds the palette from every frame and fixes it at
> zero cost in file size. Disabling the optimisation instead (`-gifflags -transdiff`)
> also works but blew this 12s clip from 1.1 MB to **7.1 MB** — treat it as a last
> resort, not the fix.

**Verify before you ship it.** Ghosting is invisible in a single frame; check a
contact sheet across the whole clip:

```bash
ffmpeg -i demo.gif -vf "select='not(mod(n,6))',scale=380:-1" -vsync 0 f_%02d.png
montage f_*.png -tile 4x -geometry +2+2 -background '#ff00ff' sheet.png
```

`gifski` produces noticeably better output than either and is worth the install
(`cargo install gifski`):

```bash
ffmpeg -i demo.mp4 -vf "fps=12,scale=900:-1:flags=lanczos" frame%04d.png
gifski -o demo.gif --fps 12 --quality 90 frame*.png
```

**Budget: keep the GIF under ~5 MB.** GitHub will render more, but a README that
takes seconds to paint loses the reader. If you're over, drop to 10 fps before you
drop resolution — smoothness matters less than legible text.

## Where it goes

1. `README.md` — first thing after the title, above the badges and the
   description. Replace the current `## Screenshot` section; static PNGs move
   below it as secondary detail.
2. Both marketplace listings — they render the README and fetch its images over
   HTTPS from GitHub, so this is automatic **once the image is pushed to the
   default branch**. Either link style works: `vsce package` rewrites relative
   `media/...` paths to `https://github.com/<repo>/raw/HEAD/...` from the
   `repository` field. We use absolute `raw.githubusercontent.com` URLs anyway so
   the same README renders identically outside the vsce pipeline.

   Because the listing always fetches from GitHub, the image files are excluded
   from the VSIX (`.vscodeignore`) — that took the package from 1.41 MB to 81 KB.
   The catch: **push before you publish**, or the listing shows broken images.
3. The community post — lead with it; it is the post.

## Checklist before publishing the asset

- [ ] No real workspace, repo, or module names anywhere in frame
- [ ] **No `/home/<username>` in any tooltip** — hover tooltips show absolute paths.
      Seed the fixture at `/tmp/demo` (above) rather than excising frames later.
      To audit an existing GIF, dump frames and scan for popups:
      `ffmpeg -i demo.gif f_%03d.png && montage f_*.png -tile 7x -geometry +2+2 sheet.png`
- [ ] No account name, email, or avatar in the status/title bar
- [ ] No notification toasts
- [ ] Text legible at the final scaled width, on a phone
- [ ] Loops without a visible jump
- [ ] Under ~5 MB
- [ ] Absolute raw-githubusercontent URL in the README (so both registries render it)
