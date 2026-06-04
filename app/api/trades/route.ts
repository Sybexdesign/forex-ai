// app/api/trades/route.ts
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId')
  const result = req.nextUrl.searchParams.get('result') // optional: 'OPEN', 'WIN', 'LOSS', 'CLOSED'

  if (!userId || userId === 'demo') {
    return NextResponse.json({ trades: [] })
  }

  try {
    const admin = getAdminClient()
    let query = admin
      .from('trades')
      .select('*')
      .eq('user_id', userId)
      .order('opened_at', { ascending: false })
      .limit(200)

    if (result) query = query.eq('result', result)

    const { data, error } = await query
    if (error) throw error
    return NextResponse.json({ trades: data || [] })
  } catch (error: any) {
    console.error('[trades GET]', error.message)
    return NextResponse.json({ trades: [] })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const admin = getAdminClient()
    const { data, error } = await admin.from('trades').insert(body).select().single()
    if (error) throw error
    return NextResponse.json({ trade: data })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, ...updates } = body
    const admin = getAdminClient()
    const { data, error } = await admin.from('trades').update(updates).eq('id', id).select().single()
    if (error) throw error
    return NextResponse.json({ trade: data })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
