# Quickstart — OpenClaw Session UI

## 1) Install

```bash
git clone <YOUR_REPO_URL>
cd session-ui
npm install
```

## 2) Get your Gateway token

On the OpenClaw host, run:

```bash
openclaw dashboard --no-open
```

Copy the `token` value from the printed URL.

OPSEC note: do **not** paste the full URL into chats or screenshots.
## 3) Run

```bash
npm start
```

Open:

- http://localhost:5174/?gatewayUrl=ws://127.0.0.1:18789

Then paste your token into **Connection → gateway token**.

## Kill switch

Each session row has a **Kill** button. It calls:

- `chat.abort { sessionKey }`

That stops the currently running agent response for that session.
