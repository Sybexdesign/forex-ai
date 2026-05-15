'use client'
// components/AuthPage.tsx — Login / Register / Forgot Password screen

import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'

type Mode = 'signin' | 'signup' | 'forgot'

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  )
}

function friendlyError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes('invalid login') || m.includes('invalid credentials')) return 'Incorrect email or password.'
  if (m.includes('email not confirmed'))   return 'Please confirm your email address first, then sign in.'
  if (m.includes('user already registered') || m.includes('already exists')) return 'An account with this email already exists.'
  if (m.includes('password') && m.includes('6')) return 'Password must be at least 6 characters.'
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts — please wait a moment and try again.'
  if (m.includes('network') || m.includes('fetch')) return 'Connection error — check your internet and try again.'
  return msg
}

export default function AuthPage() {
  const { signIn, signUp, resetPassword } = useAuth()

  const [mode, setMode]                   = useState<Mode>('signin')
  const [email, setEmail]                 = useState('')
  const [password, setPassword]           = useState('')
  const [confirmPassword, setConfirm]     = useState('')
  const [fullName, setFullName]           = useState('')
  const [showPassword, setShowPw]         = useState(false)
  const [showConfirm, setShowConfirm]     = useState(false)
  const [loading, setLoading]             = useState(false)
  const [error, setError]                 = useState<string | null>(null)
  const [success, setSuccess]             = useState<string | null>(null)

  function switchMode(m: Mode) {
    setMode(m); setError(null); setSuccess(null)
    setPassword(''); setConfirm(''); setShowPw(false); setShowConfirm(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null); setSuccess(null)

    if (mode === 'signup') {
      if (password.length < 6) { setError('Password must be at least 6 characters.'); return }
      if (password !== confirmPassword) { setError('Passwords do not match.'); return }
    }

    setLoading(true)
    try {
      if (mode === 'signin') {
        const { error } = await signIn(email, password)
        if (error) setError(friendlyError(error.message))
      } else if (mode === 'signup') {
        const { error } = await signUp(email, password, fullName)
        if (error) setError(friendlyError(error.message))
        else setSuccess('Account created! Check your email to confirm your address, then sign in.')
      } else {
        const { error } = await resetPassword(email)
        if (error) setError(friendlyError(error.message))
        else setSuccess('Reset email sent! Check your inbox and follow the link.')
      }
    } finally {
      setLoading(false)
    }
  }

  const submitLabel =
    loading          ? 'PLEASE WAIT...' :
    mode === 'signin' ? 'SIGN IN' :
    mode === 'signup' ? 'CREATE ACCOUNT' : 'SEND RESET LINK'

  return (
    <div className="scanline-bg" style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg,#020810 0%,#040c1a 100%)',
    }}>
      <div style={{ width: '100%', maxWidth: 420, padding: '0 20px' }}>

        {/* Logo */}
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

        {/* Card */}
        <div style={{
          background: 'rgba(6,14,30,0.95)',
          border: '1px solid var(--border)',
          borderRadius: 6, padding: 28,
          boxShadow: '0 0 40px rgba(0,128,255,0.08)',
        }}>

          {mode === 'forgot' ? (
            /* ── Forgot Password ── */
            <>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 15, letterSpacing: 1, color: '#60c0ff', marginBottom: 6 }}>
                  RESET PASSWORD
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Enter your email address and we'll send you a link to reset your password.
                </div>
              </div>

              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label htmlFor="reset-email" style={labelStyle}>EMAIL ADDRESS</label>
                  <input
                    id="reset-email"
                    type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="trader@example.com" required
                    autoComplete="email"
                    style={inputStyle}
                  />
                </div>

                {error   && <AlertBox color="red">{error}</AlertBox>}
                {success && <AlertBox color="green">{success}</AlertBox>}

                <button type="submit" disabled={loading} style={submitStyle(loading)}>
                  {submitLabel}
                </button>
              </form>

              <div style={{ textAlign: 'center', marginTop: 18, fontSize: 12, color: 'var(--text-muted)' }}>
                <button onClick={() => switchMode('signin')} style={linkBtnStyle}>
                  ← Back to sign in
                </button>
              </div>
            </>
          ) : (
            /* ── Sign In / Register ── */
            <>
              {/* Tabs */}
              <div style={{ display: 'flex', marginBottom: 24, borderBottom: '1px solid var(--border)' }}>
                {(['signin', 'signup'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => switchMode(m)}
                    style={{
                      flex: 1, padding: '10px 0', background: 'none', border: 'none', cursor: 'pointer',
                      fontSize: 13, fontWeight: 700, letterSpacing: 1, fontFamily: 'Rajdhani',
                      color: mode === m ? '#60c0ff' : 'var(--text-muted)',
                      borderBottom: mode === m ? '2px solid #0080ff' : '2px solid transparent',
                      marginBottom: -1, transition: 'all 0.2s',
                    }}
                  >
                    {m === 'signin' ? 'SIGN IN' : 'REGISTER'}
                  </button>
                ))}
              </div>

              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {mode === 'signup' && (
                  <div>
                    <label htmlFor="full-name" style={labelStyle}>FULL NAME</label>
                    <input
                      id="full-name"
                      type="text" value={fullName} onChange={e => setFullName(e.target.value)}
                      placeholder="Your name" required
                      autoComplete="name"
                      style={inputStyle}
                    />
                  </div>
                )}

                <div>
                  <label htmlFor="email" style={labelStyle}>EMAIL ADDRESS</label>
                  <input
                    id="email"
                    type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="trader@example.com" required
                    autoComplete="email"
                    style={inputStyle}
                  />
                </div>

                <div>
                  <label htmlFor="password" style={labelStyle}>PASSWORD</label>
                  <div style={{ position: 'relative' }}>
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password} onChange={e => setPassword(e.target.value)}
                      placeholder={mode === 'signup' ? 'Min 6 characters' : '••••••••'} required
                      autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                      style={{ ...inputStyle, paddingRight: 40 }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw(v => !v)}
                      tabIndex={-1}
                      style={eyeBtnStyle}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      <EyeIcon open={showPassword} />
                    </button>
                  </div>
                </div>

                {mode === 'signup' && (
                  <div>
                    <label htmlFor="confirm-password" style={labelStyle}>CONFIRM PASSWORD</label>
                    <div style={{ position: 'relative' }}>
                      <input
                        id="confirm-password"
                        type={showConfirm ? 'text' : 'password'}
                        value={confirmPassword} onChange={e => setConfirm(e.target.value)}
                        placeholder="Re-enter password" required
                        autoComplete="new-password"
                        style={{ ...inputStyle, paddingRight: 40 }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirm(v => !v)}
                        tabIndex={-1}
                        style={eyeBtnStyle}
                        aria-label={showConfirm ? 'Hide password' : 'Show password'}
                      >
                        <EyeIcon open={showConfirm} />
                      </button>
                    </div>
                  </div>
                )}

                {error   && <AlertBox color="red">{error}</AlertBox>}
                {success && <AlertBox color="green">{success}</AlertBox>}

                <button type="submit" disabled={loading} style={submitStyle(loading)}>
                  {submitLabel}
                </button>
              </form>

              {mode === 'signin' && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, fontSize: 12 }}>
                  <span style={{ color: 'var(--text-muted)' }}>
                    No account?{' '}
                    <button onClick={() => switchMode('signup')} style={linkBtnStyle}>Register free</button>
                  </span>
                  <button onClick={() => switchMode('forgot')} style={linkBtnStyle}>
                    Forgot password?
                  </button>
                </div>
              )}

              {mode === 'signup' && (
                <div style={{ textAlign: 'center', marginTop: 16, fontSize: 12, color: 'var(--text-muted)' }}>
                  Already have an account?{' '}
                  <button onClick={() => switchMode('signin')} style={linkBtnStyle}>Sign in</button>
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ textAlign: 'center', marginTop: 20, fontSize: 10, color: 'var(--text-dim)', letterSpacing: 1 }}>
          YOUR DATA IS PRIVATE · EACH ACCOUNT IS ISOLATED
        </div>
      </div>
    </div>
  )
}

