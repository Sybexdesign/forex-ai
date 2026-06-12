'use client'
// hooks/useAuth.ts
import { useEffect, useState, useCallback } from 'react'
import type { User, Session } from '@supabase/supabase-js'
import { getSupabase } from '@/lib/supabase'

interface AuthState {
  user: User | null
  session: Session | null
  loading: boolean
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({ user: null, session: null, loading: true })

  useEffect(() => {
    const sb = getSupabase()
    let resolved = false
    const settle = (session: Session | null) => {
      resolved = true
      setState({ user: session?.user ?? null, session, loading: false })
    }
    // Safety net: never let the LOADING… screen stick forever. If getSession
    // hangs or rejects (corrupted localStorage token, Supabase outage, blocked
    // by extension), unblock the UI after 5s so the user lands on AuthPage
    // and can retry. onAuthStateChange will still update state if it fires.
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        console.warn('[useAuth] getSession() did not resolve within 5s — unblocking UI as signed-out')
        settle(null)
      }
    }, 5000)
    sb.auth.getSession()
      .then(({ data: { session } }) => { if (!resolved) settle(session) })
      .catch(err => {
        if (!resolved) {
          console.error('[useAuth] getSession failed', err)
          settle(null)
        }
      })
    const { data: { subscription } } = sb.auth.onAuthStateChange((_event, session) => {
      settle(session)
    })
    return () => {
      clearTimeout(timeoutId)
      subscription.unsubscribe()
    }
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    const { data, error } = await getSupabase().auth.signInWithPassword({ email, password })
    return { user: data.user, error }
  }, [])

  const signUp = useCallback(async (email: string, password: string, fullName?: string) => {
    const { data, error } = await getSupabase().auth.signUp({
      email, password,
      options: {
        data: { full_name: fullName || '' },
        emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
      },
    })
    return { user: data.user, error }
  }, [])

  const signOut = useCallback(async () => {
    await getSupabase().auth.signOut()
  }, [])

  const resetPassword = useCallback(async (email: string) => {
    const redirectTo = typeof window !== 'undefined' ? `${window.location.origin}/reset-password` : undefined
    const { error } = await getSupabase().auth.resetPasswordForEmail(email, { redirectTo })
    return { error }
  }, [])

  const isAdmin = state.user?.email === 'sybexdesigns@gmail.com'

  return { ...state, signIn, signUp, signOut, resetPassword, isAdmin }
}
