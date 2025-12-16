# Prise OpenTUI Client

A TypeScript client for the Prise terminal multiplexer using the msgpack-RPC protocol.

## Overview

The OpenTUI client is an alternative UI for Prise that communicates with the Prise server via Unix domain sockets using the msgpack-RPC protocol. Unlike the built-in Lua-based UI, this client can run on any system with TypeScript/Node.js support, enabling flexible terminal multiplexing workflows.

## Architecture

```
┌─────────────────────┐         Unix Domain Socket        ┌──────────────────┐
│   OpenTUI Client    │◄──────── msgpack-RPC ────────────►│   Prise Server   │
│  (TypeScript/Node)  │                                   │   (Zig daemon)   │
└─────────────────────┘                                   └──────────────────┘
        │                                                         │
        ▼                                                         ▼
   User terminal                                          PTY sessions
   (TTY input)                                            (shell processes)
```

## Prerequisites

- **Prise server** running (see main README for installation)
- **Bun** (required)

## Quick Start

### 1. Build the prise server

```bash
cd /path/to/prise
zig build -Doptimize=ReleaseSafe
```

### 2. Start the prise server

```bash
# Option A: As a background service (recommended)
zig build -Doptimize=ReleaseSafe --prefix ~/.local enable-service

# Option B: Manually in a background terminal
~/.local/bin/prise serve &
```

The server creates a Unix domain socket at:
```
/tmp/prise-<uid>.sock
```
where `<uid>` is your user ID.

### 3. Run the OpenTUI client

```bash
cd clients/opentui
bun install
bun run start  # or: bun run src/index.tsx
```

Optional: bundle to `clients/opentui/dist/`:

```bash
bun run build
```

## Usage

### Interactive Session Picker (Default)

Run the client without arguments to see an interactive picker:

```bash
bun run start
```

**Picker Commands:**
- `↑` / `k` - Move selection up
- `↓` / `j` - Move selection down
- `Home` / `g` - Jump to first session
- `End` / `G` - Jump to last session
- Type text - Filter sessions by name
- `Backspace` - Delete filter character
- `Enter` - Attach to selected session
- `Ctrl+C` - Quit

### List/Attach (Non-interactive)

Not implemented yet; use the interactive picker for now.

### Terminal Mode

Once attached, the client enters terminal mode.

**Keybindings (tmux-inspired):**
- `Ctrl+b` then `"` - Split vertically (top/bottom)
- `Ctrl+b` then `%` - Split horizontally (left/right)
- `Ctrl+b` then `h/j/k/l` - Move focus between panes
- `Ctrl+b` then `c` - New tab
- `Ctrl+b` then `n` / `p` - Next/previous tab
- `Ctrl+b` then `x` - Close focused pane

### Detach

Press `Ctrl+C` to detach and return to the session picker.

## Environment Variables

The client uses the following environment variables to locate the server socket:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PRISE_SOCKET` | `/tmp/prise-<uid>.sock` | Path to the Unix domain socket |

### Example with custom socket path

```bash
PRISE_SOCKET=/var/run/prise.sock bun run start
```

## RPC Protocol

The client communicates with the server using **msgpack-RPC** over a Unix domain socket.

### Message Format

- **Request**: `[type=0, msgid, method, params]`
- **Response**: `[type=1, msgid, error, result]`
- **Notification**: `[type=2, method, params]`

All messages are encoded using msgpack binary format.

### Core RPC Methods

#### `list_sessions()` → Object

List all active PTY sessions with metadata.

**Response format:**
```json
{
  "pty_validity": 1234567890,
  "sessions": [
    {
      "id": 0,
      "name": "my-session",
      "attached_client_count": 1
    }
  ]
}
```

#### `list_ptys()` → Array<PTY> (Legacy)

List all active PTY sessions with full details (legacy).

**Response format:**
```json
[
  {
    "id": 0,
    "rows": 24,
    "cols": 80,
    "title": "shell",
    "client_count": 1
  }
]
```

#### `spawn_pty(params)` → PTY ID

Create a new PTY session.

**Parameters:**
```json
{
  "rows": 24,
  "cols": 80,
  "shell": "/bin/bash",
  "cwd": "/home/user",
  "attach": true,
  "env": {
    "TERM": "xterm-256color"
  }
}
```

#### `attach_pty(params)` → null

Attach the client to an existing PTY session. Starts receiving redraw notifications.

**Parameters:**
```json
{
  "pty_id": 0,
  "macos_option_as_alt": false
}
```

#### `detach_pty(params)` → null

Detach from a PTY session. Stop receiving redraw notifications.

**Parameters:**
```json
{
  "pty_id": 0,
  "client_fd": <file_descriptor>
}
```

#### `close_pty(params)` → null

Terminate a PTY session.

**Parameters:**
```json
{
  "pty_id": 0
}
```

#### `write_pty(params)` → bytes_written

Send input (keyboard/mouse/paste) to a PTY.

**Parameters:**
```json
{
  "pty_id": 0,
  "data": "<binary_data>"
}
```

#### `resize_pty(params)` → null

Resize a PTY session.

**Parameters:**
```json
{
  "pty_id": 0,
  "rows": 24,
  "cols": 80
}
```

#### `get_server_info()` → Object

Query server version and capabilities.

**Response format:**
```json
{
  "version": "0.3.1",
  "ptys_max": 256,
  "clients_max": 64
}
```

### Server Notifications

The server sends these notifications to connected clients:

#### `redraw(params)`

Full or incremental screen update for an attached PTY.

**Parameters:**
```json
{
  "pty_id": 0,
  "data": "<vt_sequences>"
}
```

This contains raw VT100/ANSI escape sequences that should be rendered directly to the terminal.

#### `pty_closed(params)`

Notification that a PTY session has been closed.

**Parameters:**
```json
{
  "pty_id": 0
}
```

## Example Client Implementation

```typescript
import { RpcClient } from "./src/rpc";
import * as net from "net";

