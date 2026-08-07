import { useState, useRef, useLayoutEffect, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Music, WifiOff, MicOff, Mic } from 'lucide-react'
import { useAuraColor } from '../hooks/useAuraColor'
import { usePlayback, formatDuration } from '../hooks/usePlayback'

/**
 * Lyrics-first big screen.
 *
 * Unlike /display, which is an ambient now-playing view, this exists to be read
 * from across a room by someone holding a microphone. The lyrics get essentially
 * the whole viewport and everything else is demoted to a narrow side rail.
 *
 * Two rules keep it readable while singing:
 *
 * 1. Every line renders at the SAME font size and weight. Emphasis comes from
 *    colour and a composited scale only. Growing the active line re-wraps it
 *    mid-song, which shifts every word and destroys the reading flow.
 * 2. The list slides. The whole column is translated so the active line sits at
 *    a fixed anchor, with the movement animated - jumping between positions is
 *    very hard to follow at this type size.
 */
const SLIDE_MS = 550
const SLIDE_EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)'

function SideAlbumArt({ src, alt }) {
    const [error, setError] = useState(false)
    if (!src || error) {
        return (
            <div className="w-full aspect-square rounded-xl bg-white/10 flex items-center justify-center">
                <Music className="h-[8%] w-[8%] min-h-6 min-w-6 text-white/40" />
            </div>
        )
    }
    return (
        <img
            src={src}
            alt={alt || 'Album art'}
            className="w-full aspect-square rounded-xl object-cover shadow-2xl"
            onError={() => setError(true)}
        />
    )
}

