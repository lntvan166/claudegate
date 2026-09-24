#!/usr/bin/env bash
# Captures media/demo.gif and the README screenshots from a REAL VS Code, on a
# virtual display, against the seeded demo workspace. Linux-only, dev-only.
#
#   npm run compile && npx @vscode/vsce package -o /tmp/claudegate.vsix
#   dev/demo/capture.sh /tmp/claudegate.vsix      # → dev/demo/out/*.png, media/demo.gif
#
# Needs Xvfb, xdotool, ImageMagick (import) and ffmpeg. Reuses the VS Code that
# the integration suite already downloaded into .vscode-test/.
#
# Two things keep real data off the recording, and both matter: internal
# workspace and organisation names have leaked to the marketplaces before. The
# fixture is manual-test-seed.py --demo, which uses only generic names; and HOME
# is a throwaway, so the panel can only ever show that fixture's sessions, never
# yours.
#
# Almost everything is driven through the Command Palette rather than by clicking
# at fixed pixel positions. That is deliberate: coordinate-clicking is what makes
# a capture script rot, because it breaks silently whenever the editor's layout
# shifts. ClaudeGate's surface is commands, so the demo can mostly avoid it. The
# few coordinates left are marked COORD and are the first suspects if a run comes
# out looking wrong — check the numbered step PNGs in dev/demo/out/.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$ROOT/dev/demo/out
HOME_DIR=/tmp/claudegate-demo-home
PROFILE=/tmp/claudegate-shoot
WS=$HOME_DIR/claudegate-demo
CODE=$(ls -d "$ROOT"/.vscode-test/vscode-linux-x64-*/ | sort -V | tail -1)
export DISPLAY=:99
mkdir -p "$OUT"

# ── Fixture: generic names only, under a throwaway HOME ──────────────────────
rm -rf "$HOME_DIR" "$PROFILE"
mkdir -p "$HOME_DIR" "$PROFILE/user/User" "$PROFILE/ext"
echo "[1/6] seeding fixture"
HOME=$HOME_DIR python3 "$ROOT/manual-test-seed.py" --demo >/dev/null
[ -d "$WS" ] || { echo "seed did not create $WS" >&2; exit 1; }

# ── Demo-grade content ───────────────────────────────────────────────────────
# manual-test-seed.py builds files of five to eleven lines. That is right for the
# manual checklist, where the point is that capture works at all — but a
# three-line diff on a 1440px screen reads as an empty screenshot. The demo needs
# one file with enough real code that the red and green mean something.
#
# Done here rather than in the seed script, which the manual checklist and the
# integration suite both depend on.
python3 "$ROOT/dev/demo/enrich.py" "$HOME_DIR"

# ── A registered hook, so the product does not warn about itself ────────────
# With a throwaway HOME there is no ~/.claude/settings.json, so the status bar
# shows an orange "Claude Gate" warning and the Settings row reads "Hook: Not
# registered". Both are correct and both look like a broken product in its own
# demo. Register it properly against the throwaway HOME instead of hiding the
# chip: the matcher below must stay in step with PRE_TOOL_MATCHER.
mkdir -p "$HOME_DIR/.claude" "$HOME_DIR/.claudegate"
cp "$ROOT/hooks/hook.py" "$HOME_DIR/.claudegate/hook.py"
printf '#!/usr/bin/env bash\npython3 "$HOME/.claudegate/hook.py"\n' > "$HOME_DIR/.claudegate/hook.sh"
chmod +x "$HOME_DIR/.claudegate/hook.sh"
MATCHER=$(grep -oP 'PRE_TOOL_MATCHER = "\K[^"]+' "$ROOT/src/hookInstaller.ts")
cat > "$HOME_DIR/.claude/settings.json" <<EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "$MATCHER",
        "hooks": [{ "type": "command", "command": "$HOME_DIR/.claudegate/hook.sh" }]
      }
    ]
  }
}
EOF

# ── Borrow the maintainer's theme and file icons ─────────────────────────────
# The default profile has no icon theme, so every file renders with the same
# generic glyph and the tree looks lifeless. Copying just these two extensions
# into the throwaway profile keeps the recording clean — no account, no other
# extensions, nothing else that could appear on screen — while giving the demo
# real file icons and a considered palette.
#
# ClaudeGate's own colours are gitDecoration.* theme tokens, so they follow
# whatever theme is active. Filming under a third-party theme therefore shows the
# extension as a themed user sees it rather than only under the default.
for ext in dracula-theme.theme-dracula-* pkief.material-icon-theme-*; do
  src=$(ls -d "$HOME/.vscode/extensions/"$ext 2>/dev/null | sort -V | tail -1) || true
  [ -n "${src:-}" ] && [ -d "$src" ] && cp -r "$src" "$PROFILE/ext/" 2>/dev/null || true