const socket = net.createConnection("/tmp/prise-" + process.getuid() + ".sock");
const rpc = new RpcClient(socket);

// Handle server notifications
rpc.on("redraw", (params) => {
  const { pty_id, data } = params;
  process.stdout.write(data);
});

// List PTY sessions
const ptys = await rpc.request("list_ptys", []);
console.log("Active PTYs:", ptys);

// Spawn a new PTY
const pty_id = await rpc.request("spawn_pty", {
  rows: 24,
  cols: 80,
  shell: "/bin/bash",
  attach: true,
});

// Attach to it
await rpc.request("attach_pty", {
  pty_id: pty_id,
  macos_option_as_alt: false,
});

// Send keyboard input
await rpc.request("write_pty", {
  pty_id: pty_id,
  data: "ls -la\n",
});
```

## Socket Location

The server creates a **Unix domain socket** in the system temp directory:

```
/tmp/prise-<uid>.sock
```

where `<uid>` is your numeric user ID (e.g., `1000` on Linux, `501` on macOS).

To find your UID:
```bash
id -u
```

To find the socket path:
```bash
ls -la /tmp/prise-*.sock
```

## Troubleshooting

### Socket not found

1. Verify the server is running:
   ```bash
   systemctl --user status prise  # Linux
   launchctl list | grep prise    # macOS
   ```

2. Check the correct socket path:
   ```bash
   ls -la /tmp/prise-$(id -u).sock
   ```

3. Verify file permissions:
   ```bash
   ls -la /tmp/prise-$(id -u).sock
   # Should be: srwxr-xr-x (socket owned by you)
   ```

### Connection refused

- The server may have crashed. Check logs:
  ```bash
  cat ~/.local/var/log/prise/server.log  # if installed via build
  ```

- Try restarting the server:
  ```bash
  brew services restart prise  # Homebrew
  # or manually:
  pkill -f "prise serve"
  ~/.local/bin/prise serve &
  ```

### Client hangs when attaching

- Check if the PTY ID is valid:
  ```bash
  node -e "const {RpcClient} = require('./dist/rpc.js'); ..."
  ```

- Ensure the server is responsive:
  ```bash
  # In another terminal, test the ping method
  # (would need a small test script)
  ```

## Development

### Building

```bash
# TypeScript compilation + bundling
npm run build

# Watch mode for development
npm run dev
```

### Testing

```bash
npm run test
```

### Debugging

Enable debug logging:
```bash
PRISE_DEBUG=1 bun run start
```

Or modify `src/rpc.ts` to add more `console.log` calls.

## Implementation Notes

- **Socket type**: Unix domain socket (AF_UNIX)
- **Protocol**: msgpack-RPC over raw socket
- **Encoding**: 32-bit msgpack (see msgpackr docs)
- **Async**: Fully asynchronous using Node.js/Bun streams
- **Request timeout**: 30 seconds per RPC request

## Related Documentation

- See `ARCHITECTURE.md` for server-side protocol details
- See main `README.md` for Prise server installation and configuration
- Prise server code: `src/server.zig`
- Prise client code: `src/client.zig` (built-in UI)
