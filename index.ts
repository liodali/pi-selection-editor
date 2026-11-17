/**
 * pi-selection-editor — text selection for Pi's input editor.
 *
 * Pi's built-in editor has no keyboard text selection. This extension swaps in
 * a CustomEditor subclass that adds:
 *
 *   Shift+Left/Right          select by character
 *   Shift+Up/Down             select by (visual) line
 *   Shift+Alt/Ctrl+Left/Right select by word
 *   Shift+Home / Shift+End    select to line start / end
 *   Shift+PageUp/PageDown     select by page
 *   Ctrl+Shift+A              select all
 *   Backspace/Delete/Ctrl+W…  delete the selection
 *   typing / paste / Ctrl+Y   replace the selection
 *   Ctrl+C / Ctrl+X           copy / cut selection (only while idle)
 *   Escape                    clear selection
 *   double-click              select word (paste markers are atomic)
 *   triple-click              select line
 *   Shift+click               extend selection to click position
 *
 * Highlight uses the active theme's `selectedBg` token.
 *
 * NOTE: cursor control requires a few private Editor internals (pi exposes no
 * public cursor setter). Accessed defensively at runtime; if a future pi
 * version changes them, the extension falls back to default editing.
 * Verified against pi 1.5.2.
 */
import {
	CustomEditor,
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	getKeybindings,
	matchesKey,
	visibleWidth,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

type Pos = { line: number; col: number };

interface VisualLine {
	logicalLine: number;
	startCol: number;
	length: number;
}

interface LayoutLine {
	text: string;
	hasCursor: boolean;
	cursorPos?: number;
}

/** Runtime shape of pi-tui Editor internals (private in TS, plain JS at runtime). */
interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	scrollOffset: number;
	renderedVisibleLineCount: number;
	lastWidth: number;
	jumpMode: string | null;
	autocompleteState: unknown;
	lastAction: string | null;
	setCursorCol(col: number): void;
	moveCursor(deltaLine: number, deltaCol: number): void;
	moveWordBackwards(): void;
	moveWordForwards(): void;
	moveToLineStart(): void;
	moveToLineEnd(): void;
	pageScroll(direction: number): void;
	pushUndoSnapshot(): void;
	cancelAutocomplete(): void;
	exitHistoryBrowsing(): void;
	buildVisualLineMap(width: number): VisualLine[];
	layoutText(width: number): LayoutLine[];
	segment(text: string, granularity: "grapheme" | "word"): Iterable<{ segment: string; index: number }>;
}

/** Length of the escape sequence starting at s[i] (s[i] === ESC). Zero-width. */
function scanEscape(s: string, i: number): number {
	const c = s[i + 1];
	if (c === "[") {
		// CSI: parameter/intermediate bytes until a final byte @-~
		let j = i + 2;
		while (j < s.length) {
			const code = s.charCodeAt(j);
			if (code >= 0x40 && code <= 0x7e) return j + 1;
			j++;
		}
		return j;
	}
	if (c === "]" || c === "_" || c === "P" || c === "^") {
		// OSC / APC / DCS / PM: until BEL or ST (ESC \)
		let j = i + 2;
		while (j < s.length) {
			if (s[j] === "\x07") return j + 1;
			if (s[j] === "\x1b" && s[j + 1] === "\\") return j + 2;
			j++;
		}
		return j;
	}
	return Math.min(i + 2, s.length);
}

