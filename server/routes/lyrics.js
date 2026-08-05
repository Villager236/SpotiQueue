const express = require('express');
const { getConfig } = require('../utils/config');
const { peekAvailability, warmAvailability, checkAvailability } = require('../utils/lyricsAvailability');
const { requireAdminSession } = require('../middleware/adminSession');
const { parseSpotifyCollectionUrl, getCollectionTracks } = require('../utils/spotify');

const router = express.Router();

const MAX_TRACKS_PER_REQUEST = 25;
const MAX_PREWARM_TRACKS = 500;

/**
 * Pre-caching runs as a single background job rather than a long request -
 * warming a 100-track playlist takes minutes once lookups are throttled.
 */
let prewarmJob = null;

async function runPrewarm(tracks) {
    for (const track of tracks) {
        if (!prewarmJob || prewarmJob.cancelled) return;
        try {
            const hasLyrics = await checkAvailability(track);
            if (hasLyrics) prewarmJob.found += 1;
            else prewarmJob.missing += 1;
        } catch {
            prewarmJob.failed += 1;
        }
        prewarmJob.done += 1;
    }
    if (prewarmJob) {
        prewarmJob.running = false;
        prewarmJob.finishedAt = Date.now();
    }
}

/**
 * Availability badges for a batch of tracks.
 *
 * Answers immediately from cache and starts background lookups for the rest, so
 * a search never blocks on lrclib. The client polls again to pick up the
 * stragglers.
 */
router.post('/availability', (req, res) => {
    const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks.slice(0, MAX_TRACKS_PER_REQUEST) : [];

    const availability = {};
    for (const track of tracks) {
        if (!track?.id) continue;
        const cached = peekAvailability(track.id);
        availability[track.id] = cached;
        if (cached === null) {
            warmAvailability({
                id: track.id,
                name: track.name,
                artists: track.artists,
                durationMs: track.duration_ms
            });
        }
    }

    res.json({
        availability,
        required: getConfig('require_synced_lyrics') === 'true'
    });
});

function jobStatus() {
    if (!prewarmJob) return { running: false, total: 0, done: 0, found: 0, missing: 0, failed: 0 };
    const { running, total, done, found, missing, failed, source } = prewarmJob;
    return { running, total, done, found, missing, failed, source };
}

/** Warm the lyrics cache from a Spotify playlist or album, before the event. */
router.post('/prewarm', requireAdminSession, async (req, res) => {
    if (prewarmJob?.running) {
        return res.status(409).json({ error: 'A pre-cache job is already running.', ...jobStatus() });
    }

    const url = (req.body?.url || '').trim();
    const collection = parseSpotifyCollectionUrl(url);
    if (!collection) {
        return res.status(400).json({ error: 'Paste a Spotify playlist or album link.' });
    }

    try {
        const tracks = await getCollectionTracks(collection.type, collection.id, MAX_PREWARM_TRACKS);
        if (tracks.length === 0) {
            return res.status(404).json({ error: 'No tracks found in that playlist or album.' });
        }

        prewarmJob = {
            running: true,
            cancelled: false,
            total: tracks.length,
            done: 0,
            found: 0,
            missing: 0,
            failed: 0,
            source: `${collection.type} (${tracks.length} tracks)`,
            startedAt: Date.now()
        };

        // Deliberately not awaited - the client polls GET /prewarm for progress
        runPrewarm(tracks.map(t => ({
            id: t.id,
            name: t.name,
            artists: t.artists,
            durationMs: t.duration_ms
        })));

        res.json({ success: true, ...jobStatus() });
    } catch (error) {
        console.error('Prewarm error:', error);
        const status = error.response?.status;
        // Spotify blocks third-party API access to its own editorial/algorithmic
        // playlists ("Today's Top Hits", "Discover Weekly", ...), which is by far
        // the most likely reason a paste fails here.
        if (status === 403 || status === 404) {
            return res.status(400).json({
                error: 'Spotify would not return that one. Playlists made by Spotify itself (editorial or personalised, like Discover Weekly) cannot be read by apps — use one of your own playlists, or an album link.'
            });
        }
        res.status(500).json({ error: error.message || 'Failed to read that playlist.' });
    }
});

router.get('/prewarm', requireAdminSession, (req, res) => {
    res.json(jobStatus());
});

router.delete('/prewarm', requireAdminSession, (req, res) => {
    if (prewarmJob) prewarmJob.cancelled = true;
    res.json({ success: true, ...jobStatus() });
});

module.exports = router;