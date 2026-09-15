export const PP_MODES = ['off', 'shadow', 'live']

export const PP_MODE_DEFAULT: 'shadow'

export interface ResolvedMode {
  mode: 'off' | 'shadow' | 'live'
  source: 'env' | 'default' | 'invalid' | 'legacy-override'
  notes: string[]
  shadow: boolean
  live: boolean
  off: boolean
  shadowProtection: boolean
}

export function resolveProfitProtectionMode(env?: Record<string, string | undefined>): ResolvedMode

export function describeProfitProtectionMode(r: ResolvedMode): string
