# Server Architecture

## Lifecycle

- **Start**: Explicitly run with `prise serve` command
- **Socket**: Creates Unix domain socket at `/tmp/prise-{uid}.sock`
- **Shutdown**: Server runs indefinitely until manually stopped (does not auto-exit)
- **Cleanup**: Removes stale socket on startup; cleans up socket on shutdown

## Threading Model

1. **Main Thread (Event Loop)**:
   - Accepts client connections and handles msgpack-RPC requests/responses/notifications
   - Manages PTY sessions and routes messages between clients and PTYs
   - Sends screen updates (redraw notifications) to attached clients
   - Writes to PTYs as needed (keyboard input, mouse events, resize)
   - Handles render timers and frame scheduling

2. **PTY Threads** (one per session):
   - Performs blocking reads from the underlying PTY file descriptor
   - Processes VT sequences using ghostty-vt, updating local terminal state
   - Handles automatic responses to VT queries (e.g. Device Attributes) by writing directly to PTY
   - Signals dirty state to main thread via pipe

## Event-Oriented Frame Scheduler

- **Per-PTY Pipe**: Each `Pty` owns a non-blocking pipe pair
  - Read end: Registered with main thread's event loop
  - Write end: Used by PTY thread to signal dirty state

- **Producer (PTY Thread)**:
  - After updating terminal state, writes a single byte to pipe
  - `EAGAIN` is ignored (signal already pending)

- **Consumer (Main Thread)**:
  - **On Pipe Read**: Drains the pipe. If enough time has passed since `last_render_time` (8ms), renders immediately. Otherwise, schedules a timer for the remaining duration.
  - **On Timer**: Renders frame and updates `last_render_time`

- **Cleanup**: Render timers are cancelled when PTY sessions are destroyed to prevent event loop from staying alive

# Client Architecture

1. **Main Thread (Event Loop)**:
   - Responsible for initializing the UI (raw mode, entering alternate screen) and
   establishing the connection to the Server.
   - Runs the `io.Loop`, listening to:
     - **Server Socket**: Reads messages from server (screen updates, events).
     - **Pipe**: Receives input and resize notifications from TTY Thread.
   - Updates the local screen state based on Server messages.
   - Paints the screen to the local terminal (`stdout`).
   - Parses input from the pipe and sends events to the Server Socket.

2. **TTY Thread (Input Handler)**:
   - **Loop**: Performs blocking reads on the local TTY (Input).
   - Forwards raw input (keystrokes and escape sequences) to the Main Thread via pipe.
   - Does not handle signals directly; relies on in-band events from the terminal
     or Vaxis handling.

3. **Synchronization Flow**:
   - **Resize**: 
     1. Terminal sends resize sequence (or Vaxis generates it) -> TTY Thread forwards raw bytes -> Pipe.
     2. Main Thread parses bytes -> Detects `.winsize` event -> Sends resize request to Server.
     3. Server resizes internal PTY -> Sends resize event to Client.
     4. Main Thread receives event -> Updates renderer state -> Repaints.
   - **Shutdown**:
     - **User Quit (Ctrl+C)**: TTY thread sends quit message via pipe -> Main thread closes socket and pipes -> All pending I/O operations complete with errors -> io.Loop exits when pending count reaches 0 -> TTY thread exits naturally via should_quit flag -> Process exits cleanly.
     - **Server Quit**: Main thread detects EOF on socket -> Exits process.

# Client Data Model

1. **Double Buffering**:
   - Each **Surface** maintains two `Screen` buffers:
     - **Front Buffer**: Represents the stable state for the current frame.
     - **Back Buffer**: Receives incremental updates from the server.
   - **Update Cycle**:
     1. **Receive**: Messages from the server update the **Back Buffer**.
     2. **Frame Boundary**: When a frame is ready, the Surface copies/swaps
        Back -> Front.
     3. **Render**: The application draws the **Front Buffer** into the Vaxis
        virtual screen.
     4. **Vaxis**: Handles the final diffing and generation of VT sequences to
        update the physical terminal.

2. **Surfaces**:

    - A **Surface** represents the state of a single remote PTY.
    - Each Surface owns its own pair of Front/Back buffers.
    - The Client manages a collection of Surfaces (one per connected PTY).

# RPC Protocol (msgpack-RPC)

Prise uses **msgpack-RPC** over a Unix domain socket for client/server communication. This is what allows alternative UIs (like the OpenTUI client) to exist.

## Message Format

All messages are encoded using msgpack:

- Request: `[0, msgid, method, params]`
- Response: `[1, msgid, error, result]`
- Notification: `[2, method, params]`

## Socket Location

Default:

- `/tmp/prise-{uid}.sock`

Override:

- `PRISE_SOCKET=/path/to.sock`

## Core RPC Methods (Requests)

Implemented by the server in `src/server.zig`:

- `ping()` → `"pong"`
- `get_server_info()` → `{ version, pty_validity }`
- `list_ptys()` → `{ pty_validity, ptys: [...] }`
- `list_sessions()` → `{ pty_validity, sessions: [...] }`
- `spawn_pty({ rows, cols, attach, cwd?, env?, macos_option_as_alt })` → `pty_id`
- `close_pty(pty_id)`
- `attach_pty([pty_id, macos_option_as_alt?])`
- `resize_pty([pty_id, rows, cols])`
- `detach_pty(pty_id)`
- `detach_ptys([pty_id, ...])`
- `get_selection(pty_id)` → string | nil
- `clear_selection(pty_id)`

Note: for input, clients typically use notifications (below) rather than requests.

## Notifications

### Server → Client

- `redraw([events])` (see `src/redraw.zig` for the event list)
- `pty_exited([pty_id, exit_code])`
- `cwd_changed([pty_id, cwd])`
- `color_query({ ... })` (terminal capability probing)

### Client → Server

The server also accepts notifications for high-frequency input/resize:

- `write_pty([pty_id, data])` where `data` is msgpack bin
- `resize_pty([pty_id, rows, cols])`
- `key_input([pty_id, key_event])`
- `mouse_input([pty_id, mouse_event])`
- `paste_input([pty_id, data])`
- `focus_event([pty_id, focused])`
- `color_response({ ... })`

## Client Types

### Built-in Client (Lua)

- `src/client.zig` (Vaxis)
- Full UI (panes, tabs, command palette)
- Config: `~/.config/prise/init.lua`

### OpenTUI Client (TypeScript)

- `clients/opentui/`
- OpenTUI + Solid
- Minimal UI, evolving toward tmux-like panes/tabs

## Implementation Notes

- Server I/O uses `io.Loop` (io_uring on Linux, kqueue on macOS)
- PTY threads signal the main loop via pipes
