import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, For } from "solid-js";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { RGBA, type OptimizedBuffer } from "@opentui/core";

import { PriseConnection } from "./connection";
import type { RpcClient } from "./rpc";
import { encodeKey } from "./input";
import { Renderer, type StyleAttributes, type Cell as RenderCell } from "./renderer";
import { createKeyHandler, type Action } from "./keybinds";
import {
  addTab,
  assignPtyToFocused,
  closeFocused,
  findPaneInTree,
  focusNext,
  getActiveTab,
  getAllPaneIds,
  getAllPaneRects,
  getFocusedPtyId,
  getPaneRect,
  initLayout,
  setActiveTab,
  splitFocused,
  type FocusDirection,
  type LayoutNode,
  type LayoutState,
  type PaneId,
  type Rect as LayoutRect,
} from "./layout";
import { drawBorder, getInnerRect, paintRect, type Rect as BufferRect } from "./buffer";

type Mode = "picker" | "terminal";

type Session = {
  id: number;
  name: string;
  attached_client_count: number;
};

function toNumber(val: unknown): number | null {
  return typeof val === "number" && Number.isFinite(val) ? val : null;
}

function toString(val: unknown): string | null {
  return typeof val === "string" ? val : null;
}

function toStyleAttributes(val: unknown): StyleAttributes {
  if (!val || typeof val !== "object") return {};
  const obj = val as Record<string, unknown>;
  const out: StyleAttributes = {};

  if (typeof obj.fg === "number") out.fg = obj.fg;
  if (typeof obj.bg === "number") out.bg = obj.bg;
  if (typeof obj.fg_idx === "number") out.fg_idx = obj.fg_idx;
  if (typeof obj.bg_idx === "number") out.bg_idx = obj.bg_idx;

  if (typeof obj.bold === "boolean") out.bold = obj.bold;
  if (typeof obj.dim === "boolean") out.dim = obj.dim;
  if (typeof obj.italic === "boolean") out.italic = obj.italic;
  if (typeof obj.underline === "boolean") out.underline = obj.underline;
  if (typeof obj.reverse === "boolean") out.reverse = obj.reverse;
  if (typeof obj.blink === "boolean") out.blink = obj.blink;
  if (typeof obj.strikethrough === "boolean") out.strikethrough = obj.strikethrough;

  if (typeof obj.ul_style === "number") out.ul_style = obj.ul_style;
  if (typeof obj.ul_color === "number") out.ul_color = obj.ul_color;

  return out;
}

function parseWriteCells(val: unknown): RenderCell[] {
  if (!Array.isArray(val)) return [];

  const out: RenderCell[] = [];
  for (const cell of val) {
    if (!Array.isArray(cell) || cell.length < 1) continue;

    const grapheme = toString(cell[0]);
    if (grapheme === null) continue;

    const style_id = cell.length >= 2 ? toNumber(cell[1]) : null;
    const repeat = cell.length >= 3 ? toNumber(cell[2]) : null;
    const width = cell.length >= 4 ? toNumber(cell[3]) : null;

    out.push({ grapheme, style_id, repeat, width });
  }

  return out;
}

function parseSessionsFromListSessions(result: unknown): Session[] {
  if (!result || typeof result !== "object") return [];
  const obj = result as Record<string, unknown>;
  const sessions = obj.sessions;
  if (!Array.isArray(sessions)) return [];

  const parsed: Session[] = [];
  for (const s of sessions) {
    if (!s || typeof s !== "object") continue;
    const sm = s as Record<string, unknown>;
    const id = sm.id;
    const name = sm.name;
    const attached = sm.attached_client_count;
    if (typeof id !== "number" || typeof name !== "string") continue;
    parsed.push({
      id,
      name,
      attached_client_count: typeof attached === "number" ? attached : 0,
    });
  }

  return parsed;
}

