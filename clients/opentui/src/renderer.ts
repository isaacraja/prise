/**
 * Prise redraw model + OpenTUI renderer.
 *
 * The prise server sends redraw notifications (see `src/redraw.zig`) that describe
 * terminal updates as semantic events (write/resize/style/cursor/flush).
 *
 * This file maintains a local cell grid and can draw that grid into an OpenTUI
 * `OptimizedBuffer` via `renderToBuffer()`.
 */

import { RGBA, type OptimizedBuffer } from "@opentui/core";

export interface Cell {
  grapheme: string;
  // style_id is optional; if omitted/null, the server indicates "reuse previous".
  style_id?: number | null;
  // repeat is optional; if omitted/null, treat as 1.
  repeat?: number | null;
  // width is optional; if omitted/null, treat as 1 (2 = wide char).
  width?: number | null;
}

export interface StyleAttributes {
  fg?: number;
  bg?: number;
  fg_idx?: number;
  bg_idx?: number;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  reverse?: boolean;
  blink?: boolean;
  strikethrough?: boolean;
  ul_style?: number;
  ul_color?: number;
}

export interface CursorState {
  row: number;
  col: number;
  visible: boolean;
  shape: "block" | "beam" | "underline";
}

export interface SelectionState {
  start_row?: number;
  start_col?: number;
  end_row?: number;
  end_col?: number;
}

type Style = {
  id: number;
  attrs: StyleAttributes;
};

// OpenTUI text attributes (bitmask)
// See comment in openmux: BOLD 1, DIM 2, ITALIC 4, UNDERLINE 8, BLINK 16, INVERSE 32, HIDDEN 64, STRIKETHROUGH 128
const ATTR_BOLD = 1;
const ATTR_DIM = 2;
const ATTR_ITALIC = 4;
const ATTR_UNDERLINE = 8;
const ATTR_BLINK = 16;
const ATTR_INVERSE = 32;
const ATTR_STRIKETHROUGH = 128;

const DEFAULT_FG = RGBA.fromInts(220, 220, 220);
const DEFAULT_BG = RGBA.fromInts(0, 0, 0);

function rgbFromU32(rgb: number): { r: number; g: number; b: number } {
  return {
    r: (rgb >> 16) & 0xff,
    g: (rgb >> 8) & 0xff,
    b: rgb & 0xff,
  };
}

function xtermIndexToRgb(idx: number): { r: number; g: number; b: number } {
  // 0-15: basic ANSI colors
  const basic: Array<[number, number, number]> = [
    [0, 0, 0],
    [205, 49, 49],
    [13, 188, 121],
    [229, 229, 16],
    [36, 114, 200],
    [188, 63, 188],
    [17, 168, 205],
    [229, 229, 229],
    [102, 102, 102],
    [241, 76, 76],
    [35, 209, 139],
    [245, 245, 67],
    [59, 142, 234],
    [214, 112, 214],
    [41, 184, 219],
    [255, 255, 255],
  ];

  if (idx >= 0 && idx <= 15) {
    const [r, g, b] = basic[idx] ?? basic[0];
    return { r, g, b };
  }

  // 16-231: 6x6x6 color cube
  if (idx >= 16 && idx <= 231) {
    const n = idx - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    const steps = [0, 95, 135, 175, 215, 255];
    return { r: steps[r]!, g: steps[g]!, b: steps[b]! };
  }

  // 232-255: grayscale ramp
  if (idx >= 232 && idx <= 255) {
    const shade = 8 + (idx - 232) * 10;
    return { r: shade, g: shade, b: shade };
  }

  return { r: 220, g: 220, b: 220 };
}

export class Renderer {
  private rows = 24;
  private cols = 80;
  private grid: Array<Array<{ grapheme: string; style_id?: number }>> = [];
  private styles: Map<number, Style> = new Map();
  private cursorState: CursorState = { row: 0, col: 0, visible: false, shape: "block" };
  private selectionState: SelectionState = {};
  private titleText = "";
  private dirtyCells: Set<string> = new Set();

  // Cache RGBA objects by packed RGB key to avoid per-cell allocations.
  private rgbaCache: Map<number, RGBA> = new Map([
    [0x000000, DEFAULT_BG],
    [0xdcdcdc, DEFAULT_FG],
  ]);

  constructor(rows: number = 24, cols: number = 80) {
    this.rows = rows;
    this.cols = cols;
    this.initGrid();
    this.markAllDirty();
  }

