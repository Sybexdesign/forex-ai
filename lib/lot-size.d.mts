export const LOT_MAX_DEFAULT: number
export const LOT_MIN_DEFAULT: number
export const LOT_STEP_DEFAULT: number

export interface LotValidation {
  ok: boolean
  value: number | null
  error: string | null
  empty: boolean
}

export function isPartialLotInput(raw: unknown): boolean

export function validateLotSize(
  raw: string | number | null | undefined,
  opts?: { min?: number; max?: number; step?: number; required?: boolean },
): LotValidation

export function lotSizeToText(saved: unknown): string
