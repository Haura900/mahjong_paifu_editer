import type { Seat } from './types'

const TENHOU_JSON_VIEWER = 'https://tenhou.net/5/'

export function buildTenhouJsonUrl(json: string, seat: Seat): string {
  return `${TENHOU_JSON_VIEWER}?tw=${seat}#json=${encodeURIComponent(json)}`
}

export function findAnalysisSeatByName(names: string[], preferredName?: string): Seat | undefined {
  if (!preferredName) return undefined
  const seat = names.slice(0, 4).findIndex((name) => name === preferredName)
  return seat === -1 ? undefined : seat as Seat
}
