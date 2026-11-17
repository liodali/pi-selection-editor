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

console.log("toggle command");
check("command registered", !!commands["selection-editor"]);
await commands["selection-editor"].handler("", mockCtx);
check("toggle disables", editorFactory === undefined);
await commands["selection-editor"].handler("", mockCtx);
check("toggle re-enables", typeof editorFactory === "function");

console.log(`\n${passed} passed, ${failed} failed`);
if (notifications.length) console.log("notifications:", notifications);
process.exit(failed ? 1 : 0);
