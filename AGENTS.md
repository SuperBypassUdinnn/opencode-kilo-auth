# AGENTS.md

Guidance for AI agents working with this repository.

## Overview

OpenCode V2 plugin for Kilo Gateway authentication. Registers a `kilo` provider with OpenCode, provides OAuth device-flow and API-key authentication, automatic live model discovery, and multi-account rotation across accounts.json.

## Build & Test Commands

```bash
bun install          # Install dependencies (or npm install)
bun run typecheck    # Type-check only (tsc --noEmit)
bun run build        # Compile TypeScript to dist/
```

Verification checklist before committing: `bun run typecheck` and `bun run build` must both be clean. End-to-end check: `opencode run --model kilo/kilo-auto/free "Reply with exactly: OK"` should print `OK` (works anonymously, no credentials needed).

## TypeScript Configuration

- `strict: true`
- `target: ESNext`, `module: ESNext`, `moduleResolution: bundler`
- No path aliases — all imports are relative

## Code Style

- `import type { ... }` for type-only imports; named imports preferred
- Relative imports without extensions
- No `I` prefix on interfaces; shared types in `types.ts`
- `camelCase` functions/variables, `PascalCase` types, `UPPER_SNAKE_CASE` constants
- Defensive try/catch with graceful degradation (fail-open); never empty catch blocks

## Module Structure

```
src/
├── index.ts      # Plugin entry: Plugin.define setup(), integration + provider registration, session hooks
├── auth.ts       # OAuth device flow (initiate/poll/credential), persists new accounts via appendAccount
├── accounts.ts   # accounts.json loading + mtime-based reload, KILO_API_KEY handling, log()
├── pool.ts       # Rotation engine: selectAccount, release, recordOutcome, retryVerdict, inFlight
├── models.ts     # fetchKiloModels(): live model discovery → OpenCode Model.Info[]
├── constants.ts  # URLs, provider id, env var names, timeouts
└── types.ts      # DeviceAuth/AccountFile/StoredAccount interfaces
```

## Plugin API (V2) — critical facts

- Import from `@opencode/plugin` (NOT the old `@opencode-ai/plugin` namespace)
- Entry: `export default Plugin.define({ id, async setup(ctx) { ... } })` — an object, never a bare function
- Provider packages MUST be OpenCode wrappers: use `package: "@opencode/ai/providers/openai-compatible"`. The npm `@ai-sdk/openai-compatible` fails at runtime with "does not export model(modelID, settings)"
- `editor.add()` info requires `integrationID` (branded cast) so OpenCode injects stored TUI credentials
- `Credential.OAuth` = `{ type: 'oauth', methodID (branded, required), refresh, access, expires (epoch ms), metadata? }`
- `Form.Fields` is a bare array of `{ key, title, type, ... }`; `Form.Answer` is `Record<string, string|number|boolean|readonly string[]>`
- Branded types (`Provider.ID`, `Model.ID`, `Integration.MethodID`) need casts: `as unknown as Brand<...>`
- Plugin `console.log` does NOT reach `~/.local/share/opencode/log/opencode.log`; set `KILO_POOL_LOG` to capture plugin logs in a file

## Key Design Patterns

1. **Auth injection via session hooks**: `http.request` sets the Bearer token from the pool selection (or leaves existing credentials / anonymous token); `http.response` records outcomes and cooldowns; `retry` decides retry-vs-stop from the settled request's timing.
2. **Device authorization flow**: `POST /api/device-auth/codes` → show verification URL → poll `GET /api/device-auth/codes/{code}` (202 pending, 403 denied, 410 expired) → resolve `Credential.OAuth` and persist the token to accounts.json.
3. **Rotation pool**: accounts.json (or `KILO_API_KEY`, or anonymous fallback) → `createRuntimes` → least-loaded selection with per-account cooldown after failures.
4. **Live model discovery**: `fetchKiloModels()` fetches `GET /api/openrouter/models` with a 10s timeout, maps to `Model.Info`, fail-open to `[]`.

## Dependencies

- `@opencode/plugin` (^2.2.1) — V2 plugin interface
- `@opencode/schema` — Model.Info / Provider.Info / Form types
- `zod` — schema validation
- `@ai-sdk/openai-compatible` — dev-time type reference only; runtime provider package is `@opencode/ai/providers/openai-compatible`

## API Endpoints

- Base: `https://api.kilo.ai` (override via `KILO_API_URL`)
- OpenRouter proxy: `https://api.kilo.ai/api/openrouter` (models + chat/completions)
- Device auth: `POST /api/device-auth/codes`, poll `GET /api/device-auth/codes/{code}`

## Files that must never be committed

- `accounts.json` — contains real OAuth tokens (gitignored)
- Any captured logs with tokens

## Documentation

- [README.md](README.md) — Installation, configuration, usage
- [CHANGELOG.md](CHANGELOG.md) — Version history
