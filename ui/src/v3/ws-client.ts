// Spec 261 + 272 — V3 WebSocket client.
//
// JSON-RPC 2.0 calls + binary frame consumer + auto-reconnect.

export const V3_WS_URL = "ws://127.0.0.1:4312";

export const BIN_TYPE_VIC_FRAME = 0x01;
export const BIN_TYPE_AUDIO_BUFFER = 0x02;
export const BIN_TYPE_TRACE_CHUNK = 0x03;
export const BIN_TYPE_ACK = 0x04;
export const BIN_TYPE_SID_WRITES = 0x05; // Spec 703 §8 — SID register-write stream

export interface BinaryFrame {
  type: number;
  seq: number;
  payload: Uint8Array;
}

export type ConnectionState = "connecting" | "open" | "closed" | "error";

export class V3WsClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private notificationHandlers = new Map<string, (params: any) => void>();
  private binaryHandlers = new Map<number, (frame: BinaryFrame) => void>();
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private state: ConnectionState = "closed";
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly url: string = V3_WS_URL) {}

  connect(): void {
    if (this.state === "connecting" || this.state === "open") return;
    this.setState("connecting");
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => this.setState("open");
    ws.onclose = () => {
      this.setState("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => this.setState("error");
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.onTextMessage(ev.data);
      else if (ev.data instanceof ArrayBuffer) this.onBinaryMessage(new Uint8Array(ev.data));
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  /** JSON-RPC call returning a promise. */
  call<T = any>(method: string, params?: any): Promise<T> {
    if (this.state !== "open" || !this.ws) {
      return Promise.reject(new Error(`WebSocket not open (state=${this.state})`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    });
  }

  /** Convenience wrapper for runtime/call (= AgentQueryApi facade). */
  runtime<T = any>(sessionId: string, op: string, ...args: any[]): Promise<T> {
    return this.call<T>("runtime/call", { session_id: sessionId, op, args });
  }

  onNotification(method: string, handler: (params: any) => void): () => void {
    this.notificationHandlers.set(method, handler);
    return () => this.notificationHandlers.delete(method);
  }

  onBinary(type: number, handler: (frame: BinaryFrame) => void): () => void {
    this.binaryHandlers.set(type, handler);
    return () => this.binaryHandlers.delete(type);
  }

  onState(listener: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  getState(): ConnectionState { return this.state; }

  private setState(s: ConnectionState): void {
    this.state = s;
    for (const l of this.stateListeners) l(s);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 1000);
  }

  private onTextMessage(data: string): void {
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method) {
      // Notification.
      const handler = this.notificationHandlers.get(msg.method);
      handler?.(msg.params);
    }
  }

  private onBinaryMessage(buf: Uint8Array): void {
    if (buf.length < 5) return;
    const type = buf[0]!;
    const seq = (buf[1]! | (buf[2]! << 8) | (buf[3]! << 16) | (buf[4]! << 24)) >>> 0;
    const payload = buf.slice(5);
    const handler = this.binaryHandlers.get(type);
    handler?.({ type, seq, payload });
  }
}

// Singleton for tabs to share.
let _client: V3WsClient | undefined;
export function getClient(): V3WsClient {
  if (!_client) {
    _client = new V3WsClient();
    _client.connect();
  }
  return _client;
}
