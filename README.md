# OpenClaw Session UI

A tiny local web UI for browsing OpenClaw sessions and chatting with them.

## Features

- List sessions (with simple grouping)
- View chat history
- Send messages
- **Kill switch** per session (calls `chat.abort` for that session)

## Install

```bash
cd session-ui
npm install
```

## Run

### Dev

```bash
npm run dev
```

Open: http://localhost:5174

### Production preview

```bash
npm start
```

## Connect

This UI connects to the OpenClaw Gateway websocket.

### Get your Gateway token

On the OpenClaw host:

```bash
openclaw dashboard --no-open
```

Copy the `token` value from the printed URL. Treat it like a password.

### Configure the UI

- Gateway URL format: `ws://127.0.0.1:18789`
- Auth: paste the Gateway token into the UI.
  - By default it is stored **session-only** (sessionStorage).
  - Optional: enable **Remember token** to persist via localStorage.

(We intentionally do **not** support `?token=...` in the URL to reduce accidental token leakage via browser history/screenshots/referrers.)

## Security / OPSEC

- This UI is meant to be run on **localhost**.
- The gateway token is effectively a password.
- **No `?token=...` support** (to reduce accidental leakage via browser history/screenshots/referrers).
- Token storage:
  - default: **sessionStorage** (clears when browser closes)
  - optional: **Remember token** stores it in localStorage
- Least privilege: the WS client requests only `operator.read` + `operator.write` scopes.
- A basic CSP + `referrer=no-referrer` is set in `index.html`.
- The Kill switch uses `chat.abort` (stops active runs; does not delete history).
