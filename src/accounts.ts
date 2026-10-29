// Multi-account manager for Kilo Gateway.
//
// Accounts are stored in a JSON file whose path is resolved in this order:
//   1. KILO_ACCOUNTS_PATH env var
//   2. <plugin-dir>/accounts.json
//
// The file format is flexible:
//   - Array of strings: ["token1", "token2"]
//   - Array of objects: [{ "id": "work", "token": "tk-...", "label": "work@email.com" }]
//   - Object with accounts array: { "accounts": [...] }
//
// Accounts added through the OpenCode TUI (OAuth device flow or API key) are
// appended to this file automatically.
//
// The pool is re-read on every request only when the file's mtime has changed,
// so editing the file while OpenCode runs is safe.

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRuntimes, type AccountEntry, type AccountRuntime } from "./pool"
import { ENV_KILO_API_KEY } from "./constants"
import type { AccountFile, StoredAccount } from "./types"

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ACCOUNTS_PATH = resolve(PLUGIN_DIR, "..", "accounts.json")

export const LOG_PREFIX = "[kilo-pool]"

export const accountsPath = (): string =>
  resolve(process.env.KILO_ACCOUNTS_PATH ?? DEFAULT_ACCOUNTS_PATH)

let pool: AccountRuntime[] = []
let poolSource: { path: string; mtimeMs: number } | undefined
let loadWarning = ""

export function log(line: string): void {
  const text = `${new Date().toISOString()} ${LOG_PREFIX} ${line}\n`
  try {
    console.log(`${LOG_PREFIX} ${line}`)
  } catch {
    // stdout may not be available in every host environment
  }
  const logFile = process.env.KILO_POOL_LOG
  if (logFile && logFile !== "off" && logFile !== "0") {
    try {
      mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 })
      appendFileSync(logFile, text, { mode: 0o600 })
    } catch {
      // Logging must never break a request
    }
  }
}

/**
 * Parse accounts from the JSON file. Accepts arrays of strings, objects, or a
 * wrapper object with an `accounts` property. Deduplicates tokens and assigns
 * stable IDs.
 */
function parseAccounts(raw: unknown): AccountEntry[] {
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as AccountFile)?.accounts)
      ? ((raw as AccountFile).accounts as unknown[])
      : []

  const entries: AccountEntry[] = []
  const seen = new Set<string>()
  const ids = new Set<string>()

  arr.forEach((item, index) => {
    let token: string
    let declaredId: string | undefined
    let label: string | undefined

    if (typeof item === "string") {
      token = item
    } else if (typeof item === "object" && item !== null) {
      const obj = item as StoredAccount
      token = obj.token ?? ""
      declaredId = obj.id
      label = obj.label
    } else {
      return
    }

    if (token.trim() === "" || seen.has(token)) return
    seen.add(token)

    const base =
      typeof declaredId === "string" && declaredId.trim() !== ""
        ? declaredId.trim()
        : label
          ? label.split("@")[0]!
          : `account-${index + 1}`

    let id = base
    for (let suffix = 2; ids.has(id); suffix += 1) id = `${base}-${suffix}`
    ids.add(id)
    entries.push({ id, token })
  })

  return entries
}

/**
 * Read accounts.json, reloading only when the file changes.
 * A reload resets runtime state so a rotated account set starts clean.
 *
 * Priority order:
 *   1. KILO_API_KEY env var (single account, bypasses file)
 *   2. accounts.json file (multi-account rotation)
 *   3. Anonymous free-tier (when neither is configured)
 */
export function accounts(): AccountRuntime[] {
  // Env var shortcut: a single injected account, no file needed
  const envKey = process.env[ENV_KILO_API_KEY]
  if (envKey && envKey.trim() !== "") {
    if (pool.length === 1 && pool[0]?.id === "env") return pool
    const entry: AccountEntry = { id: "env", token: envKey.trim() }
    pool = createRuntimes([entry])
    poolSource = undefined
    log("loaded source=env id=env")
    return pool
  }
  const path = accountsPath()

  let stamp: number
  try {
    stamp = statSync(path).mtimeMs
  } catch {
    if (loadWarning !== path) {
      loadWarning = path
      log(`accounts-unreadable path=${path}`)
    }
    pool = []
    poolSource = undefined
    return pool
  }

  if (poolSource && poolSource.path === path && poolSource.mtimeMs === stamp) return pool

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    log(`accounts-invalid-json path=${path}`)
    pool = []
    poolSource = { path, mtimeMs: stamp }
    return pool
  }

  const entries = parseAccounts(parsed)
  pool = createRuntimes(entries)
  poolSource = { path, mtimeMs: stamp }
  loadWarning = ""
  log(`loaded count=${pool.length} ids=${pool.map((r) => r.id).join(",") || "-"}`)
  return pool
}

/**
 * Append a new account (token) to the accounts file, creating it if it does
 * not exist. Called when a user authenticates via the TUI.
 */
export function appendAccount(entry: StoredAccount): void {
  const path = accountsPath()
  let existing: unknown[] = []
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"))
    existing = Array.isArray(raw) ? raw : Array.isArray((raw as AccountFile)?.accounts) ? ((raw as AccountFile).accounts as unknown[]) : []
  } catch {
    // File does not exist yet — start fresh
  }

  // Deduplicate: skip if token already present
  const alreadyPresent = existing.some(
    (item) =>
      (typeof item === "string" && item === entry.token) ||
      (typeof item === "object" && item !== null && (item as StoredAccount).token === entry.token),
  )
  if (alreadyPresent) return

  existing.push({ id: entry.id, token: entry.token, ...(entry.label ? { label: entry.label } : {}) })

  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 })
    // Reset cached pool so the next request reloads the file
    poolSource = undefined
    log(`appended id=${entry.id} path=${path}`)
  } catch (error) {
    log(`append-failed id=${entry.id} ${error instanceof Error ? error.message : String(error)}`)
  }
}
