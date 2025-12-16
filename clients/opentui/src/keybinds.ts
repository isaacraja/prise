/**
 * Tmux-like keybinding handling and focus traversal.
 *
 * Implements a prefix state machine (default: Ctrl+b) that interprets key sequences
 * into high-level actions for UI control (splits, tabs, focus, etc.) while maintaining
 * a pass-through path for regular terminal input.
 *
 * Architecture:
 * - PrefixMatcher: stateful prefix handler (e.g., Ctrl+b then h/j/k/l)
 * - KeyEventInterpreter: routes OpenTUI events to matcher or terminal
 * - Action types: structured output for UI layer to consume
 */

export type KeyEvent = {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
};

export type Action =
  | { type: "send_to_pty"; data: string }
  | { type: "split"; direction: "horizontal" | "vertical" }
  | { type: "new_tab"; }
  | { type: "next_tab"; }
  | { type: "prev_tab"; }
  | { type: "focus"; direction: "left" | "right" | "up" | "down" }
  | { type: "close_pane"; }
  | { type: "detach"; }
  | { type: "noop"; };

/**
 * PrefixMatcher: State machine for tmux-like prefix sequences.
 *
 * Transitions:
 *   idle + prefix (Ctrl+b) → waiting_for_command
 *   waiting + command key → emit action + idle
 *   waiting + timeout (or esc) → idle
 */
class PrefixMatcher {
  private waitingForCommand: boolean = false;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly timeoutMs: number = 2000;

  /**
   * Process a key event and return the action to take.
   * Returns null if the key is consumed (e.g., entering prefix state).
   */
  processKey(event: KeyEvent): Action | null {
    const key = event.key.toLowerCase();

    // Escape cancels prefix wait.
    if (this.waitingForCommand && key === "escape") {
      this.resetPrefixState();
      return { type: "noop" };
    }

    // If we're waiting for a command, interpret it.
    if (this.waitingForCommand) {
      const action = this.interpretCommand(key);
      this.resetPrefixState();
      return action;
    }

    // Check if this is the prefix key (Ctrl+b).
    if (this.isPrefixKey(event)) {
      this.enterPrefixWait();
      return { type: "noop" }; // Consumed.
    }

    // Not a prefix key, pass through.
    return null;
  }

  private isPrefixKey(event: KeyEvent): boolean {
    return !!event.ctrl && !event.alt && !event.meta && event.key.toLowerCase() === "b";
  }

  private enterPrefixWait(): void {
    this.waitingForCommand = true;

    // Set timeout to cancel prefix wait.
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
    }
    this.timeoutHandle = setTimeout(() => {
      this.resetPrefixState();
    }, this.timeoutMs);
  }

  private resetPrefixState(): void {
    this.waitingForCommand = false;
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  /**
   * Interpret command keys after prefix is entered.
   * tmux-inspired bindings:
   *   h/j/k/l  → focus left/down/up/right
   *   %        → split horizontal
   *   "        → split vertical
   *   c        → new tab
   *   n        → next tab
   *   p        → prev tab
   *   x        → close pane
   *   d        → detach
   */
  private interpretCommand(key: string): Action {
    // Navigation (hjkl vim-style)
    if (key === "h") return { type: "focus", direction: "left" };
    if (key === "j") return { type: "focus", direction: "down" };
    if (key === "k") return { type: "focus", direction: "up" };
    if (key === "l") return { type: "focus", direction: "right" };

    // Arrow keys as alternative navigation
    if (key === "left") return { type: "focus", direction: "left" };
    if (key === "down") return { type: "focus", direction: "down" };
    if (key === "up") return { type: "focus", direction: "up" };
    if (key === "right") return { type: "focus", direction: "right" };

    // Splits
    if (key === "%") return { type: "split", direction: "horizontal" };
    if (key === '"') return { type: "split", direction: "vertical" };

    // Send prefix through (tmux: prefix + prefix)
    if (key === "b") return { type: "send_to_pty", data: "\x02" };

    // Tabs
    if (key === "c") return { type: "new_tab" };
    if (key === "n") return { type: "next_tab" };
    if (key === "p") return { type: "prev_tab" };

    // Pane/Session control
    if (key === "x") return { type: "close_pane" };
    if (key === "d") return { type: "detach" };

    // Unknown command: treat as noop
    return { type: "noop" };
  }
}

/**
 * KeyEventInterpreter: Main interface for routing OpenTUI key events.
 *
 * Coordinates between prefix state machine and terminal pass-through.
 * Provides a clean API for the UI layer.
 */
export class KeyEventInterpreter {
  private prefixMatcher: PrefixMatcher;
  private encodeKeyFn: (event: KeyEvent) => string;

  constructor(encodeKeyFn: (event: KeyEvent) => string) {
    this.prefixMatcher = new PrefixMatcher();
    this.encodeKeyFn = encodeKeyFn;
  }

  /**
   * Process an OpenTUI-like key event and return the action to take.
   *
   * Flow:
   *   1. Check if it's a prefix key or continuation of prefix sequence
   *   2. If not consumed by prefix matcher, encode for terminal
   *   3. Return appropriate action
   */
  handleKeyEvent(event: KeyEvent): Action {
    // Try to interpret as prefix sequence.
    const prefixAction = this.prefixMatcher.processKey(event);
    if (prefixAction !== null) {
      // Prefix matcher handled it (either consumed or produced an action).
      return prefixAction;
    }

    // Not a prefix sequence; encode for terminal.
    const encoded = this.encodeKeyFn(event);
    if (encoded) {
      return { type: "send_to_pty", data: encoded };
    }

    return { type: "noop" };
  }
}

/**
 * Export a singleton factory for easy instantiation from UI.
 */
export function createKeyEventInterpreter(
  encodeKeyFn: (event: KeyEvent) => string
): KeyEventInterpreter {
  return new KeyEventInterpreter(encodeKeyFn);
}

export type OpenTuiKeyEvent = {
  name: string;
  sequence?: string;
  ctrl?: boolean;
  option?: boolean;
  meta?: boolean;
  shift?: boolean;
};

function toKeyEvent(event: OpenTuiKeyEvent): KeyEvent {
  const seq = event.sequence;
  const charCode = seq?.charCodeAt(0) ?? 0;
  const isPrintable = !!seq && seq.length === 1 && charCode >= 32 && charCode < 127;

  return {
    key: isPrintable ? seq! : event.name,
    ctrl: event.ctrl,
    shift: event.shift,
    alt: event.option,
    meta: event.meta,
  };
}

export function createKeyHandler(
  encodeKeyFn: (event: KeyEvent) => string
): (event: OpenTuiKeyEvent) => Action {
  const interpreter = createKeyEventInterpreter(encodeKeyFn);

  return (event: OpenTuiKeyEvent) => {
    return interpreter.handleKeyEvent(toKeyEvent(event));
  };
}
