/**
 * OpenTUI client for prise terminal multiplexer
 * 
 * Supports interactive session picker, listing, and named attachment
 * 
 * Usage:
 *   bun run src/main.ts                    - interactive session picker
 *   bun run src/main.ts list               - list available sessions
 *   bun run src/main.ts attach <pty_id>    - attach to PTY by ID
 *   bun run src/main.ts --attach <name>    - attach to session by name
 */

import { PriseConnection } from "./connection";
import { SessionManager, Session } from "./session";
import { SessionPicker } from "./picker";
import { Renderer } from "./renderer";
import { InputHandler } from "./input";

const log = (level: string, msg: string, ...args: unknown[]): void => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [${level}] ${msg}`, ...args);
};

/**
 * Fetch sessions from server using list_sessions RPC
 */
async function fetchSessions(rpc: any): Promise<Session[]> {
  try {
    const result = (await rpc.request("list_sessions", null)) as Record<
      string,
      unknown
    >;
    const sessions_data = result.sessions as Array<Record<string, unknown>>;

    if (!Array.isArray(sessions_data)) {
      throw new Error("Invalid sessions response from server");
    }

    return sessions_data.map((s) => ({
      id: s.id as number,
      name: s.name as string,
      attached_client_count: (s.attached_client_count as number) || 0,
    }));
  } catch (err) {
    log("error", "Failed to fetch sessions:", err);
    throw err;
  }
}

/**
 * List all available sessions (non-interactive)
 */
async function listSessions(rpc: any): Promise<void> {
  try {
    log("info", "Requesting list of sessions...");
    const sessions = await fetchSessions(rpc);

    log("info", `Found ${sessions.length} session(s)`);

    if (sessions.length === 0) {
      console.log("\n  (no sessions)");
    } else {
      console.log("\nAvailable sessions:");
      for (const session of sessions) {
        console.log(
          `  [${session.id}] ${session.name} (${session.attached_client_count} client(s))`
        );
      }
    }
    console.log("");
  } catch (err) {
    log("error", "Failed to list sessions:", err);
    throw err;
  }
}

/**
 * Run interactive session picker
 */
async function runSessionPicker(rpc: any): Promise<Session | null> {
  try {
    const sessions = await fetchSessions(rpc);
    const manager = new SessionManager();
    manager.updateSessions(sessions);

    if (sessions.length === 0) {
      console.log("No sessions available");
      return null;
    }

    const picker = new SessionPicker(manager, { max_height: 10 });

    // Import readline dynamically for line-based input
    const readline = await import("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      const render = () => {
        process.stdout.write("\x1b[2J\x1b[H"); // Clear screen
        console.log(picker.render());
      };

      const handleLine = (line: string) => {
        const input = line.trim().toLowerCase();

        // Exit commands
        if (
          input === "q" ||
          input === "quit" ||
          input === "exit" ||
          input === "c"
        ) {
          rl.close();
          return resolve(null);
        }

        // Navigation commands
        if (input === "k" || input === "up" || input === "w") {
          picker.selectUp();
        } else if (input === "j" || input === "down" || input === "s") {
          picker.selectDown();
        } else if (input === "g" || input === "home") {
          picker.selectFirst();
        } else if (input === "G" || input === "end") {
          picker.selectLast();
        }
        // Select current
        else if (input === "" || input === "enter") {
          const selected = picker.getSelectedSession();
          rl.close();
          return resolve(selected);
        }
        // Filter commands
        else if (input.startsWith("/")) {
          picker.setFilterQuery(input.slice(1));
        } else if (input === "/") {
          picker.clearFilter();
        }
        // Type to filter
        else if (input.length > 0 && /^[a-z0-9 -]*$/i.test(input)) {
          picker.setFilterQuery(input);
        }

        render();
      };

      render();
      rl.on("line", handleLine);
      rl.on("close", () => {
        resolve(null);
      });
    });
  } catch (err) {
    log("error", "Failed to run picker:", err);
    return null;
  }
}

/**
 * Attach to a PTY session and listen for redraw events
 */
async function attachSession(rpc: any, sessionId: number): Promise<void> {
  const renderer = new Renderer(24, 80);
  const inputHandler = new InputHandler(sessionId);

  // Enable raw mode for terminal input
  inputHandler.enableRawMode();

  try {
    log("info", `Attaching to session ${sessionId}...`);

    // Send attach_pty request
    await rpc.request("attach_pty", {
      pty_id: sessionId,
      macos_option_as_alt: false,
    });

    log("info", "Successfully attached to session");

    // Clear screen and hide cursor
    process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");

    // Register handlers for incoming notifications from server
    let should_render = false;

    rpc.on("redraw", (params: unknown) => {
      // Redraw events: array of UI events from server
      if (!Array.isArray(params)) {
        log("warn", "Invalid redraw params:", params);
        return;
      }

      should_render = false;

      // Process each redraw event
      for (const event of params) {
        if (!Array.isArray(event) || event.length < 2) continue;

        const [event_name, args] = event;
        if (!Array.isArray(args)) continue;

        try {
          switch (event_name) {
            case "resize":
              renderer.resize(args[1], args[2]);
              break;

            case "write": {
              const [, row, col, cells] = args;
              const parsed_cells = (cells as any[]).map((cell_data: any) => {
                if (Array.isArray(cell_data)) {
                  const [grapheme, style_id, , width] = cell_data;
                  return {
                    grapheme: String(grapheme),
                    style_id: typeof style_id === "number" ? style_id : undefined,
                    width: typeof width === "number" ? width : 1,
                  };
                }
                return { grapheme: " " };
              });
              renderer.write(row, col, parsed_cells);
              break;
            }

            case "cursor_pos":
              renderer.cursorPos(args[1], args[2], args[3]);
              break;

            case "cursor_shape":
              renderer.cursorShape(args[1]);
              break;

            case "style": {
              const [id, attrs] = args;
              renderer.style(id, attrs);
              break;
            }

            case "title":
              renderer.title(args[1]);
              break;

            case "selection": {
              const [, start_row, start_col, end_row, end_col] = args;
              renderer.selection(start_row, start_col, end_row, end_col);
              break;
            }

            case "flush":
              should_render = true;
              break;

            default:
              // Ignore unknown events
              break;
          }
        } catch (e) {
          log("warn", `Error processing redraw event ${event_name}:`, e);
        }
      }

      // Render if flush event was sent
      if (should_render) {
        const output = renderer.render(true);
        if (output) {
          process.stdout.write(output);
        }
        renderer.clearDirty();
      }
    });

    rpc.on("pty_closed", (params: unknown) => {
      log("info", "PTY closed:", params);
      process.exit(0);
    });

    // Handle stdin for input forwarding
    if (process.stdin.isTTY) {
      process.stdin.on("data", (data: Buffer) => {
        // Parse keyboard event and send to server
        const evt = inputHandler.parseKeyboardEvent(data);
        if (evt) {
          rpc.notify(evt.method, evt.params);
        } else {
          // For unparsed sequences, send raw bytes
          rpc.notify("input", {
            pty_id: sessionId,
            data: Array.from(data),
          });
        }
      });
    }

    // Keep connection alive until user interrupts
    log("info", "Connected (press Ctrl+C to detach)...");
    await new Promise((resolve) => {
      process.on("SIGINT", () => {
        log("info", "Detaching...");
        resolve(true);
      });
    });
  } catch (err) {
    log("error", "Failed to attach to session:", err);
    throw err;
  } finally {
    // Send detach request to server
    try {
      await rpc.request("detach_pty", {
        pty_id: sessionId,
      });
    } catch (err) {
      log("warn", "Failed to send detach request:", err);
    }

    // Restore terminal state
    inputHandler.disableRawMode();
    process.stdout.write("\x1b[?25h"); // Show cursor
  }
}

/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    // Connect to server
    log("info", "Connecting to prise server...");
    const conn = new PriseConnection();
    const rpc = await conn.connect();

    // Check for --attach flag (support for named session attachment)
    const attachIdx = args.indexOf("--attach");
    if (attachIdx !== -1 && args[attachIdx + 1]) {
      const sessionName = args[attachIdx + 1];
      const sessions = await fetchSessions(rpc);
      const manager = new SessionManager();
      manager.updateSessions(sessions);

      const session = manager.findSessionByName(sessionName);
      if (!session) {
        log("error", `Session not found: ${sessionName}`);
        process.exit(1);
      }

      await attachSession(rpc, session.id);
      conn.close();
      process.exit(0);
    }

    if (command === "list") {
      await listSessions(rpc);
    } else if (command === "attach" && args[1]) {
      const sessionId = parseInt(args[1], 10);
      if (isNaN(sessionId)) {
        log("error", "Usage: bun run src/main.ts attach <session_id>");
        process.exit(1);
      }

      await attachSession(rpc, sessionId);
    } else {
      // Default: interactive picker mode
      const selected = await runSessionPicker(rpc);

      if (selected) {
        await attachSession(rpc, selected.id);
      } else {
        log("info", "Picker cancelled or no sessions available");
      }
    }

    conn.close();
    process.exit(0);
  } catch (err) {
    log("error", "Fatal error:", err);
    process.exit(1);
  }
}

// Run main
main().catch((err) => {
  log("error", "Uncaught error:", err);
  process.exit(1);
});
