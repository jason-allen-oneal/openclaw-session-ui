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
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function b64urlEncode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function fingerprintPublicKey(spki: ArrayBuffer): Promise<string> {
  const raw = spki.slice(spki.byteLength - 32);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function buildDeviceAuthPayload(params: {
  version?: string;
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string;
  nonce?: string;
}) {
  const version = params.version || 'v2';
  const scopes = params.scopes.join(',');
  const token = params.token || '';
  const nonce = params.nonce || '';

  const base = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token
  ];
  if (version === 'v2') {
    base.push(nonce);
  }
  return base.join('|');
}

class DeviceIdentity {
  private keyPair: CryptoKeyPair | null = null;
  private deviceId: string | null = null;
  private spki: ArrayBuffer | null = null;

  async loadOrCreate(): Promise<{ deviceId: string; publicKey: string }> {
    const stored = localStorage.getItem('rev-session-ui-identity');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        const jwk = parsed.privateKey;
        this.keyPair = {
          publicKey: await crypto.subtle.importKey('jwk', parsed.publicKey, { name: 'Ed25519', namedCurve: 'Ed25519' }, true, ['verify']),
          privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519', namedCurve: 'Ed25519' }, true, ['sign'])
        };
        this.spki = await crypto.subtle.exportKey('spki', this.keyPair.publicKey);
        this.deviceId = await fingerprintPublicKey(this.spki);
        return { deviceId: this.deviceId, publicKey: b64urlEncode(this.spki.slice(this.spki.byteLength - 32)) };
      } catch (e) {
        console.warn('Failed to load identity, creating new one', e);
      }
    }

    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519', namedCurve: 'Ed25519' }, true, ['sign', 'verify']);
    this.keyPair = keyPair;
    this.spki = await crypto.subtle.exportKey('spki', this.keyPair.publicKey);
    this.deviceId = await fingerprintPublicKey(this.spki);

    const publicKeyJwk = await crypto.subtle.exportKey('jwk', this.keyPair.publicKey);
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', this.keyPair.privateKey);

    localStorage.setItem('rev-session-ui-identity', JSON.stringify({
      version: 1,
      deviceId: this.deviceId,
      publicKey: publicKeyJwk,
      privateKey: privateKeyJwk
    }));

    return { deviceId: this.deviceId, publicKey: b64urlEncode(this.spki.slice(this.spki.byteLength - 32)) };
  }

  async sign(payload: string): Promise<string> {
    if (!this.keyPair) throw new Error('Identity not loaded');
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, this.keyPair.privateKey, new TextEncoder().encode(payload));
    return b64urlEncode(sig);
  }
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private connectSent = false;
  private connectPromise: Promise<any> | null = null;
  private readyPromise: Promise<any> | null = null;
  private readyResolve: ((v: any) => void) | null = null;
  private readyReject: ((e: any) => void) | null = null;
  private challengeNonce: string | null = null;
  private identity = new DeviceIdentity();

  constructor(private opts: ConnectParams) {}

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    if (this.ws) return;
    this.connectPromise = null;
    this.connectSent = false;
    this.challengeNonce = null;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.ws = new WebSocket(this.opts.gatewayUrl);
    this.ws.addEventListener('open', () => {
    });
    this.ws.addEventListener('message', (e) => this.handleMessage(String((e as any).data ?? '')));
    this.ws.addEventListener('close', (e) => {
      const reason = String((e as any).reason ?? '');
      this.ws = null;
      this.challengeNonce = null;
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
    this.challengeNonce = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
  }

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

    if (!this.challengeNonce) {
      this.ws?.close(4000, 'missing nonce');
      return;
    }

    const { deviceId, publicKey } = await this.identity.loadOrCreate();
    const clientId = this.opts.clientName ?? 'openclaw-control-ui';
    const clientMode = 'webchat';
    const role = 'operator';
    const scopes = ['operator.read', 'operator.write'];
    const signedAtMs = Date.now();

    const auth = (this.opts.token || this.opts.password)
      ? { token: this.opts.token, password: this.opts.password }
      : undefined;

    const payload = buildDeviceAuthPayload({
      version: 'v2',
      deviceId,
      clientId,
      clientMode,
      role,
      scopes,
      signedAtMs,
      token: this.opts.token || '',
      nonce: this.challengeNonce
    });

    const signature = await this.identity.sign(payload);

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: clientId,
        version: this.opts.clientVersion ?? 'dev',
        platform: (navigator as any).platform ?? navigator.platform ?? 'web',
        mode: clientMode,
        instanceId: undefined
      },
      role,
      scopes,
      device: {
        id: deviceId,
        publicKey,
        signature,
        signedAt: signedAtMs,
        nonce: this.challengeNonce
      },
      caps: [],
      auth,
      userAgent: `rev-session-ui-browser/${navigator.userAgent}`,
      locale: navigator.language
    };

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
        this.challengeNonce = ev.payload?.nonce ?? null;
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
