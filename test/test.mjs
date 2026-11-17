/**
 * Runtime tests for pi-selection-editor against the installed pi's real modules.
 * Run: node test/test.mjs   (auto-detects the latest pi release)
 * Re-run after pi updates: failures here mean editor internals changed.
 */
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const releasesDir = join(homedir(), ".pi/agent/install/releases");
const latest = readdirSync(releasesDir)
	.filter((d) => /^\d+\.\d+\.\d+$/.test(d))
	.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
	.pop();
if (!latest) {
	console.error("No pi release found under", releasesDir);
	process.exit(1);
}
const NM = join(releasesDir, latest, "node_modules");
globalThis.__PI_NM = NM;
console.log(`Testing against pi ${latest}\n`);

const { createJiti } = await import(join(NM, "jiti/lib/jiti.mjs"));
const { visibleWidth, stripTerminalSequences } = await import(join(NM, "@earendil-works/pi-tui/dist/index.js"));

const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": join(here, "shim.mjs"),
		"@earendil-works/pi-tui": join(NM, "@earendil-works/pi-tui/dist/index.js"),
	},
});

const mod = await jiti.import(join(here, "..", "index.ts"));
const extension = mod.default;

// ── mocks ──────────────────────────────────────────────────────────────────
const notifications = [];
let editorFactory;
const handlers = {};
const commands = {};
const mockPi = {
	on: (ev, fn) => (handlers[ev] = fn),
	registerCommand: (name, def) => (commands[name] = def),
};
const mockCtx = {
	ui: {
		notify: (m, t) => notifications.push([t, m]),
		theme: { getBgAnsi: () => "\x1b[48;5;24m" },
		setEditorComponent: (f) => (editorFactory = f),
		getEditorComponent: () => editorFactory,
	},
};
const mockTui = { terminal: { rows: 24, columns: 80 }, requestRender() {} };
const mockEditorTheme = {
	borderColor: (s) => s,
	selectList: { selectedPrefix: (s) => s, selectedText: (s) => s, description: (s) => s, scrollInfo: (s) => s },
};
const mockKb = { matches: (data, action) => action === "app.message.copy" && data === "\x18" };

extension(mockPi);
handlers.session_start({}, mockCtx);
const ed = editorFactory(mockTui, mockEditorTheme, mockKb);

// ── helpers ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
	if (cond) {
		passed++;
		console.log(`  ok  ${name}`);
	} else {
		failed++;
		console.log(`FAIL  ${name} ${extra}`);
	}
}
const sel = () => ed.selectedText();
const text = () => ed.getText();
const type = (d) => ed.handleInput(d);
const SHIFT_LEFT = "\x1b[1;2D";
const SHIFT_CTRL_RIGHT = "\x1b[1;6C";
const CTRL_SHIFT_A = "\x1b[97;6u"; // kitty: ctrl+shift+a
const BG = "\x1b[48;5;24m";

// ── tests ──────────────────────────────────────────────────────────────────
console.log("selection basics");
ed.setText("hello world"); // cursor at end
for (let i = 0; i < 5; i++) type(SHIFT_LEFT);
check("shift+left x5 selects 'world'", sel() === "world", `got ${JSON.stringify(sel())}`);

const rendered = ed.render(40);
const textRow = rendered[1];
check("render highlights selection", textRow.includes(BG));
check("render keeps visible width", visibleWidth(textRow) === 40, `got ${visibleWidth(textRow)}`);
check("render keeps text content", stripTerminalSequences(textRow).trimEnd() === "hello world");

console.log("type-to-replace + undo");
type("X");
check("typing replaces selection", text() === "hello X", `got ${JSON.stringify(text())}`);
type("\x1f"); // ctrl+- undo (insert)
type("\x1f"); // undo (selection delete)
check("two undos restore original", text() === "hello world", `got ${JSON.stringify(text())}`);

console.log("select-all + delete");
type(CTRL_SHIFT_A);
check("ctrl+shift+a selects all", sel() === "hello world", `got ${JSON.stringify(sel())}`);
type("\x7f"); // backspace
check("backspace deletes selection only", text() === "", `got ${JSON.stringify(text())}`);
type("\x1f");
check("undo restores deleted selection", text() === "hello world");

console.log("word selection");
ed.setText("foo bar baz");
type("\x01"); // ctrl+a -> line start
type(SHIFT_CTRL_RIGHT);
check("shift+ctrl+right selects word", sel() === "foo", `got ${JSON.stringify(sel())}`);
type("Z");
check("replace word", text() === "Z bar baz", `got ${JSON.stringify(text())}`);

console.log("multi-line selection");
ed.setText("aaa\nbbb\nccc");
type("\x1b[H"); // home -> start of last line
type("\x1b[1;2A"); // shift+up
check("shift+up selects across lines", sel() === "bbb\n", `got ${JSON.stringify(sel())}`);
type("\x7f");
check("multi-line delete joins lines", text() === "aaa\nccc", `got ${JSON.stringify(text())}`);

