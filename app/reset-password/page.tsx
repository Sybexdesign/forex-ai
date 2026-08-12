'use client'
// app/reset-password/page.tsx — Password reset page
// Handles the redirect from the Supabase password reset email.
// The user arrives here with a session token in the URL hash after clicking
// the reset link. They enter a new password and we update it via Supabase.

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { getSupabase } from '@/lib/supabase'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [sessionReady, setSessionReady] = useState(false)

  // Check if we have a session from the reset link
  useEffect(() => {
    const sb = getSupabase()
    sb.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setSessionReady(true)
      } else {
        setError('Invalid or expired reset link. Please request a new one.')
      }
    })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      const { error } = await getSupabase().auth.updateUser({ password })
      if (error) {
        setError(error.message)
      } else {
        setSuccess(true)
        setTimeout(() => router.push('/'), 2000)
      }
    } catch (err: any) {
      setError(err?.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="scanline-bg" style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg,#020810 0%,#040c1a 100%)',
    }}>
      <div style={{ width: '100%', maxWidth: 420, padding: '0 20px' }}>
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ fontFamily: 'Rajdhani', fontWeight: 900, fontSize: 32, letterSpacing: 4, lineHeight: 1 }}>
            <span style={{ color: 'var(--text-secondary)' }}>SYBEX </span>
            <span style={{ color: '#0080ff' }}>FOREX</span>
            <span style={{ color: '#00ff87' }}>AI</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: 3, marginTop: 6 }}>
            INTELLIGENT TRADING TERMINAL
          </div>
        </div>

        <div style={{
          background: 'rgba(6,14,30,0.95)',
          border: '1px solid var(--border)',
          borderRadius: 6, padding: 28,
          boxShadow: '0 0 40px rgba(0,128,255,0.08)',
        }}>
          {success ? (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
              <div style={{ fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 18, color: '#00ff87', letterSpacing: 1, marginBottom: 8 }}>
                PASSWORD UPDATED
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Your password has been changed successfully.
                <br />
                Redirecting to sign in…
              </div>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 15, letterSpacing: 1, color: '#60c0ff', marginBottom: 6 }}>
                  SET NEW PASSWORD
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Enter a new password for your account.
                </div>
              </div>

              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label htmlFor="new-password" style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, display: 'block', marginBottom: 6 }}>
                    NEW PASSWORD
                  </label>
                  <input
                    id="new-password"
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Min 6 characters"
                    required
                    autoComplete="new-password"
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 4, boxSizing: 'border-box',
                      background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)',
                      color: 'var(--text-primary)', fontSize: 13, fontFamily: 'JetBrains Mono',
                      outline: 'none',
                    }}
                  />
                </div>

                <div>
                  <label htmlFor="confirm-password" style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, display: 'block', marginBottom: 6 }}>
                    CONFIRM PASSWORD
                  </label>
                  <input
                    id="confirm-password"
                    type="password"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    placeholder="Re-enter password"
                    required
                    autoComplete="new-password"
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 4, boxSizing: 'border-box',
                      background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)',
                      color: 'var(--text-primary)', fontSize: 13, fontFamily: 'JetBrains Mono',
                      outline: 'none',
                    }}
                  />
                </div>

                {error && (
                  <div style={{
                    padding: '10px 14px', borderRadius: 3, fontSize: 12, lineHeight: 1.5,
                    background: 'rgba(255,48,86,0.08)',
                    border: '1px solid rgba(255,48,86,0.25)',
                    color: '#ff6060',
                  }}>
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || !sessionReady}
                  style={{
                    marginTop: 4, padding: '14px', borderRadius: 4,
                    cursor: loading || !sessionReady ? 'not-allowed' : 'pointer',
                    fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 15, letterSpacing: 2,
                    background: loading || !sessionReady ? 'rgba(0,128,255,0.2)' : 'rgba(0,128,255,0.15)',
                    border: '1px solid rgba(0,128,255,0.4)',
                    color: loading || !sessionReady ? 'var(--text-muted)' : '#60c0ff',
                    transition: 'all 0.2s',
                  }}
                >
                  {loading ? 'UPDATING…' : 'UPDATE PASSWORD'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