function parseSessionsFromListPtys(result: unknown): Session[] {
  if (!result || typeof result !== "object") return [];
  const obj = result as Record<string, unknown>;
  const ptys = obj.ptys;
  if (!Array.isArray(ptys)) return [];

  const parsed: Session[] = [];
  for (const p of ptys) {
    if (!p || typeof p !== "object") continue;
    const pm = p as Record<string, unknown>;
    const id = pm.id;
    if (typeof id !== "number") continue;

    const title = typeof pm.title === "string" && pm.title.length > 0 ? pm.title : `PTY ${id}`;
    const attached = pm.attached_client_count;

    parsed.push({
      id,
      name: title,
      attached_client_count: typeof attached === "number" ? attached : 0,
    });
  }

  return parsed;
}

async function fetchSessions(rpc: RpcClient): Promise<Session[]> {
  try {
    const res = await rpc.request("list_sessions", null);
    const sessions = parseSessionsFromListSessions(res);
    if (sessions.length > 0) return sessions;
  } catch {
    // ignore
  }

  const fallback = await rpc.request("list_ptys", null);
  return parseSessionsFromListPtys(fallback);
}

function applyRedraw(renderersByPtyId: Map<number, Renderer>, params: unknown): boolean {
  // Per `src/redraw.zig`: notification params are `[events]`
  if (!Array.isArray(params)) return false;
  const events = params;

  let shouldFlush = false;

  for (const event of events) {
    if (!Array.isArray(event) || event.length !== 2) continue;
    const name = toString(event[0]);
    const args = event[1];
    if (!name || !Array.isArray(args)) continue;

    if (name === "flush") {
      shouldFlush = true;
      continue;
    }

    if (name === "style") {
      const id = toNumber(args[0]);
      if (id === null) continue;
      const attrs = toStyleAttributes(args[1]);
      for (const r of renderersByPtyId.values()) {
        r.style(id, attrs);
      }
      continue;
    }

    const pty = toNumber(args[0]);
    if (pty === null) continue;
    const model = renderersByPtyId.get(pty);
    if (!model) continue;

    if (name === "resize") {
      const rows = toNumber(args[1]);
      const cols = toNumber(args[2]);
      if (rows === null || cols === null) continue;
      model.resize(rows, cols);
      continue;
    }

    if (name === "title") {
      const title = toString(args[1]);
      if (title !== null) model.title(title);
      continue;
    }

    if (name === "cursor_pos") {
      const row = toNumber(args[1]);
      const col = toNumber(args[2]);
      const visible = typeof args[3] === "boolean" ? args[3] : false;
      if (row === null || col === null) continue;
      model.cursorPos(row, col, visible);
      continue;
    }

    if (name === "cursor_shape") {
      const shape = toNumber(args[1]);
      if (shape === null) continue;
      model.cursorShape(shape);
      continue;
    }

    if (name === "selection") {
      const sr = toNumber(args[1]);
      const sc = toNumber(args[2]);
      const er = toNumber(args[3]);
      const ec = toNumber(args[4]);
      model.selection(sr, sc, er, ec);
      continue;
    }

    if (name === "write") {
      const row = toNumber(args[1]);
      const col = toNumber(args[2]);
      if (row === null || col === null) continue;
      const cells = parseWriteCells(args[3]);
      model.write(row, col, cells);
      continue;
    }
  }

  return shouldFlush;
}

function clampRectToBounds(rect: BufferRect, bounds: BufferRect): BufferRect | null {
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const maxX = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const maxY = Math.min(rect.y + rect.height, bounds.y + bounds.height);

  if (x >= maxX || y >= maxY) return null;

  return {
    x,
    y,
    width: maxX - x,
    height: maxY - y,
  };
}