export default function Karaoke() {
    const {
        nowPlaying,
        upNext,
        connected,
        progress,
        initialized,
        auraEnabled,
        currentLyricIndex,
        rateLimited,
        appUrl,
        getPlaybackMs
    } = usePlayback()

    const auraColor = useAuraColor(auraEnabled ? nowPlaying?.album_art : null)
    const lines = nowPlaying?.lyrics?.lines
    const hasLyrics = !!lines?.length

    const stageRef = useRef(null)
    const columnRef = useRef(null)
    const lineRefs = useRef([])
    const [translateY, setTranslateY] = useState(0)

    /**
     * The first placement of a new song jumps into position; everything after it
     * slides. Tracked in a ref rather than state so it is read at render time
     * without an extra render, and without depending on rAF - which never fires
     * if the screen is not actively painting.
     */
    const jumpNextPlacementRef = useRef(true)

    useEffect(() => {
        jumpNextPlacementRef.current = true
    }, [nowPlaying?.id])

    /**
     * Centre the active line. Measured rather than computed, because wrapped
     * lines have varying heights.
     */
    useLayoutEffect(() => {
        const stage = stageRef.current
        const el = lineRefs.current[currentLyricIndex]
        if (!stage || !el) return

        const centre = el.offsetTop + el.offsetHeight / 2
        setTranslateY(stage.clientHeight / 2 - centre)
        jumpNextPlacementRef.current = false
    }, [currentLyricIndex, lines])

    // Wrapped line heights change with the viewport, so re-centre on resize
    useEffect(() => {
        const stage = stageRef.current
        if (!stage || !hasLyrics) return
        const ro = new ResizeObserver(() => {
            const el = lineRefs.current[currentLyricIndex]
            if (!el) return
            setTranslateY(stage.clientHeight / 2 - (el.offsetTop + el.offsetHeight / 2))
        })
        ro.observe(stage)
        return () => ro.disconnect()
    }, [currentLyricIndex, hasLyrics])

    return (
        <div className="fixed inset-0 bg-gray-950 text-white flex overflow-hidden select-none">
            {!connected && (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-red-900/80 backdrop-blur px-3 py-1.5 rounded-full text-sm text-red-200">
                    <WifiOff className="h-3.5 w-3.5" />
                    Reconnecting…
                </div>
            )}

            {/* Lyrics stage */}
            <div
                className="relative flex flex-1 min-w-0 items-center justify-center px-[3vw] transition-colors duration-500"
                style={auraColor ? { background: `radial-gradient(ellipse at center, rgba(${auraColor}, 0.18) 0%, transparent 70%)` } : {}}
            >
                {!initialized ? (
                    <div className="h-[6vh] w-[40%] rounded bg-white/5 animate-pulse" />
                ) : !nowPlaying ? (
                    <p className="text-white/30 text-[clamp(1.25rem,3vw,2.5rem)]">
                        {rateLimited ? 'Spotify is rate-limiting this app' : 'Nothing playing'}
                    </p>
                ) : !hasLyrics ? (
                    <div className="flex flex-col items-center gap-[2vh] text-white/30 text-center">
                        <MicOff className="h-[6vmin] w-[6vmin]" />
                        <p className="text-[clamp(1.125rem,2.5vw,2rem)] font-medium">No synced lyrics for this track</p>
                        <p className="text-[clamp(0.875rem,1.2vw,1.125rem)] text-white/20">
                            Enable “Require Synced Lyrics” in the admin panel to keep these out of the queue
                        </p>
                    </div>
                ) : (
                    <div
                        ref={stageRef}
                        className="relative h-full w-full overflow-hidden"
                        style={{
                            // Fade the ends so lines enter and leave instead of being clipped
                            maskImage: 'linear-gradient(to bottom, transparent 0%, black 22%, black 78%, transparent 100%)',
                            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 22%, black 78%, transparent 100%)'
                        }}
                    >
                        <div
                            ref={columnRef}
                            className="relative mx-auto flex w-full max-w-[92%] flex-col items-center gap-[1.4vh] text-center will-change-transform"
                            style={{
                                transform: `translateY(${translateY}px)`,
                                transition: jumpNextPlacementRef.current ? 'none' : `transform ${SLIDE_MS}ms ${SLIDE_EASING}`
                            }}
                        >
                            {lines.map((line, i) => {
                                const distance = i - currentLyricIndex
                                const isActive = distance === 0
                                // Colour and scale only. Font size and weight stay identical for
                                // every line so nothing ever re-wraps as the song moves on.
                                const opacity = isActive
                                    ? 1
                                    : distance < 0
                                        ? Math.max(0.08, 0.3 - (Math.abs(distance) - 1) * 0.08)
                                        : Math.max(0.12, 0.55 - (distance - 1) * 0.13)
                                return (
                                    <p
                                        key={`${i}-${line.startTimeMs}`}
                                        ref={(el) => { lineRefs.current[i] = el }}
                                        className="w-full text-[clamp(1.5rem,3.4vw,4rem)] font-semibold leading-[1.25] [overflow-wrap:break-word] text-white"
                                        style={{
                                            opacity,
                                            transform: isActive ? 'scale(1.05)' : 'scale(1)',
                                            textShadow: isActive ? '0 0 40px rgba(255,255,255,0.18)' : 'none',
                                            transition: `opacity 350ms ease, transform ${SLIDE_MS}ms ${SLIDE_EASING}`
                                        }}
                                    >
                                        {line.words}
                                    </p>
                                )
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* Side rail */}
            <aside className="flex w-[clamp(12rem,18vw,20rem)] shrink-0 flex-col gap-[2vh] border-l border-white/10 bg-black/40 p-[1.2vw]">
                {nowPlaying ? (
                    <div className="shrink-0">
                        <SideAlbumArt src={nowPlaying.album_art} alt={nowPlaying.album} />
                        <p className="mt-[1vh] truncate text-[clamp(0.8125rem,1vw,1.125rem)] font-semibold" title={nowPlaying.name}>
                            {nowPlaying.name}
                        </p>
                        <p className="truncate text-[clamp(0.6875rem,0.8vw,0.9375rem)] text-white/50" title={nowPlaying.artists}>
                            {nowPlaying.artists}
                        </p>
                        {nowPlaying.requested_by && (
                            <p
                                className="mt-[0.6vh] truncate rounded-md bg-white/10 px-2 py-[0.4vh] text-center text-[clamp(0.75rem,1.1vw,1.25rem)] font-semibold"
                                title={nowPlaying.requested_by}
                            >
                                <Mic className="mr-1 inline h-[1em] w-[1em] align-[-0.1em]" />
                                {nowPlaying.requested_by}
                            </p>
                        )}
                        <div className="mt-[0.8vh] h-1 w-full overflow-hidden rounded-full bg-white/15">
                            <div
                                className="h-full rounded-full"
                                style={{
                                    width: `${Math.min(Math.max(progress, 0), 100)}%`,
                                    backgroundColor: auraColor ? `rgb(${auraColor})` : '#4ade80',
                                    transition: 'width 500ms'
                                }}
                            />
                        </div>
                        <div className="mt-[0.4vh] flex justify-between font-mono text-[clamp(0.5625rem,0.6vw,0.75rem)] tabular-nums text-white/35">
                            <span>{formatDuration(getPlaybackMs())}</span>
                            <span>{formatDuration(nowPlaying.duration_ms)}</span>
                        </div>
                    </div>
                ) : (
                    <div className="w-full aspect-square rounded-xl bg-white/5" />
                )}

                <div className="flex min-h-0 flex-1 flex-col">
                    <p className="mb-[0.8vh] shrink-0 text-[clamp(0.5625rem,0.65vw,0.75rem)] font-semibold uppercase tracking-widest text-white/35">
                        Up next
                    </p>
                    <div className="no-scrollbar min-h-0 flex-1 space-y-[0.8vh] overflow-y-auto">
                        {upNext.length === 0 ? (
                            <p className="text-[clamp(0.625rem,0.75vw,0.875rem)] text-white/25">Queue is empty</p>
                        ) : (
                            upNext.slice(0, 8).map((track, i) => (
                                <div key={`${track.id}-${i}`} className="flex items-center gap-[0.5vw]">
                  <span className="w-[1.2em] shrink-0 text-right font-mono text-[clamp(0.5625rem,0.65vw,0.75rem)] tabular-nums text-white/25">
                    {i + 1}
                  </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-[clamp(0.625rem,0.8vw,0.9375rem)] font-medium" title={track.name}>
                                            {track.name}
                                        </p>
                                        <p className="truncate text-[clamp(0.5625rem,0.65vw,0.8125rem)] text-white/40" title={track.artists}>
                                            {track.requested_by || track.artists}
                                        </p>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {appUrl && (
                    <div className="shrink-0">
                        <div className="mx-auto w-fit rounded-lg bg-white p-[0.4vw]">
                            <QRCodeSVG value={appUrl} size={128} className="h-auto w-full max-w-[9vw] min-w-[4rem]" />
                        </div>
                        <p className="mt-[0.6vh] text-center text-[clamp(0.5625rem,0.7vw,0.8125rem)] text-white/40">
                            Scan to queue a song
                        </p>
                    </div>
                )}
            </aside>
        </div>
    )
}