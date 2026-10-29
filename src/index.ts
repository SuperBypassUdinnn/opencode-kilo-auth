import { Plugin } from "@opencode/plugin"
import type {
  SessionHttpRequest,
  SessionHttpResponse,
  SessionRetry,
} from "@opencode/plugin/promise/session"
import type { Form } from "@opencode/schema/form"
import { buildDeviceAuthAuthorization } from "./auth"
import { ANONYMOUS_API_KEY, DEFAULT_EDITOR_NAME, ENV_EDITOR_NAME, HEADER_EDITORNAME, KILO_OPENROUTER_BASE, PROVIDER_ID, TOKEN_EXPIRATION_MS } from "./constants"
import { accounts, log, LOG_PREFIX } from "./accounts"
import { fetchKiloModels } from "./models"
import {
  inFlight,
  recordOutcome,
  release,
  retryVerdict,
  selectAccount,
  type AccountRuntime,
  type SettledAttempt,
} from "./pool"

// Kilo Gateway plugin for OpenCode.
//
// Provides:
//   1. OAuth device-flow authentication ("Connect provider" TUI)
//   2. API key authentication
//   3. Multi-account rotation: rotates across all accounts stored in
//      accounts.json to spread load and survive rate limits
//
// When accounts.json is absent or empty, requests proceed with the anonymous
// token ("anonymous"), which gives access to free-tier models.

const PLUGIN_ID = "kilo-auth"

/** Bound on request/response correlation entries held in memory. */
const MAX_PENDING = 256
/** Bound on per-session settled-request records. */
const MAX_SESSIONS = 512

interface Assignment {
  readonly sessionID: string
  readonly kind: string
  readonly accountId: string
  readonly startedAt: number
}

const assignments = new WeakMap<Request, Assignment>()
const pending: Assignment[] = []
/** Last completed request per session, so the retry hook can time the failure. */
const lastSettled = new Map<string, SettledAttempt>()

/** Replace the Bearer credential on the outgoing request. */
function authorize(request: Request, token: string): void {
  const current = request.headers.get("authorization")
  const scheme = current && /^bearer\s/i.test(current) ? current.trim().split(/\s+/)[0]! : "Bearer"
  request.headers.set("authorization", `${scheme} ${token}`)
  if (request.headers.has("api-key")) request.headers.set("api-key", token)
  if (request.headers.has("x-api-key")) request.headers.set("x-api-key", token)
}

function shallow(sessionID: string): string {
  return sessionID.length > 12 ? sessionID.slice(0, 12) : sessionID
}

function rememberSettled(sessionID: string, settled: SettledAttempt): void {
  if (lastSettled.size >= MAX_SESSIONS && !lastSettled.has(sessionID)) {
    const oldest = lastSettled.keys().next()
    if (!oldest.done) lastSettled.delete(oldest.value)
  }
  lastSettled.set(sessionID, settled)
}

function takePending(sessionID: string, kind: string): Assignment | undefined {
  const index = pending.findIndex((item) => item.sessionID === sessionID && item.kind === kind)
  if (index < 0) return undefined
  return pending.splice(index, 1)[0]
}

function forget(item: Assignment): void {
  const index = pending.indexOf(item)
  if (index >= 0) pending.splice(index, 1)
}

function onRequest(event: SessionHttpRequest): void {
  const pool = accounts()

  // Inject Kilo editor header unconditionally
  const editorName = process.env[ENV_EDITOR_NAME] ?? DEFAULT_EDITOR_NAME
  event.request.headers.set(HEADER_EDITORNAME, editorName)

  const now = Date.now()

  if (pool.length === 0) {
    // No explicit accounts configured. Keep whatever credential OpenCode already
    // resolved for the provider (OAuth device login or API key), and only fall
    // back to the anonymous free-tier token when none is present.
    const existing = event.request.headers.get("authorization")
    const token = existing?.replace(/^bearer\s+/i, "").trim()
    if (!existing || token === ANONYMOUS_API_KEY || token === "") {
      authorize(event.request, ANONYMOUS_API_KEY)
      log(`request session=${shallow(event.sessionID)} kind=${event.kind} account=anonymous`)
    } else {
      log(`request session=${shallow(event.sessionID)} kind=${event.kind} account=opencode-credential`)
    }
    return
  }

  const selection = selectAccount(pool, now)
  if (!selection) return

  authorize(event.request, selection.runtime.token)

  const assignment: Assignment = {
    sessionID: event.sessionID,
    kind: event.kind,
    accountId: selection.runtime.id,
    startedAt: now,
  }
  assignments.set(event.request, assignment)
  pending.push(assignment)
  if (pending.length > MAX_PENDING) pending.shift()

  log(
    `request session=${shallow(event.sessionID)} kind=${event.kind} account=${selection.runtime.id} ` +
      `inflight=${inFlight(selection.runtime, now)} forced=${selection.forced}`,
  )
}

