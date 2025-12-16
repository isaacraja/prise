/**
 * Socket connection management for prise server
 */

import { RpcClient } from "./rpc";
import { createConnection } from "net";

const log = (level: string, msg: string, ...args: unknown[]) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${msg}`, ...args);
};

/**
 * Determines the socket path for prise server
 * Default: /tmp/prise-{uid}.sock or PRISE_SOCKET env var
 */
function getSocketPath(): string {
  // Check environment variable first
  if (process.env.PRISE_SOCKET) {
    return process.env.PRISE_SOCKET;
  }

  // Default socket path: /tmp/prise-{uid}.sock
  const uid = process.getuid?.() || 1000;
  return `/tmp/prise-${uid}.sock`;
}

/**
 * Connection manager handles socket lifecycle and reconnection
 */
export class PriseConnection {
  private socket: any;
  private rpc: RpcClient | null = null;
  private socketPath: string;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelayMs: number = 1000;
  private onReconnect: (() => void) | null = null;

  constructor(socketPath?: string) {
    this.socketPath = socketPath || getSocketPath();
  }

  /**
   * Connect to prise server
   */
  async connect(): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      log("info", "Connecting to prise server at", this.socketPath);

      this.socket = createConnection(this.socketPath, () => {
        log("info", "Connected to prise server");
        this.isConnected = true;
        this.reconnectAttempts = 0;

        // Initialize RPC client
        this.rpc = new RpcClient(this.socket);

        // Set up data handler
        this.socket.on("data", (chunk: Buffer) => {
          if (this.rpc) {
            this.rpc.processData(new Uint8Array(chunk));
          }
        });

        // Handle connection close
        this.socket.on("close", () => {
          log("info", "Connection closed");
          this.isConnected = false;
          this.rpc = null;
          this.attemptReconnect();
        });

        // Handle connection error
        this.socket.on("error", (err: Error) => {
          log("error", "Socket error:", err.message);
          this.isConnected = false;
          this.rpc = null;
          this.attemptReconnect();
        });

        resolve(this.rpc);
      });

      // Handle connection error during initial connect
      this.socket.on("error", (err: Error) => {
        if (!this.isConnected) {
          log("error", "Failed to connect:", err.message);
          reject(err);
        }
      });
    });
  }

  /**
   * Attempt to reconnect to server
   */
  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log("error", "Max reconnection attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelayMs * this.reconnectAttempts;
    log("info", `Attempting reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms`);

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      await this.connect();
      if (this.onReconnect) {
        this.onReconnect();
      }
    } catch (err) {
      log("warn", "Reconnection failed:", err);
      this.attemptReconnect();
    }
  }

  /**
   * Set callback for when connection is re-established
   */
  setReconnectCallback(callback: () => void): void {
    this.onReconnect = callback;
  }

  /**
   * Get RPC client for sending requests
   */
  getRpc(): RpcClient {
    if (!this.rpc) {
      throw new Error("Not connected to server");
    }
    return this.rpc;
  }

  /**
   * Check if connected
   */
  isSocketConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Gracefully close connection
   */
  close(): void {
    if (this.socket) {
      this.socket.destroy();
    }
    this.isConnected = false;
    this.rpc = null;
  }
}