class SelectionEditor extends CustomEditor {
	private anchor: Pos | null = null;
	private readonly appKeybindings: KeybindingsManager;
	private readonly ctx: ExtensionContext;
	private readonly isWorking: () => boolean;
	private readonly broken: boolean;
	private lastClick: { time: number; x: number; y: number; count: number } | null = null;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		ctx: ExtensionContext,
		isWorking: () => boolean,
	) {
		super(tui, theme, keybindings);
		this.appKeybindings = keybindings;
		this.ctx = ctx;
		this.isWorking = isWorking;
		const it = this.internals;
		this.broken =
			!it.state ||
			typeof it.moveCursor !== "function" ||
			typeof it.buildVisualLineMap !== "function" ||
			typeof it.layoutText !== "function";
		if (this.broken) {
			ctx.ui.notify("pi-selection-editor: editor internals changed in this pi version; using default editing", "warning");
		}
	}

	private get internals(): EditorInternals {
		return this as unknown as EditorInternals;
	}

	// ── selection state ────────────────────────────────────────────────────

	private cursorPos(): Pos {
		const c = this.getCursor();
		return { line: c.line, col: c.col };
	}

	private setCursor(pos: Pos): void {
		const it = this.internals;
		it.state.cursorLine = pos.line;
		it.setCursorCol(pos.col);
	}

	/** Normalized, bounds-clamped selection range; null when nothing is selected. */
	private selectionRange(): { start: Pos; end: Pos } | null {
		if (!this.anchor) return null;
		const lines = this.internals.state.lines;
		const clamp = (p: Pos): Pos => {
			const line = Math.max(0, Math.min(p.line, lines.length - 1));
			return { line, col: Math.max(0, Math.min(p.col, (lines[line] ?? "").length)) };
		};
		const a = clamp(this.anchor);
		const c = clamp(this.cursorPos());
		if (a.line === c.line && a.col === c.col) return null;
		const aFirst = a.line < c.line || (a.line === c.line && a.col < c.col);
		return aFirst ? { start: a, end: c } : { start: c, end: a };
	}

	private hasSelection(): boolean {
		return this.selectionRange() !== null;
	}

	private selectedText(): string {
		const range = this.selectionRange();
		if (!range) return "";
		const { start, end } = range;
		const lines = this.internals.state.lines;
		if (start.line === end.line) return (lines[start.line] ?? "").slice(start.col, end.col);
		const parts = [(lines[start.line] ?? "").slice(start.col)];
		for (let l = start.line + 1; l < end.line; l++) parts.push(lines[l] ?? "");
		parts.push((lines[end.line] ?? "").slice(0, end.col));
		return parts.join("\n");
	}

	private clearSelection(render = true): void {
		if (this.anchor) {
			this.anchor = null;
			if (render) this.tui.requestRender();
		}
	}

	/** Delete the selected range. One undo snapshot; cursor lands at range start. */
	private deleteSelection(): boolean {
		const range = this.selectionRange();
		if (!range) {
			this.anchor = null;
			return false;
		}
		const it = this.internals;
		const { start, end } = range;
		it.pushUndoSnapshot();
		it.exitHistoryBrowsing();
		const before = (it.state.lines[start.line] ?? "").slice(0, start.col);
		const after = (it.state.lines[end.line] ?? "").slice(end.col);
		it.state.lines = [
			...it.state.lines.slice(0, start.line),
			before + after,
			...it.state.lines.slice(end.line + 1),
		];
		this.setCursor(start);
		it.lastAction = null;
		it.cancelAutocomplete();
		this.anchor = null;
		this.onChange?.(this.getText());
		this.tui.requestRender();
		return true;
	}

	private async copySelection(cut: boolean): Promise<void> {
		const text = this.selectedText();
		if (!text) return;
		try {
			await copyToClipboard(text);
			this.ctx.ui.notify(`${cut ? "Cut" : "Copied"} ${text.length} chars`, "info");
		} catch {
			this.ctx.ui.notify("pi-selection-editor: clipboard copy failed", "warning");
		}
		if (cut) this.deleteSelection();
	}

	private extendSelection(move: () => void): void {
		if (!this.anchor) this.anchor = this.cursorPos();
		move();
		this.tui.requestRender();
	}

	/** Vertical selection movement by visual line; never browses history. */
	private moveVertical(dir: -1 | 1): void {
		const it = this.internals;
		if (it.lastWidth > 0) {
			it.moveCursor(dir, 0);
			return;
		}
		// Before first render: fall back to logical lines.
		const target = Math.max(0, Math.min(it.state.lines.length - 1, it.state.cursorLine + dir));
		it.state.cursorLine = target;
		it.setCursorCol(Math.min(it.state.cursorCol, (it.state.lines[target] ?? "").length));
	}

	// ── keyboard ───────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.broken) {
			super.handleInput(data);
			return;
		}
		const it = this.internals;
		const kb = getKeybindings();

		// Character-jump mode (ctrl+]): let the base editor consume the jump target.
		if (it.jumpMode !== null && it.jumpMode !== undefined) {
			this.clearSelection(false);
			super.handleInput(data);
			return;
		}

		// Bracketed paste replaces the selection (first chunk carries the start marker).
		if (data.includes("\x1b[200~")) {
			if (this.hasSelection()) this.deleteSelection();
			super.handleInput(data);
			return;
		}

		// Ctrl+C copies the selection — but only while idle; during a run it stays interrupt.
		if (kb.matches(data, "tui.input.copy")) {
			if (this.hasSelection() && !this.isWorking()) {
				void this.copySelection(false);
				return;
			}
			super.handleInput(data);
			return;
		}

		// Ctrl+X (app.message.copy binding) cuts the selection while idle.
		if (this.appKeybindings.matches(data, "app.message.copy") && this.hasSelection() && !this.isWorking()) {
			void this.copySelection(true);
			return;
		}

		// Ctrl+Shift+A selects everything (Ctrl+A keeps pi's line-start binding).
		if (matchesKey(data, "ctrl+shift+a")) {
			const lines = this.getLines();
			this.anchor = { line: 0, col: 0 };
			this.setCursor({ line: lines.length - 1, col: (lines[lines.length - 1] ?? "").length });
			this.tui.requestRender();
			return;
		}

		// Shift+movement extends the selection.
		if (matchesKey(data, "shift+left")) return this.extendSelection(() => it.moveCursor(0, -1));
		if (matchesKey(data, "shift+right")) return this.extendSelection(() => it.moveCursor(0, 1));
		if (matchesKey(data, "shift+up")) return this.extendSelection(() => this.moveVertical(-1));
		if (matchesKey(data, "shift+down")) return this.extendSelection(() => this.moveVertical(1));
		if (matchesKey(data, "shift+alt+left") || matchesKey(data, "shift+ctrl+left"))
			return this.extendSelection(() => it.moveWordBackwards());
		if (matchesKey(data, "shift+alt+right") || matchesKey(data, "shift+ctrl+right"))
			return this.extendSelection(() => it.moveWordForwards());
		if (matchesKey(data, "shift+home")) return this.extendSelection(() => it.moveToLineStart());
		if (matchesKey(data, "shift+end")) return this.extendSelection(() => it.moveToLineEnd());
		if (matchesKey(data, "shift+pageUp")) return this.extendSelection(() => it.pageScroll(-1));
		if (matchesKey(data, "shift+pageDown")) return this.extendSelection(() => it.pageScroll(1));

		// Escape clears the selection first; otherwise app/autocomplete handling.
		if (matchesKey(data, "escape")) {
			if (this.anchor) {
				this.clearSelection();
				return;
			}
			super.handleInput(data);
			return;
		}

		// Undo restores old positions — drop the selection.
		if (kb.matches(data, "tui.editor.undo")) {
			this.clearSelection(false);
			super.handleInput(data);
			return;
		}

		// Any delete action kills the selection instead of deleting more text.
		if (
			this.hasSelection() &&
			(kb.matches(data, "tui.editor.deleteCharBackward") ||
				matchesKey(data, "shift+backspace") ||
				kb.matches(data, "tui.editor.deleteCharForward") ||
				matchesKey(data, "shift+delete") ||
				kb.matches(data, "tui.editor.deleteWordBackward") ||
				kb.matches(data, "tui.editor.deleteWordForward") ||
				kb.matches(data, "tui.editor.deleteToLineStart") ||
				kb.matches(data, "tui.editor.deleteToLineEnd"))
		) {
			this.deleteSelection();
			return;
		}

		// Yank and newline replace the selection, then insert at the cursor.
		if (
			this.hasSelection() &&
			(kb.matches(data, "tui.editor.yank") ||
				kb.matches(data, "tui.input.newLine") ||
				data === "\n" ||
				data === "\x1b\r" ||
				data === "\x1b[13;2~")
		) {
			this.deleteSelection();
			super.handleInput(data);
			return;
		}

		// Typing replaces the selection.
		if (this.hasSelection()) {
			const printable =
				data.length === 1
					? data.charCodeAt(0) >= 32
						? data
						: undefined
					: decodeKittyPrintable(data);
			if (
				printable !== undefined ||
				matchesKey(data, "shift+space") ||
				(!data.includes("\x1b") && data.length > 1 && data.charCodeAt(0) >= 32)
			) {
				this.deleteSelection();
				super.handleInput(data);
				return;
			}
		}

		// Submit and everything else: drop selection, defer to app + base editor.
		this.clearSelection(false);
		super.handleInput(data);
	}

	// ── programmatic text changes ──────────────────────────────────────────

	setText(text: string): void {
		this.anchor = null;
		super.setText(text);
	}

	insertTextAtCursor(text: string): void {
		// Clipboard image/file paste paths call this directly.
		if (!this.broken && this.hasSelection()) this.deleteSelection();
		super.insertTextAtCursor(text);
	}

	// ── mouse ──────────────────────────────────────────────────────────────

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.broken || event.type !== "click" || event.button !== "left") {
			return super.handleMouse(event);
		}
		const now = Date.now();
		let count = event.clickCount ?? 0;
		if (!count) {
			const last = this.lastClick;
			count =
				last && now - last.time < 500 && Math.abs(last.x - event.x) <= 1 && Math.abs(last.y - event.y) <= 1
					? last.count + 1
					: 1;
		}
		this.lastClick = { time: now, x: event.x, y: event.y, count };

		// Shift+click extends the selection to the clicked position.
		if (event.shift) {
			const pos = this.mouseToPos(event);
			if (pos) {
				if (!this.anchor) this.anchor = this.cursorPos();
				this.setCursor(pos);
				this.internals.lastAction = null;
				this.tui.requestRender();
				return { handled: true, focus: true };
			}
		}

		const inText = event.y >= 1 && event.y <= this.internals.renderedVisibleLineCount;
		const result = super.handleMouse(event);
		if (inText) {
			if (count >= 3) this.selectLineAtCursor();
			else if (count === 2) this.selectWordAtCursor();
			else this.clearSelection(false);
		}
		return result;
	}

	/** Map a mouse event to a logical text position (mirrors base Editor click logic). */
	private mouseToPos(event: TuiMouseEvent): Pos | null {
		const it = this.internals;
		if (!(it.lastWidth > 0) || event.y <= 0 || event.y > it.renderedVisibleLineCount) return null;
		const visualLines = it.buildVisualLineMap(it.lastWidth);
		const idx = it.scrollOffset + event.y - 1;
		const vl = visualLines[idx];
		if (!vl) return null;
		const logicalLine = it.state.lines[vl.logicalLine] ?? "";
		const chunk = logicalLine.slice(vl.startCol, vl.startCol + vl.length);
		const maxPadding = Math.max(0, Math.floor((event.width - 1) / 2));
		const paddingX = Math.min(this.getPaddingX(), maxPadding);
		const targetColumn = Math.max(0, event.x - paddingX);
		let visibleColumn = 0;
		let targetIndex = chunk.length;
		let lastGraphemeIndex = 0;
		for (const g of it.segment(chunk, "grapheme")) {
			const nextColumn = visibleColumn + visibleWidth(g.segment);
			lastGraphemeIndex = g.index;
			if (targetColumn < nextColumn) {
				targetIndex = g.index;
				break;
			}
			visibleColumn = nextColumn;
		}
		const isLastSegment = idx === visualLines.length - 1 || visualLines[idx + 1]?.logicalLine !== vl.logicalLine;
		if (!isLastSegment && targetIndex === chunk.length && chunk.length > 0) targetIndex = lastGraphemeIndex;
		return { line: vl.logicalLine, col: vl.startCol + targetIndex };
	}

	private selectWordAtCursor(): void {
		const it = this.internals;
		const lineNo = it.state.cursorLine;
		const line = it.state.lines[lineNo] ?? "";
		if (!line) return;
		const col = Math.min(it.state.cursorCol, line.length - 1);

		// Paste markers are atomic editing units — select the whole marker.
		for (const m of line.matchAll(/\[paste #\d+(?: \+\d+ lines| \d+ chars)?\]/g)) {
			const end = m.index + m[0].length;
			if (col >= m.index && col < end) {
				this.anchor = { line: lineNo, col: m.index };
				this.setCursor({ line: lineNo, col: end });
				this.tui.requestRender();
				return;
			}
		}

		// Expand a run of same-class codepoints (word / whitespace / other).
		const cps = Array.from(line);
		let cp = 0;
		let si = 0;
		while (cp < cps.length && si < col) {
			si += cps[cp].length;
			cp++;
		}
		if (cp >= cps.length) cp = cps.length - 1;
		const classOf = (ch: string): number => (/[\p{L}\p{N}_]/u.test(ch) ? 0 : /\s/.test(ch) ? 1 : 2);
		const cls = classOf(cps[cp]);
		let start = cp;
		let end = cp;
		while (start > 0 && classOf(cps[start - 1]) === cls) start--;
		while (end < cps.length - 1 && classOf(cps[end + 1]) === cls) end++;
		const startCol = cps.slice(0, start).reduce((n, c) => n + c.length, 0);
		const endCol = cps.slice(0, end + 1).reduce((n, c) => n + c.length, 0);
		this.anchor = { line: lineNo, col: startCol };
		this.setCursor({ line: lineNo, col: endCol });
		this.tui.requestRender();
	}

	private selectLineAtCursor(): void {
		const it = this.internals;
		const lineNo = it.state.cursorLine;
		this.anchor = { line: lineNo, col: 0 };
		this.setCursor({ line: lineNo, col: (it.state.lines[lineNo] ?? "").length });
		this.tui.requestRender();
	}

	// ── rendering ──────────────────────────────────────────────────────────

	render(width: number): string[] {
		const lines = super.render(width);
		if (this.broken) return lines;
		const range = this.selectionRange();
		if (!range) return lines;

		const it = this.internals;
		// Recompute the exact layout super.render() used (same width math).
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.getPaddingX(), maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
		const layoutLines = it.layoutText(layoutWidth);
		const visualLines = it.buildVisualLineMap(layoutWidth);
		const bgOn = this.ctx.ui.theme.getBgAnsi("selectedBg");
		const bgOff = "\x1b[49m";
		const { start, end } = range;

		const count = Math.min(it.renderedVisibleLineCount, layoutLines.length, visualLines.length);
		for (let i = 0; i < count; i++) {
			const li = i + it.scrollOffset;
			const ll = layoutLines[li];
			const vl = visualLines[li];
			const outIndex = i + 1; // line 0 is the top border
			if (!ll || !vl || outIndex >= lines.length) continue;
			const L = vl.logicalLine;
			if (L < start.line || L > end.line) continue;

			// Empty line strictly inside a multi-line selection: fill the row.
			if (ll.text === "" && !ll.hasCursor && L > start.line && L < end.line) {
				lines[outIndex] = " ".repeat(paddingX) + bgOn + " ".repeat(contentWidth) + bgOff + " ".repeat(paddingX);
				continue;
			}

			const selStart = L === start.line ? start.col : 0;
			const selEnd = L === end.line ? end.col : (it.state.lines[L] ?? "").length;
			if (selStart >= selEnd) continue;
			lines[outIndex] = this.highlightLine(lines[outIndex], paddingX, ll, vl, selStart, selEnd, bgOn, bgOff);
		}
		return lines;
	}

	/**
	 * Inject selection background into one rendered editor row without changing
	 * its visible width. Walks the row's graphemes (paste-marker aware), skipping
	 * zero-width escape sequences (SGR, cursor APC markers), and wraps selected
	 * runs in bg on/off. Padding after the text is never highlighted.
	 */
	private highlightLine(
		line: string,
		paddingX: number,
		layoutLine: LayoutLine,
		visualLine: VisualLine,
		selStart: number,
		selEnd: number,
		bgOn: string,
		bgOff: string,
	): string {
		const it = this.internals;
		const text = layoutLine.text;
		const graphemes = [...it.segment(text, "grapheme")];
		const cursorAtEnd = layoutLine.hasCursor && layoutLine.cursorPos === text.length;
		const displayCount = graphemes.length + (cursorAtEnd ? 1 : 0);
		if (displayCount === 0) return line;

		let out = line.slice(0, paddingX);
		let pos = paddingX;
		let gi = 0;
		let selOpen = false;
		while (pos < line.length && gi < displayCount) {
			if (line[pos] === "\x1b") {
				const end = scanEscape(line, pos);
				out += line.slice(pos, end);
				pos = end;
				continue;
			}
			let g: string;
			let col: number;
			if (gi < graphemes.length) {
				g = graphemes[gi].segment;
				col = visualLine.startCol + graphemes[gi].index;
			} else {
				g = " "; // trailing fake-cursor space
				col = visualLine.startCol + text.length;
			}
			if (!line.startsWith(g, pos)) break; // unexpected layout — leave the rest untouched
			const selected = col >= selStart && col < selEnd;
			if (selected && !selOpen) {
				out += bgOn;
				selOpen = true;
			}
			if (!selected && selOpen) {
				out += bgOff;
				selOpen = false;
			}
			out += g;
			pos += g.length;
			gi++;
		}
		if (selOpen) out += bgOff;
		out += line.slice(pos);
		return out;
	}
}

export default function (pi: ExtensionAPI) {
	let working = false;
	pi.on("agent_start", () => {
		working = true;
	});
	pi.on("agent_settled", () => {
		working = false;
	});

	const factory = (ctx: ExtensionContext) => (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) =>
		new SelectionEditor(tui, theme, keybindings, ctx, () => working);

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent(factory(ctx));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setEditorComponent(undefined);
	});

	pi.registerCommand("selection-editor", {
		description: "Toggle the selection editor (shift+arrow text selection)",
		handler: async (_args, ctx) => {
			if (ctx.ui.getEditorComponent()) {
				ctx.ui.setEditorComponent(undefined);
				ctx.ui.notify("Selection editor disabled", "info");
			} else {
				ctx.ui.setEditorComponent(factory(ctx));
				ctx.ui.notify("Selection editor enabled — shift+arrows to select", "info");
			}
		},
	});
}
