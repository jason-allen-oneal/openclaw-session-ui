import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GatewayClient, GatewayEvent } from './gatewayClient';
import { markdownToHtml } from './markdown';

type SessionRow = {
  key: string;
  kind?: string;
  label?: string;
  updatedAt?: number;
  lastMessageAt?: number;
  model?: string;
  tokens?: string;
};

type ChatMsg = {
  role: 'user' | 'assistant' | 'system' | string;
  content?: any;
  timestamp?: number;
};

function getText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p) return '';
        if (typeof p === 'string') return p;
        if (p.type === 'text') return p.text ?? '';
        return '';
      })
      .join('')
      .trim();
  }
  if (content && typeof content === 'object') {
    if (content.type === 'text') return content.text ?? '';
  }
  return '';
}

function fmtTime(ts?: number) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

function groupKeyForSession(s: SessionRow): string {
  // Pin the primary session so it never gets visually "lost" under a project label.
  if (s.key === 'agent:main:main') return 'main';

  const label = (s.label ?? '').trim();
  const m = /^([a-zA-Z0-9_-]+):/.exec(label);
  if (m) return m[1].toLowerCase();
  // fallback grouping based on key segments
  if (s.key.includes(':cron:')) return 'cron';
  if (s.key.includes(':discord:') || s.key.includes(':slack:') || s.key.includes(':telegram:')) return 'channels';
  return 'other';
}

function isUserSession(s: SessionRow): boolean {
  // Your ask: “only my sessions”. Heuristic: hide group/channel sessions + cron by default.
  if (s.kind === 'group') return false;
  if (s.key.includes(':cron:')) return false;
  if (s.key.includes(':discord:') || s.key.includes(':slack:') || s.key.includes(':telegram:')) return false;
  return true;
}

