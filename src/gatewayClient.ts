export type GatewayEvent = { type: 'event'; event: string; seq?: number; payload?: any };
export type GatewayRes = { type: 'res'; id: string; ok: boolean; payload?: any; error?: { message?: string } };
export type GatewayMsg = GatewayEvent | GatewayRes | any;

export type ConnectParams = {
  gatewayUrl: string; // ws://127.0.0.1:18789
  token?: string;
  password?: string;
  onEvent?: (ev: GatewayEvent) => void;
  onClose?: (info: { code: number; reason: string }) => void;
  clientName?: string;
  clientVersion?: string;
};

function rid() {
  // tiny request id (matches control-ui style enough)
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private connectSent = false;
  private connectPromise: Promise<any> | null = null;
  private readyPromise: Promise<any> | null = null;
  private readyResolve: ((v: any) => void) | null = null;
  private readyReject: ((e: any) => void) | null = null;

  constructor(private opts: ConnectParams) {}

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    if (this.ws) return;
    this.connectPromise = null;
    this.connectSent = false;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.ws = new WebSocket(this.opts.gatewayUrl);
    this.ws.addEventListener('open', () => {
      void this.sendConnect();
    });
    this.ws.addEventListener('message', (e) => this.handleMessage(String((e as any).data ?? '')));
    this.ws.addEventListener('close', (e) => {
      const reason = String((e as any).reason ?? '');
      this.ws = null;
      for (const [id, p] of this.pending.entries()) {
        p.reject(new Error(`gateway closed (${e.code}): ${reason}`));
        this.pending.delete(id);
      }
      if (this.readyReject) {
        this.readyReject(new Error(`gateway closed (${e.code}): ${reason}`));
        this.readyReject = null;
        this.readyResolve = null;
      }
      this.opts.onClose?.({ code: e.code, reason });
    });
    this.ws.addEventListener('error', () => {});
  }

  stop() {
    this.ws?.close();
    this.ws = null;
    this.connectPromise = null;
    this.connectSent = false;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
  }

  /** Resolves after a successful `connect` handshake. */
  ready(): Promise<any> {
    return this.readyPromise ?? Promise.reject(new Error('not started'));
  }

  async request(method: string, params?: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('gateway not connected');
    }
    const id = rid();
    const msg = { type: 'req', id, method, params };
    const p = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(msg));
    return p;
  }

  private async sendConnect() {
    if (this.connectSent) return;
    this.connectSent = true;

    const auth = (this.opts.token || this.opts.password)
      ? { token: this.opts.token, password: this.opts.password }
      : undefined;

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        // Must match the gateway's allowed client schema.
        // Reuse the official Control UI id so the handshake schema validates.
        id: this.opts.clientName ?? 'openclaw-control-ui',
        version: this.opts.clientVersion ?? 'dev',
        platform: (navigator as any).platform ?? navigator.platform ?? 'web',
        mode: 'webchat',
        instanceId: undefined
      },
      role: 'operator',
      // OPSEC hardening: least privilege scopes.
      // Session UI needs read (list/history) + write (send/abort/patch).
      scopes: ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals', 'operator.pairing'],
      device: undefined,
      caps: [],
      auth,
      userAgent: navigator.userAgent,
      locale: navigator.language
    };

    // If the gateway wants a nonce challenge, it'll emit connect.challenge; we retry.
    this.connectPromise = this.request('connect', params);
    try {
      const hello = await this.connectPromise;
      this.readyResolve?.(hello);
      this.readyResolve = null;
      this.readyReject = null;
    } catch (e) {
      this.readyReject?.(e);
      this.readyResolve = null;
      this.readyReject = null;
      // Let close handler + UI display the error.
      try { this.ws?.close(4000, 'connect failed'); } catch {}
    }
  }

  private handleMessage(raw: string) {
    let msg: GatewayMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg?.type === 'event') {
      const ev = msg as GatewayEvent;
      if (ev.event === 'connect.challenge') {
        // Challenge: resend connect (we're not doing device identity signing in this mini client).
        this.connectSent = false;
        this.connectPromise = null;
        void this.sendConnect();
        return;
      }
      try {
        this.opts.onEvent?.(ev);
      } catch (e) {
        console.error('event handler error', e);
      }
      return;
    }

    if (msg?.type === 'res') {
      const res = msg as GatewayRes;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.payload);
      else p.reject(new Error(res.error?.message ?? 'request failed'));
      return;
    }
  }
}
