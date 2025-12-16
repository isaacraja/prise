/**
 * Tmux-like layout model for managing panes, splits, and tabs
 *
 * Supports:
 * - Multiple tabs with independent layouts
 * - Binary split tree (horizontal/vertical)
 * - Pane focus management
 * - Layout operations: split, close, focus navigation
 * - Rectangle calculation helpers
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Direction for splits and focus navigation
 */
export type SplitDirection = "horizontal" | "vertical";

/**
 * Direction for focus movement
 */
export type FocusDirection = "up" | "down" | "left" | "right";

/**
 * Unique identifier for a pane
 */
export type PaneId = number & { readonly __paneId: unique symbol };

/**
 * Unique identifier for a tab
 */
export type TabId = number & { readonly __tabId: unique symbol };

/**
 * Rectangle representing a pane's position and size
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Leaf node representing a terminal pane
 */
export interface PaneNode {
  type: "pane";
  id: PaneId;
  ptyId: number | null; // null until PTY is assigned
}

/**
 * Internal node representing a split between two children
 */
export interface SplitNode {
  type: "split";
  direction: SplitDirection;
  ratio: number; // 0..1, position of split divider
  first: LayoutNode;
  second: LayoutNode;
}

/**
 * Layout node: either a pane or split
 */
export type LayoutNode = PaneNode | SplitNode;

/**
 * A tab contains an independent layout and focus state
 */
export interface Tab {
  id: TabId;
  root: LayoutNode;
  focusedPaneId: PaneId;
}

/**
 * Global layout state: tabs + active tab
 */
export interface LayoutState {
  tabs: Tab[];
  activeTabId: TabId;
}

// ============================================================================
// ID Factories
// ============================================================================

let _paneCounter = 0;
let _tabCounter = 0;

/**
 * Create a new unique pane ID
 */
export function createPaneId(): PaneId {
  return ++_paneCounter as PaneId;
}

/**
 * Create a new unique tab ID
 */
export function createTabId(): TabId {
  return ++_tabCounter as TabId;
}

/**
 * Reset ID counters (for testing)
 */
