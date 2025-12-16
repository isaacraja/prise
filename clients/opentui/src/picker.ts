/**
 * Session picker UI component
 *
 * Provides an interactive text-based UI for:
 * - Listing available sessions
 * - Filtering by name
 * - Selecting a session to attach
 * - Managing attach/detach flow
 */

import { Session, SessionManager } from "./session";

export interface PickerOptions {
  /**
   * Max height in terminal rows
   */
  max_height?: number;

  /**
   * Show session attach count
   */
  show_attach_count?: boolean;
}

export interface PickerResult {
  /**
   * Selected session, or null if cancelled
   */
  selected: Session | null;

  /**
   * User pressed Ctrl+C or Escape (cancelled)
   */
  cancelled: boolean;
}

/**
 * Interactive session picker for terminal UI
 */
export class SessionPicker {
  private manager: SessionManager;
  private options: PickerOptions;
  private filter_query: string = "";
  private selected_index: number = 0;
  private view_offset: number = 0;

  constructor(manager: SessionManager, options: PickerOptions = {}) {
    this.manager = manager;
    this.options = {
      max_height: options.max_height || 10,
      show_attach_count: options.show_attach_count ?? true,
    };
  }

  /**
   * Get the current filter query
   */
  getFilterQuery(): string {
    return this.filter_query;
  }

  /**
   * Set the filter query and update display
   */
  setFilterQuery(query: string): void {
    this.filter_query = query;
    this.selected_index = 0;
    this.view_offset = 0;
  }

  /**
   * Add a character to the filter
   */
  addFilterChar(char: string): void {
    this.filter_query += char;
    this.selected_index = 0;
    this.view_offset = 0;
  }

  /**
   * Remove the last character from filter
   */
  backspaceFilter(): void {
    if (this.filter_query.length > 0) {
      this.filter_query = this.filter_query.slice(0, -1);
      this.selected_index = 0;
      this.view_offset = 0;
    }
  }

  /**
   * Clear the entire filter
   */
  clearFilter(): void {
    this.filter_query = "";
    this.selected_index = 0;
    this.view_offset = 0;
  }

  /**
   * Get filtered sessions list
   */
  getFilteredSessions(): Session[] {
    return this.manager.filterSessions(this.filter_query);
  }

  /**
   * Move selection down
   */
  selectDown(): void {
    const filtered = this.getFilteredSessions();
    if (filtered.length === 0) return;

    this.selected_index = Math.min(
      this.selected_index + 1,
      filtered.length - 1
    );
    this.updateViewOffset();
  }

  /**
   * Move selection up
   */
  selectUp(): void {
    if (this.selected_index > 0) {
      this.selected_index--;
      this.updateViewOffset();
    }
  }

  /**
   * Jump to first item
   */
  selectFirst(): void {
    this.selected_index = 0;
    this.view_offset = 0;
  }

  /**
   * Jump to last item
   */
  selectLast(): void {
    const filtered = this.getFilteredSessions();
    if (filtered.length === 0) return;

    this.selected_index = filtered.length - 1;
    this.updateViewOffset();
  }

  /**
   * Get the currently selected session
   */
  getSelectedSession(): Session | null {
    const filtered = this.getFilteredSessions();
    if (filtered.length === 0) return null;
    return filtered[this.selected_index] || null;
  }

  /**
   * Get the visible window of sessions for display
   */
  getVisibleSessions(): {
    sessions: Array<{ session: Session; is_selected: boolean; is_current: boolean }>;
    total_count: number;
    visible_count: number;
    offset: number;
  } {
    const filtered = this.getFilteredSessions();
    const total = filtered.length;
    const max_visible = this.options.max_height || 10;

    const end = Math.min(this.view_offset + max_visible, total);
    const visible = filtered.slice(this.view_offset, end);

    const sessions = visible.map((session) => ({
      session,
      is_selected: filtered.indexOf(session) === this.selected_index,
      is_current: session.id === this.manager.getCurrentSessionId(),
    }));

    return {
      sessions,
      total_count: total,
      visible_count: visible.length,
      offset: this.view_offset,
    };
  }

  /**
   * Render the picker UI as a string (for terminal output)
   */
  render(): string {
    const lines: string[] = [];

    // Header with filter input
    lines.push("─".repeat(40));
    lines.push(`Filter: ${this.filter_query || "(empty)"}`);
    lines.push("─".repeat(40));

    const visible = this.getVisibleSessions();
    const { sessions, total_count, offset } = visible;

    if (total_count === 0) {
      lines.push("(no sessions found)");
      lines.push("");
      lines.push("Keys: Ctrl+C to cancel");
      return lines.join("\n");
    }

    // Render session list with selection indicator
    for (const { session, is_selected, is_current } of sessions) {
      const prefix = is_selected ? "▶ " : "  ";
      const current = is_current ? " [ATTACHED]" : "";
      const count = this.options.show_attach_count
        ? ` (${session.attached_client_count} clients)`
        : "";

      lines.push(`${prefix}${session.name}${count}${current}`);
    }

    // Footer
    lines.push("");
    lines.push(
      `${offset + 1}-${offset + sessions.length} of ${total_count} sessions`
    );
    lines.push("Keys: ↑↓ to navigate, Enter to attach, Backspace to filter, Ctrl+C to cancel");

    return lines.join("\n");
  }

  /**
   * Update view offset to keep selected item visible
   */
  private updateViewOffset(): void {
    const max_visible = this.options.max_height || 10;

    // Scroll down if selection is below visible area
    if (this.selected_index >= this.view_offset + max_visible) {
      this.view_offset = this.selected_index - max_visible + 1;
    }

    // Scroll up if selection is above visible area
    if (this.selected_index < this.view_offset) {
      this.view_offset = this.selected_index;
    }
  }
}
