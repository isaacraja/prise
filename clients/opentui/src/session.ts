/**
 * Session model for managing Prise PTY sessions
 *
 * Handles:
 * - Session state (list, current attachment, metadata)
 * - Session lifecycle (attach/detach)
 * - Filtering and search
 */

export interface Session {
  id: number;
  name: string;
  attached_client_count: number;
}

export interface SessionPickerState {
  sessions: Session[];
  current_session_id: number | null;
  is_attached: boolean;
  last_updated: number;
}

/**
 * Manages session state and provides filtering capabilities
 */
export class SessionManager {
  private state: SessionPickerState = {
    sessions: [],
    current_session_id: null,
    is_attached: false,
    last_updated: 0,
  };

  /**
   * Update the session list from server response
   */
  updateSessions(sessions: Session[]): void {
    this.state.sessions = sessions.sort((a, b) => a.id - b.id);
    this.state.last_updated = Date.now();
  }

  /**
   * Set the currently attached session
   */
  setCurrentSession(session_id: number | null): void {
    this.state.current_session_id = session_id;
    this.state.is_attached = session_id !== null;
  }

  /**
   * Get all sessions sorted by ID
   */
  getSessions(): Session[] {
    return this.state.sessions;
  }

  /**
   * Get the current attached session ID
   */
  getCurrentSessionId(): number | null {
    return this.state.current_session_id;
  }

  /**
   * Check if currently attached to a session
   */
  isAttached(): boolean {
    return this.state.is_attached;
  }

  /**
   * Filter sessions by name (case-insensitive substring match)
   */
  filterSessions(query: string): Session[] {
    if (!query.trim()) {
      return this.state.sessions;
    }

    const lower = query.toLowerCase();
    return this.state.sessions.filter((session) =>
      session.name.toLowerCase().includes(lower)
    );
  }

  /**
   * Find a session by name (case-insensitive exact match)
   */
  findSessionByName(name: string): Session | undefined {
    const lower = name.toLowerCase();
    return this.state.sessions.find(
      (session) => session.name.toLowerCase() === lower
    );
  }

  /**
   * Find a session by ID
   */
  findSessionById(id: number): Session | undefined {
    return this.state.sessions.find((session) => session.id === id);
  }

  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.state.sessions.length;
  }

  /**
   * Get state snapshot
   */
  getState(): SessionPickerState {
    return { ...this.state };
  }
}
