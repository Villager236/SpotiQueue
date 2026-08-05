import { useState, useEffect } from 'react'
import axios from '@/lib/api'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { Input } from './ui/input'

const isDemoMode = import.meta.env.VITE_DEMO_MODE === 'true'

function ConfigItem({ label, children, saveKey, saveVal, help, config, updateConfig }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-4 py-3 border-b last:border-0">
      <div className="flex-1 min-w-0">
        {label}
        {help && <p className="text-xs text-muted-foreground mt-1">{help}</p>}
      </div>
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
        {children}
        <Button size="sm" onClick={() => updateConfig(saveKey, saveVal !== undefined ? saveVal : config[saveKey])}>Save</Button>
      </div>
    </div>
  )
}

/** Warm the lyrics cache from a playlist before the event, so nothing is fetched live. */
function LyricsPrewarm() {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)

  const poll = async () => {
    try {
      const res = await axios.get('/api/lyrics/prewarm')
      setStatus(res.data)
      return res.data
    } catch { return null }
  }

  useEffect(() => { poll() }, [])

  useEffect(() => {
    if (!status?.running) return
    const t = setInterval(poll, 1500)
    return () => clearInterval(t)
  }, [status?.running])

  const start = async () => {
    setError('')
    setStarting(true)
    try {
      const res = await axios.post('/api/lyrics/prewarm', { url })
      setStatus(res.data)
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to start pre-caching.')
    } finally {
      setStarting(false)
    }
  }

  const stop = async () => {
    try {
      const res = await axios.delete('/api/lyrics/prewarm')
      setStatus(res.data)
    } catch { /* ignore */ }
  }

  const pct = status?.total ? Math.round((status.done / status.total) * 100) : 0

  return (
      <div className="py-3">
        <span className="block font-medium">Pre-cache lyrics from a playlist</span>
        <p className="text-xs text-muted-foreground mt-1 mb-3">
          Looks up every track ahead of time and stores the lyrics locally. Run this before an
          event so nothing depends on an external service on the night. Lookups are throttled,
          so a large playlist takes a few minutes.
        </p>

        <div className="flex flex-col sm:flex-row gap-2">
          <Input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://open.spotify.com/playlist/..."
              className="w-full sm:w-96 font-mono text-sm"
              disabled={status?.running}
          />
          {status?.running ? (
              <Button size="sm" variant="destructive" onClick={stop}>Stop</Button>
          ) : (
              <Button size="sm" onClick={start} disabled={starting || !url.trim()}>
                {starting ? 'Starting…' : 'Pre-cache'}
              </Button>
          )}
        </div>

        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

        {status && status.total > 0 && (
            <div className="mt-3">
              <div className="h-2 w-full sm:w-96 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {status.running ? 'Caching' : 'Finished'} — {status.done}/{status.total} ·{' '}
                <span className="text-primary">{status.found} with lyrics</span> ·{' '}
                {status.missing} without
                {status.failed > 0 && <> · {status.failed} failed</>}
              </p>
            </div>
        )}
      </div>
  )
}