console.log("deselect paths");
ed.setText("hello world");
type(SHIFT_LEFT);
type("\x1b[C"); // plain right
check("plain arrow clears selection", sel() === "");
type(SHIFT_LEFT);
type("\x1b"); // escape
check("escape clears selection", sel() === "");

console.log("paste replaces selection");
ed.setText("hello world");
for (let i = 0; i < 5; i++) type(SHIFT_LEFT);
type("\x1b[200~XYZ\x1b[201~");
check("bracketed paste replaces selection", text() === "hello XYZ", `got ${JSON.stringify(text())}`);

console.log("mouse");
ed.setText("hello world");
ed.render(40);
const click = (x, extra = {}) => ({
	type: "click",
	button: "left",
	x,
	y: 1,
	screenX: x,
	screenY: 1,
	width: 40,
	height: 3,
	shift: false,
	alt: false,
	ctrl: false,
	...extra,
});
ed.handleMouse(click(2, { clickCount: 2 }));
check("double-click selects word", sel() === "hello", `got ${JSON.stringify(sel())}`);
ed.handleMouse(click(8, { shift: true }));
check("shift+click extends selection", sel() === "hello wo", `got ${JSON.stringify(sel())}`);
ed.handleMouse(click(2, { clickCount: 3 }));
check("triple-click selects line", sel() === "hello world", `got ${JSON.stringify(sel())}`);
ed.handleMouse(click(2, { clickCount: 1 }));
check("plain click clears selection", sel() === "");
// manual double-click detection without terminal clickCount
await new Promise((r) => setTimeout(r, 600));
ed.handleMouse(click(3));
ed.handleMouse(click(3));
check("manual double-click detection selects word", sel() === "hello", `got ${JSON.stringify(sel())}`);
await new Promise((r) => setTimeout(r, 600));
ed.handleMouse(click(3));
check("plain click after pause clears selection", sel() === "");

console.log("unicode + wrapping render integrity");
ed.setText("héllo 🌍 world");
type(CTRL_SHIFT_A);
for (const w of [40, 12, 7]) {
	const rows = ed.render(w);
	const widthsOk = rows.slice(1, 1 + ed.renderedVisibleLineCount).every((r) => visibleWidth(r) === w);
	check(`width preserved @${w}`, widthsOk);
}
ed.setText("the quick brown fox jumps over the lazy dog and keeps running far away");
type(CTRL_SHIFT_A);
const wrapped = ed.render(20);
const body = wrapped.slice(1, 1 + ed.renderedVisibleLineCount);
check("wrapped selection highlights multiple rows", body.filter((r) => r.includes(BG)).length >= 3);
check("wrapped widths preserved", body.every((r) => visibleWidth(r) === 20));
check("wrapped content preserved", stripTerminalSequences(body.join("")).replace(/\s+/g, " ").trim() === ed.getText());

console.log("shift+enter replaces selection with newline");
ed.setText("hello world");
for (let i = 0; i < 5; i++) type(SHIFT_LEFT);
type("\x1b[13;2~"); // shift+enter legacy
check("newline replaces selection", text() === "hello \n", `got ${JSON.stringify(text())}`);

console.log("mouse drag selection");
const mouse = (type, x, y, extra = {}) => ({
	type,
	button: "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width: 40,
	height: 10,
	shift: false,
	alt: false,
	ctrl: false,
	...extra,
});
ed.setText("hello world");
ed.render(40);
ed.handleMouse(mouse("press", 2, 1));
ed.handleMouse(mouse("drag", 7, 1));
ed.handleMouse(mouse("release", 7, 1));
check("drag selects range", sel() === "llo w", `got ${JSON.stringify(sel())}`);
check("drag render highlights", ed.render(40)[1].includes(BG));
type("\x7f");
check("backspace deletes drag selection", text() === "heorld", `got ${JSON.stringify(text())}`);

ed.setText("hello world");
ed.render(40);
ed.handleMouse(mouse("press", 4, 1));
ed.handleMouse(mouse("release", 4, 1));
check("click positions cursor exactly", ed.getCursor().col === 4 && sel() === "", `cursor=${JSON.stringify(ed.getCursor())}`);
type("X");
check("typing at clicked position", text() === "hellXo world", `got ${JSON.stringify(text())}`);

ed.setText("aaa\nbbb\nccc");
ed.render(40);
ed.handleMouse(mouse("press", 1, 1));
ed.handleMouse(mouse("drag", 2, 3));
ed.handleMouse(mouse("release", 2, 3));
check("drag across lines", sel() === "aa\nbbb\ncc", `got ${JSON.stringify(sel())}`);
ed.handleMouse(mouse("press", 2, 3));
ed.handleMouse(mouse("drag", 1, 1));
ed.handleMouse(mouse("release", 1, 1));
check("upward drag normalizes range", sel() === "aa\nbbb\ncc", `got ${JSON.stringify(sel())}`);
type("Z");
check("typing replaces drag selection", text() === "aZc", `got ${JSON.stringify(text())}`);

