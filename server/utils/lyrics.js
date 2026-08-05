const { getConfig } = require('./config')
const { getProvider } = require('./lyricsProviders')

const DEFAULT_PROVIDER_ORDER = 'lrclib,netease'

/**
 * How far a candidate's length may differ from the Spotify track before we
 * refuse it. A radio edit's timings applied to an album version desyncs every
 * line, which on a karaoke screen is worse than showing nothing at all.
 */
const DURATION_TOLERANCE_MS = 5000

/**
 * Credit lines some providers (notably NetEase) put at the top of the LRC.
 * They carry real timestamps, so without this they scroll past as if they were
 * the opening lyrics.
 */
const CREDIT_LINE = /^(作词|作曲|编曲|制作人|制作|混音|录音|监制|出品|发行|和声|吉他|贝斯|鼓|词|曲)\s*[:：]/

/**
 * Parse LRC synced text: [offset:±ms], [mm:ss.xx] / [m:ss.xxx] (2 = centiseconds, 3 = milliseconds).
 */
function parseSyncedLyrics(syncedLyricsText) {
  const rawLines = syncedLyricsText.split(/\r?\n/)
  let globalOffsetMs = 0
  const rows = []

  for (const line of rawLines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const offsetMatch = trimmed.match(/^\[offset:([+-]?\d+)]/i)
    if (offsetMatch) {
      globalOffsetMs = parseInt(offsetMatch[1], 10)
      continue
    }

    const match = trimmed.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?]\s*(.*)$/)
    if (!match) continue

    const minutes = parseInt(match[1], 10)
    const seconds = parseInt(match[2], 10)
    const fracPart = match[3]
    const text = (match[4] || '').trim()
    if (!text) continue
    if (CREDIT_LINE.test(text)) continue

    let fracMs = 0
    if (fracPart != null && fracPart.length > 0) {
      if (fracPart.length === 3) {
        fracMs = parseInt(fracPart, 10)
      } else {
        fracMs = parseInt(fracPart, 10) * 10
      }
    }

    const totalMs = (minutes * 60 + seconds) * 1000 + fracMs + globalOffsetMs

    rows.push({
      timeTag: `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${fracPart ? String(fracPart).padStart(fracPart.length === 3 ? 3 : 2, '0') : '00'}`,
      words: text,
      startTimeMs: totalMs
    })
  }

  rows.sort((a, b) => a.startTimeMs - b.startTimeMs)
  return rows
}

/**
 * Per-provider circuit breaker.
 *
 * Without this, a provider that is down costs every single lookup its full
 * timeout before the chain moves on - which turns a dead lrclib into seconds of
 * latency on every queue submission.
 */
const PROVIDER_FAILURE_THRESHOLD = 3
const PROVIDER_COOLDOWN_MS = 5 * 60 * 1000
const providerHealth = new Map()

function isProviderSkipped(name) {
  const health = providerHealth.get(name)
  return !!(health && health.skipUntil > Date.now())
}

function noteProviderFailure(name) {
  const health = providerHealth.get(name) || { failures: 0, skipUntil: 0 }
  health.failures += 1
  if (health.failures >= PROVIDER_FAILURE_THRESHOLD) {
    health.skipUntil = Date.now() + PROVIDER_COOLDOWN_MS
    health.failures = 0
    console.warn(`Lyrics provider "${name}" keeps failing; skipping it for ${PROVIDER_COOLDOWN_MS / 60000} minutes`)
  }
  providerHealth.set(name, health)
}

function noteProviderSuccess(name) {
  providerHealth.set(name, { failures: 0, skipUntil: 0 })
}

function getProviderChain() {
  return (getConfig('lyrics_providers') || DEFAULT_PROVIDER_ORDER)
      .split(',')
      .map(name => name.trim().toLowerCase())
      .filter(Boolean)
      .map(getProvider)
      .filter(Boolean)
}

/**
 * Choose the candidate whose length best matches the track actually playing.
 * Returns null when nothing is close enough, so a mismatched version is treated
 * as "no lyrics" rather than shown out of sync.
 */
function pickCandidate(candidates, targetDurationMs) {
  if (!candidates.length) return null
  if (!targetDurationMs) return candidates[0]

  const timed = candidates.filter(c => c.durationMs != null)
  if (!timed.length) return candidates[0]

  let best = null
  let bestDelta = Infinity
  for (const candidate of timed) {
    const delta = Math.abs(candidate.durationMs - targetDurationMs)
    if (delta < bestDelta) {
      best = candidate
      bestDelta = delta
    }
  }

  return bestDelta <= DURATION_TOLERANCE_MS ? best : null
}

/**
 * Ask each configured provider in turn for synced lyrics.
 *
 * Throws only when every provider failed at the transport level - that lets
 * callers tell "this song has no lyrics" (cacheable) apart from "the lyrics
 * services are unreachable" (must not be cached, must not block anyone).
 */
async function fetchSyncedLyrics({ trackName, artistName, durationMs } = {}, timeout = 10000) {
  if (!trackName || !artistName) return null

  let lastError = null
  let anyProviderAnswered = false
  let attempted = 0

  for (const provider of getProviderChain()) {
    if (isProviderSkipped(provider.name)) continue
    attempted += 1

    try {
      const candidates = await provider.search(trackName, artistName, timeout)
      anyProviderAnswered = true
      noteProviderSuccess(provider.name)

      const picked = pickCandidate(candidates, durationMs)
      if (!picked) continue

      const lrcText = await provider.resolve(picked, timeout)
      if (!lrcText) continue

      const lines = parseSyncedLyrics(lrcText)
      if (lines.length > 0) {
        return { syncType: 'LINE_SYNCED', lines, provider: provider.name }
      }
    } catch (error) {
      lastError = error
      noteProviderFailure(provider.name)
      console.warn(`Lyrics provider "${provider.name}" failed: ${error.response?.status || error.code || error.message}`)
    }
  }

  // Everything is in cooldown - treat as an outage so callers fail open rather
  // than caching a wrong "this song has no lyrics".
  if (attempted === 0) throw new Error('All lyrics providers are temporarily unavailable')
  if (!anyProviderAnswered && lastError) throw lastError
  return null
}

/** Display-side helper: never throws, since a missing lyric pane is harmless. */
async function getLyrics(trackName, artistName, trackId, durationMs) {
  try {
    return await fetchSyncedLyrics({ trackName, artistName, durationMs })
  } catch (error) {
    return null
  }
}

module.exports = {
  getLyrics,
  fetchSyncedLyrics,
  parseSyncedLyrics
}