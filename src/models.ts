// Model discovery for Kilo Gateway.
//
// Fetches the full model list from the Kilo /api/openrouter/models endpoint and
// maps it to OpenCode's Model.Info shape. Uses the anonymous token so this works
// without any credentials — callers may pass a real token to get the complete list.

import type { Model } from "@opencode/schema/model"
import type { Provider } from "@opencode/schema/provider"
import { ANONYMOUS_API_KEY, KILO_API_BASE, MODELS_FETCH_TIMEOUT_MS, PROVIDER_ID } from "./constants"

/** Raw model shape from the Kilo /api/openrouter/models endpoint. */
interface KiloModel {
  readonly id: string
  readonly name: string
  readonly created: number
  readonly context_length: number
  readonly isFree: boolean
  readonly architecture?: {
    readonly input_modalities?: string[]
    readonly output_modalities?: string[]
  }
  readonly top_provider?: {
    readonly max_completion_tokens?: number
    readonly context_length?: number
  }
  readonly supported_parameters?: string[]
}

interface KiloModelsResponse {
  readonly data: KiloModel[]
}

/**
 * Fetch all models from the Kilo Gateway models endpoint.
 * Returns an empty array on any network or parse error (fail-open).
 */
export async function fetchKiloModels(token?: string): Promise<Model.Info[]> {
  const authToken = token ?? ANONYMOUS_API_KEY
  let response: Response
  try {
    response = await fetch(`${KILO_API_BASE}/api/openrouter/models`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    console.warn(
      `[kilo-pool] model-fetch-failed reason=${error instanceof Error ? error.message : String(error)}`,
    )
    return []
  }

  if (!response.ok) {
    console.warn(`[kilo-pool] model-fetch-http-error status=${response.status}`)
    return []
  }

  let data: KiloModelsResponse
  try {
    data = (await response.json()) as KiloModelsResponse
  } catch {
    console.warn("[kilo-pool] model-fetch-parse-error")
    return []
  }

  if (!Array.isArray(data.data)) {
    console.warn("[kilo-pool] model-fetch-unexpected-shape")
    return []
  }

  const providerID = PROVIDER_ID as unknown as Provider.ID

  return data.data
    .filter((m) => typeof m.id === "string" && m.id.length > 0)
    .map((m): Model.Info => {
      const inputModalities = m.architecture?.input_modalities ?? ["text"]
      const outputModalities = m.architecture?.output_modalities ?? ["text"]
      const contextLength =
        m.context_length ?? m.top_provider?.context_length ?? 128_000
      const outputLength =
        m.top_provider?.max_completion_tokens ?? Math.min(contextLength, 65_536)
      const supportsTools = (m.supported_parameters ?? []).includes("tools")

      const modelID = m.id as unknown as Model.ID

      return {
        id: modelID,
        modelID,
        providerID,
        name: m.name || m.id,
        capabilities: {
          tools: supportsTools,
          input: inputModalities,
          output: outputModalities,
        },
        variants: [],
        time: { released: m.created ?? 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: {
          context: contextLength,
          output: outputLength,
        },
      } satisfies Model.Info
    })
}