export default function App() {
  const urlParams = new URLSearchParams(location.search);
  const defaultGatewayUrl = urlParams.get('gatewayUrl') ?? 'ws://127.0.0.1:18789';

  const [rememberToken, setRememberToken] = useState<boolean>(() => {
    // OPSEC: default OFF.
    return (localStorage.getItem('sessionUi.rememberToken') ?? '') === '1';
  });

  const [gatewayUrl, setGatewayUrl] = useState<string>(() => {
    const stored = localStorage.getItem('sessionUi.gatewayUrl');
    return stored && stored.trim() ? stored : defaultGatewayUrl;
  });

  const [token, setToken] = useState<string>(() => {
    // OPSEC: never read token from URL query params.
    // Prefer sessionStorage unless user explicitly opts-in to remembering.
    const sess = sessionStorage.getItem('sessionUi.token') ?? '';
    const perm = localStorage.getItem('sessionUi.token') ?? '';
    const picked = (rememberToken ? perm : sess).trim();
    return picked;
  });

  const [connected, setConnected] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);

  const clientRef = useRef<GatewayClient | null>(null);

  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>(() => localStorage.getItem('sessionUi.selectedKey') ?? 'agent:main:main');
  const selectedKeyRef = useRef<string>(selectedKey);

  const [search, setSearch] = useState('');
  const [showOnlyUser, setShowOnlyUser] = useState(true);
  const [archivedKeys, setArchivedKeys] = useState<Record<string, true>>(() => {
    try {
      return JSON.parse(localStorage.getItem('sessionUi.archived') ?? '{}');
    } catch {
      return {};
    }
  });

  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const chatMessagesRef = useRef<ChatMsg[]>([]);
  const [chatStream, setChatStream] = useState<string | null>(null);
  const chatStreamRef = useRef<string | null>(null);
  const [input, setInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSending, setChatSending] = useState(false);

  // Prevent cross-session UI bleed by caching per sessionKey and guarding async updates.
  const chatCacheRef = useRef<Record<string, { messages: ChatMsg[]; stream: string | null }>>({});

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  function saveArchived(next: Record<string, true>) {
    setArchivedKeys(next);
    localStorage.setItem('sessionUi.archived', JSON.stringify(next));
  }

  useEffect(() => {
    localStorage.setItem('sessionUi.gatewayUrl', gatewayUrl);
  }, [gatewayUrl]);

  useEffect(() => {
    // OPSEC: store token in sessionStorage by default.
    sessionStorage.setItem('sessionUi.token', token);
    if (rememberToken) {
      localStorage.setItem('sessionUi.token', token);
    } else {
      localStorage.removeItem('sessionUi.token');
    }
  }, [token, rememberToken]);

  useEffect(() => {
    localStorage.setItem('sessionUi.rememberToken', rememberToken ? '1' : '0');
  }, [rememberToken]);

  useEffect(() => {
    localStorage.setItem('sessionUi.selectedKey', selectedKey);
    selectedKeyRef.current = selectedKey;
  }, [selectedKey]);

  // Connect once.
  useEffect(() => {
    const client = new GatewayClient({
      gatewayUrl,
      token: token || undefined,
      onClose: ({ code, reason }) => {
        setConnected(false);
        setConnError(`disconnected (${code}): ${reason || 'closed'}`);
      },
      // IMPORTANT: this callback is captured once at connect-time; it must use refs,
      // not render-time state, to avoid cross-session bleed.
      onEvent: (ev) => onEvent(ev)
    });

    clientRef.current = client;
    setConnError(null);
    client.connect();

    // Wait for the gateway `connect` handshake to succeed.
    let cancelled = false;
    client
      .ready()
      .then(() => {
        if (cancelled) return;
        setConnected(true);
        setConnError(null);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setConnected(false);
        setConnError(String(e?.message ?? e));
      });

    return () => {
      cancelled = true;
      client.stop();
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayUrl, token]);

  function onEvent(ev: GatewayEvent) {
    if (ev.event !== 'chat') return;

    const p = ev.payload;
    const evKey = String(p?.sessionKey ?? '');
    if (!evKey) return;

    // Never trust render-time selectedKey inside a long-lived websocket callback.
    // Use ref to prevent cross-session bleed.
    if (evKey !== selectedKeyRef.current) return;

    if (p.state === 'delta') {
      // control-ui treats delta.message as full message text sometimes
      const text = getText(p.message?.content ?? p.message ?? '');
      if (text) {
        chatCacheRef.current[evKey] = {
          messages: chatCacheRef.current[evKey]?.messages ?? chatMessagesRef.current,
          stream: text,
        };
        chatStreamRef.current = text;
        setChatStream(text);
      }
    }

    if (p.state === 'final') {
      chatCacheRef.current[evKey] = {
        messages: chatCacheRef.current[evKey]?.messages ?? chatMessagesRef.current,
        stream: null,
      };
      chatStreamRef.current = null;
      setChatStream(null);
      void refreshChat(evKey);
    }

    if (p.state === 'error' || p.state === 'aborted') {
      chatCacheRef.current[evKey] = {
        messages: chatCacheRef.current[evKey]?.messages ?? chatMessagesRef.current,
        stream: null,
      };
      chatStreamRef.current = null;
      setChatStream(null);
    }
  }

  async function refreshSessions() {
    const c = clientRef.current;
    if (!c) return;
    try {
      const res = await c.request('sessions.list', { includeGlobal: false, includeUnknown: false, limit: 500 });
      const rows: SessionRow[] = Array.isArray(res?.sessions) ? res.sessions : (Array.isArray(res) ? res : []);
      setSessions(rows);
    } catch (e: any) {
      setConnError(String(e?.message ?? e));
    }
  }

  async function refreshChat(forKey?: string) {
    const c = clientRef.current;
    if (!c) return;

    const key = (forKey ?? selectedKey).trim();
    if (!key) return;

    setChatLoading(true);
    try {
      const res = await c.request('chat.history', { sessionKey: key, limit: 200 });
      const msgs: ChatMsg[] = Array.isArray(res?.messages) ? res.messages : [];

      // Cache per-key. Only update visible UI if the user is still on that key.
      chatCacheRef.current[key] = { messages: msgs, stream: chatCacheRef.current[key]?.stream ?? null };
      if (selectedKeyRef.current === key) {
        chatMessagesRef.current = msgs;
        setChatMessages(msgs);
      }
    } catch (e: any) {
      setConnError(String(e?.message ?? e));
    } finally {
      setChatLoading(false);
    }
  }

  // periodic session refresh
  useEffect(() => {
    if (!connected) return;
    void refreshSessions();
    const t = setInterval(() => void refreshSessions(), 5000);
    return () => clearInterval(t);
  }, [connected]);

  // refresh chat when selection changes
  useEffect(() => {
    if (!connected) return;

    // Restore from per-session cache immediately to avoid visual bleed.
    const cached = chatCacheRef.current[selectedKey];
    if (cached) {
      chatMessagesRef.current = cached.messages;
      chatStreamRef.current = cached.stream ?? null;
      setChatMessages(cached.messages);
      setChatStream(cached.stream ?? null);
    } else {
      chatMessagesRef.current = [];
      chatStreamRef.current = null;
      setChatMessages([]);
      setChatStream(null);
    }

    void refreshChat(selectedKey);
  }, [connected, selectedKey]);

  // auto-scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, chatStream]);

  const visibleSessions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sessions
      .filter((s) => !archivedKeys[s.key])
      .filter((s) => (showOnlyUser ? isUserSession(s) : true))
      .filter((s) => {
        if (!q) return true;
        return (
          s.key.toLowerCase().includes(q) ||
          (s.label ?? '').toLowerCase().includes(q) ||
          fmtTime(s.updatedAt).toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (b.updatedAt ?? b.lastMessageAt ?? 0) - (a.updatedAt ?? a.lastMessageAt ?? 0));
  }, [sessions, archivedKeys, search, showOnlyUser]);

  const grouped = useMemo(() => {
    const map = new Map<string, SessionRow[]>();
    for (const s of visibleSessions) {
      const g = groupKeyForSession(s);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(s);
    }
    const keys = Array.from(map.keys()).sort((a, b) => {
      const order = ['proj', 'bug', 'ops', 'main', 'other', 'channels', 'cron'];
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return a.localeCompare(b);
    });
    return keys.map((k) => [k, map.get(k)!] as const);
  }, [visibleSessions]);

  async function abortSession(sessionKey: string) {
    const c = clientRef.current;
    if (!c) return;

    const key = sessionKey.trim();
    if (!key) return;

    const ok = confirm(`Abort all active runs for session?\n\n${key}`);
    if (!ok) return;

    try {
      await c.request('chat.abort', { sessionKey: key });
      // give the gateway a moment, then refresh
      setTimeout(() => void refreshChat(key), 800);
    } catch (e: any) {
      setConnError(String(e?.message ?? e));
    }
  }

  async function send() {
    const c = clientRef.current;
    if (!c) return;
    const msg = input.trim();
    if (!msg) return;

    setChatSending(true);
    setInput('');

    try {
      const idempotencyKey = `${selectedKey}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      await c.request('chat.send', {
        sessionKey: selectedKey,
        message: msg,
        deliver: false,
        idempotencyKey
      });
    } catch (e: any) {
      setConnError(String(e?.message ?? e));
    } finally {
      setChatSending(false);
      // We rely on chat events to refresh; but if events fail, do a delayed refresh.
      setTimeout(() => void refreshChat(), 1200);
    }
  }

  async function newProjectSession() {
    const name = prompt('Project label (e.g., proj:billing-refactor):', 'proj:');
    if (!name) return;
    const slug = name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9:_-]/g, '')
      .replace(/:+/g, ':')
      .replace(/^-+|-+$/g, '');

    const key = `agent:main:${slug || 'proj:' + Date.now()}`;
    setSelectedKey(key);

    // Create it by sending a first message (keeps it visible in sessions.list).
    const c = clientRef.current;
    if (!c) return;
    try {
      const idempotencyKey = `${key}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      await c.request('chat.send', {
        sessionKey: key,
        message: `Session created. Context: ${name}`,
        deliver: false,
        idempotencyKey
      });
      await c.request('sessions.patch', { key, label: name });
      await refreshSessions();
    } catch (e: any) {
      setConnError(String(e?.message ?? e));
    }
  }

  async function renameLabel() {
    const label = prompt('New label for this session:', sessions.find((s) => s.key === selectedKey)?.label ?? '');
    if (label === null) return;
    const c = clientRef.current;
    if (!c) return;
    try {
      await c.request('sessions.patch', { key: selectedKey, label });
      await refreshSessions();
    } catch (e: any) {
      setConnError(String(e?.message ?? e));
    }
  }

  async function summarize() {
    const c = clientRef.current;
    if (!c) return;
    const promptText =
      'Summarize this session so far in terse bullet points. Include: current goal, decisions made, next actions, and any blockers. Keep it under ~12 bullets.';
    try {
      const idempotencyKey = `${selectedKey}:summarize:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      await c.request('chat.send', { sessionKey: selectedKey, message: promptText, deliver: false, idempotencyKey });
    } catch (e: any) {
      setConnError(String(e?.message ?? e));
    }
  }

  function archive() {
    const next = { ...archivedKeys, [selectedKey]: true as const };
    saveArchived(next);
    const remaining = visibleSessions.filter((s) => !next[s.key]);
    if (remaining[0]) setSelectedKey(remaining[0].key);
  }

  function unarchiveAll() {
    if (!confirm('Unarchive all sessions in this UI?')) return;
    saveArchived({});
  }

  return (
    <div className="layout">
      <div className="sidebar">
        <div className="sidebarHeader">
          <div className="rowSpace">
            <div style={{ fontWeight: 750 }}>Sessions</div>
            <span className="badge">
              <span style={{ color: connected ? 'var(--ok)' : 'var(--danger)' }}>●</span>
              {connected ? 'Connected' : 'Offline'}
            </span>
          </div>

          <div className="row" style={{ flexWrap: 'wrap' }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sessions…"
              style={{ flex: 1, minWidth: 180 }}
            />
            <button onClick={() => setShowOnlyUser((v) => !v)} title="Toggle only-my-sessions filter">
              {showOnlyUser ? 'My' : 'All'}
            </button>
          </div>

          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button onClick={newProjectSession}>New project</button>
            <button onClick={unarchiveAll} title="Clears local UI-only archive list">
              Unarchive
            </button>
          </div>

          <div className="small">
            <div>Gateway: <span style={{ color: 'var(--muted)' }}>{gatewayUrl}</span></div>
            {connError ? <div style={{ color: 'var(--danger)' }}>{connError}</div> : null}
            {!token ? <div className="small">Token missing. Tip: run <code>openclaw dashboard --no-open</code> and paste the token param.</div> : null}
          </div>

          <details>
            <summary className="small">Connection</summary>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input value={gatewayUrl} onChange={(e) => setGatewayUrl(e.target.value)} placeholder="ws://127.0.0.1:18789" />
              <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="gateway token" />
              <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={rememberToken} onChange={(e) => setRememberToken(e.target.checked)} />
                Remember token (stores in localStorage)
              </label>
              <div className="small">Default is session-only storage (clears when browser closes).</div>
            </div>
          </details>
        </div>

        <div className="sessionList">
          {grouped.length === 0 ? <div className="small" style={{ padding: 10 }}>No sessions.</div> : null}

          {grouped.map(([g, rows]) => (
            <div key={g}>
              <div className="groupHeader">{g}</div>
              {rows.map((s) => {
                const active = s.key === selectedKey;
                const label = (s.label ?? '').trim();
                const title = label || s.key;
                const when = s.updatedAt ?? s.lastMessageAt;
                return (
                  <div
                    key={s.key}
                    className={`sessionItem ${active ? 'active' : ''}`}
                    onClick={() => setSelectedKey(s.key)}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="sessionTitle" style={{ justifyContent: 'space-between' }}>
                      <div className="sessionLabel">{title}</div>
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void abortSession(s.key);
                        }}
                        disabled={!connected}
                        title="Kill switch: abort all active runs in this session"
                        style={{
                          padding: '4px 8px',
                          fontSize: 12,
                          borderRadius: 999,
                          borderColor: 'rgba(255,77,77,0.45)',
                          background: 'rgba(255,77,77,0.08)',
                          color: 'var(--text)'
                        }}
                      >
                        Kill
                      </button>
                    </div>
                    <div className="sessionKey">{s.key}</div>
                    <div className="sessionMeta">
                      <span>{when ? fmtTime(when) : ''}</span>
                      {s.model ? <span>· {s.model}</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="main">
        <div className="mainHeader">
          <div className="rowSpace">
            <div>
              <div style={{ fontWeight: 750 }}>{sessions.find((s) => s.key === selectedKey)?.label || selectedKey}</div>
              <div className="small" style={{ marginTop: 4 }}>{selectedKey}</div>
            </div>
            <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button onClick={renameLabel} disabled={!connected}>Rename</button>
              <button onClick={summarize} disabled={!connected}>Summarize</button>
              <button onClick={archive}>Archive</button>
              <button onClick={refreshChat} disabled={!connected || chatLoading}>Refresh</button>
            </div>
          </div>
        </div>

        <div className="chat">
          {chatLoading ? <div className="small" style={{ textAlign: 'center', padding: 10 }}>Loading…</div> : null}

          {chatMessages.map((m, i) => {
            const text = getText(m.content);
            if (!text) return null;
            const cls = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : '';
            return (
              <div className={`msg ${cls}`} key={i}>
                <div className="role">{m.role}{m.timestamp ? ` · ${fmtTime(m.timestamp)}` : ''}</div>
                <div className="msgText" dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }} />
              </div>
            );
          })}

          {chatStream ? (
            <div className="msg assistant">
              <div className="role">assistant · streaming</div>
              <div className="msgText" dangerouslySetInnerHTML={{ __html: markdownToHtml(chatStream) }} />
            </div>
          ) : null}

          <div ref={chatEndRef} />
        </div>

        <div className="composer">
          <div className="composerInner">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;

                // Shift+Enter inserts newline
                if (e.shiftKey) {
                  e.stopPropagation();
                  return;
                }

                // Enter sends
                e.preventDefault();
                void send();
              }}
              placeholder={connected ? 'Message… (Enter to send, Shift+Enter for newline)' : 'Disconnected'}
              disabled={!connected || chatSending}
              rows={2}
              style={{ resize: 'vertical' }}
            />
            <button onClick={() => void send()} disabled={!connected || chatSending || !input.trim()}>
              Send
            </button>
          </div>
          <div className="small" style={{ maxWidth: 900, margin: '8px auto 0 auto' }}>
            Deliver is OFF (UI-only). This won’t broadcast to external channels.
          </div>
        </div>
      </div>
    </div>
  );
}
