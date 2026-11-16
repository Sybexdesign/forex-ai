// lib/diagnostics-auth.d.mts
// Type surface for lib/diagnostics-auth.mjs (SEC-1 diagnostics exposure).

export type DiagnosticsAuthMethod = 'operator_secret' | 'admin_jwt' | 'none'

export interface DiagnosticsCaller {
  method: DiagnosticsAuthMethod
  token: string
  authorised: boolean
  reason: string
}

export interface DiagnosticsAuthInput {
  headers?: { get(name: string): string | null } | null
  env?: Record<string, string | undefined>
}

export interface RestrictedDiagnosticsBody {
  readOnly: true
  authenticationRequired: true
  error: string
  note: string
}

export declare function bearerToken(
  headers?: { get(name: string): string | null } | null,
): string

export declare function classifyDiagnosticsCaller(input?: DiagnosticsAuthInput): DiagnosticsCaller

export declare function restrictedDiagnosticsBody(): RestrictedDiagnosticsBody
