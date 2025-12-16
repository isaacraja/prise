/**
 * Buffer utilities for multi-pane terminal rendering.
 *
 * Provides primitives for:
 * - Clipping/viewport management (render one pane region into a larger buffer)
 * - Border drawing (focused/unfocused pane borders)
 * - Background painting (fill rectangular regions with a color)
 *
 * These helpers support the multi-PTY rendering model where each pane
 * is a separate Renderer instance writing to independent regions of the terminal.
 */

import { RGBA, type OptimizedBuffer } from "@opentui/core";

/** Rectangle definition: position and dimensions. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Paints a solid rectangular region in the buffer with the given background color.
 *
 * Used to:
 * - Clear pane backgrounds
 * - Highlight focused/unfocused pane regions
 * - Reset dirty cells before rendering content
 *
 * @param buffer - OpenTUI buffer to paint into
 * @param rect - Region to fill
 * @param background - RGBA color to fill with
 */
export function paintRect(buffer: OptimizedBuffer, rect: Rect, background: RGBA): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      buffer.setCell(x, y, " ", background, background, 0);
    }
  }
}

/**
 * Draws a box border around a region in the buffer.
 *
 * Used for visual pane separation. Supports focused/unfocused styling
 * (e.g. bright border for focused pane, dim for unfocused).
 *
 * Corners: ┌─┐│└─┘ (box-drawing characters)
 * The border is drawn *inside* the rect (top-left corner is at rect.x, rect.y).
 *
 * @param buffer - OpenTUI buffer to draw into
 * @param rect - Region to border
 * @param foreground - Color for border lines
 * @param background - Background color inside border region
 * @param focused - If true, use brighter styling; if false, use dimmer
 */
export function drawBorder(
  buffer: OptimizedBuffer,
  rect: Rect,
  foreground: RGBA,
  background: RGBA,
  focused: boolean
): void {
  const attrs = focused ? 0 : 2; // 2 = ATTR_DIM (from renderer.ts)

  // Corners and edges
  const topLeft = "┌";
  const topRight = "┐";
  const bottomLeft = "└";
  const bottomRight = "┘";
  const horizontal = "─";
  const vertical = "│";

  const x = rect.x;
  const y = rect.y;
  const maxX = x + rect.width - 1;
  const maxY = y + rect.height - 1;

  // Top-left corner
  if (x >= 0 && y >= 0) {
    buffer.setCell(x, y, topLeft, foreground, background, attrs);
  }

  // Top-right corner
  if (maxX >= 0 && y >= 0) {
    buffer.setCell(maxX, y, topRight, foreground, background, attrs);
  }

  // Bottom-left corner
  if (x >= 0 && maxY >= 0) {
    buffer.setCell(x, maxY, bottomLeft, foreground, background, attrs);
  }

  // Bottom-right corner
  if (maxX >= 0 && maxY >= 0) {
    buffer.setCell(maxX, maxY, bottomRight, foreground, background, attrs);
  }

  // Top and bottom edges
  for (let col = x + 1; col < maxX; col++) {
    if (y >= 0) {
      buffer.setCell(col, y, horizontal, foreground, background, attrs);
    }
    if (maxY >= 0) {
      buffer.setCell(col, maxY, horizontal, foreground, background, attrs);
    }
  }

  // Left and right edges
  for (let row = y + 1; row < maxY; row++) {
    if (x >= 0) {
      buffer.setCell(x, row, vertical, foreground, background, attrs);
    }
    if (maxX >= 0) {
      buffer.setCell(maxX, row, vertical, foreground, background, attrs);
    }
  }
}

/**
 * Clips a rendering operation to a viewport region.
 *
 * Returns adjusted render offsets that map from a pane's local coordinate system
 * (0,0 = top-left of pane) to the global buffer coordinate system.
 *
 * The returned offsets can be used directly in `Renderer.renderToBuffer(buffer, opts)`
 * as `offsetX` and `offsetY` to ensure the pane content is rendered within its
 * designated region without overflowing.
 *
 * Example:
 *   const paneRect = { x: 10, y: 5, width: 30, height: 20 };
 *   const { offsetX, offsetY } = clipViewport(paneRect);
 *   renderer.renderToBuffer(buffer, {
 *     width: paneRect.width,
 *     height: paneRect.height,
 *     offsetX,
 *     offsetY,
 *     isFocused: true
 *   });
 *
 * @param rect - Viewport region in global buffer coordinates
 * @returns Object with offsetX and offsetY for use in renderToBuffer
 */
export function clipViewport(
  rect: Rect
): {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
} {
  return {
    offsetX: rect.x,
    offsetY: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Calculates the inner content area of a bordered rectangle.
 *
 * Useful for determining where content should be rendered after a border
 * is drawn (border takes 1 cell on each edge).
 *
 * @param rect - Outer rectangle (including border)
 * @returns Inner rect for content, or null if too small for border
 */
export function getInnerRect(rect: Rect): Rect | null {
  if (rect.width <= 2 || rect.height <= 2) {
    return null;
  }

  return {
    x: rect.x + 1,
    y: rect.y + 1,
    width: rect.width - 2,
    height: rect.height - 2,
  };
}

/**
 * Checks if a point (x, y) is within a rectangle.
 *
 * @param point - { x, y } coordinates to check
 * @param rect - Rectangle to test against
 * @returns true if point is inside rect (inclusive of edges)
 */
export function pointInRect(point: { x: number; y: number }, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

/**
 * Calculates the intersection of two rectangles.
 *
 * @param a - First rectangle
 * @param b - Second rectangle
 * @returns Intersection rectangle, or null if they don't overlap
 */
export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const maxX = Math.min(a.x + a.width, b.x + b.width);
  const maxY = Math.min(a.y + a.height, b.y + b.height);

  if (x >= maxX || y >= maxY) {
    return null;
  }

  return {
    x,
    y,
    width: maxX - x,
    height: maxY - y,
  };
}