  private initGrid(): void {
    this.grid = [];
    for (let r = 0; r < this.rows; r++) {
      const row: Array<{ grapheme: string; style_id?: number }> = [];
      for (let c = 0; c < this.cols; c++) {
        row.push({ grapheme: " " });
      }
      this.grid.push(row);
    }
  }

  private markAllDirty(): void {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.dirtyCells.add(`${r},${c}`);
      }
    }
  }

  clearDirty(): void {
    this.dirtyCells.clear();
  }

  resize(rows: number, cols: number): void {
    if (rows === this.rows && cols === this.cols) return;
    this.rows = rows;
    this.cols = cols;
    this.initGrid();
    this.dirtyCells.clear();
    this.markAllDirty();
  }

  write(row: number, col: number, cells: Cell[]): void {
    if (row < 0 || row >= this.rows) return;

    let currentStyleId: number | undefined;
    let c = col;

    for (const cell of cells) {
      if (c >= this.cols) break;

      if (cell.style_id !== undefined && cell.style_id !== null) {
        currentStyleId = cell.style_id;
      }

      const styleId = cell.style_id === undefined || cell.style_id === null ? currentStyleId : cell.style_id;
      const repeat = cell.repeat ?? 1;
      const width = cell.width ?? 1;

      for (let rep = 0; rep < repeat; rep++) {
        if (c >= this.cols) break;

        if (width === 2 && c + 1 < this.cols) {
          this.grid[row]![c] = { grapheme: cell.grapheme, style_id: styleId };
          this.grid[row]![c + 1] = { grapheme: " ", style_id: styleId };
          this.dirtyCells.add(`${row},${c}`);
          this.dirtyCells.add(`${row},${c + 1}`);
          c += 2;
        } else {
          this.grid[row]![c] = { grapheme: cell.grapheme, style_id: styleId };
          this.dirtyCells.add(`${row},${c}`);
          c += 1;
        }
      }
    }
  }

  style(id: number, attrs: StyleAttributes): void {
    this.styles.set(id, { id, attrs });
  }

  cursorPos(row: number, col: number, visible: boolean): void {
    // mark old cursor location dirty
    this.dirtyCells.add(`${this.cursorState.row},${this.cursorState.col}`);

    this.cursorState = { ...this.cursorState, row, col, visible };

    // mark new cursor location dirty
    this.dirtyCells.add(`${row},${col}`);
  }

  cursorShape(shape: number): void {
    const shapes = ["block", "beam", "underline"] as const;
    this.cursorState = { ...this.cursorState, shape: shapes[shape] ?? "block" };
  }

  selection(
    start_row: number | null,
    start_col: number | null,
    end_row: number | null,
    end_col: number | null
  ): void {
    this.selectionState = {
      start_row: start_row ?? undefined,
      start_col: start_col ?? undefined,
      end_row: end_row ?? undefined,
      end_col: end_col ?? undefined,
    };
  }

  title(text: string): void {
    this.titleText = text;
  }

  getState(): {
    rows: number;
    cols: number;
    cursor: CursorState;
    title: string;
    selection: SelectionState;
    style_count: number;
  } {
    return {
      rows: this.rows,
      cols: this.cols,
      cursor: this.cursorState,
      title: this.titleText,
      selection: this.selectionState,
      style_count: this.styles.size,
    };
  }

  private rgbaFor(rgb: number): RGBA {
    const key = rgb & 0xffffff;
    const cached = this.rgbaCache.get(key);
    if (cached) return cached;

    const { r, g, b } = rgbFromU32(key);
    const rgba = RGBA.fromInts(r, g, b);
    this.rgbaCache.set(key, rgba);
    return rgba;
  }

  private rgbaForIndex(idx: number): RGBA {
    const rgb = xtermIndexToRgb(idx);
    const key = (rgb.r << 16) | (rgb.g << 8) | rgb.b;
    const cached = this.rgbaCache.get(key);
    if (cached) return cached;

    const rgba = RGBA.fromInts(rgb.r, rgb.g, rgb.b);
    this.rgbaCache.set(key, rgba);
    return rgba;
  }

  renderToBuffer(
    buffer: OptimizedBuffer,
    opts: {
      width: number;
      height: number;
      offsetX?: number;
      offsetY?: number;
      isFocused?: boolean;
      forceFullRedraw?: boolean;
    }
  ): void {
    const offsetX = opts.offsetX ?? 0;
    const offsetY = opts.offsetY ?? 0;
    const width = opts.width;
    const height = opts.height;
    const isFocused = opts.isFocused ?? true;

    // OpenTUI's render buffer is per-frame; do a full draw when requested.
    if (opts.forceFullRedraw) {
      const maxRows = Math.min(height, this.rows);
      const maxCols = Math.min(width, this.cols);

      for (let row = 0; row < maxRows; row++) {
        for (let col = 0; col < maxCols; col++) {
          const cell = this.grid[row]![col]!;
          const glyph = cell.grapheme && cell.grapheme.length > 0 ? cell.grapheme : " ";

          let fg = DEFAULT_FG;
          let bg = DEFAULT_BG;
          let attrs = 0;

          const styleId = cell.style_id;
          if (styleId !== undefined) {
            const style = this.styles.get(styleId);
            if (style) {
              const a = style.attrs;

              if (a.fg !== undefined) fg = this.rgbaFor(a.fg);
              else if (a.fg_idx !== undefined) fg = this.rgbaForIndex(a.fg_idx);

              if (a.bg !== undefined) bg = this.rgbaFor(a.bg);
              else if (a.bg_idx !== undefined) bg = this.rgbaForIndex(a.bg_idx);

              if (a.bold) attrs |= ATTR_BOLD;
              if (a.dim) attrs |= ATTR_DIM;
              if (a.italic) attrs |= ATTR_ITALIC;
              if (a.underline) attrs |= ATTR_UNDERLINE;
              if (a.blink) attrs |= ATTR_BLINK;
              if (a.strikethrough) attrs |= ATTR_STRIKETHROUGH;

              if (a.reverse) {
                const tmp = fg;
                fg = bg;
                bg = tmp;
              }
            }
          }

          const isCursor =
            isFocused &&
            this.cursorState.visible &&
            this.cursorState.row === row &&
            this.cursorState.col === col;

          if (isCursor) {
            // Avoid inverting the underlying glyph unless we're a block cursor.
            // Inversion reads as "highlighted text" to users.
            if (this.cursorState.shape === "block") {
              attrs |= ATTR_INVERSE;
            } else {
              attrs |= ATTR_UNDERLINE;
            }
          }

          buffer.setCell(col + offsetX, row + offsetY, glyph, fg, bg, attrs);
        }
      }

      return;
    }

    // Paint dirty cells only.
    for (const key of this.dirtyCells) {
      const [rowStr, colStr] = key.split(",");
      const row = Number(rowStr);
      const col = Number(colStr);

      if (!Number.isFinite(row) || !Number.isFinite(col)) continue;
      if (row < 0 || col < 0) continue;
      if (row >= height || col >= width) continue;
      if (row >= this.rows || col >= this.cols) continue;

      const cell = this.grid[row]![col]!;
      const glyph = cell.grapheme && cell.grapheme.length > 0 ? cell.grapheme : " ";

      let fg = DEFAULT_FG;
      let bg = DEFAULT_BG;
      let attrs = 0;

      const styleId = cell.style_id;
      if (styleId !== undefined) {
        const style = this.styles.get(styleId);
        if (style) {
          const a = style.attrs;

          if (a.fg !== undefined) fg = this.rgbaFor(a.fg);
          else if (a.fg_idx !== undefined) fg = this.rgbaForIndex(a.fg_idx);

          if (a.bg !== undefined) bg = this.rgbaFor(a.bg);
          else if (a.bg_idx !== undefined) bg = this.rgbaForIndex(a.bg_idx);

          if (a.bold) attrs |= ATTR_BOLD;
          if (a.dim) attrs |= ATTR_DIM;
          if (a.italic) attrs |= ATTR_ITALIC;
          if (a.underline) attrs |= ATTR_UNDERLINE;
          if (a.blink) attrs |= ATTR_BLINK;
          if (a.strikethrough) attrs |= ATTR_STRIKETHROUGH;

          if (a.reverse) {
            const tmp = fg;
            fg = bg;
            bg = tmp;
          }
        }
      }

      const isCursor =
        isFocused &&
        this.cursorState.visible &&
        this.cursorState.row === row &&
        this.cursorState.col === col;

      if (isCursor) {
        if (this.cursorState.shape === "block") {
          attrs |= ATTR_INVERSE;
        } else {
          attrs |= ATTR_UNDERLINE;
        }
      }

      buffer.setCell(col + offsetX, row + offsetY, glyph, fg, bg, attrs);
    }
  }
}
