import { NextResponse } from 'next/server'
import { getSupabase } from '@/lib/supabase'

// Auth callback route — handles email confirmation and password reset redirects.
// Supabase redirects here after the user clicks the confirmation/reset link in
// their email, passing the session tokens in the URL hash (#access_token=...).
// We exchange the code for a session and redirect to the app root.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'

  if (code) {
    const supabase = getSupabase()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  // If no code or exchange failed, redirect to the app root.
  // The useAuth hook will detect the session from the URL hash if present,
  // or show the auth page if not.
  return NextResponse.redirect(`${origin}`)
}
