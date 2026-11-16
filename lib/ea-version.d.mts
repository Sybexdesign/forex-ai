// lib/ea-version.d.mts
// Type surface for lib/ea-version.mjs (EA build identity for the Broker page).
//
// The required build is data, not prose scattered through JSX, so the page, the
// download link and the tests cannot drift apart again.

export declare const EA_BUILD: {
  readonly version: string
  readonly label: string
  readonly buildStamp: string
  readonly fileName: string
  readonly downloadPath: string
  readonly expertsLogLine: string
  readonly executionPayloadVersion: number
}

export declare const REQUIRED_FOR_NET_ACCOUNTING: string
export declare const REQUIRED_FOR_TICKET_CLOSES: string

export declare const BUILD_STATUS: {
  readonly CURRENT: 'CURRENT'
  readonly OUTDATED: 'OUTDATED'
  readonly UNKNOWN: 'UNKNOWN'
}

export type BuildStatus = 'CURRENT' | 'OUTDATED' | 'UNKNOWN'

export interface ReportedBuild {
  version: string
  build: number
  payloadVersion: number | null
  symbol: string | null
}

export interface BuildVerdict {
  status: BuildStatus
  reported: string | null
  required: string
  isCurrent: boolean
  headline: string
  detail: string
}

/** Parse a version-like value into a compare-friendly integer. Null when unusable. */
export declare function parseEaBuild(raw: unknown): { reported: string; build: number } | null

/** Newest stamped entry in a stored `openPositions` array, or null. */
export declare function extractReportedBuild(openPositions: unknown): ReportedBuild | null

/** Verdict for the Broker page. Accepts a raw stamp or a ReportedBuild. */
export declare function describeEaBuild(reported: unknown): BuildVerdict
