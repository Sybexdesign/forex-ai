import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const limit  = Math.min(parseInt(searchParams.get('limit') || '200'), 500)
    const level  = searchParams.get('level')  // optional filter

    const admin = getAdminClient()
    let query = admin
      .from('worker_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (level && level !== 'all') query = query.eq('level', level)

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json({ logs: data || [] })
  } catch (error: any) {
    console.error('[worker/logs]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
