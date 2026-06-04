// app/api/strategy/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient, DEFAULT_STRATEGY } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId')
  if (!userId) return NextResponse.json({ settings: DEFAULT_STRATEGY })

  try {
    const admin = getAdminClient()
    const { data } = await admin
      .from('strategies')
      .select('settings')
      .eq('user_id', userId)
      .single()
    return NextResponse.json({ settings: data?.settings || DEFAULT_STRATEGY })
  } catch (e: any) {
    console.error('[strategy GET]', e?.message)
    return NextResponse.json({ settings: DEFAULT_STRATEGY, isDefault: true })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId, settings } = await req.json()
    if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 })

    const admin = getAdminClient()
    const { error } = await admin
      .from('strategies')
      .upsert({ user_id: userId, settings, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