console.log("drag auto-scroll");
ed.setText(Array.from({ length: 20 }, (_, i) => `line${String(i).padStart(2, "0")}`).join("\n"));
ed.internals.state.cursorLine = 0;
ed.internals.setCursorCol(0);
ed.render(40); // 24 rows -> max 7 visible, viewport at top
ed.handleMouse(mouse("press", 0, 7));
ed.handleMouse(mouse("drag", 0, 8));
ed.handleMouse(mouse("drag", 0, 8));
ed.handleMouse(mouse("release", 0, 8));
check("drag past bottom scrolls", ed.internals.scrollOffset === 2, `offset=${ed.internals.scrollOffset}`);
check("auto-scroll selection spans lines", sel() === "line06\nline07\n", `got ${JSON.stringify(sel())}`);

console.log("regular-mode mouse (opt-in)");
const { readFileSync, writeFileSync, unlinkSync, existsSync } = await import("node:fs");
const writes = [];
const regularTui = {
	mode: "regular",
	terminal: { rows: 24, columns: 80, write: (d) => writes.push(d) },
	requestRender() {},
	mouseLayout: null,
};
const ed2 = editorFactory(regularTui, mockEditorTheme, mockKb);
// widget(2 rows) + editor(3 rows) + footer(1 row) -> editor top at screen row 20 (0-based)
regularTui.mouseLayout = {
	width: 80,
	children: [{ component: {}, height: 2 }, { component: ed2, height: 3 }, { component: {}, height: 1 }],
};
ed2.setText("hello world");
ed2.render(80);
ed2.enableRegularMouse();
check("enable writes mouse reporting sequences", writes.some((w) => w.includes("?1000h") && w.includes("?1006h")));
// SGR coords are 1-based: text row = screen row 21 -> y=22; col 2 -> x=3
ed2.handleInput("\x1b[<0;3;22M"); // press
ed2.handleInput("\x1b[<32;8;22M"); // drag (button 32 = left motion)
ed2.handleInput("\x1b[<0;8;22m"); // release
check("regular-mode drag selects", ed2.selectedText() === "llo w", `got ${JSON.stringify(ed2.selectedText())}`);
ed2.handleInput("\x7f");
check("regular-mode drag selection deletable", ed2.getText() === "heorld", `got ${JSON.stringify(ed2.getText())}`);

ed2.setText("hello world");
ed2.render(80);
ed2.handleInput("\x1b[<0;5;22M");
ed2.handleInput("\x1b[<0;5;22m");
check("regular-mode click positions cursor", ed2.getCursor().col === 4 && ed2.selectedText() === "");
ed2.handleInput("\x1b[<0;5;22M");
ed2.handleInput("\x1b[<0;5;22m");
check("regular-mode double-click selects word", ed2.selectedText() === "hello", `got ${JSON.stringify(ed2.selectedText())}`);

const before = ed2.getText();
ed2.handleInput("\x1b[<64;5;22M"); // wheel: consumed
ed2.handleInput("\x1b[<0;5;5M"); // press in transcript area: ignored
ed2.handleInput("\x1b[<0;5;5m");
ed2.handleInput("\x1b[<2;5;22M"); // right button: ignored
check("wheel/outside/right-button ignored safely", ed2.getText() === before);
ed2.disableRegularMouse();
check("disable writes mouse-off sequences", writes.some((w) => w.includes("?1000l")));
const selBeforeDisable = ed2.selectedText();
ed2.handleInput("\x1b[<0;3;22M");
ed2.handleInput("\x1b[<0;8;22m");
check("SGR ignored after disable", ed2.selectedText() === selBeforeDisable);

console.log("mouse opt-in persistence");
const configPath = join(here, "..", "config.json");
const originalConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
writeFileSync(configPath, JSON.stringify({ regularModeMouse: false }));
await commands["selection-editor"].handler("mouse", mockCtx);
check("opt-in persisted on", JSON.parse(readFileSync(configPath, "utf8")).regularModeMouse === true);
await commands["selection-editor"].handler("mouse", mockCtx);
check("opt-in persisted off", JSON.parse(readFileSync(configPath, "utf8")).regularModeMouse === false);
if (originalConfig === null) unlinkSync(configPath);
else writeFileSync(configPath, originalConfig);

console.log("toggle command");
check("command registered", !!commands["selection-editor"]);
await commands["selection-editor"].handler("", mockCtx);
check("toggle disables", editorFactory === undefined);
await commands["selection-editor"].handler("", mockCtx);
check("toggle re-enables", typeof editorFactory === "function");

console.log(`\n${passed} passed, ${failed} failed`);
if (notifications.length) console.log("notifications:", notifications);
process.exit(failed ? 1 : 0);
