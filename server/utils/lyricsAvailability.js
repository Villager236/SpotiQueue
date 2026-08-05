const { getDb } = require('../db');
const { fetchSyncedLyrics } = require('./lyrics');

// A hit is permanent - lrclib does not lose lyrics. A miss is retried later
// because lyrics do get contributed over time.
const MISS_TTL_SECONDS = 6 * 60 * 60;

// A guest is waiting on this call, so give up sooner than the display-side path.
const REQUEST_TIMEOUT_MS = 6000;

// lrclib is a free community service. A single search fans out to ~10 tracks, so
// calls are serialised behind a minimum gap instead of going out in parallel -
// firing them all at once reliably earns a 429.
const MIN_REQUEST_GAP_MS = 350;
// How long to stop calling entirely after lrclib asks us to back off.
const BACKOFF_MS = 60 * 1000;
// Ceiling on queued lookups so a busy night cannot build an unbounded backlog.
const MAX_QUEUE_DEPTH = 40;

// Tracks currently being looked up, so a burst of search results does not fire
// the same lrclib request several times over.
const inFlight = new Map();

let queueTail = Promise.resolve();
let queueDepth = 0;
let lastRequestAt = 0;
let backoffUntil = 0;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isBackingOff() {
    return Date.now() < backoffUntil;
}

function noteFailure(error) {
    if (error.response?.status === 429) {
        backoffUntil = Date.now() + BACKOFF_MS;
        console.warn(`lrclib rate-limited us; pausing lyrics lookups for ${BACKOFF_MS / 1000}s`);
    }
}

/** Run an lrclib call on the shared queue, spacing requests out. */
function enqueue(task) {
    queueDepth += 1;
    const run = queueTail.then(async () => {
        const gap = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
        if (gap > 0) await sleep(gap);
        lastRequestAt = Date.now();
        return task();
    });
    queueTail = run.then(() => {}, () => {}).finally(() => { queueDepth -= 1; });
    return run;
}

function readCache(trackId) {
    const row = getDb().prepare('SELECT has_synced, checked_at FROM lyrics_availability WHERE track_id = ?').get(trackId);
    if (!row) return null;
    if (row.has_synced === 0 && Math.floor(Date.now() / 1000) - row.checked_at > MISS_TTL_SECONDS) {
        return null;
    }
    return row.has_synced === 1;
}

function writeCache(trackId, hasSynced) {
    getDb().prepare(`
    INSERT INTO lyrics_availability (track_id, has_synced, checked_at)
    VALUES (?, ?, ?)
    ON CONFLICT(track_id) DO UPDATE SET has_synced = excluded.has_synced, checked_at = excluded.checked_at
  `).run(trackId, hasSynced ? 1 : 0, Math.floor(Date.now() / 1000));
}

/** Full lyrics for a track, or null if we have never successfully fetched them. */
function getCachedLyrics(trackId) {
    if (!trackId) return null;
    try {
        const row = getDb().prepare('SELECT provider, sync_type, lines_json FROM lyrics_cache WHERE track_id = ?').get(trackId);
        if (!row) return null;
        const lines = JSON.parse(row.lines_json);
        if (!Array.isArray(lines) || lines.length === 0) return null;
        return { syncType: row.sync_type || 'LINE_SYNCED', lines, provider: row.provider || undefined };
    } catch (error) {
        console.error('Lyrics cache read error:', error);
        return null;
    }
}

function saveLyrics(trackId, lyrics) {
    if (!trackId || !lyrics?.lines?.length) return;
    try {
        getDb().prepare(`
      INSERT INTO lyrics_cache (track_id, provider, sync_type, lines_json, fetched_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(track_id) DO UPDATE SET
        provider = excluded.provider,
        sync_type = excluded.sync_type,
        lines_json = excluded.lines_json,
        fetched_at = excluded.fetched_at
    `).run(
            trackId,
            lyrics.provider || null,
            lyrics.syncType || 'LINE_SYNCED',
            JSON.stringify(lyrics.lines),
            Math.floor(Date.now() / 1000)
        );
    } catch (error) {
        console.error('Lyrics cache write error:', error);
    }
}

/** Cached answer only - null when we have not checked this track yet. */
function peekAvailability(trackId) {
    if (!trackId) return null;
    try {
        return readCache(trackId);
    } catch (error) {
        console.error('Lyrics cache read error:', error);
        return null;
    }
}

/**
 * Does this track have synced lyrics? Answers from cache when possible,
 * otherwise asks lrclib and caches the result.
 *
 * Fails open: if lrclib is unreachable this resolves to `true` and caches
 * nothing, so an outage degrades to "everything is allowed" rather than
 * poisoning the cache and rejecting every song for hours.
 */
async function checkAvailability({ id, name, artists, durationMs } = {}) {
    const trackId = id;
    if (!trackId) return true;

    const cached = peekAvailability(trackId);
    if (cached !== null) return cached;

    if (inFlight.has(trackId)) return inFlight.get(trackId);

    // While a provider is telling us to slow down, answer optimistically rather
    // than queueing up work that will only earn another 429.
    if (isBackingOff()) return true;

    const lookup = enqueue(async () => {
        try {
            const lyrics = await fetchSyncedLyrics({ trackName: name, artistName: artists, durationMs }, REQUEST_TIMEOUT_MS);
            const hasSynced = !!(lyrics && lyrics.lines?.length > 0);
            writeCache(trackId, hasSynced);
            // One lookup serves both the badge and the big screen
            if (hasSynced) saveLyrics(trackId, lyrics);
            return hasSynced;
        } catch (error) {
            noteFailure(error);
            console.error(`Lyrics lookup unavailable for ${trackId}, allowing track:`, error.message);
            return true;
        } finally {
            inFlight.delete(trackId);
        }
    });

    inFlight.set(trackId, lookup);
    return lookup;
}

/** Kick off a check without waiting, for filling in search-result badges. */
function warmAvailability(track) {
    const trackId = track?.id;
    if (!trackId || peekAvailability(trackId) !== null || inFlight.has(trackId)) return;
    // Badges are cosmetic - never let them crowd out the blocking checks guests wait on.
    if (isBackingOff() || queueDepth >= MAX_QUEUE_DEPTH) return;
    checkAvailability(track).catch(() => {});
}

module.exports = {
    peekAvailability,
    checkAvailability,
    warmAvailability,
    getCachedLyrics,
    saveLyrics
};