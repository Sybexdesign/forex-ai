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
    sb.auth.getSession().then(({ data: { session } }) => {
      setState({ user: session?.user ?? null, session, loading: false })
    })
    const { data: { subscription } } = sb.auth.onAuthStateChange((_event, session) => {
      setState({ user: session?.user ?? null, session, loading: false })
    })
    return () => subscription.unsubscribe()
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
