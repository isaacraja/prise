/**
 * msgpack-RPC protocol implementation
 * 
 * Message format:
 * - Request: [0, msgid, method, params]
 * - Response: [1, msgid, error, result]
 * - Notification: [2, method, params]
 */

import { Packr, Unpackr } from "msgpackr";

export enum MessageType {
  Request = 0,
  Response = 1,
  Notification = 2,
}

export interface RpcRequest {
  msgid: number;
  method: string;
  params: unknown;
}

export interface RpcResponse {
  msgid: number;
  error: unknown;
  result: unknown;
}

export interface RpcNotification {
  method: string;
  params: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

/**
 * RPC codec handles encoding/decoding msgpack-RPC messages
 */
export class RpcCodec {
  private packr: Packr;
  unpackr: Unpackr;

  constructor() {
    this.packr = new Packr({ useRecords: false, mapsAsObjects: true });
    this.unpackr = new Unpackr({ useRecords: false, mapsAsObjects: true });
  }

  /**
   * Encode a request message to binary format
   */
  encodeRequest(msgid: number, method: string, params: unknown): Uint8Array {
    const packed = this.packr.pack([MessageType.Request, msgid, method, params]);
    return new Uint8Array(packed);
  }

  /**
   * Encode a response message to binary format
   */
  encodeResponse(msgid: number, error: unknown, result: unknown): Uint8Array {
    const packed = this.packr.pack([MessageType.Response, msgid, error, result]);
    return new Uint8Array(packed);
  }

  /**
   * Encode a notification message to binary format
   */
  encodeNotification(method: string, params: unknown): Uint8Array {
    const packed = this.packr.pack([MessageType.Notification, method, params]);
    return new Uint8Array(packed);
  }

  /**
   * Decode a msgpack array into an RPC message
   */
  decodeMessage(data: Uint8Array): RpcMessage | null {
    try {
      const decoded = this.unpackr.unpack(data);

      if (!Array.isArray(decoded) || decoded.length < 3) {
        console.error("[RPC] Invalid message format:", decoded);
        return null;
      }

      const [type, ...rest] = decoded;

      if (type === MessageType.Request && rest.length === 3) {
        const [msgid, method, params] = rest;
        return {
          msgid,
          method,
          params,
        } as RpcRequest;
      } else if (type === MessageType.Response && rest.length === 3) {
        const [msgid, error, result] = rest;
        return {
          msgid,
          error,
          result,
        } as RpcResponse;
      } else if (type === MessageType.Notification && rest.length === 2) {
        const [method, params] = rest;
        return {
          method,
          params,
        } as RpcNotification;
      }

      console.error("[RPC] Unknown message type:", type);
      return null;
    } catch (err) {
      console.error("[RPC] Failed to decode message:", err);
      return null;
    }
  }
}

/**
 * RPC client manages request/response correlation and callbacks
 */
export class RpcClient {
  private codec: RpcCodec;
  private socket: any;
  private msgidCounter: number = 1;
  private pendingRequests: Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private notificationHandlers: Map<string, (params: unknown) => void> = new Map();
  private buffer: Buffer = Buffer.alloc(0);
  private REQUEST_TIMEOUT_MS = 30000;

  constructor(socket: any) {
    this.codec = new RpcCodec();
    this.socket = socket;
  }

  /**
   * Send an RPC request and wait for response
   */
  async request(method: string, params: unknown = null): Promise<unknown> {
    const msgid = this.msgidCounter++;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(msgid);
        reject(new Error(`RPC request "${method}" (id=${msgid}) timed out after ${this.REQUEST_TIMEOUT_MS}ms`));
      }, this.REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(msgid, { resolve, reject, timeout });

      try {
        const encoded = this.codec.encodeRequest(msgid, method, params);
        this.socket.write(Buffer.from(encoded));
      } catch (err) {
        this.pendingRequests.delete(msgid);
        clearTimeout(timeout);
        reject(new Error(`Failed to send RPC request: ${err}`));
      }
    });
  }

  /**
   * Send an RPC notification (no response expected)
   */
  notify(method: string, params: unknown = null): void {
    try {
      const encoded = this.codec.encodeNotification(method, params);
      this.socket.write(Buffer.from(encoded));
    } catch (err) {
      console.error(`[RPC] Failed to send notification "${method}":`, err);
    }
  }

  /**
   * Register handler for notifications from server
   */
  on(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /**
   * Process incoming data from socket
   */
  processData(chunk: Buffer | Uint8Array): void {
    // Append chunk to buffer
    if (Buffer.isBuffer(chunk)) {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    } else {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    }

    // Decode all complete messages from buffer, preserving any remainder bytes.
    const messages: unknown[] = [];
    let lastEnd = 0;

    try {
      this.codec.unpackr.unpackMultiple(this.buffer, (msg: unknown, _start?: number, end?: number) => {
        messages.push(msg);
        if (typeof end === "number") {
          lastEnd = end;
        }
      });
    } catch {
      // Partial message at end (or corrupt data). We still process decoded messages
      // and keep any remaining bytes in the buffer for the next recv.
    }

    if (lastEnd > 0) {
      this.buffer = this.buffer.subarray(lastEnd);
    }

    for (const msg of messages) {
      this.handleMessage(msg);
    }
  }

  /**
   * Handle decoded RPC message
   */
  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;

    if (!Array.isArray(message)) {
      console.error("[RPC] Message is not an array:", message);
      return;
    }

    const [type, ...rest] = message as unknown[];

    if (type === MessageType.Response) {
      // Response: [1, msgid, error, result]
      if (rest.length !== 3) return;
      const [msgid, error, result] = rest;

      if (typeof msgid !== "number") return;

      const pending = this.pendingRequests.get(msgid);
      if (pending) {
        this.pendingRequests.delete(msgid);
        clearTimeout(pending.timeout);

        if (error !== null && error !== undefined) {
          pending.reject(new Error(`RPC error: ${JSON.stringify(error)}`));
        } else {
          pending.resolve(result);
        }
      }
    } else if (type === MessageType.Notification) {
      // Notification: [2, method, params]
      if (rest.length !== 2) return;
      const [method, params] = rest;

      if (typeof method !== "string") return;

      const handler = this.notificationHandlers.get(method);
      if (handler) {
        try {
          handler(params);
        } catch (err) {
          console.error(`[RPC] Error in notification handler for "${method}":`, err);
        }
      }
    }
  }
}
