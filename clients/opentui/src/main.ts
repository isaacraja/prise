/**
 * OpenTUI client for prise terminal multiplexer
 * 
 * Minimal CLI for connecting, listing sessions, and attaching to PTYs
 * 
 * Usage:
 *   bun run src/main.ts list               - list available PTY sessions
 *   bun run src/main.ts attach <pty_id>   - attach to a PTY session
 */

import { PriseConnection } from "./connection";

const log = (level: string, msg: string, ...args: unknown[]): void => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [${level}] ${msg}`, ...args);
};

/**
 * List all available PTY sessions
 */
async function listSessions(rpc: any): Promise<void> {
  try {
    log("info", "Requesting list of PTY sessions...");
    const result = (await rpc.request("list_ptys", null)) as unknown;

    // Server returns {pty_validity: number, ptys: array}
    if (!result || typeof result !== "object") {
      log("error", "Invalid response format");
      throw new Error("Expected object response");
    }

    const resultMap = result as Record<string, unknown>;
    const ptysData = resultMap.ptys;

    if (!Array.isArray(ptysData)) {
      log("error", "Invalid response: ptys is not an array");
      throw new Error("Expected ptys array in response");
    }

    log("info", `Found ${ptysData.length} session(s)`);

    if (ptysData.length === 0) {
      console.log("\n  (no sessions)");
    } else {
      console.log("\nAvailable sessions:");
      for (const pty of ptysData) {
        if (pty && typeof pty === "object") {
          const ptyMap = pty as Record<string, unknown>;
          const id = ptyMap.id;
          const title = ptyMap.title || "(no title)";
          const cols = ptyMap.cols || "?";
          const rows = ptyMap.rows || "?";
          const clients = ptyMap.attached_client_count || 0;
          console.log(`  [${id}] ${title} (${rows}x${cols}, ${clients} client(s))`);
        }
      }
    }
    console.log("");
  } catch (err) {
    log("error", "Failed to list sessions:", err);
    throw err;
  }
}

/**
 * Attach to a PTY session and listen for redraw events
 */
async function attachSession(rpc: any, ptyId: number): Promise<void> {
  try {
    log("info", `Attaching to PTY ${ptyId}...`);

    // Send attach_pty request
    const result = await rpc.request("attach_pty", {
      pty_id: ptyId,
      macos_option_as_alt: false,
    });

    log("info", "Successfully attached to session:", result);

    // Register handlers for incoming notifications from server
    rpc.on("redraw", (params: unknown) => {
      // Redraw event - log for now (rendering layer is bead 4v4.3)
      const data = params as Record<string, unknown>;
      const dataLen = (data.data as string)?.length || 0;
      log("info", `Received redraw for PTY ${data.pty_id}: ${dataLen} bytes`);
    });

    rpc.on("pty_closed", (params: unknown) => {
      log("info", "PTY closed:", params);
      process.exit(0);
    });

    rpc.on("event", (params: unknown) => {
      log("info", "Received event notification:", params);
    });

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

    if (command === "list") {
      await listSessions(rpc);
    } else if (command === "attach") {
      const ptyIdStr = args[1];
      if (!ptyIdStr) {
        log("error", "Usage: bun run src/main.ts attach <pty_id>");
        process.exit(1);
      }

      const ptyId = parseInt(ptyIdStr, 10);
      if (isNaN(ptyId)) {
        log("error", `Invalid PTY ID: ${ptyIdStr}`);
        process.exit(1);
      }

      await attachSession(rpc, ptyId);
    } else {
      log("info", "OpenTUI client for prise terminal multiplexer");
      log("info", "Usage:");
      log("info", "  bun run src/main.ts list              - List available PTY sessions");
      log("info", "  bun run src/main.ts attach <pty_id>  - Attach to a PTY session");
      process.exit(1);
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
