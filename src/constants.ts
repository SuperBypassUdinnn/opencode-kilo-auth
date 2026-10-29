/**
 * Kilo Gateway Configuration Constants
 */

/** Environment variable for custom Kilo API URL */
export const ENV_KILO_API_URL = "KILO_API_URL"

/** Default Kilo API URL */
export const DEFAULT_KILO_API_URL = "https://api.kilo.ai"

/** Base URL for Kilo API - can be overridden by KILO_API_URL env var */
export const KILO_API_BASE = process.env[ENV_KILO_API_URL] || DEFAULT_KILO_API_URL

/** OpenRouter-compatible endpoint proxied by Kilo */
export const KILO_OPENROUTER_BASE = `${KILO_API_BASE}/api/openrouter`

/** Device auth polling interval in milliseconds */
export const POLL_INTERVAL_MS = 3000

/** Provider ID registered with OpenCode */
export const PROVIDER_ID = "kilo"

/** Token expiration duration in milliseconds (1 year) */
export const TOKEN_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000

/** Default API key used when no credential is present (anonymous free tier) */
export const ANONYMOUS_API_KEY = "anonymous"

/** Fetch timeout for model requests in milliseconds */
export const MODELS_FETCH_TIMEOUT_MS = 10_000

export const HEADER_EDITORNAME = "X-KILO-EDITORNAME"
export const DEFAULT_EDITOR_NAME = "OpenCode"
export const ENV_EDITOR_NAME = "KILO_EDITOR_NAME"

/** When KILO_API_KEY is set, it acts as a single injected account. */
export const ENV_KILO_API_KEY = "KILO_API_KEY"
