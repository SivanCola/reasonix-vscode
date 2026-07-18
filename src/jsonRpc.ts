import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./acpTypes";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type JsonRpcPeerHandlers = {
  onNotification?: (method: string, params: unknown) => Promise<void> | void;
  onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
  onError?: (err: Error) => void;
};

export class JsonRpcPeer extends EventEmitter {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  constructor(
    private readonly writer: Writable,
    private readonly handlers: JsonRpcPeerHandlers = {},
    private readonly trace?: (line: string) => void,
  ) {
    super();
  }

  sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("JSON-RPC peer is closed"));
    }
    const id = this.nextId++;
    const frame: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.writeFrame(frame);
    return promise;
  }

  sendNotification(method: string, params?: unknown): void {
    if (this.closed) {
      return;
    }
    const frame: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.writeFrame(frame);
  }

  handleData(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    for (;;) {
      const i = this.buffer.indexOf("\n");
      if (i < 0) {
        return;
      }
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line.length > 0) {
        this.dispatchLine(line);
      }
    }
  }

  close(reason = new Error("JSON-RPC peer closed")): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(reason);
    }
    this.pending.clear();
  }

  private dispatchLine(line: string): void {
    this.trace?.("< " + line);
    let frame: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
    try {
      frame = JSON.parse(line) as JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
    } catch (err) {
      this.reportError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if ("method" in frame && frame.method && "id" in frame) {
      void this.handleRequest(frame);
      return;
    }
    if ("method" in frame && frame.method) {
      const handler = this.handlers.onNotification;
      if (handler) {
        void Promise.resolve()
          .then(() => handler(frame.method, frame.params))
          .catch((err: unknown) => this.reportError(err instanceof Error ? err : new Error(String(err))));
      }
      return;
    }
    if ("id" in frame) {
      this.handleResponse(frame);
      return;
    }
    this.reportError(new Error("invalid JSON-RPC frame"));
  }

  private async handleRequest(frame: JsonRpcRequest): Promise<void> {
    try {
      const result = this.handlers.onRequest ? await this.handlers.onRequest(frame.method, frame.params) : undefined;
      if (!this.closed) {
        this.writeFrame({ jsonrpc: "2.0", id: frame.id, result });
      }
    } catch (err) {
      if (!this.closed) {
        const message = err instanceof Error ? err.message : String(err);
        this.writeFrame({ jsonrpc: "2.0", id: frame.id, error: { code: -32603, message } });
      }
    }
  }

  private handleResponse(frame: JsonRpcResponse): void {
    const id = typeof frame.id === "number" ? frame.id : Number(frame.id);
    if (Number.isNaN(id)) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    if (frame.error) {
      pending.reject(new Error(frame.error.message));
      return;
    }
    pending.resolve(frame.result);
  }

  private writeFrame(frame: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    const line = JSON.stringify(frame);
    this.trace?.("> " + line);
    this.writer.write(line + "\n");
  }

  private reportError(err: Error): void {
    this.handlers.onError?.(err);
  }
}
