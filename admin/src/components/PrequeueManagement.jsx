import { useState, useEffect } from 'react'
import axios from '@/lib/api'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { Loader2, Check, X, Music, MicOff, SkipForward, User } from 'lucide-react'

/**
 * Now playing plus a skip control.
 *
 * Lives on the moderation screen because that is where you are looking when
 * something needs to come off the speakers. Spotify cannot remove a queued
 * track, so skipping is the only way to cut one short.
 */
function NowPlayingControl() {
  const [track, setTrack] = useState(null)
  const [skipping, setSkipping] = useState(false)
  const [error, setError] = useState('')

  const fetchTrack = async () => {
    try {
      const res = await axios.get('/api/now-playing')
      setTrack(res.data?.track || null)
    } catch {
      // Non-critical
    }
  }

  useEffect(() => {
    fetchTrack()
    const interval = setInterval(fetchTrack, 5000)
    return () => clearInterval(interval)
  }, [])

  const skip = async () => {
    setSkipping(true)
    setError('')
    try {
      await axios.post('/api/admin/playback/next')
      // Spotify needs a moment before it reports the new track
      setTimeout(fetchTrack, 700)
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to skip.')
    } finally {
      setSkipping(false)
    }
  }

  return (
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            {track?.album_art ? (
                <img src={track.album_art} alt={track.name} className="h-12 w-12 flex-shrink-0 rounded object-cover" />
            ) : (
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded bg-muted">
                  <Music className="h-5 w-5 text-muted-foreground" />
                </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-widest text-muted-foreground">Now playing</p>
              {track ? (
                  <>
                    <p className="truncate font-medium">{track.name}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {track.artists}
                      {track.requested_by && (
                          <span className="ml-2 inline-flex items-center gap-1 text-primary">
                      <User className="h-3 w-3" />{track.requested_by}
                    </span>
                      )}
                    </p>
                  </>
              ) : (
                  <p className="text-sm text-muted-foreground">Nothing playing</p>
              )}
            </div>
            <Button
                size="sm"
                variant="destructive"
                onClick={skip}
                disabled={skipping || !track}
                className="flex-shrink-0"
                title="Skip the current track"
            >
              {skipping ? <Loader2 className="h-4 w-4 animate-spin" /> : <><SkipForward className="mr-1 h-4 w-4" /> Skip</>}
            </Button>
          </div>
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
  )
}

function PrequeueManagement() {
  const [pending, setPending] = useState([])
  const [loading, setLoading] = useState(true)
  const [actionInProgress, setActionInProgress] = useState(null)

  useEffect(() => {
    fetchPending()
    const interval = setInterval(fetchPending, 3000)
    return () => clearInterval(interval)
  }, [])

  const fetchPending = async () => {
    try {
      const response = await axios.get('/api/prequeue/pending')
      setPending(response.data.pending)
    } catch {
      // Auth or network error
    } finally {
      setLoading(false)
    }
  }

  const approve = async (prequeueId) => {
    setActionInProgress(prequeueId)
    try {
      await axios.post(`/api/prequeue/approve/${prequeueId}`, { approved_by: 'admin' })
      setPending((p) => p.filter((x) => x.id !== prequeueId))
    } catch {
      // Error - will refetch on next poll
    } finally {
      setActionInProgress(null)
    }
  }

  const decline = async (prequeueId) => {
    setActionInProgress(prequeueId)
    try {
      await axios.post(`/api/prequeue/decline/${prequeueId}`, { approved_by: 'admin' })
      setPending((p) => p.filter((x) => x.id !== prequeueId))
    } catch {
      // Error
    } finally {
      setActionInProgress(null)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Loader2 className="h-5 w-5 mx-auto animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <NowPlayingControl />
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Prequeue Requests</h2>
        {pending.length > 0 && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-sm text-primary">
            {pending.length} pending
          </span>
        )}
      </div>

      {pending.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No pending requests
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {pending.map((request) => (
            <Card key={request.id}>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  {request.album_art ? (
                    <img
                      src={request.album_art}
                      alt={request.track_name}
                      className="w-12 h-12 rounded object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded bg-muted flex items-center justify-center flex-shrink-0">
                      <Music className="h-5 w-5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{request.track_name}</p>
                    <p className="text-sm text-muted-foreground truncate">
                      {request.artist_name}
                      {request.requested_by && (
                          <span className="ml-2 inline-flex items-center gap-1 text-foreground/70">
                          <User className="h-3 w-3" />{request.requested_by}
                        </span>
                      )}
                    </p>
                    {request.has_lyrics === 0 && (
                        <p className="mt-1 inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                          <MicOff className="h-3 w-3" /> No synced lyrics
                        </p>
                    )}
                    {request.approved_by && (
                      <p className="text-xs text-muted-foreground">Reviewed by: {request.approved_by}</p>
                    )}
                  </div>
                  <div className="flex gap-1.5 flex-shrink-0">
                    <Button
                      size="sm"
                      onClick={() => approve(request.id)}
                      disabled={actionInProgress === request.id}
                    >
                      {actionInProgress === request.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => decline(request.id)}
                      disabled={actionInProgress === request.id}
                    >
                      {actionInProgress === request.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <X className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

export default PrequeueManagement
