export interface DeviceAuthInitiateResponse {
  code: string
  verificationUrl: string
  expiresIn: number
}

export interface DeviceAuthPollResponse {
  status: "pending" | "approved" | "denied" | "expired"
  token?: string
  userEmail?: string
}

export interface AccountFile {
  readonly accounts?: unknown
}

export interface StoredAccount {
  readonly id: string
  readonly token: string
  /** Optional human-readable label, e.g. the Kilo user email */
  readonly label?: string
}