done
# extensions.json is a cache written by whatever last touched this directory, and
# its recorded locations point at wherever that was. Copied-in directories are
# invisible until it is gone and VS Code rescans.
rm -f "$PROFILE/ext/extensions.json"

cat > "$PROFILE/user/User/settings.json" <<EOF
{
  "workbench.colorTheme": "Dracula Theme",
  "workbench.iconTheme": "material-icon-theme",
  "editor.fontFamily": "JetBrains Mono",
  "editor.fontLigatures": true,
  "workbench.startupEditor": "none",
  "window.titleBarStyle": "custom",
  "window.commandCenter": false,
  "workbench.layoutControl.enabled": false,
  "chat.commandCenter.enabled": false,
  "chat.disableAIFeatures": true,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.tips.enabled": false,
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "workbench.tree.renderIndentGuides": "always",
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "editor.minimap.enabled": false,
  "breadcrumbs.enabled": false,
  "explorer.compactFolders": false,
  "editor.fontSize": 13,
  "window.zoomLevel": 0
}
EOF

# ── Display first ────────────────────────────────────────────────────────────
# DISPLAY is already :99, so anything launched before Xvfb is up dies with a
# trace trap rather than a legible error — including --install-extension, which
# still needs a display even though it prints nothing.
echo "[2/6] starting Xvfb"
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/dev/null 2>&1 &
XVFB=$!
CODEPID=
trap 'kill ${CODEPID:-} $XVFB 2>/dev/null || true' EXIT
for _ in $(seq 40); do xdotool search --name . >/dev/null 2>&1 && break; sleep 0.25; done
sleep 1

# The extension is loaded from source rather than installed. `code
# --install-extension` HANGS on this build in a headless profile: it starts an
# agent host and never exits, so a run dies on a timeout with no error. The
# integration suite already loads from source this way and is known to work.
#
# The cost is that the window title gains "[Extension Development Host]", so the
# title bar is cropped off every capture below — a demo GIF has no use for a
# title bar showing a temp path anyway.

# ── Launch ───────────────────────────────────────────────────────────────────

echo "[4/6] launching editor"
HOME=$HOME_DIR "$CODE/code" --no-sandbox --disable-gpu \
  --user-data-dir "$PROFILE/user" --extensions-dir "$PROFILE/ext" \
  --extensionDevelopmentPath="$ROOT" --disable-workspace-trust "$WS" \
  >"$PROFILE/code.log" 2>&1 &
CODEPID=$!
for _ in $(seq 60); do
  WIN=$(xdotool search --name "Visual Studio Code" 2>/dev/null | head -1) && [ -n "$WIN" ] && break
  sleep 0.5
done
[ -n "${WIN:-}" ] || { echo "VS Code window never appeared; see $PROFILE/code.log" >&2; exit 1; }
sleep 5
xdotool windowmove "$WIN" 0 0 windowsize "$WIN" 1440 900
sleep 2

# CROP drops the 35px title bar, which carries "[Extension Development Host]"
# and a temp path. Nothing below it is chrome the demo needs to hide.
CROP="1440x865+0+35"
# Toasts stack up bottom-right and linger past the action that raised them, which
# in a GIF just reads as clutter. Clear them before each still.
shot() {
  xdotool key --clearmodifiers ctrl+shift+p; sleep 0.5
  xdotool type --delay 12 "Notifications: Clear All Notifications"; sleep 0.6
  xdotool key Return; sleep 0.6
  xdotool mousemove 1439 899; sleep 0.5
  import -window root -crop "$CROP" +repage "$OUT/$1.png"
}
cmd() { xdotool key --clearmodifiers ctrl+shift+p; sleep 0.7; xdotool type --delay 12 "$1"; sleep 0.9; xdotool key Return; sleep "${2:-1.6}"; }

# The extension activates onStartupFinished and then scans for worktrees; give it
# room before asking it to do anything, or the first command finds an empty panel.
sleep 6

