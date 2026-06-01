// app/api/news/route.ts
// Checks for upcoming high-impact forex news events via ForexFactory calendar.

export const dynamic = 'force-dynamic'  // never cache — stale news = trading into events

import { NextResponse } from 'next/server'

export interface NewsEvent {
  title: string
  currency: string
  impact: 'high' | 'medium' | 'low'
  time: string
  minutesAway: number
  isInWindow: boolean  // within 30-min trading block window
  isToday: boolean
}

const FF_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.forexfactory.com/',
  'Origin':          'https://www.forexfactory.com',
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { cache: 'no-store', headers: FF_HEADERS, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function GET() {
  try {
    const now = new Date()
    let events: NewsEvent[] = []
    let simulated = false

    try {
      // Primary: current week. Fallback URL: next week (covers Mon refresh gap)
      const urls = [
        'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
        'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
      ]
      let fetched = false
      for (const url of urls) {
        try {
          const res = await fetchWithTimeout(url, 5000)
          if (res.ok) {
            const data = await res.json()
            if (Array.isArray(data) && data.length > 0) {
              events = parseForexFactoryEvents(data, now)
              fetched = true
              break
            }
          }
        } catch { /* try next URL */ }
      }
      if (!fetched) simulated = true
    } catch {
      simulated = true
    }

    // When feed is unavailable: return empty events — do NOT fall back to fake demo
    // events that could falsely trigger the news-window trade block.
    const inWindow    = !simulated && events.some(e => e.impact === 'high' && e.isInWindow)
    const todayEvents = events.filter(e => e.isToday)
    const upcomingHigh = events.filter(e => e.impact === 'high' && e.minutesAway > 0)

    return NextResponse.json({
      events:                events.slice(0, 20),
      todayEvents:           todayEvents.slice(0, 10),
      hasHighImpactInWindow: inWindow,
      nextHighImpact:        upcomingHigh[0] ?? null,
      windowMinutes:         30,
      checkedAt:             now.toISOString(),
      simulated,
    })
  } catch (error: any) {
    return NextResponse.json({
      events:                [],
      hasHighImpactInWindow: false,
      simulated:             true,
      error:                 error.message,
    })
  }
}

function parseForexFactoryEvents(data: any[], now: Date): NewsEvent[] {
  const todayStr = now.toISOString().split('T')[0]
  return data
    .filter(e => e.impact === 'High' || e.impact === 'Medium')
    .map(e => {
      const eventTime   = new Date(e.date)
      const minutesAway = Math.round((eventTime.getTime() - now.getTime()) / 60000)
      const isToday     = eventTime.toISOString().startsWith(todayStr)
      return {
        title:      e.title,
        currency:   e.country,
        impact:     (e.impact === 'High' ? 'high' : 'medium') as 'high' | 'medium' | 'low',
        time:       eventTime.toISOString(),
        minutesAway,
        isInWindow: minutesAway >= -5 && minutesAway <= 30,
        isToday,
      }
    })
    .filter(e => e.minutesAway > -60 && e.minutesAway < 10080)
    .sort((a, b) => a.minutesAway - b.minutesAway)
}
