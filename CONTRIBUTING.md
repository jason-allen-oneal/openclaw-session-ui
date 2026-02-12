# Contributing (Session UI)

This repo is intentionally small.

## Dev setup

```bash
npm install
npm run dev
```

Open: http://localhost:5174

## Building

```bash
npm run build
```

## Code style

- Keep dependencies minimal.
- Prefer plain CSS over adding a framework.
- Avoid clever abstractions — this is an ops tool.

## Security

This UI talks to the OpenClaw Gateway with operator scopes.

- Don’t add features that execute arbitrary shell commands.
- Treat the gateway token like a password.
- Default bind: localhost only.

## PRs

- One feature per PR.
- Include a short screenshot/GIF for UI changes.
