# pi-selection-editor

Text selection for [Pi](https://pi.dev)'s input editor — select wrong text and delete/replace it, like other agent harnesses.

Pi's built-in editor has no keyboard selection. This extension installs a `CustomEditor` subclass (pi's official `ctx.ui.setEditorComponent()` hook) that adds selection with a theme-aware highlight (`selectedBg` token).

## Keys

| Action | Keys |
|---|---|
| Select by character | `Shift+←` / `Shift+→` |
| Select by line | `Shift+↑` / `Shift+↓` |
| Select by word | `Shift+Alt+←/→` or `Shift+Ctrl+←/→` |
| Select to line start/end | `Shift+Home` / `Shift+End` |
| Select by page | `Shift+PageUp` / `Shift+PageDown` |
| Select all | `Ctrl+Shift+A` (`Ctrl+A` keeps pi's line-start binding) |
| Delete selection | `Backspace`, `Delete`, `Ctrl+W`, `Alt+D`, `Ctrl+U`, `Ctrl+K` |
| Replace selection | just type, paste, or `Ctrl+Y` (yank) |
| Copy / cut | `Ctrl+C` / `Ctrl+X` — **only while idle**; during an agent run they keep pi's normal interrupt / copy-message behavior |
| Clear selection | `Esc`, or any plain cursor move |
| Undo | `Ctrl+-` (pi default) — selection deletes are undoable |

## Mouse (requires fullscreen TUI mode)

- **Click** — move the cursor to that exact position in the text
- **Drag** — select text: delete it, type over it, or `Ctrl+C` to copy it
- **Double-click** — select word (collapsed paste markers are selected whole)
- **Triple-click** — select line
- **Shift+click** — extend selection to the clicked position
- Dragging past the top/bottom edge auto-scrolls

Mouse input requires pi's **fullscreen** TUI mode (pi's default). In `regular` mode the
terminal emulator owns the mouse, so pi never sees clicks or drags. Switch via
`/settings` → TUI mode, or set `"tuiMode": "fullscreen"` in `~/.pi/agent/settings.json`.
Transcript drag-to-copy still works outside the input box.

## Install

Clone:

```bash
git clone https://github.com/liodali/pi-selection-editor.git
```

Register the folder in `~/.pi/agent/settings.json`:

```json
"extensions": ["/path/to/pi-selection-editor"]
```

Or clone/symlink it into `~/.pi/agent/extensions/` for auto-discovery. Run `/reload` in pi (or restart) to apply.

Toggle at runtime: `/selection-editor`.

## Tests

```bash
node test/test.mjs
```

32 runtime checks against the installed pi's real editor modules (auto-detects the latest release): selection, delete/replace, undo, paste, mouse, unicode/wrapped-render width integrity, toggle. Re-run after pi updates — failures mean editor internals changed and the extension needs a touch-up.

## Notes & caveats

- Terminal must report Shift+arrow sequences (iTerm2, Kitty, WezTerm, Ghostty, Windows Terminal, Terminal.app all do).
- Clipboard uses pi's own `copyToClipboard` (native on macOS/Windows, `wl-copy`/`xclip` on Linux, OSC 52 over SSH).
- Typing over a selection takes two undo steps to fully revert (selection delete, then the insert) — pi's undo is per-edit.
- Cursor control needs a few private `pi-tui` Editor internals (pi exposes no public cursor setter). Verified against **pi 1.5.2**; if a future version changes them, the extension detects it and falls back to default editing with a warning.
- Everything else (key matching, theming, clipboard, editor hook) uses public documented APIs.
