import { useState, useEffect, useCallback, useRef } from 'react'
import axios from '@/lib/api'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { MicOff, Mic } from 'lucide-react'
import { cn } from '@/lib/utils'

// Lyrics lookups happen in the background on the server, so poll a couple of
// times to pick up results that were not cached when the search returned.
const LYRICS_POLL_DELAYS = [0, 1200, 3000, 6000]

function QueueForm({ fingerprintId }) {
  const [lyricsAvailability, setLyricsAvailability] = useState({})
  const [lyricsRequired, setLyricsRequired] = useState(false)
  const lyricsTimers = useRef([])
  const [searchQuery, setSearchQuery] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [isSearching, setIsSearching] = useState(false)
  const [isQueueing, setIsQueueing] = useState(false)
  const [message, setMessage] = useState(null)
  const [messageType, setMessageType] = useState(null)
  const [rateLimitedAdminUrl, setRateLimitedAdminUrl] = useState('')
  const [inputMethod, setInputMethod] = useState('search')
  const [pendingQueue, setPendingQueue] = useState(null)
  const [countdown, setCountdown] = useState(0)
  const [config, setConfig] = useState({
    search_ui_enabled: true,
    url_input_enabled: true,
    prequeue_enabled: false,
    admin_panel_url: '',
    rate_limit_redirect_to_admin: false,
    rate_limit_custom_message_enabled: false,
    rate_limit_custom_message: ''
  })

  useEffect(() => {
    const fetchConfig = () => {
      axios.get('/api/config/public')
          .then(res => setConfig(prev => ({ ...prev, ...res.data })))
          .catch(() => {})
    }
    fetchConfig()
    const interval = setInterval(fetchConfig, 10000)
    return () => clearInterval(interval)
  }, [])

  const clearPending = useCallback(() => {
    setPendingQueue(null)
    setCountdown(0)
  }, [])

  const cancelLyricsPolling = useCallback(() => {
    lyricsTimers.current.forEach(clearTimeout)
    lyricsTimers.current = []
  }, [])

  useEffect(() => cancelLyricsPolling, [cancelLyricsPolling])

  /** Fill in lyric badges for a result set, retrying while answers are still pending. */
  const loadLyricsAvailability = useCallback((tracks) => {
    cancelLyricsPolling()
    if (!tracks.length) return

    const payload = tracks.map(t => ({ id: t.id, name: t.name, artists: t.artists, duration_ms: t.duration_ms }))
    let done = false

    const schedule = (index) => {
      if (done || index >= LYRICS_POLL_DELAYS.length) return
      const timer = setTimeout(async () => {
        try {
          const res = await axios.post('/api/lyrics/availability', { tracks: payload })
          const availability = res.data?.availability || {}
          setLyricsAvailability(prev => ({ ...prev, ...availability }))
          setLyricsRequired(!!res.data?.required)
          // Every track answered, nothing left to wait for
          if (Object.values(availability).every(v => v !== null)) done = true
        } catch {
          done = true // Badges are a nicety; stop retrying if the endpoint is unhappy
        }
        schedule(index + 1)
      }, LYRICS_POLL_DELAYS[index])
      lyricsTimers.current.push(timer)
    }

    schedule(0)
  }, [cancelLyricsPolling])

  useEffect(() => {
    if (!pendingQueue || !fingerprintId) return undefined

    let cancelled = false

    const pollPendingStatus = async () => {
      try {
        const response = await axios.get(`/api/queue/pending/${pendingQueue.pending_id}`, {
          params: { fingerprint_id: fingerprintId }
        })
        if (cancelled) return

        const { status, message: statusMessage } = response.data
        if (status === 'confirmed') {
          setMessage(statusMessage || 'Track queued successfully!')
          setMessageType('success')
          setRateLimitedAdminUrl('')
          clearPending()
        } else if (status === 'cancelled') {
          setMessage('Queue request was cancelled.')
          setMessageType('error')
          clearPending()
        } else if (status === 'failed') {
          setMessage('Failed to add track to the queue.')
          setMessageType('error')
          clearPending()
        }
      } catch (error) {
        if (cancelled) return
        const apiError = error.response?.data?.error
        if (error.response?.status === 404) {
          setMessage('Queue request expired.')
          setMessageType('error')
          clearPending()
        } else if (apiError) {
          setMessage(apiError)
          setMessageType('error')
          clearPending()
        }
      }
    }

    const tick = () => {
      const nowSec = Date.now() / 1000
      setCountdown(Math.max(0, Math.ceil(pendingQueue.execute_at - nowSec)))
    }

    tick()
    pollPendingStatus()
    const countdownInterval = setInterval(tick, 200)
    const pollInterval = setInterval(pollPendingStatus, 500)

    return () => {
      cancelled = true
      clearInterval(countdownInterval)
      clearInterval(pollInterval)
    }
  }, [pendingQueue, fingerprintId, clearPending])

  const handleQueueError = (error, latestConfig) => {
    const status = error.response?.status
    const apiError = error.response?.data?.error
    const isRateLimited = status === 429

    if (isRateLimited) {
      const customMessageEnabled = !!latestConfig?.rate_limit_custom_message_enabled
      const customMessage = (latestConfig?.rate_limit_custom_message || '').trim()
      const fallbackMessage = apiError || 'You are currently rate limited.'
      setMessage(customMessageEnabled && customMessage ? customMessage : fallbackMessage)
      setMessageType('error')

      if (latestConfig?.rate_limit_redirect_to_admin) {
        setRateLimitedAdminUrl((latestConfig.admin_panel_url || '').trim() || '/admin')
      } else {
        setRateLimitedAdminUrl('')
      }
      return
    }

    setRateLimitedAdminUrl('')
    setMessage(apiError || 'Failed to queue track')
    setMessageType('error')
  }

  const handleSearch = async (e) => {
    e.preventDefault()
    if (!searchQuery.trim() || pendingQueue) return

    setIsSearching(true)
    setMessage(null)

    try {
      const response = await axios.post('/api/queue/search', { query: searchQuery })
      setSearchResults(response.data.tracks)
      loadLyricsAvailability(response.data.tracks || [])
    } catch (error) {
      setMessage(error.response?.data?.error || 'Failed to search tracks')
      setMessageType('error')
    } finally {
      setIsSearching(false)
    }
  }

  const handleQueueResponse = (response, prequeueEnabled) => {
    if (response.data.pending) {
      setPendingQueue({
        pending_id: response.data.pending_id,
        execute_at: response.data.execute_at,
        track: response.data.track,
        grace_seconds: response.data.grace_seconds || 5
      })
      setCountdown(response.data.grace_seconds || Math.max(0, response.data.execute_at - Math.floor(Date.now() / 1000)))
      setMessage(response.data.message || 'Confirming queue...')
      setMessageType('success')
      setSearchResults([])
      setSearchQuery('')
      return
    }

    setMessage(response.data.message || (prequeueEnabled ? 'Track submitted for approval!' : 'Track queued successfully!'))
    setMessageType('success')
    setRateLimitedAdminUrl('')
    setSearchResults([])
  }

  const handleQueueTrack = async (trackId) => {
    if (pendingQueue) return
    setIsQueueing(true)
    setMessage(null)
    let latestConfig = config

    try {
      const configRes = await axios.get('/api/config/public')
      latestConfig = { ...config, ...(configRes.data || {}) }
      const prequeueEnabled = latestConfig.prequeue_enabled ?? config.prequeue_enabled
      setConfig(latestConfig)

      const url = prequeueEnabled ? '/api/prequeue/submit' : '/api/queue/add'
      const response = await axios.post(url, {
        fingerprint_id: fingerprintId,
        track_id: trackId
      })
      handleQueueResponse(response, prequeueEnabled)
    } catch (error) {
      handleQueueError(error, latestConfig)
    } finally {
      setIsQueueing(false)
    }
  }

  const handleQueueUrl = async (e) => {
    e.preventDefault()
    if (!urlInput.trim() || pendingQueue) return

    setIsQueueing(true)
    setMessage(null)
    let latestConfig = config

    try {
      const configRes = await axios.get('/api/config/public')
      latestConfig = { ...config, ...(configRes.data || {}) }
      const prequeueEnabled = latestConfig.prequeue_enabled ?? config.prequeue_enabled
      setConfig(latestConfig)

      const url = prequeueEnabled ? '/api/prequeue/submit' : '/api/queue/add'
      const response = await axios.post(url, {
        fingerprint_id: fingerprintId,
        track_url: urlInput
      })
      handleQueueResponse(response, prequeueEnabled)
      setUrlInput('')
    } catch (error) {
      handleQueueError(error, latestConfig)
    } finally {
      setIsQueueing(false)
    }
  }

  const handleCancelPending = async () => {
    if (!pendingQueue) return
    try {
      const response = await axios.post(`/api/queue/cancel/${pendingQueue.pending_id}`, {
        fingerprint_id: fingerprintId
      })
      setMessage(response.data.message || 'Queue request cancelled.')
      setMessageType('success')
      clearPending()
    } catch (error) {
      setMessage(error.response?.data?.error || 'Failed to cancel queue request')
      setMessageType('error')
      if (error.response?.status === 409) {
        clearPending()
      }
    }
  }

  const inputsDisabled = isSearching || isQueueing || !!pendingQueue

  return (
      <Card>
        <CardContent className="pt-6">
          {pendingQueue && (
              <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
                <div className="flex items-center gap-3 mb-3">
                  {pendingQueue.track?.album_art && (
                      <img
                          src={pendingQueue.track.album_art}
                          alt={pendingQueue.track.album || pendingQueue.track.name}
                          className="w-14 h-14 rounded-lg object-cover shrink-0"
                      />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{pendingQueue.track?.name}</div>
                    <div className="text-sm text-muted-foreground truncate">{pendingQueue.track?.artists}</div>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mb-3">
                  {countdown > 0 ? (
                      <>
                        Adding to queue in{' '}
                        <span className="font-semibold text-foreground tabular-nums">{countdown}</span>s
                      </>
                  ) : (
                      'Adding to queue...'
                  )}
                </p>
                <Button
                    variant="destructive"
                    className="w-full min-h-[44px] touch-manipulation"
                    onClick={handleCancelPending}
                >
                  Cancel
                </Button>
              </div>
          )}

          {message && !pendingQueue && (
              <div className={cn(
                  'mb-4 rounded-lg p-3 text-sm',
                  messageType === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'
              )}>
                {message}
                {rateLimitedAdminUrl && (
                    <div className="mt-3">
                      <Button
                          size="sm"
                          variant="outline"
                          className="min-h-[40px]"
                          onClick={() => { window.location.href = rateLimitedAdminUrl }}
                      >
                        Go to Admin
                      </Button>
                    </div>
                )}
              </div>
          )}

          <div className="flex gap-2 mb-4 flex-wrap">
            {config.search_ui_enabled !== false && (
                <Button
                    variant={inputMethod === 'search' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setInputMethod('search')}
                    disabled={!!pendingQueue}
                    className="min-h-[44px] px-4 touch-manipulation"
                >
                  Search
                </Button>
            )}
            {config.url_input_enabled !== false && (
                <Button
                    variant={inputMethod === 'url' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setInputMethod('url')}
                    disabled={!!pendingQueue}
                    className="min-h-[44px] px-4 touch-manipulation"
                >
                  Paste URL
                </Button>
            )}
          </div>

          {inputMethod === 'search' && (
              <div className="space-y-4">
                <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-2">
                  <Input
                      type="search"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search for a song..."
                      disabled={inputsDisabled}
                      className="flex-1 min-h-[44px] text-base sm:text-sm"
                      autoComplete="off"
                  />
                  <Button type="submit" disabled={inputsDisabled || !searchQuery.trim()} className="min-h-[44px] touch-manipulation shrink-0">
                    {isSearching ? 'Searching...' : 'Search'}
                  </Button>
                </form>

                {searchResults.length > 0 && (
                    <div className="space-y-2">
                      {searchResults.map((track) => {
                        const hasLyrics = lyricsAvailability[track.id]
                        const blocked = lyricsRequired && hasLyrics === false
                        return (
                            <div
                                key={track.id}
                                className={cn(
                                    'flex items-center gap-3 p-3 rounded-lg border transition-colors touch-manipulation',
                                    blocked
                                        ? 'opacity-60'
                                        : 'hover:bg-accent/50 active:bg-accent/70 cursor-pointer'
                                )}
                                onClick={() => !inputsDisabled && !blocked && handleQueueTrack(track.id)}
                            >
                              {track.album_art && (
                                  <img src={track.album_art} alt={track.album} className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg object-cover shrink-0" />
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="font-medium truncate flex items-center gap-2">
                                  {track.name}
                                  {track.explicit && <span className="text-xs px-1.5 py-0.5 rounded bg-muted">E</span>}
                                </div>
                                <div className="text-sm text-muted-foreground truncate">{track.artists}</div>
                                {hasLyrics === false && (
                                    <div className="mt-1 inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
                                      <MicOff className="h-3 w-3 shrink-0" />
                                      {blocked ? 'No lyrics available - cannot be queued' : 'No lyrics available for this one'}
                                    </div>
                                )}
                                {hasLyrics === true && (
                                    <div className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                                      <Mic className="h-3 w-3 shrink-0" /> Synced lyrics
                                    </div>
                                )}
                              </div>
                              <Button
                                  size="sm"
                                  onClick={(e) => { e.stopPropagation(); handleQueueTrack(track.id) }}
                                  disabled={inputsDisabled || blocked}
                                  className="min-h-[40px] min-w-[64px] touch-manipulation shrink-0"
                              >
                                Queue
                              </Button>
                            </div>
                        )
                      })}
                    </div>
                )}
              </div>
          )}

          {inputMethod === 'url' && (
              <form onSubmit={handleQueueUrl} className="space-y-4">
                <Input
                    type="url"
                    inputMode="url"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder="Paste Spotify track URL"
                    disabled={inputsDisabled}
                    className="min-h-[44px] text-base sm:text-sm"
                />
                <div className="text-xs text-muted-foreground space-y-1">
                  <div>Examples:</div>
                  <code className="block break-all">https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC</code>
                  <code className="block break-all">spotify:track:4uLU6hMCjMI75M1A2tKUQC</code>
                </div>
                <Button type="submit" disabled={inputsDisabled || !urlInput.trim()} className="w-full min-h-[44px] touch-manipulation">
                  {isQueueing ? 'Queueing...' : 'Queue Track'}
                </Button>
              </form>
          )}
        </CardContent>
      </Card>
  )
}

export default QueueForm