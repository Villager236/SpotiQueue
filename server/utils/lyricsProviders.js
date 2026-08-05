const axios = require('axios');

// Point this at a self-hosted lrclib (default port 3300) to remove the
// dependency on the public instance entirely.
const LRCLIB_BASE_URL = (process.env.LRCLIB_BASE_URL || 'https://lrclib.net').replace(/\/+$/, '');
const USER_AGENT = 'SpotiQueue (https://github.com/StroepWafel/SpotiQueue)';

// NetEase rejects requests that do not look like they came from its own site.
const NETEASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0',
    Referer: 'https://music.163.com/'
};

/**
 * A provider exposes two steps so the caller can choose between candidates
 * before paying for a second request:
 *
 *   search(trackName, artistName, timeout) -> [{ name, artist, durationMs, payload }]
 *   resolve(candidate, timeout)            -> LRC text or null
 *
 * lrclib returns the lyrics inline, so its resolve() is free. NetEase needs a
 * follow-up call, which is exactly why picking the right candidate first matters.
 */

const lrclib = {
    name: 'lrclib',

    async search(trackName, artistName, timeout) {
        const res = await axios.get(`${LRCLIB_BASE_URL}/api/search`, {
            params: { track_name: trackName, artist_name: artistName },
            headers: { 'User-Agent': USER_AGENT },
            timeout
        });

        const rows = Array.isArray(res.data) ? res.data : [];
        return rows
            .filter(row => row.syncedLyrics)
            .map(row => ({
                name: row.trackName,
                artist: row.artistName,
                // lrclib reports duration in seconds; everything else here is ms
                durationMs: row.duration != null ? Math.round(row.duration * 1000) : null,
                payload: row.syncedLyrics
            }));
    },

    async resolve(candidate) {
        return candidate.payload || null;
    }
};

const netease = {
    name: 'netease',

    async search(trackName, artistName, timeout) {
        const res = await axios.get('https://music.163.com/api/search/get', {
            params: { s: `${trackName} ${artistName}`, type: 1, limit: 8 },
            headers: NETEASE_HEADERS,
            timeout
        });

        const songs = res.data?.result?.songs || [];
        return songs.map(song => ({
            name: song.name,
            artist: (song.artists || []).map(a => a.name).join(', '),
            durationMs: song.duration ?? null,
            payload: song.id
        }));
    },

    async resolve(candidate, timeout) {
        const res = await axios.get('https://music.163.com/api/song/lyric', {
            params: { id: candidate.payload, lv: 1, kv: 1, tv: -1 },
            headers: NETEASE_HEADERS,
            timeout
        });
        return res.data?.lrc?.lyric || null;
    }
};

const PROVIDERS = { lrclib, netease };

function getProvider(name) {
    return PROVIDERS[name] || null;
}

module.exports = {
    getProvider,
    providerNames: Object.keys(PROVIDERS),
    LRCLIB_BASE_URL
};