export function resetIdCounters(): void {
  _paneCounter = 0;
  _tabCounter = 0;
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Find a pane node by ID in a layout tree
 */
export function findPaneInTree(node: LayoutNode, id: PaneId): PaneNode | null {
  if (node.type === "pane") {
    return node.id === id ? node : null;
  }
  const inFirst = findPaneInTree(node.first, id);
  if (inFirst) return inFirst;
  return findPaneInTree(node.second, id);
}

/**
 * Get all pane IDs in a layout tree (depth-first)
 */
export function getAllPaneIds(node: LayoutNode): PaneId[] {
  if (node.type === "pane") {
    return [node.id];
  }
  return [...getAllPaneIds(node.first), ...getAllPaneIds(node.second)];
}

/**
 * Get the parent split node of a pane, if it exists
 */
export function findParentSplit(
  node: LayoutNode,
  paneId: PaneId,
  parent: SplitNode | null = null
): SplitNode | null {
  if (node.type === "pane") {
    return node.id === paneId ? parent : null;
  }
  const inFirst = findParentSplit(node.first, paneId, node);
  if (inFirst) return inFirst;
  return findParentSplit(node.second, paneId, node);
}

/**
 * Check if a pane exists in the layout
 */
export function hasPane(node: LayoutNode, id: PaneId): boolean {
  return findPaneInTree(node, id) !== null;
}

// ============================================================================
// Layout Mutations
// ============================================================================

/**
 * Split a pane into two panes
 * Direction determines: horizontal = side-by-side, vertical = top-bottom
 * Returns new layout tree with focused pane in new split
 */
export function splitPane(
  node: LayoutNode,
  paneId: PaneId,
  direction: SplitDirection
): LayoutNode {
  if (node.type === "pane") {
    if (node.id !== paneId) return node;

    // Create new pane with same PTY state
    const newPane: PaneNode = {
      type: "pane",
      id: createPaneId(),
      ptyId: null,
    };

    const split: SplitNode = {
      type: "split",
      direction,
      ratio: 0.5,
      first: node,
      second: newPane,
    };
    return split;
  }

  // Recurse into split
  const first = splitPane(node.first, paneId, direction);
  if (first !== node.first) {
    return { ...node, first };
  }

  const second = splitPane(node.second, paneId, direction);
  return { ...node, second };
}

/**
 * Close a pane and collapse its parent split
 * If pane is the only one, returns null (indicates tab should be closed)
 */
export function closePane(node: LayoutNode, paneId: PaneId): LayoutNode | null {
  if (node.type === "pane") {
    return node.id === paneId ? null : node;
  }

  const first = closePane(node.first, paneId);
  const second = closePane(node.second, paneId);

  // If first was closed, return second (collapse)
  if (first === null) return second;
  // If second was closed, return first (collapse)
  if (second === null) return first;

  // Both children still exist, update split
  return { ...node, first, second };
}

/**
 * Set the PTY ID for a pane
 */
export function setPtyId(
  node: LayoutNode,
  paneId: PaneId,
  ptyId: number
): LayoutNode {
  if (node.type === "pane") {
    if (node.id === paneId) {
      return { ...node, ptyId };
    }
    return node;
  }

  const first = setPtyId(node.first, paneId, ptyId);
  if (first !== node.first) {
    return { ...node, first };
  }

  const second = setPtyId(node.second, paneId, ptyId);
  return { ...node, second };
}

// ============================================================================
// Tab Operations
// ============================================================================

/**
 * Create a new tab with a single pane
 */
export function createTab(): Tab {
  const paneId = createPaneId();
  return {
    id: createTabId(),
    root: {
      type: "pane",
      id: paneId,
      ptyId: null,
    },
    focusedPaneId: paneId,
  };
}

/**
 * Initialize layout state with a single tab
 */
export function initLayout(): LayoutState {
  const tab = createTab();
  return {
    tabs: [tab],
    activeTabId: tab.id,
  };
}

/**
 * Add a new tab to the layout
 */
export function addTab(state: LayoutState): LayoutState {
  const tab = createTab();
  return {
    ...state,
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
  };
}

/**
 * Close a tab; switch to previous if active, or next if last
 * Cannot close the last tab
 */
export function closeTab(state: LayoutState, tabId: TabId): LayoutState {
  if (state.tabs.length <= 1) {
    return state; // Cannot close last tab
  }

  const index = state.tabs.findIndex((t) => t.id === tabId);
  if (index === -1) return state;

  const newTabs = state.tabs.filter((t) => t.id !== tabId);
  let newActiveId = state.activeTabId;

  // If closed tab was active, switch to another
  if (newActiveId === tabId) {
    newActiveId = index > 0 ? state.tabs[index - 1].id : state.tabs[index + 1].id;
  }

  return {
    ...state,
    tabs: newTabs,
    activeTabId: newActiveId,
  };
}

/**
 * Set the active tab
 */
export function setActiveTab(state: LayoutState, tabId: TabId): LayoutState {
  if (!state.tabs.find((t) => t.id === tabId)) {
    return state;
  }
  return { ...state, activeTabId: tabId };
}

// ============================================================================
// Focused Pane Operations (within a tab)
// ============================================================================

/**
 * Get the active tab
 */
export function getActiveTab(state: LayoutState): Tab | null {
  return state.tabs.find((t) => t.id === state.activeTabId) || null;
}

/**
 * Split the focused pane in the active tab
 */
export function splitFocused(
  state: LayoutState,
  direction: SplitDirection
): LayoutState {
  const tab = getActiveTab(state);
  if (!tab) return state;

  const newRoot = splitPane(tab.root, tab.focusedPaneId, direction);

  // Get the new pane ID (always the second child of the new split)
  const newPaneId = getAllPaneIds(newRoot)[getAllPaneIds(newRoot).length - 1];

  return updateTab(state, tab.id, {
    ...tab,
    root: newRoot,
    focusedPaneId: newPaneId,
  });
}

/**
 * Close the focused pane in the active tab
 */
export function closeFocused(state: LayoutState): LayoutState {
  const tab = getActiveTab(state);
  if (!tab) return state;

  const newRoot = closePane(tab.root, tab.focusedPaneId);

  // If layout is empty, close the tab
  if (newRoot === null) {
    return closeTab(state, tab.id);
  }

  // Find the next pane to focus (first available)
  const paneIds = getAllPaneIds(newRoot);
  const focusedId = paneIds.length > 0 ? paneIds[0] : tab.focusedPaneId;

  return updateTab(state, tab.id, {
    ...tab,
    root: newRoot,
    focusedPaneId: focusedId,
  });
}

/**
 * Move focus to the next pane in a direction
 * For now: simplified - moves to next available pane
 */
export function focusNext(state: LayoutState, direction: FocusDirection): LayoutState {
  const tab = getActiveTab(state);
  if (!tab) return state;

  const paneIds = getAllPaneIds(tab.root);
  const currentIndex = paneIds.indexOf(tab.focusedPaneId);

  if (paneIds.length <= 1 || currentIndex === -1) {
    return state;
  }

  // Simplified: cycle through panes (left/up = prev, right/down = next)
  let nextIndex: number;
  if (direction === "left" || direction === "up") {
    nextIndex = currentIndex > 0 ? currentIndex - 1 : paneIds.length - 1;
  } else {
    nextIndex = (currentIndex + 1) % paneIds.length;
  }

  return moveFocusToPane(state, paneIds[nextIndex]);
}

/**
 * Move focus to a specific pane
 */
export function moveFocusToPane(
  state: LayoutState,
  paneId: PaneId
): LayoutState {
  const tab = getActiveTab(state);
  if (!tab || !hasPane(tab.root, paneId)) {
    return state;
  }

  return updateTab(state, tab.id, {
    ...tab,
    focusedPaneId: paneId,
  });
}

/**
 * Update a tab in the state
 */
function updateTab(state: LayoutState, tabId: TabId, updatedTab: Tab): LayoutState {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.id === tabId ? updatedTab : t)),
  };
}