function Configuration() {
  const [config, setConfig] = useState({})
  const [adminPasswordDraft, setAdminPasswordDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [messageType, setMessageType] = useState('success')

  useEffect(() => { loadConfig() }, [])

  const loadConfig = async () => {
    try {
      const res = await axios.get('/api/config')
      setConfig(res.data.config)
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  const updateConfig = async (key, value) => {
    try {
      await axios.put(`/api/config/${key}`, { value })
      setConfig(prev => ({ ...prev, [key]: value }))
      setMessage('Configuration updated!')
      setMessageType('success')
      setTimeout(() => setMessage(null), 3000)
    } catch (e) {
      alert('Failed to update configuration')
    }
  }

  const saveAdminPassword = async () => {
    if (!adminPasswordDraft.trim()) {
      alert('Enter a new password')
      return
    }
    try {
      await axios.put('/api/config/admin_password', { value: adminPasswordDraft })
      setAdminPasswordDraft('')
      setConfig(prev => ({ ...prev, admin_password_configured: true }))
      setMessage('Admin password updated (stored hashed).')
      setMessageType('success')
      setTimeout(() => setMessage(null), 3000)
    } catch (e) {
      alert('Failed to update password')
    }
  }

  const saveAllConfig = async () => {
    try {
      setSaving(true)
      const updates = Object.fromEntries(
        Object.entries(config).filter(
          ([k, v]) => v != null && k !== 'admin_password_configured'
        )
      )
      if (adminPasswordDraft.trim()) {
        updates.admin_password = adminPasswordDraft
      }
      const res = await axios.put('/api/config', updates)
      setConfig(res.data.config || config)
      if (adminPasswordDraft.trim()) setAdminPasswordDraft('')
      setMessage('All configuration saved!')
      setMessageType('success')
      setTimeout(() => setMessage(null), 3000)
    } catch (e) {
      setMessage('Failed to save configuration')
      setMessageType('error')
      setTimeout(() => setMessage(null), 3000)
    } finally {
      setSaving(false)
    }
  }

  const handleChange = (key, value) => setConfig(prev => ({ ...prev, [key]: value }))

  if (loading) return <Card><CardContent className="py-12 text-center text-muted-foreground">Loading configuration...</CardContent></Card>

  return (
    <div className="space-y-6">
      <div className="sticky top-2 z-40 flex justify-end">
        <Button
          onClick={saveAllConfig}
          disabled={saving}
          className="min-h-[44px] px-5 sm:min-h-9 sm:px-4"
        >
          {saving ? 'Saving…' : 'Save All'}
        </Button>
      </div>
      {message && (
        <div
          className={`fixed left-0 right-0 top-0 z-50 flex items-center justify-center border-b px-6 py-3 pt-safe pl-safe pr-safe text-sm shadow-md ${
            messageType === 'success'
              ? 'bg-primary/95 text-primary-foreground border-primary/30'
              : 'bg-destructive/95 text-destructive-foreground border-destructive/30'
          }`}
          style={{ animation: 'slideDown 0.25s ease-out' }}
        >
          {message}
        </div>
      )}

      <Card>
        <CardContent className="pt-6">
          <h2 className="text-lg font-semibold mb-4">Queue Management</h2>
          <ConfigItem config={config} updateConfig={updateConfig}
            label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.queueing_enabled !== 'false'} onChange={(e) => handleChange('queueing_enabled', e.target.checked ? 'true' : 'false')} /> Enable Queueing</label>}
            saveKey="queueing_enabled"
            saveVal={config.queueing_enabled || 'true'}
            help="When disabled, all queue requests and search will be blocked."
          />
          <ConfigItem config={config} updateConfig={updateConfig} label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.prequeue_enabled === 'true'} onChange={(e) => handleChange('prequeue_enabled', e.target.checked ? 'true' : 'false')} /> Enable Prequeue (approval required)</label>} saveKey="prequeue_enabled" saveVal={config.prequeue_enabled || 'false'} help="When enabled, queue requests must be approved in the Prequeue tab before adding to Spotify." />
          <ConfigItem
              config={config}
              updateConfig={updateConfig}
              label={<><span className="block font-medium">Max Pending Requests Per Guest</span><p className="text-xs text-muted-foreground mt-1">How many un-reviewed songs one guest can have waiting</p></>}
              saveKey="prequeue_max_pending_per_guest"
              saveVal={config.prequeue_max_pending_per_guest || '2'}
              help="Stops one person burying the approval list faster than you can work through it."
          >
            <Input type="number" value={config.prequeue_max_pending_per_guest || '2'} onChange={(e) => handleChange('prequeue_max_pending_per_guest', e.target.value)} min="1" className="w-full sm:w-20" />
          </ConfigItem>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <h2 className="text-lg font-semibold mb-4">Rate Limiting</h2>
          <ConfigItem config={config} updateConfig={updateConfig} label={<><span className="block font-medium">Cooldown Duration (seconds)</span><p className="text-xs text-muted-foreground mt-1">Time between queue attempts</p></>} saveKey="cooldown_duration" saveVal={config.cooldown_duration}>
            <Input type="number" value={config.cooldown_duration || '300'} onChange={(e) => handleChange('cooldown_duration', e.target.value)} min="0" className="w-full sm:w-24" />
          </ConfigItem>
          <ConfigItem config={config} updateConfig={updateConfig} label={<><span className="block font-medium">Songs Before Cooldown</span><p className="text-xs text-muted-foreground mt-1">Songs a user can queue before cooldown starts</p></>} saveKey="songs_before_cooldown" saveVal={config.songs_before_cooldown || '1'}>
            <Input type="number" value={config.songs_before_cooldown || '1'} onChange={(e) => handleChange('songs_before_cooldown', e.target.value)} min="1" className="w-full sm:w-20" />
          </ConfigItem>
          <ConfigItem config={config} updateConfig={updateConfig} label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.fingerprinting_enabled === 'true'} onChange={(e) => handleChange('fingerprinting_enabled', e.target.checked ? 'true' : 'false')} /> Enable Fingerprinting & Cooldown</label>} saveKey="fingerprinting_enabled" />
          <ConfigItem
            config={config}
            updateConfig={updateConfig}
            label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.queue_grace_period_enabled !== 'false'} onChange={(e) => handleChange('queue_grace_period_enabled', e.target.checked ? 'true' : 'false')} /> Enable queue grace period (cancel window)</label>}
            saveKey="queue_grace_period_enabled"
            saveVal={config.queue_grace_period_enabled !== 'false' ? 'true' : 'false'}
            help="When enabled, users can cancel a queue request during the grace period and keep their queue slot."
          />
          <ConfigItem
            config={config}
            updateConfig={updateConfig}
            label={<><span className="block font-medium">Queue Grace Period (seconds)</span><p className="text-xs text-muted-foreground mt-1">Wait time before a song is added to Spotify</p></>}
            saveKey="queue_grace_period_seconds"
            saveVal={config.queue_grace_period_seconds || '5'}
          >
            <Input type="number" value={config.queue_grace_period_seconds || '5'} onChange={(e) => handleChange('queue_grace_period_seconds', e.target.value)} min="0" className="w-full sm:w-24" />
          </ConfigItem>
          <ConfigItem
            config={config}
            updateConfig={updateConfig}
            label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.rate_limit_redirect_to_admin === 'true'} onChange={(e) => handleChange('rate_limit_redirect_to_admin', e.target.checked ? 'true' : 'false')} /> Show "Go to Admin" option when rate limited</label>}
            saveKey="rate_limit_redirect_to_admin"
            saveVal={config.rate_limit_redirect_to_admin || 'false'}
            help="When enabled, rate-limited users see a button linking to the admin panel URL."
          />
          <ConfigItem
            config={config}
            updateConfig={updateConfig}
            label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.rate_limit_custom_message_enabled === 'true'} onChange={(e) => handleChange('rate_limit_custom_message_enabled', e.target.checked ? 'true' : 'false')} /> Show custom rate-limit message</label>}
            saveKey="rate_limit_custom_message_enabled"
            saveVal={config.rate_limit_custom_message_enabled || 'false'}
            help="Use your custom text instead of the backend rate-limit error."
          />
          <ConfigItem
            config={config}
            updateConfig={updateConfig}
            label={<><span className="block font-medium">Custom Rate-Limit Message</span><p className="text-xs text-muted-foreground mt-1">Displayed to rate-limited users when custom message is enabled.</p></>}
            saveKey="rate_limit_custom_message"
            saveVal={config.rate_limit_custom_message || ''}
          >
            <Input
              type="text"
              value={config.rate_limit_custom_message || ''}
              onChange={(e) => handleChange('rate_limit_custom_message', e.target.value)}
              placeholder="Too many requests. Please ask an admin for help."
              className="w-full sm:w-80"
            />
          </ConfigItem>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <h2 className="text-lg font-semibold mb-4">Song Voting</h2>
          <ConfigItem config={config} updateConfig={updateConfig} label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.voting_enabled === 'true'} onChange={(e) => handleChange('voting_enabled', e.target.checked ? 'true' : 'false')} /> Enable Song Voting</label>} saveKey="voting_enabled" saveVal={config.voting_enabled || 'false'} help="Allow guests to vote on tracks in the queue (off by default)." />
          <ConfigItem config={config} updateConfig={updateConfig} label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.voting_downvote_enabled !== 'false'} onChange={(e) => handleChange('voting_downvote_enabled', e.target.checked ? 'true' : 'false')} /> Enable Downvotes</label>} saveKey="voting_downvote_enabled" saveVal={config.voting_downvote_enabled !== 'false' ? 'true' : 'false'} help="Allow guests to downvote tracks in addition to upvoting. When disabled, only upvotes are shown." />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <h2 className="text-lg font-semibold mb-4">Display Mode</h2>
          <ConfigItem config={config} updateConfig={updateConfig} label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.aura_enabled === 'true'} onChange={(e) => handleChange('aura_enabled', e.target.checked ? 'true' : 'false')} /> Enable Album Aura</label>} saveKey="aura_enabled" saveVal={config.aura_enabled || 'false'} help="Show radial gradient from album art dominant color on the /display and /karaoke views." />
          <ConfigItem
              config={config}
              updateConfig={updateConfig}
              label={<><span className="block font-medium">Lyric Sync Offset (ms)</span><p className="text-xs text-muted-foreground mt-1">Negative shows lyrics earlier</p></>}
              saveKey="lyric_sync_offset_ms"
              saveVal={config.lyric_sync_offset_ms ?? '-220'}
              help="Calibrate against your actual speakers. If lyrics appear too late, go more negative. Bluetooth speakers typically add 100-300ms of their own delay, so try -400 to -600 there. Applies to /display and /karaoke, and takes effect within ~10 seconds without a reload."
          >
            <Input
                type="number"
                value={config.lyric_sync_offset_ms ?? '-220'}
                onChange={(e) => handleChange('lyric_sync_offset_ms', e.target.value)}
                min="-5000"
                max="5000"
                step="50"
                className="w-full sm:w-28"
            />
          </ConfigItem>
        </CardContent>
        </Card>

      <Card>
        <CardContent className="pt-6">
          <h2 className="text-lg font-semibold mb-4">Input Methods</h2>
          <ConfigItem config={config} updateConfig={updateConfig} label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.search_ui_enabled === 'true'} onChange={(e) => handleChange('search_ui_enabled', e.target.checked ? 'true' : 'false')} /> Enable Search UI</label>} saveKey="search_ui_enabled" />
          <ConfigItem config={config} updateConfig={updateConfig} label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.url_input_enabled === 'true'} onChange={(e) => handleChange('url_input_enabled', e.target.checked ? 'true' : 'false')} /> Enable URL Input</label>} saveKey="url_input_enabled" />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <h2 className="text-lg font-semibold mb-4">Content Filtering</h2>
          <ConfigItem config={config} updateConfig={updateConfig} label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.ban_explicit === 'true'} onChange={(e) => handleChange('ban_explicit', e.target.checked ? 'true' : 'false')} /> Ban Explicit Songs</label>} saveKey="ban_explicit" help="Block songs marked explicit by Spotify." />
          <ConfigItem
              config={config}
              updateConfig={updateConfig}
              label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.require_synced_lyrics === 'true'} onChange={(e) => handleChange('require_synced_lyrics', e.target.checked ? 'true' : 'false')} /> Require Synced Lyrics</label>}
              saveKey="require_synced_lyrics"
              saveVal={config.require_synced_lyrics || 'false'}
              help="Reject songs that have no synced lyrics, so nothing reaches the beamer with an empty screen. Tracks are always labelled in the guest UI and prequeue list regardless of this setting. If every lyrics provider is unreachable, songs are allowed through rather than blocked."
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <h2 className="text-lg font-semibold mb-4">Lyrics</h2>
          <ConfigItem
              config={config}
              updateConfig={updateConfig}
              label={<><span className="block font-medium">Lyrics Providers</span><p className="text-xs text-muted-foreground mt-1">Comma-separated, tried in order</p></>}
              saveKey="lyrics_providers"
              saveVal={config.lyrics_providers || 'lrclib,netease'}
              help="Available: lrclib, netease. The first provider that returns synced lyrics wins. Set to just one to compare quality. Point lrclib at a self-hosted instance with the LRCLIB_BASE_URL environment variable."
          >
            <Input
                type="text"
                value={config.lyrics_providers ?? 'lrclib,netease'}
                onChange={(e) => handleChange('lyrics_providers', e.target.value)}
                placeholder="lrclib,netease"
                className="w-full sm:w-56 font-mono"
            />
          </ConfigItem>
          <LyricsPrewarm />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <h2 className="text-lg font-semibold mb-4">Guest Authentication</h2>
          <ConfigItem config={config} updateConfig={updateConfig} label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.require_github_auth === 'true'} onChange={(e) => handleChange('require_github_auth', e.target.checked ? 'true' : 'false')} /> Require GitHub Sign-in</label>} saveKey="require_github_auth" saveVal={config.require_github_auth || 'false'} help="Guests must sign in with GitHub to queue or vote. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in the Environment tab." />
          <ConfigItem config={config} updateConfig={updateConfig} label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.require_google_auth === 'true'} onChange={(e) => handleChange('require_google_auth', e.target.checked ? 'true' : 'false')} /> Require Google Sign-in</label>} saveKey="require_google_auth" saveVal={config.require_google_auth || 'false'} help="Guests must sign in with Google to queue or vote. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the Environment tab." />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <h2 className="text-lg font-semibold mb-4">User Identification</h2>
          <ConfigItem config={config} updateConfig={updateConfig} label={<label className="flex items-center gap-2"><input type="checkbox" checked={config.require_username === 'true'} onChange={(e) => handleChange('require_username', e.target.checked ? 'true' : 'false')} /> Require Username on First Visit</label>} saveKey="require_username" saveVal={config.require_username || 'false'} help="Prompt users to enter a username before queueing." />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <h2 className="text-lg font-semibold mb-4">URLs</h2>
          <ConfigItem config={config} updateConfig={updateConfig} label="Queue URL:" saveKey="queue_url" help="Public URL for the queue (used in QR codes on Display mode and admin). Leave empty to use current host or CLIENT_URL.">
            <Input type="text" value={config.queue_url || ''} onChange={(e) => handleChange('queue_url', e.target.value)} placeholder="https://queue.example.com" className="w-full sm:w-64" />
          </ConfigItem>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <h2 className="text-lg font-semibold mb-4">Security</h2>
          {isDemoMode ? (
            <p className="text-sm text-muted-foreground py-3">
              Admin password is fixed to <strong>demo</strong> in this demo. Password and secret settings are not stored or exposed.
            </p>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center gap-4 py-3 border-b">
                <div className="flex-1 min-w-0">
                  <span className="font-medium">Admin password</span>
                  <p className="text-xs text-muted-foreground mt-1">
                    Stored as a scrypt hash in the database. Enter a new password to replace it.
                    {config.admin_password_configured === false && (
                      <span className="block mt-1">No custom password saved yet; default is still <code className="text-xs">admin</code> until you set one.</span>
                    )}
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
                  <Input
                    type="password"
                    value={adminPasswordDraft}
                    onChange={(e) => setAdminPasswordDraft(e.target.value)}
                    placeholder="New password"
                    autoComplete="new-password"
                    className="w-full sm:w-48"
                  />
                  <Button size="sm" onClick={saveAdminPassword}>
                    Save
                  </Button>
                </div>
              </div>
            </>
          )}
          <ConfigItem config={config} updateConfig={updateConfig} label="Admin Panel Redirect URL:" saveKey="admin_panel_url" help="Full URL for 'Go to Admin Panel' after Spotify auth.">
            <Input type="text" value={config.admin_panel_url || ''} onChange={(e) => handleChange('admin_panel_url', e.target.value)} placeholder="https://admin.url.com" className="w-full sm:w-64" />
          </ConfigItem>
        </CardContent>
      </Card>

      <Card className="border-destructive">
        <CardContent className="pt-6">
          <h2 className="text-lg font-semibold text-destructive mb-4">Danger Zone</h2>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="font-medium mb-1">Reset All Data</div>
              <p className="text-sm text-muted-foreground">Permanently delete all devices, statistics, and banned tracks. Configuration preserved. Cannot be undone.</p>
            </div>
            <Button variant="destructive" onClick={async () => {
              if (!window.confirm('Reset all data? This cannot be undone.')) return
              if (!window.confirm('Final warning. Continue?')) return
              try {
                await axios.post('/api/admin/reset-all-data')
                setMessage('All data has been reset.')
                setMessageType('success')
                setTimeout(() => setMessage(null), 5000)
              } catch (e) { alert('Failed: ' + (e.response?.data?.error || e.message)) }
            }}>Reset All Data</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default Configuration
