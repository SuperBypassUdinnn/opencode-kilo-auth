// Account pool for Kilo Gateway.
//
// Spreads requests across multiple authenticated accounts, keeps a failing
// account out of rotation for a cool-down period, and lets the retry hook
// immediately re-route a transient failure to a different account instead of
// waiting for a delayed retry on the same one.

export const COOLDOWN_MS = {
  /** Rate-limited. One minute is enough for a request window to drain. */
  rateLimited: 60_000,
  /** Server-side failure. Short, because most are transient. */
  serverError: 20_000,
  /** No HTTP status at all: timeout, reset, abort. */
  transport: 10_000,
  /** Rejected credential. Long, so a dead token stops burning attempts. */
  unauthorized: 600_000,
} as const

/**
 * A request older than this is considered stale; the response hook may never
 * run for an aborted request.
 */
export const STALE_PENDING_MS = 330_000

export interface AccountEntry {
  readonly id: string
  readonly token: string
}

export interface AccountRuntime {
  readonly id: string
  readonly token: string
  /** Acquire timestamps of requests still waiting for response headers. */
  pending: number[]
  coolingUntil: number
  lastUsedAt: number
  used: number
  failures: number
  lastStatus?: number
}

export interface Selection {
  readonly runtime: AccountRuntime
  /** True when every account was cooling and one had to be reused anyway. */
  readonly forced: boolean
}

export function createRuntimes(entries: readonly AccountEntry[]): AccountRuntime[] {
  return entries.map((entry) => ({
    id: entry.id,
    token: entry.token,
    pending: [],
    coolingUntil: 0,
    lastUsedAt: 0,
    used: 0,
    failures: 0,
  }))
}

function prunePending(runtime: AccountRuntime, now: number): void {
  while (runtime.pending.length > 0 && now - runtime.pending[0]! > STALE_PENDING_MS) {
    runtime.pending.shift()
  }
}

export function inFlight(runtime: AccountRuntime, now: number): number {
  prunePending(runtime, now)
  return runtime.pending.length
}

export function isCooling(runtime: AccountRuntime, now: number): boolean {
  return runtime.coolingUntil > now
}

/**
 * Pick the account for the next request.
 *
 * Order: fewest requests awaiting headers first, then the account used
 * longest ago, then id — so parallel fan-out lands on distinct accounts and
 * a sequential run rotates through all of them.
 *
 * When every account is cooling, reuse the one that recovers first rather than
 * refusing the request. Refusing turns a temporary upstream problem into a
 * local outage.
 */
export function selectAccount(
  runtimes: readonly AccountRuntime[],
  now: number,
): Selection | undefined {
  if (runtimes.length === 0) return undefined

  for (const runtime of runtimes) prunePending(runtime, now)

  const available = runtimes.filter((runtime) => !isCooling(runtime, now))
  const candidates = available.length > 0 ? available : runtimes

  let best = candidates[0]!
  for (const runtime of candidates.slice(1)) {
    if (better(runtime, best)) best = runtime
  }

  const forced = available.length === 0
  if (forced) best.coolingUntil = 0

  best.pending.push(now)
  best.lastUsedAt = now
  best.used += 1
  return { runtime: best, forced }
}

function better(a: AccountRuntime, b: AccountRuntime): boolean {
  if (a.pending.length !== b.pending.length) return a.pending.length < b.pending.length
  if (a.coolingUntil !== b.coolingUntil) return a.coolingUntil < b.coolingUntil
  if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt < b.lastUsedAt
  return a.id < b.id
}

/** Release the oldest outstanding request for this account. */
export function release(runtime: AccountRuntime): void {
  runtime.pending.shift()
}

/** Cooldown a status deserves, as an absolute timestamp. */
export function cooldownUntil(status: number | undefined, now: number): number {
  if (status === undefined) return now + COOLDOWN_MS.transport
  if (status === 401 || status === 403) return now + COOLDOWN_MS.unauthorized
  if (status === 429) return now + COOLDOWN_MS.rateLimited
  if (status >= 500 && status <= 599) return now + COOLDOWN_MS.serverError
  return 0
}

/**
 * Record the outcome of one request. Success clears any cooldown; failures set
 * one, except ordinary client errors (400, 404, ...) which say nothing about
 * the account.
 */
export function recordOutcome(
  runtime: AccountRuntime,
  status: number | undefined,
  now: number,
): void {
  runtime.lastStatus = status
  const until = cooldownUntil(status, now)
  if (until > 0) {
    runtime.coolingUntil = until
    runtime.failures += 1
    return
  }
  if (status !== undefined && status >= 200 && status <= 299) {
    runtime.coolingUntil = 0
    runtime.failures = 0
  }
}

export interface AccountReport {
  readonly id: string
  readonly inFlight: number
  readonly coolingForMs: number
  readonly used: number
  readonly failures: number
  readonly lastStatus?: number
}

export function report(runtimes: readonly AccountRuntime[], now: number): AccountReport[] {
  return runtimes.map((runtime) => ({
    id: runtime.id,
    inFlight: inFlight(runtime, now),
    coolingForMs: Math.max(0, runtime.coolingUntil - now),
    used: runtime.used,
    failures: runtime.failures,
    lastStatus: runtime.lastStatus,
  }))
}

/** A completed request, kept so the retry hook can time the failure it sees. */
export interface SettledAttempt {
  readonly status: number | undefined
  readonly startedAt: number
  readonly at: number
}

export const FAST_FAILURE_MS = 60_000
export const MAX_ATTEMPTS = 3
/** A retry decision must follow the response it is about within this window. */
export const RETRY_MATCH_MS = 10_000

/**
 * `leave` means the plugin has no opinion: either the retry is not the request
 * just finished, or the failure is not transient, so OpenCode's own policy stands.
 */
export type RetryVerdict = "leave" | "next-account" | "stop-slow"

export function retryVerdict(
  settled: SettledAttempt | undefined,
  status: number | undefined,
  attempt: number,
  now: number,
): RetryVerdict {
  if (!isTransient(status)) return "leave"
  if (!settled || settled.status !== status) return "leave"
  if (now - settled.at > RETRY_MATCH_MS) return "leave"

  const elapsed = now - settled.startedAt
  if (elapsed < 0) return "leave"
  if (elapsed >= FAST_FAILURE_MS) return "stop-slow"
  return shouldRetry(status, elapsed, attempt) ? "next-account" : "leave"
}

export function shouldRetry(
  status: number | undefined,
  elapsedMs: number,
  attempt: number,
): boolean {
  if (status === undefined) return false
  const transient = status === 429 || (status >= 500 && status <= 599)
  if (!transient) return false
  if (attempt >= MAX_ATTEMPTS) return false
  return elapsedMs >= 0 && elapsedMs < FAST_FAILURE_MS
}

/** True when the status is transient, regardless of how long it took. */
export function isTransient(status: number | undefined): boolean {
  if (status === undefined) return false
  return status === 429 || (status >= 500 && status <= 599)
}
