import type { Credential } from "@opencode/plugin"
import type { DeviceAuthInitiateResponse, DeviceAuthPollResponse } from "./types"
import { KILO_API_BASE, POLL_INTERVAL_MS, TOKEN_EXPIRATION_MS } from "./constants"

async function initiateDeviceAuth(): Promise<DeviceAuthInitiateResponse> {
  const response = await fetch(`${KILO_API_BASE}/api/device-auth/codes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  })

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("Too many pending authorization requests. Please try again later.")
    }
    throw new Error(`Failed to initiate device authorization: ${response.status}`)
  }

  return (await response.json()) as DeviceAuthInitiateResponse
}

async function pollDeviceAuth(code: string): Promise<DeviceAuthPollResponse> {
  const response = await fetch(`${KILO_API_BASE}/api/device-auth/codes/${code}`)

  if (response.status === 202) return { status: "pending" }
  if (response.status === 403) return { status: "denied" }
  if (response.status === 410) return { status: "expired" }

  if (!response.ok) {
    throw new Error(`Failed to poll device authorization: ${response.status}`)
  }

  return (await response.json()) as DeviceAuthPollResponse
}

/**
 * Run the Kilo device-auth flow and return an `IntegrationOAuthAuthorization`
 * compatible with OpenCode V2 plugin API (mode: "auto").
 */
export async function buildDeviceAuthAuthorization(methodID: string): Promise<{
  url: string
  instructions: string
  expiresAt?: number
  mode: "auto"
  callback: Promise<Credential.OAuth>
}> {
  const authData = await initiateDeviceAuth()
  const { code, verificationUrl, expiresIn } = authData

  const callback: Promise<Credential.OAuth> = new Promise((resolve, reject) => {
    const maxAttempts = Math.ceil((expiresIn * 1000) / POLL_INTERVAL_MS)
    let attempts = 0

    const interval = setInterval(async () => {
      attempts += 1
      try {
        const result = await pollDeviceAuth(code)

        if (result.status === "approved") {
          clearInterval(interval)
          if (!result.token) {
            reject(new Error("Authorization succeeded but no token was returned"))
            return
          }
          resolve({
            type: "oauth",
            methodID: methodID as unknown as Credential.OAuth["methodID"],
            access: result.token,
            refresh: result.token,
            expires: Date.now() + TOKEN_EXPIRATION_MS,
          })
        } else if (result.status === "denied") {
          clearInterval(interval)
          reject(new Error("Authorization denied by user"))
        } else if (result.status === "expired") {
          clearInterval(interval)
          reject(new Error("Authorization code expired"))
        } else if (attempts >= maxAttempts) {
          clearInterval(interval)
          reject(new Error("Authorization timed out"))
        }
      } catch (error) {
        clearInterval(interval)
        reject(error)
      }
    }, POLL_INTERVAL_MS)
  })

  return {
    url: verificationUrl,
    instructions: `Open ${verificationUrl} and enter code: ${code}`,
    expiresAt: Date.now() + expiresIn * 1000,
    mode: "auto",
    callback,
  }
}
