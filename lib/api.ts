// lib/api.ts — auth-aware fetch wrapper
// Automatically injects the Supabase JWT so API routes can identify the user.
import { getSupabase } from './supabase'

export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const { data: { session } } = await getSupabase().auth.getSession()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  }
  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`
  }
  return fetch(url, { ...options, headers })
}

export async function authJson<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await authFetch(url, options)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}
