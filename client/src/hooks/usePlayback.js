import { useState, useEffect, useRef, useCallback } from 'react'
import axios from '@/lib/api'

const POLL_NOW_PLAYING_MS = 3000
const POLL_QUEUE_MS = 8000
const POLL_VOTES_MS = 10000
const POLL_CONFIG_MS = 10000
const DEFAULT_LYRIC_OFFSET_MS = -220

/**
 * Spotify reports a position that is already slightly stale by the time it
 * reaches the browser, so every poll used to yank the clock backwards and the
 * lyric line twitched with it. Instead we run our own clock and only correct it:
 * hard-snap on a track change or a real seek, otherwise ease toward the reported
 * value so the drift is absorbed invisibly.
 */
const HARD_RESYNC_MS = 1500
const RESYNC_SMOOTHING = 0.25

/** Index of the last lyric line that should have started by `currentMs`. */
export function computeLyricLineIndex(lines, currentMs) {
    if (!lines?.length) return 0
    const t = Math.max(0, currentMs)
    let idx = 0
    for (let i = lines.length - 1; i >= 0; i--) {
        const lineStartMs = lines[i].startTimeMs ?? 0
        if (t >= lineStartMs) {
            idx = i
            break
        }
    }
    return idx
}

export function formatDuration(ms) {
    if (!ms || !Number.isFinite(ms)) return '0:00'
    return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
}

/**
 * Everything the big-screen views need: now playing, extrapolated position, the
 * active lyric line, the up-next queue, votes, and the room-aware queue URL.
 *
 * Shared by /display and /karaoke so the two screens can never drift apart on
 * lyric timing - which matters now that the sync offset is admin-configurable.
 */