// ============================================================================
// PTY Management
// ============================================================================

/**
 * Assign a PTY ID to the focused pane
 */
export function assignPtyToFocused(state: LayoutState, ptyId: number): LayoutState {
  const tab = getActiveTab(state);
  if (!tab) return state;

  const newRoot = setPtyId(tab.root, tab.focusedPaneId, ptyId);
  return updateTab(state, tab.id, {
    ...tab,
    root: newRoot,
  });
}

/**
 * Get the PTY ID of the focused pane
 */
export function getFocusedPtyId(state: LayoutState): number | null {
  const tab = getActiveTab(state);
  if (!tab) return null;

  const pane = findPaneInTree(tab.root, tab.focusedPaneId);
  return pane?.ptyId ?? null;
}

// ============================================================================
// Rectangle Calculation (API signature only - actual rendering in OpenTUI layer)
// ============================================================================

/**
 * Calculate the rectangle for a specific pane
 * Returns null if pane not found
 *
 * This is a signature-level helper; actual calculation delegates to renderer
 * based on terminal size and split ratios
 */
export function getPaneRect(
  state: LayoutState,
  paneId: PaneId,
  containerRect: Rect
): Rect | null {
  const tab = getActiveTab(state);
  if (!tab) return null;

  if (!hasPane(tab.root, paneId)) {
    return null;
  }

  // Calculate recursively through split tree
  return calculatePaneRectInTree(tab.root, paneId, containerRect);
}

/**
 * Calculate pane rectangle by traversing split tree
 */
function calculatePaneRectInTree(
  node: LayoutNode,
  paneId: PaneId,
  bounds: Rect
): Rect | null {
  if (node.type === "pane") {
    return node.id === paneId ? bounds : null;
  }

  const { direction, ratio } = node;
  let firstBounds: Rect, secondBounds: Rect;

  if (direction === "vertical") {
    // Split top/bottom
    const splitY = Math.floor(bounds.y + bounds.height * ratio);
    const firstHeight = splitY - bounds.y;
    const secondHeight = bounds.height - firstHeight - 1; // -1 for divider

    firstBounds = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: firstHeight,
    };

    secondBounds = {
      x: bounds.x,
      y: splitY + 1,
      width: bounds.width,
      height: secondHeight,
    };
  } else {
    // Split left/right
    const splitX = Math.floor(bounds.x + bounds.width * ratio);
    const firstWidth = splitX - bounds.x;
    const secondWidth = bounds.width - firstWidth - 1; // -1 for divider

    firstBounds = {
      x: bounds.x,
      y: bounds.y,
      width: firstWidth,
      height: bounds.height,
    };

    secondBounds = {
      x: splitX + 1,
      y: bounds.y,
      width: secondWidth,
      height: bounds.height,
    };
  }

  const inFirst = calculatePaneRectInTree(node.first, paneId, firstBounds);
  if (inFirst) return inFirst;

  return calculatePaneRectInTree(node.second, paneId, secondBounds);
}

/**
 * Get rectangles for all panes in the active tab
 * Returns map of pane ID -> rectangle
 */
export function getAllPaneRects(
  state: LayoutState,
  containerRect: Rect
): Map<PaneId, Rect> {
  const tab = getActiveTab(state);
  if (!tab) return new Map();

  const result = new Map<PaneId, Rect>();
  const paneIds = getAllPaneIds(tab.root);

  for (const paneId of paneIds) {
    const rect = getPaneRect(state, paneId, containerRect);
    if (rect) {
      result.set(paneId, rect);
    }
  }

  return result;
}

// ============================================================================
// Validation & Debugging
// ============================================================================

/**
 * Validate layout state consistency
 */
export function validateLayoutState(state: LayoutState): string[] {
  const errors: string[] = [];

  if (state.tabs.length === 0) {
    errors.push("Layout must have at least one tab");
  }

  if (!state.tabs.find((t) => t.id === state.activeTabId)) {
    errors.push("Active tab ID does not exist");
  }

  for (const tab of state.tabs) {
    // Check focused pane exists
    if (!hasPane(tab.root, tab.focusedPaneId)) {
      errors.push(`Tab ${tab.id}: focused pane ${tab.focusedPaneId} does not exist`);
    }

    // Check at least one pane
    const paneCount = getAllPaneIds(tab.root).length;
    if (paneCount === 0) {
      errors.push(`Tab ${tab.id}: has no panes`);
    }
  }

  return errors;
}

/**
 * Get debug info about layout state
 */
export function getLayoutDebugInfo(state: LayoutState): string {
  const tab = getActiveTab(state);
  if (!tab) return "No active tab";

  const paneIds = getAllPaneIds(tab.root);
  const focused = tab.focusedPaneId;

  return (
    `Active Tab: ${tab.id}\n` +
    `Panes: ${paneIds.length} total\n` +
    `Focused: ${focused}\n` +
    `Pane list: ${paneIds.map((id) => (id === focused ? `*${id}` : id)).join(", ")}`
  );
}