// ── Small components ──────────────────────────────────────────────────────────

function AlertBox({ color, children }: { color: 'red' | 'green'; children: React.ReactNode }) {
  const isRed = color === 'red'
  return (
    <div style={{
      padding: '10px 14px', borderRadius: 3, fontSize: 12, lineHeight: 1.5,
      background: isRed ? 'rgba(255,48,86,0.08)' : 'rgba(0,255,135,0.06)',
      border: `1px solid ${isRed ? 'rgba(255,48,86,0.25)' : 'rgba(0,255,135,0.2)'}`,
      color: isRed ? '#ff6060' : '#00ff87',
    }}>
      {children}
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, display: 'block', marginBottom: 6,
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 4, boxSizing: 'border-box',
  background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)',
  color: 'var(--text-primary)', fontSize: 13, fontFamily: 'JetBrains Mono',
  outline: 'none',
}

const eyeBtnStyle: React.CSSProperties = {
  position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
  background: 'none', border: 'none', cursor: 'pointer',
  color: 'var(--text-muted)', padding: 2, display: 'flex', alignItems: 'center',
  lineHeight: 0,
}

function submitStyle(loading: boolean): React.CSSProperties {
  return {
    marginTop: 4, padding: '14px', borderRadius: 4, cursor: loading ? 'not-allowed' : 'pointer',
    fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 15, letterSpacing: 2,
    background: loading ? 'rgba(0,128,255,0.2)' : 'rgba(0,128,255,0.15)',
    border: '1px solid rgba(0,128,255,0.4)', color: loading ? 'var(--text-muted)' : '#60c0ff',
    transition: 'all 0.2s',
  }
}

const linkBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#60c0ff', cursor: 'pointer', fontSize: 12, padding: 0,
}