function drawDividers(buffer: OptimizedBuffer, node: LayoutNode, bounds: BufferRect, fg: RGBA, bg: RGBA): void {
  if (node.type === "pane") return;

  if (node.direction === "vertical") {
    const splitY = Math.floor(bounds.y + bounds.height * node.ratio);
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
      buffer.setCell(x, splitY, "─", fg, bg, 0);
    }

    const firstHeight = splitY - bounds.y;
    const secondHeight = bounds.height - firstHeight - 1;

    const firstBounds: BufferRect = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: firstHeight,
    };

    const secondBounds: BufferRect = {
      x: bounds.x,
      y: splitY + 1,
      width: bounds.width,
      height: secondHeight,
    };

    const f = clampRectToBounds(firstBounds, bounds);
    const s = clampRectToBounds(secondBounds, bounds);
    if (f) drawDividers(buffer, node.first, f, fg, bg);
    if (s) drawDividers(buffer, node.second, s, fg, bg);

    return;
  }

  const splitX = Math.floor(bounds.x + bounds.width * node.ratio);
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
    buffer.setCell(splitX, y, "│", fg, bg, 0);
  }

  const firstWidth = splitX - bounds.x;
  const secondWidth = bounds.width - firstWidth - 1;

  const firstBounds: BufferRect = {
    x: bounds.x,
    y: bounds.y,
    width: firstWidth,
    height: bounds.height,
  };

  const secondBounds: BufferRect = {
    x: splitX + 1,
    y: bounds.y,
    width: secondWidth,
    height: bounds.height,
  };

  const f = clampRectToBounds(firstBounds, bounds);
  const s = clampRectToBounds(secondBounds, bounds);
  if (f) drawDividers(buffer, node.first, f, fg, bg);
  if (s) drawDividers(buffer, node.second, s, fg, bg);
}

function cycleTab(state: LayoutState, delta: number): LayoutState {
  const tabs = state.tabs;
  if (tabs.length <= 1) return state;

  const idx = tabs.findIndex((t) => t.id === state.activeTabId);
  if (idx === -1) return state;

  const nextIdx = (idx + delta + tabs.length) % tabs.length;
  const nextId = tabs[nextIdx]!.id;
  return setActiveTab(state, nextId);
}

