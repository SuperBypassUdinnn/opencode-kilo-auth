# Kilo Auth Plugin for OpenCode (V2)

OpenCode plugin for Kilo Gateway authentication — ported to the OpenCode V2 plugin API with automatic model discovery and multi-account rotation.

> Fork of [JungHoonGhae/opencode-kilo-auth](https://github.com/JungHoonGhae/opencode-kilo-auth), rewritten for OpenCode 2.x (`Plugin.define` API). This is an independent community plugin, not affiliated with Kilo.ai or OpenCode.

## Features

- **V2 plugin API** — `Plugin.define({ id, setup })` from `@opencode/plugin`; no more `SchemaError(Expected object at ["default"])`
- **Automatic model discovery** — fetches the live model list from `GET /api/openrouter/models` at startup (387+ models) and registers them with OpenCode; fail-open if the network is down
- **Anonymous mode** — zero config: without any credentials the plugin uses Kilo's anonymous free-tier token, giving access to free models such as `kilo/kilo-auto/free`
- **OAuth device flow** — connect via the TUI ("Connect provider" → Kilo Gateway); the token is persisted automatically to `accounts.json`
- **API key auth** — paste a Kilo API key through the TUI form
- **`KILO_API_KEY` env var** — set it and the plugin injects it as a single account, bypassing the accounts file
- **Multi-account rotation** — rotates across every account in `accounts.json` with cooldowns on failures, inflight tracking, and retry steering, spreading load and surviving rate limits
- **Long-lived tokens** — Kilo OAuth tokens last ~1 year; the refresh hook passes them through untouched

## Installation

Point your `opencode.jsonc` plugin array at this repo (local path or git URL):

```jsonc
{
  "plugin": ["file:///home/you/.clone/Github/opencode-plugins/opencode-kilo-auth"]
}
```

Or, once published to npm under your own package name, use that instead.

## Configuration

### Accounts file

Accounts live in `accounts.json`, resolved in this order:

1. `KILO_ACCOUNTS_PATH` env var
2. `<plugin-dir>/../accounts.json` (sibling of the plugin directory)

Accepted formats:

```jsonc
["token1", "token2"]

// or
[{ "id": "work", "token": "eyJ...", "label": "work@example.com" }]

// or
{ "accounts": ["token1", { "id": "personal", "token": "eyJ..." }] }
```

The file is re-read whenever its mtime changes — safe to edit while OpenCode runs. Accounts authenticated via the TUI are appended automatically.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `KILO_API_KEY` | Single-account shortcut; bypasses the accounts file |
| `KILO_ACCOUNTS_PATH` | Custom path to `accounts.json` |
| `KILO_POOL_LOG` | Path for a detailed rotation log file (`off`/`0` disables) |
| `KILO_API_URL` | Override the Kilo API base (default `https://api.kilo.ai`) |
| `KILO_EDITOR_NAME` | Value of the `X-KILO-EDITORNAME` header (default `OpenCode`) |

## Usage

With no configuration at all, the `kilo` provider appears with its free models and anonymous access works:

```bash
opencode run --model kilo/kilo-auto/free "Reply with exactly: OK"
```

For full model access and better quotas, connect an account: OpenCode TUI → "Connect provider" → Kilo Gateway → Device Authorization (or paste an API key). The token is stored in `accounts.json` and joins the rotation pool.

> **Note**: model discovery runs once at plugin startup. If the network is unreachable at that moment the model list starts empty — restart OpenCode to re-fetch.

## Module structure

```
src/
├── index.ts      # Plugin entry: setup(), integration/provider registration, session hooks
├── auth.ts       # OAuth device flow (initiate, poll, credential building)
├── accounts.ts   # accounts.json loading, env-key handling, persistence
├── pool.ts       # Rotation engine: selection, cooldowns, retry verdicts
├── models.ts     # Live model discovery → OpenCode Model.Info mapping
├── constants.ts  # API URLs, provider id, env var names
└── types.ts      # Shared interfaces
```

## Build & develop

```bash
bun install        # or npm install
bun run typecheck  # tsc --noEmit
bun run build      # tsc
```

The plugin is loaded by OpenCode from `dist/index.js`; rebuild and OpenCode's watcher reloads it.

## API endpoints used

- Base: `https://api.kilo.ai` (override with `KILO_API_URL`)
- Models: `GET /api/openrouter/models`
- Chat: `POST /api/openrouter/chat/completions` (OpenAI-compatible)
- Device auth: `POST /api/device-auth/codes`, poll `GET /api/device-auth/codes/{code}`

## License

MIT — see [LICENSE](LICENSE).