export function usePlayback() {
    const [nowPlaying, setNowPlaying] = useState(null)
    const [upNext, setUpNext] = useState([])
    const [votes, setVotes] = useState({})
    const [connected, setConnected] = useState(true)
    const [progress, setProgress] = useState(0)
    const [initialized, setInitialized] = useState(false)
    const [votingEnabled, setVotingEnabled] = useState(false)
    const [auraEnabled, setAuraEnabled] = useState(false)
    const [queueUrl, setQueueUrl] = useState('')
    const [roomCode, setRoomCode] = useState(null)
    const [lyricOffsetMs, setLyricOffsetMs] = useState(DEFAULT_LYRIC_OFFSET_MS)
    const [currentLyricIndex, setCurrentLyricIndex] = useState(0)
    const [cachedLyrics, setCachedLyrics] = useState(null)
    const [finishedTrackId, setFinishedTrackId] = useState(null)
    const [rateLimited, setRateLimited] = useState(false)

    const nowPlayingRef = useRef(null)
    const progressTimerRef = useRef(null)
    const offsetRef = useRef(DEFAULT_LYRIC_OFFSET_MS)

    // Our own playback clock, corrected against Spotify rather than reset by it.
    const basePositionRef = useRef(0)
    const baseTimestampRef = useRef(null)

    useEffect(() => { offsetRef.current = lyricOffsetMs }, [lyricOffsetMs])

    /** Extrapolated playback position (ms). Does not advance while paused. */
    const getPlaybackMs = useCallback(() => {
        const track = nowPlayingRef.current
        if (!track) return 0
        if (!track.is_playing) return basePositionRef.current
        const ts = baseTimestampRef.current
        if (ts == null) return basePositionRef.current
        return basePositionRef.current + (Date.now() - ts)
    }, [])

    // Poll now playing
    useEffect(() => {
        let cancelled = false
        let failCount = 0

        const fetchNowPlaying = async () => {
            if (cancelled) return
            try {
                // The big screens are the only clients that render lyrics, so they ask
                // for them explicitly; guest phones get a much smaller payload.
                const res = await axios.get('/api/now-playing?lyrics=1', { timeout: 5000 })
                if (cancelled) return
                const track = res.data?.track ?? null
                setRateLimited(!!res.data?.rate_limited)

                if (track?.id && nowPlayingRef.current?.id && track.id !== nowPlayingRef.current.id) {
                    setFinishedTrackId(nowPlayingRef.current.id)
                }

                if (track?.id !== nowPlayingRef.current?.id) {
                    setCachedLyrics(null)
                }

                // Lyrics arrive a poll or two after the track does; hold on to them so
                // the pane does not flicker when a later response omits them.
                if (track && track.lyrics) {
                    setCachedLyrics(track.lyrics)
                } else if (track && cachedLyrics) {
                    track.lyrics = cachedLyrics
                }

                // Reconcile our clock before swapping in the new track, so `predicted`
                // still refers to the track we were timing.
                if (track) {
                    const now = Date.now()
                    const reported = track.progress_ms ?? 0
                    const isNewTrack = track.id !== nowPlayingRef.current?.id
                    const wasPlaying = nowPlayingRef.current?.is_playing
                    const canPredict = !isNewTrack && wasPlaying && baseTimestampRef.current != null
                    const predicted = canPredict
                        ? basePositionRef.current + (now - baseTimestampRef.current)
                        : reported
                    const error = reported - predicted

                    if (isNewTrack || !track.is_playing || Math.abs(error) > HARD_RESYNC_MS) {
                        basePositionRef.current = reported
                    } else {
                        basePositionRef.current = predicted + error * RESYNC_SMOOTHING
                    }
                    baseTimestampRef.current = now
                }

                setNowPlaying(track)
                nowPlayingRef.current = track
                setConnected(true)
                failCount = 0
                if (track?.progress_ms != null && track?.duration_ms) {
                    setProgress((basePositionRef.current / track.duration_ms) * 100)
                }
                setInitialized(true)
            } catch {
                failCount++
                if (failCount >= 3) setConnected(false)
                setInitialized(true)
            }
        }

        fetchNowPlaying()
        const interval = setInterval(fetchNowPlaying, POLL_NOW_PLAYING_MS)
        return () => { cancelled = true; clearInterval(interval) }
    }, [cachedLyrics])

    // Progress + active lyric line: tick every 100ms while playing
    useEffect(() => {
        if (progressTimerRef.current) clearInterval(progressTimerRef.current)
        if (!nowPlayingRef.current?.is_playing) return

        const tick = () => {
            const track = nowPlayingRef.current
            if (!track?.duration_ms || baseTimestampRef.current == null) return
            const currentMs = getPlaybackMs()
            setProgress(Math.min((currentMs / track.duration_ms) * 100, 100))
            const lines = track.lyrics?.lines
            if (lines?.length) {
                setCurrentLyricIndex(computeLyricLineIndex(lines, currentMs + offsetRef.current))
            }
        }
        tick()
        progressTimerRef.current = setInterval(tick, 100)

        return () => clearInterval(progressTimerRef.current)
    }, [nowPlaying, getPlaybackMs])

    // When paused (or lyrics arrive while paused), align without extrapolation
    useEffect(() => {
        const track = nowPlayingRef.current
        if (!track?.lyrics?.lines?.length) return
        if (track.is_playing) return
        setCurrentLyricIndex(computeLyricLineIndex(track.lyrics.lines, getPlaybackMs() + offsetRef.current))
    }, [nowPlaying?.id, nowPlaying?.is_playing, nowPlaying?.lyrics, lyricOffsetMs])

    // Up next
    useEffect(() => {
        let cancelled = false

        const fetchQueue = async () => {
            if (cancelled) return
            try {
                const res = await axios.get('/api/queue/current', { timeout: 8000 })
                if (cancelled) return
                setUpNext(res.data?.queue?.slice(0, 20) ?? [])
            } catch {
                // keep showing last known queue
            }
        }

        fetchQueue()
        const interval = setInterval(fetchQueue, POLL_QUEUE_MS)
        return () => { cancelled = true; clearInterval(interval) }
    }, [])

    // Optimistic: drop the first entry as soon as the track changes
    useEffect(() => {
        if (finishedTrackId) setUpNext((prev) => prev.slice(1))
    }, [finishedTrackId])

    // Public config
    useEffect(() => {
        let cancelled = false

        const fetchConfig = async () => {
            if (cancelled) return
            try {
                const res = await axios.get('/api/config/public', { timeout: 5000 })
                if (cancelled) return
                setVotingEnabled(res.data?.voting_enabled ?? false)
                setAuraEnabled(res.data?.aura_enabled ?? false)
                setQueueUrl(res.data?.queue_url || '')
                setRoomCode(res.data?.room_code || null)
                if (Number.isFinite(res.data?.lyric_sync_offset_ms)) {
                    setLyricOffsetMs(res.data.lyric_sync_offset_ms)
                }
            } catch {
                if (!cancelled) setVotingEnabled(false)
            }
        }

        fetchConfig()
        const interval = setInterval(fetchConfig, POLL_CONFIG_MS)
        return () => { cancelled = true; clearInterval(interval) }
    }, [])

    useEffect(() => {
        if (!votingEnabled) setVotes({})
    }, [votingEnabled])

    // Votes
    useEffect(() => {
        if (!votingEnabled) return
        let cancelled = false

        const fetchVotes = async () => {
            if (cancelled) return
            try {
                const res = await axios.get('/api/queue/votes', { timeout: 5000 })
                if (cancelled) return
                setVotes(res.data?.votes ?? {})
            } catch {
                // non-critical
            }
        }

        fetchVotes()
        const interval = setInterval(fetchVotes, POLL_VOTES_MS)
        return () => { cancelled = true; clearInterval(interval) }
    }, [votingEnabled])

    /**
     * Queue URL for the QR. Falls back to this screen's own origin, and always
     * carries the room code - without it the projected QR is unjoinable.
     */
    const appUrl = (() => {
        const base = queueUrl || (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.host}` : '')
        if (!base || !roomCode) return base
        try {
            const url = new URL(base)
            url.searchParams.set('room', roomCode)
            return url.toString()
        } catch {
            return `${base}${base.includes('?') ? '&' : '?'}room=${encodeURIComponent(roomCode)}`
        }
    })()

    return {
        nowPlaying,
        upNext,
        votes,
        connected,
        progress,
        initialized,
        votingEnabled,
        auraEnabled,
        currentLyricIndex,
        lyricOffsetMs,
        rateLimited,
        appUrl,
        getPlaybackMs
    }
}