export function App() {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();

  const [connected, setConnected] = createSignal(false);
  const [mode, setMode] = createSignal<Mode>("picker");
  const [status, setStatus] = createSignal<string>("Connecting...");

  const [sessions, setSessions] = createSignal<Session[]>([]);
  const [filter, setFilter] = createSignal<string>("");
  const [selectedIndex, setSelectedIndex] = createSignal<number>(0);

  const [layoutState, setLayoutState] = createSignal<LayoutState | null>(null);
  const [attachedPtyIds, setAttachedPtyIds] = createSignal<number[]>([]);

  let rpc: RpcClient | null = null;
  const renderersByPtyId = new Map<number, Renderer>();

  const handleKey = createKeyHandler(encodeKey);

  const contentHeight = createMemo(() => {
    const reserved = mode() === "terminal" ? 2 : 1; // tab bar + status, or just status
    return Math.max(1, dimensions().height - reserved);
  });

  const filteredSessions = createMemo(() => {
    const q = filter().trim().toLowerCase();
    const list = sessions();
    if (!q) return list;
    return list.filter((s) => s.name.toLowerCase().includes(q));
  });

  const clampSelection = () => {
    const list = filteredSessions();
    if (list.length === 0) {
      setSelectedIndex(0);
      return;
    }
    const idx = selectedIndex();
    if (idx < 0) setSelectedIndex(0);
    else if (idx >= list.length) setSelectedIndex(list.length - 1);
  };

  const refreshSessions = async () => {
    if (!rpc) return;
    const list = await fetchSessions(rpc);
    setSessions(list.sort((a, b) => a.id - b.id));
    clampSelection();
  };

  const getContentRect = (): LayoutRect => {
    return {
      x: 0,
      y: 0,
      width: dimensions().width,
      height: contentHeight(),
    };
  };

  const getInnerSizeForPane = (state: LayoutState, paneId: PaneId): { rows: number; cols: number } | null => {
    const outer = getPaneRect(state, paneId, getContentRect());
    if (!outer) return null;

    const inner = getInnerRect(outer as unknown as BufferRect);
    if (!inner) return null;

    return {
      rows: Math.max(1, inner.height),
      cols: Math.max(1, inner.width),
    };
  };

  const ensureRenderer = (ptyId: number, rows: number, cols: number): Renderer => {
    const existing = renderersByPtyId.get(ptyId);
    if (existing) {
      existing.resize(rows, cols);
      return existing;
    }

    const r = new Renderer(rows, cols);
    renderersByPtyId.set(ptyId, r);
    setAttachedPtyIds(Array.from(renderersByPtyId.keys()).sort((a, b) => a - b));
    return r;
  };

  const attachPty = async (ptyId: number, state: LayoutState): Promise<void> => {
    if (!rpc) return;

    const tab = getActiveTab(state);
    if (!tab) return;

    const size = getInnerSizeForPane(state, tab.focusedPaneId) ?? { rows: 24, cols: 80 };
    ensureRenderer(ptyId, size.rows, size.cols);

    await rpc.request("attach_pty", [ptyId, false]);
    await rpc.request("resize_pty", [ptyId, size.rows, size.cols]);
  };

  const spawnAndAttachFocused = async (state: LayoutState): Promise<LayoutState> => {
    if (!rpc) return state;

    const tab = getActiveTab(state);
    if (!tab) return state;

    const focusedPty = getFocusedPtyId(state);
    if (focusedPty !== null) return state;

    const size = getInnerSizeForPane(state, tab.focusedPaneId) ?? { rows: 24, cols: 80 };
    const ptyId = await rpc.request("spawn_pty", {
      rows: size.rows,
      cols: size.cols,
      attach: false,
      macos_option_as_alt: false,
    });

    const ptyNum = toNumber(ptyId);
    if (ptyNum === null) return state;

    const nextState = assignPtyToFocused(state, ptyNum);

    await attachPty(ptyNum, nextState);

    return nextState;
  };

  const detach = async () => {
    if (!rpc) return;

    const ptys = attachedPtyIds();
    if (ptys.length > 0) {
      try {
        await rpc.request("detach_ptys", ptys);
      } catch {
        // ignore
      }
    }

    renderersByPtyId.clear();
    setAttachedPtyIds([]);

    setLayoutState(null);
    setMode("picker");
    setStatus("Detached");
    await refreshSessions();
    renderer.requestRender();
  };

  const attachFromPicker = async (ptyId: number) => {
    if (!rpc) return;

    setStatus(`Attaching to PTY ${ptyId}...`);

    let state = initLayout();
    state = assignPtyToFocused(state, ptyId);

    // Switch to terminal mode early so sizing matches reserved bars.
    setMode("terminal");
    setLayoutState(state);

    try {
      await attachPty(ptyId, state);
      setStatus(`Attached to PTY ${ptyId}. Ctrl+C detaches. Ctrl+b for commands.`);
      renderer.requestRender();
    } catch (err) {
      setStatus(`Attach failed: ${String(err)}`);
      setLayoutState(null);
      setMode("picker");
    }
  };

  const handleTerminalAction = (action: Action) => {
    if (action.type === "noop") return;

    const state = layoutState();
    if (!state || !rpc) return;

    if (action.type === "send_to_pty") {
      const ptyId = getFocusedPtyId(state);
      if (ptyId === null) return;

      const data = Buffer.from(action.data, "utf8");
      rpc.notify("write_pty", [ptyId, data]);
      return;
    }

    if (action.type === "focus") {
      setLayoutState(focusNext(state, action.direction as FocusDirection));
      renderer.requestRender();
      return;
    }

    if (action.type === "next_tab") {
      setLayoutState(cycleTab(state, 1));
      renderer.requestRender();
      return;
    }

    if (action.type === "prev_tab") {
      setLayoutState(cycleTab(state, -1));
      renderer.requestRender();
      return;
    }

    if (action.type === "detach") {
      detach().catch(() => {});
      return;
    }

    if (action.type === "close_pane") {
      const ptyId = getFocusedPtyId(state);
      const next = closeFocused(state);
      setLayoutState(next);

      if (ptyId !== null) {
        renderersByPtyId.delete(ptyId);
        setAttachedPtyIds(Array.from(renderersByPtyId.keys()).sort((a, b) => a - b));
        rpc.request("close_pty", [ptyId]).catch(() => {});
      }

      renderer.requestRender();
      return;
    }

    if (action.type === "split") {
      let next = splitFocused(state, action.direction);
      setLayoutState(next);

      spawnAndAttachFocused(next)
        .then((s) => {
          setLayoutState(s);
          renderer.requestRender();
        })
        .catch(() => {});

      return;
    }

    if (action.type === "new_tab") {
      let next = addTab(state);
      setLayoutState(next);

      spawnAndAttachFocused(next)
        .then((s) => {
          setLayoutState(s);
          renderer.requestRender();
        })
        .catch(() => {});

      return;
    }
  };

  useKeyboard((event) => {
    const isCtrlC = !!event.ctrl && (event.name.toLowerCase() === "c" || event.sequence === "\u0003");

    if (mode() === "terminal") {
      if (isCtrlC) {
        detach().catch(() => {});
        return;
      }

      handleTerminalAction(handleKey(event));
      return;
    }

    // picker mode
    if (isCtrlC) {
      process.exit(0);
    }

    const key = event.name.toLowerCase();

    if (key === "up" || key === "k") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key === "down" || key === "j") {
      setSelectedIndex((i) => Math.min(filteredSessions().length - 1, i + 1));
      return;
    }
    if (key === "home" || key === "g") {
      setSelectedIndex(0);
      return;
    }
    if (key === "end") {
      setSelectedIndex(Math.max(0, filteredSessions().length - 1));
      return;
    }
    if (key === "backspace") {
      setFilter((s) => s.slice(0, -1));
      setSelectedIndex(0);
      return;
    }
    if (key === "return" || key === "enter") {
      const list = filteredSessions();
      const idx = selectedIndex();
      const selected = list[idx];
      if (selected && rpc) {
        attachFromPicker(selected.id).catch((err) => {
          setStatus(`Attach failed: ${String(err)}`);
        });
      }
      return;
    }

    const charCode = event.sequence?.charCodeAt(0) ?? 0;
    const isPrintable = event.sequence?.length === 1 && charCode >= 32 && charCode < 127;
    if (isPrintable && !event.ctrl && !event.option && !event.meta) {
      setFilter((s) => s + event.sequence);
      setSelectedIndex(0);
    }
  });

  onMount(() => {
    const conn = new PriseConnection();

    conn
      .connect()
      .then(async (r) => {
        rpc = r;
        setConnected(true);
        setStatus("Connected");

        rpc.on("redraw", (params: unknown) => {
          const shouldFlush = applyRedraw(renderersByPtyId, params);
          if (shouldFlush) {
            renderer.requestRender();
          }
        });

        await refreshSessions();
      })
      .catch((err) => {
        setStatus(`Connection failed: ${String(err)}`);
      });

    onCleanup(() => {
      conn.close();
    });
  });

  createEffect(() => {
    if (mode() !== "terminal") return;
    const state = layoutState();
    if (!rpc || !state) return;

    const tab = getActiveTab(state);
    if (!tab) return;

    const contentRect = getContentRect();
    const paneIds = getAllPaneIds(tab.root);

    for (const paneId of paneIds) {
      const pane = findPaneInTree(tab.root, paneId);
      const ptyId = pane?.ptyId ?? null;
      if (ptyId === null) continue;

      const outer = getPaneRect(state, paneId, contentRect);
      if (!outer) continue;

      const inner = getInnerRect(outer as unknown as BufferRect);
      if (!inner) continue;

      const rows = Math.max(1, inner.height);
      const cols = Math.max(1, inner.width);

      const r = renderersByPtyId.get(ptyId);
      if (r) r.resize(rows, cols);

      rpc.request("resize_pty", [ptyId, rows, cols]).catch(() => {});
    }
  });

  const tabBar = createMemo(() => {
    if (mode() !== "terminal") return "";
    const state = layoutState();
    if (!state) return "";

    return state.tabs
      .map((t, i) => {
        const active = t.id === state.activeTabId;
        return active ? `[*${i + 1}*]` : `[${i + 1}]`;
      })
      .join(" ");
  });

  const statusLine = createMemo(() => {
    if (mode() !== "terminal") {
      return (status() ? `${status()} | ` : "") + "Select session (Enter attach, Ctrl+C quit)";
    }

    const state = layoutState();
    const focused = state ? getFocusedPtyId(state) : null;
    const ptys = attachedPtyIds();
    const hint = `PTYS ${ptys.length}${focused !== null ? ` | focused pty ${focused}` : ""} (Ctrl+C detach, Ctrl+b prefix)`;
    return (status() ? `${status()} | ` : "") + hint;
  });

  const renderTerminal = (buffer: OptimizedBuffer) => {
    const state = layoutState();
    if (!state) return;

    const tab = getActiveTab(state);
    if (!tab) return;

    const w = dimensions().width;
    const h = contentHeight();

    const background = RGBA.fromInts(0, 0, 0);
    const dividerFg = RGBA.fromInts(90, 90, 90);
    const borderFg = RGBA.fromInts(180, 180, 180);

    const bounds: BufferRect = { x: 0, y: 0, width: w, height: h };

    // OpenTUI provides a fresh frame buffer; paint our own background.
    paintRect(buffer, bounds, background);

    drawDividers(buffer, tab.root as LayoutNode, bounds, dividerFg, background);

    const paneRects = getAllPaneRects(state, getContentRect());
    for (const [paneId, rect] of paneRects.entries()) {
      const focused = paneId === tab.focusedPaneId;
      drawBorder(buffer, rect as unknown as BufferRect, borderFg, background, focused);

      const inner = getInnerRect(rect as unknown as BufferRect);
      if (!inner) continue;

      const pane = findPaneInTree(tab.root, paneId);
      const ptyId = pane?.ptyId ?? null;
      if (ptyId === null) continue;

      const model = renderersByPtyId.get(ptyId);
      if (!model) continue;

      model.renderToBuffer(buffer, {
        width: inner.width,
        height: inner.height,
        offsetX: inner.x,
        offsetY: inner.y,
        isFocused: focused,
        forceFullRedraw: true,
      });
      model.clearDirty();
    }
  };

  return (
    <box
      style={{
        width: dimensions().width,
        height: dimensions().height,
        flexDirection: "column",
      }}
    >
      <Show
        when={connected()}
        fallback={
          <box style={{ width: dimensions().width, height: dimensions().height, alignItems: "center", justifyContent: "center" }}>
            <text fg="#666666">{status()}</text>
          </box>
        }
      >
        <Show when={mode() === "terminal"}>
          <box style={{ width: dimensions().width, height: 1 }}>
            <text fg="#000000" bg="#dcdcdc">
              {tabBar() || "(no tabs)"}
            </text>
          </box>

          <box
            style={{
              width: dimensions().width,
              height: contentHeight(),
            }}
            renderAfter={renderTerminal}
          />
        </Show>

        <Show when={mode() === "picker"}>
          <box style={{ width: dimensions().width, height: dimensions().height - 1, flexDirection: "column" }}>
            <text fg="#cccccc">Filter: {filter() || "(empty)"}</text>
            <text fg="#666666">↑/↓ or j/k to select, Enter to attach</text>
            <box style={{ width: dimensions().width, height: dimensions().height - 4, flexDirection: "column" }}>
              <For each={filteredSessions()} fallback={<text fg="#666666">(no sessions)</text>}>
                {(s, i) => {
                  const isSelected = () => i() === selectedIndex();
                  return (
                    <text fg={isSelected() ? "#00ffaf" : "#cccccc"}>
                      {isSelected() ? "> " : "  "}[{s.id}] {s.name} ({s.attached_client_count})
                    </text>
                  );
                }}
              </For>
            </box>
          </box>
        </Show>

        <box style={{ width: dimensions().width, height: 1 }}>
          <text fg="#000000" bg="#dcdcdc">{statusLine()}</text>
        </box>
      </Show>
    </box>
  );
}