echo "[5/6] driving the demo"
cmd "Claude Gate: Focus on Pending View" 2.5
# The Settings view expands by default and eats the lower half of the sidebar
# with rows the demo is not about. Focusing it lands on its CONTENT, so collapse
# it from the section header: shift+Tab moves focus up to the header, Space
# toggles it. Then hand focus back to Pending.
cmd "Claude Gate: Focus on Settings View" 1.2
xdotool key --clearmodifiers shift+Tab; sleep 0.6
xdotool key --clearmodifiers space; sleep 1.0
cmd "Claude Gate: Focus on Pending View" 1.5
shot 00-panel

# ── The GIF: the core loop, and nothing else ─────────────────────────────────
# Claude's edits are waiting → open one as a real diff → accept it → reject the
# next → see the whole set at once. That is the product in fifteen seconds; the
# filter, excludes and scoped bulk actions are left to the README screenshots.
ffmpeg -loglevel error -y -f x11grab -framerate 15 -video_size 1440x900 -i :99 \
  "$PROFILE/demo.mp4" &
FF=$!
sleep 1.5

# Driven by the mouse, because that is what a user does. The Command Palette is
# more robust to film, but it records someone typing command names rather than
# the product being used.
#
# COORD — the only fixed pixel positions in this script, and the first suspects
# if a run looks wrong. Verified against dev/demo/out/*.png at 1440x900 with
# Dark Modern and editor.fontSize 13:
#   ROW0_Y   screen y of the first row under the "Pending" header
#   ROWH     row pitch
#   ROW_X    x of a row's label (safe to click; away from the twisties)
#   OK_X/NO_X  x of the inline accept / reject icons, which appear on hover
# The tree is: service-api / handlers / checkout.go / service-core / pricing /
# discount.go, so checkout.go is row 2. After it is accepted its now-empty parent
# folders disappear too, which puts discount.go at that same row.
ROW0_Y=102; ROWH=22; ROW_X=150; OK_X=258; NO_X=277
row_y() { echo $((ROW0_Y + $1 * ROWH)); }
hover() { xdotool mousemove "$1" "$2"; sleep "${3:-0.7}"; }
tap()   { xdotool mousemove "$1" "$2"; sleep 0.45; xdotool click 1; sleep "${3:-1.6}"; }

CHECKOUT_Y=$(row_y 2)

hover $ROW_X $CHECKOUT_Y 1.0            # the inline actions appear on hover
tap   $ROW_X $CHECKOUT_Y 3.2            # click the row: its diff opens
shot 01-diff
sleep 1.2                                # let the viewer read the diff

tap   $OK_X  $CHECKOUT_Y 2.8            # click the tick: accepted, auto-advances

# Accepting empties service-api/handlers, so those rows go and discount.go takes
# the same position. Re-derived rather than assumed, so a fixture change shows up
# as a wrong click in the step PNGs instead of silently filming nothing.
DISCOUNT_Y=$(row_y 2)
hover $ROW_X $DISCOUNT_Y 0.9
tap   $ROW_X $DISCOUNT_Y 2.8
sleep 1.0
tap   $NO_X  $DISCOUNT_Y 1.3            # click the cross: reject
xdotool key --clearmodifiers Return; sleep 2.4   # blank reason = plain reject
sleep 1.5

kill -INT $FF; wait $FF 2>/dev/null || true

# The remaining stills are not part of the GIF, so they use the palette — a
# static image does not care how it was reached, and the palette cannot drift.
cmd "Claude Gate: Review All Pending" 3.5
shot 02-review-all

# ── Encode ───────────────────────────────────────────────────────────────────
# Two-pass palette: a single-pass GIF of an editor screenshot bands badly on the
# syntax colours. 10 fps at 800px keeps it near 2 MB — this is served by GitHub
# on every README view, so weight matters more than smoothness. A screen
# recording of mostly-static text loses little at 10 fps.
echo "[6/6] encoding"
ffmpeg -loglevel error -y -i "$PROFILE/demo.mp4" \
  -vf "crop=1440:865:0:35,fps=10,scale=800:-1:flags=lanczos,palettegen=stats_mode=diff" "$PROFILE/pal.png"
ffmpeg -loglevel error -y -i "$PROFILE/demo.mp4" -i "$PROFILE/pal.png" \
  -lavfi "crop=1440:865:0:35,fps=10,scale=800:-1:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=3" \
  "$OUT/demo.gif"

echo
echo "steps   : $OUT/*.png"
echo "gif     : $OUT/demo.gif  ($(du -h "$OUT/demo.gif" | cut -f1))"
echo
echo "Review the step PNGs before copying anything into media/."