function onResponse(event: SessionHttpResponse): void {
  const now = Date.now()
  const matched = assignments.get(event.request)
  const assignment = matched ?? takePending(event.sessionID, event.kind)
  if (!assignment) {
    // Could be an anonymous request with no assignment
    return
  }
  assignments.delete(event.request)
  forget(assignment)

  const status = event.response.status
  rememberSettled(event.sessionID, { status, startedAt: assignment.startedAt, at: now })
  const runtime = accounts().find((candidate: AccountRuntime) => candidate.id === assignment.accountId)
  let coolingMs = 0
  if (runtime) {
    release(runtime)
    recordOutcome(runtime, status, now)
    coolingMs = Math.max(0, runtime.coolingUntil - now)
  }

  log(
    `response session=${shallow(event.sessionID)} kind=${event.kind} account=${assignment.accountId} ` +
      `status=${status} ms=${now - assignment.startedAt} cooldownMs=${coolingMs}` +
      (runtime ? "" : " account-gone"),
  )
}

function onRetry(event: SessionRetry): void {
  const status = event.error.status
  const now = Date.now()
  const settled = lastSettled.get(event.sessionID)
  const verdict = retryVerdict(settled, status, event.attempt, now)
  if (verdict === "leave" || settled === undefined) return

  const elapsed = now - settled.startedAt

  if (verdict === "stop-slow") {
    event.decision = { retry: false }
  } else {
    // Retry immediately; the failed account is cooling so the next attempt
    // lands on a different one.
    event.decision = { retry: true, delay: 0 }
  }

  log(
    `retry session=${shallow(event.sessionID)} status=${status} attempt=${event.attempt} ` +
      `elapsedMs=${elapsed} decision=${verdict}`,
  )
}

function guard(name: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    log(`error hook=${name} ${error instanceof Error ? error.message : String(error)}`)
  }
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const initial = accounts()
    console.log(
      `${LOG_PREFIX} ready accounts=${initial.length}` +
        (initial.length > 0
          ? ` ids=${initial.map((r) => r.id).join(",")}`
          : " (using anonymous free-tier token)"),
    )

    // Register integration so users can connect via the TUI
    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: {
          id: "device",
          type: "oauth",
          label: "Kilo Gateway (Device Authorization)",
        },
        async authorize(_answer: Form.Answer) {
          return await buildDeviceAuthAuthorization("device")
        },
        async refresh(credential) {
          // Kilo tokens are long-lived (~1 year) with no refresh endpoint; on
          // refresh, extend the recorded expiry so OpenCode keeps treating the
          // still-valid token as valid instead of looping on a stale expires.
          return { ...credential, expires: Date.now() + TOKEN_EXPIRATION_MS }
        },
      })

      editor.method.update({
        integrationID: PROVIDER_ID,
        method: {
          type: "key",
          label: "Kilo Gateway (API Key)",
          form: [
            {
              key: "apiKey",
              title: "API Key",
              placeholder: "kilo_...",
              type: "string",
              required: true,
            },
          ] as Form.Fields,
        },
      })
    })

    // Hook into Kilo provider requests for rotation and auth injection
    await ctx.session.hook("http.request", (event) => guard("http.request", () => onRequest(event)), {
      providerID: PROVIDER_ID,
    })
    await ctx.session.hook("http.response", (event) => guard("http.response", () => onResponse(event)), {
      providerID: PROVIDER_ID,
    })
    await ctx.session.hook("retry", (event) => guard("retry", () => onRetry(event)), {
      providerID: PROVIDER_ID,
    })

    // Register provider pointing at Kilo's OpenRouter-compatible endpoint,
    // then discover the model list from the API (fail-open: registers with
    // empty list if the network is unavailable at startup).
    const initialModels = await fetchKiloModels(
      initial.length > 0 ? initial[0]?.token : undefined,
    )
    log(`models-discovered count=${initialModels.length}`)

    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: PROVIDER_ID as unknown as Parameters<typeof editor.add>[0]["info"]["id"],
          name: "Kilo Gateway",
          package: "@opencode/ai/providers/openai-compatible",
          activation: "auto",
          // Link the provider to its integration so OpenCode resolves and injects
          // the credential stored by the TUI login (device OAuth or API key).
          integrationID: PROVIDER_ID as unknown as Parameters<typeof editor.add>[0]["info"]["integrationID"],
          settings: {
            baseURL: KILO_OPENROUTER_BASE,
            apiKey: ANONYMOUS_API_KEY,
          },
        },
        models: initialModels,
      })
    })
  },
})
