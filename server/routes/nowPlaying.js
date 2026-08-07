const express = require('express');
const { getNowPlaying, getQueue, getPlayerBackoffUntil, setPlayerBackoff } = require('../utils/spotify');
const { getLyrics } = require('../utils/lyrics');
const { getCachedLyrics, saveLyrics } = require('../utils/lyricsAvailability');
const { getRequesterNames } = require('../utils/requesters');

const router = express.Router();
const lyricsFailureCache = new Map();
const LYRICS_RETRY_AFTER_MS = 5 * 60 * 1000; // Don't retry failed tracks for 5 minutes
const inFlight = new Set();

/**
 * Spotify's player endpoints are quota-limited per application, not per screen.
 * Every display, karaoke screen and phone polls this route every few seconds, so
 * without a shared cache the upstream call rate scales with the number of people
 * watching - which is exactly how you exhaust the quota mid-event and blank every
 * screen at once.
 *
 * One upstream call per TTL, shared by every client, with concurrent requests
 * collapsed into a single in-flight promise.
 */
// Clients run their own 100ms playback clock and only need periodic correction,
// so a coarse TTL here costs nothing visually and saves a lot of quota.
const NOW_PLAYING_TTL_MS = 2500;
// How long a cached track keeps being served while Spotify is refusing us
const STALE_SERVE_MS = 60 * 1000;
// The queue is only read to pre-fetch lyrics; it does not need request cadence
const QUEUE_PREFETCH_INTERVAL_MS = 20000;
/**
 * Spotify can answer a player rate-limit with a Retry-After of many hours. Honouring
 * that literally would keep the screens dark long after the limit actually lifts, so
 * re-probe periodically instead - one call every 15 minutes costs nothing.
 */
const MAX_BACKOFF_MS = 15 * 60 * 1000;

let npCache = { track: null, at: 0 };
let npInFlight = null;
let lastQueuePrefetchAt = 0;

/**
 * Age-correct a cached response.
 *
 * progress_ms is only true for the instant it was fetched. Serving it verbatim
 * from cache reports a position that is behind real playback, which drags the
 * clients' playback clocks backwards until they snap forward - and a snap jumps
 * the highlighted lyric line past whatever should have been sung in between.
 * Returns a copy so the cached object is never mutated.
 */
function withCurrentProgress(track, fetchedAt) {
  if (!track) return null;
  if (!track.is_playing || !fetchedAt) return { ...track };

  const elapsed = Date.now() - fetchedAt;
  const advanced = (track.progress_ms ?? 0) + elapsed;
  return {
    ...track,
    progress_ms: track.duration_ms ? Math.min(advanced, track.duration_ms) : advanced
  };
}

/** True once a cached track would have run past its own end. */
function cachedTrackHasFinished() {
  const track = npCache.track;
  if (!track?.is_playing || !track.duration_ms || !npCache.at) return false;
  return (track.progress_ms ?? 0) + (Date.now() - npCache.at) >= track.duration_ms;
}

async function loadNowPlaying() {
  const now = Date.now();

  // Past the end of the cached track the clamped position would lag real
  // playback, so go back to Spotify even if the cache is otherwise fresh.
  if (npCache.at && now - npCache.at < NOW_PLAYING_TTL_MS && !cachedTrackHasFinished()) {
    return withCurrentProgress(npCache.track, npCache.at);
  }
  // Rate limited: keep showing the last known track rather than "nothing playing"
  if (now < getPlayerBackoffUntil()) return withCurrentProgress(npCache.track, npCache.at);
  if (npInFlight) return npInFlight;

  npInFlight = (async () => {
    try {
      const track = await getNowPlaying();
      npCache = { track, at: Date.now() };
      return track;
    } catch (error) {
      if (error.status === 429) {
        const askedMs = (error.retryAfter ? error.retryAfter + 1 : 10) * 1000;
        const waitMs = Math.min(askedMs, MAX_BACKOFF_MS);
        setPlayerBackoff(waitMs);
        console.warn(
            `Spotify rate-limited the player API (Retry-After ${error.retryAfter ?? '?'}s). ` +
            `Serving cached playback and re-probing in ${Math.round(waitMs / 1000)}s. ` +
            `Note: this limit follows the Spotify account, not the app - new client credentials will not reset it.`
        );
      } else {
        console.error('Now playing error:', error.message);
      }
      // Serve the last known track while it is still recent enough to be true
      if (npCache.at && Date.now() - npCache.at < STALE_SERVE_MS) {
        return withCurrentProgress(npCache.track, npCache.at);
      }
      return null;
    } finally {
      npInFlight = null;
    }
  })();

  return npInFlight;
}

/**
 * Kick off a lyrics fetch for a track we have not cached yet.
 *
 * Results land in the database, so a restart mid-event does not re-fetch the
 * whole night from an external service.
 */
function ensureLyricsFetch(track) {
  if (!track?.id) return;
  const trackId = track.id;
  if (inFlight.has(trackId)) return;
  if (getCachedLyrics(trackId)) return;
  const failedAt = lyricsFailureCache.get(trackId);
  if (failedAt && Date.now() - failedAt < LYRICS_RETRY_AFTER_MS) return;

  inFlight.add(trackId);
  getLyrics(track.name, track.artists, trackId, track.duration_ms)
      .then(lyrics => {
        if (lyrics) {
          saveLyrics(trackId, lyrics);
          lyricsFailureCache.delete(trackId);
        } else {
          lyricsFailureCache.set(trackId, Date.now());
        }
      })
      .catch(() => {
        lyricsFailureCache.set(trackId, Date.now());
      })
      .finally(() => inFlight.delete(trackId));
}

/** Warm lyrics for the next couple of tracks, off the request path. */
function prefetchQueueLyrics() {
  getQueue()
      .then(({ queue }) => {
        for (let i = 0; i < Math.min(queue?.length || 0, 2); i++) {
          ensureLyricsFetch(queue[i]);
        }
      })
      .catch(() => {
        // Non-critical, and never worth spending quota on retries
      });
}

router.get('/', async (req, res) => {
  try {
    const nowPlaying = await loadNowPlaying();

    if (nowPlaying) {
      const cached = getCachedLyrics(nowPlaying.id);
      if (cached) {
        nowPlaying.lyrics = cached;
      } else {
        ensureLyricsFetch(nowPlaying);
      }
      // Who is up at the microphone
      nowPlaying.requested_by = getRequesterNames([nowPlaying.id])[nowPlaying.id] || null;
    }

    // Deliberately not awaited, and on its own slow cadence - this used to run on
    // every request, doubling the Spotify calls each screen cost.
    const now = Date.now();
    if (now - lastQueuePrefetchAt > QUEUE_PREFETCH_INTERVAL_MS && now >= getPlayerBackoffUntil()) {
      lastQueuePrefetchAt = now;
      prefetchQueueLyrics();
    }

    // Tell the screens *why* there is nothing to show. Silently rendering
    // "Nothing playing" during a rate limit sends you hunting the wrong problem.
    const backoffUntil = getPlayerBackoffUntil();
    const rateLimited = Date.now() < backoffUntil;
    res.json({
      track: nowPlaying,
      rate_limited: rateLimited,
      retry_after_s: rateLimited ? Math.round((backoffUntil - Date.now()) / 1000) : 0
    });
  } catch (error) {
    console.error('Now playing error:', error);
    res.json({ track: null });
  }
});

module.exports = router;
