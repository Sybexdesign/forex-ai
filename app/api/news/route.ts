// app/api/news/route.ts
// Checks for upcoming high-impact forex news events
// Uses ForexFactory calendar (public JSON) or falls back to simulation

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

export async function GET() {
  try {
    // Try ForexFactory (they sometimes block server fetches, so we catch gracefully)
    const now = new Date()
    const dateStr = now.toISOString().split('T')[0].replace(/-/g, '')

    let events: NewsEvent[] = []

    let simulated = false
    try {
      const res = await fetch(
        `https://nfs.faireconomy.media/ff_calendar_thisweek.json`,
        { cache: 'no-store' }  // always fetch fresh — stale news check = trading into NFP/FOMC
      )
      if (res.ok) {
        const data = await res.json()
        events = parseForexFactoryEvents(data, now)
      } else {
        events = generateSimulatedEvents(now)
        simulated = true
      }
    } catch {
      events = generateSimulatedEvents(now)
      simulated = true
    }

    const inWindow = events.some(e => e.impact === 'high' && e.isInWindow)

    const todayEvents  = events.filter(e => e.isToday)
    const upcomingHigh = events.filter(e => e.impact === 'high' && e.minutesAway > 0)

    return NextResponse.json({
      events:               events.slice(0, 20),   // up to 20 events for the week
      todayEvents:          todayEvents.slice(0, 10),
      hasHighImpactInWindow: inWindow,
      nextHighImpact:       upcomingHigh[0] ?? null,
      windowMinutes:        30,
      checkedAt:            now.toISOString(),
      simulated,
    })
  } catch (error: any) {
    return NextResponse.json({
      events: [],
      hasHighImpactInWindow: false,
      error: error.message,
    })
  }
}

function parseForexFactoryEvents(data: any[], now: Date): NewsEvent[] {
  const todayStr = now.toISOString().split('T')[0]
  return data
    .filter(e => e.impact === 'High' || e.impact === 'Medium')
    .map(e => {
      const eventTime = new Date(e.date)
      const minutesAway = Math.round((eventTime.getTime() - now.getTime()) / 60000)
      const isToday = eventTime.toISOString().startsWith(todayStr)
      return {
        title:     e.title,
        currency:  e.country,
        impact:    (e.impact === 'High' ? 'high' : 'medium') as 'high' | 'medium' | 'low',
        time:      eventTime.toISOString(),
        minutesAway,
        isInWindow: minutesAway >= -5 && minutesAway <= 30,
        isToday,
      }
    })
    // Show: events within last hour, all future events up to end of week (10,080 min = 7 days)
    .filter(e => e.minutesAway > -60 && e.minutesAway < 10080)
    .sort((a, b) => a.minutesAway - b.minutesAway)
}

function generateSimulatedEvents(now: Date): NewsEvent[] {
  // Simulated upcoming events for demo
  const events = [
    { title: 'USD Non-Farm Payrolls', currency: 'USD', minutesOffset: 28 },
    { title: 'EUR ECB Interest Rate Decision', currency: 'EUR', minutesOffset: 95 },
    { title: 'GBP CPI y/y', currency: 'GBP', minutesOffset: -30 }, // past
    { title: 'USD Federal Reserve FOMC Meeting', currency: 'USD', minutesOffset: 180 },
  ]
  const todayStr = now.toISOString().split('T')[0]
  return events.map(e => {
    const eventTime = new Date(now.getTime() + e.minutesOffset * 60000)
    return {
      title:      e.title,
      currency:   e.currency,
      impact:     'high' as const,
      time:       eventTime.toISOString(),
      minutesAway: e.minutesOffset,
      isInWindow: e.minutesOffset >= -5 && e.minutesOffset <= 30,
      isToday:    eventTime.toISOString().startsWith(todayStr),
    }
  })
}
