const { getDb } = require('../db');

/**
 * Who asked for a given track.
 *
 * Spotify's queue carries no idea of who requested anything, so the link is
 * rebuilt from our own successful queue attempts. Where a track was requested
 * more than once, the most recent requester wins - that is the person standing
 * up to sing.
 */
function displayName(row) {
    return row.username || row.github_username || row.google_username || null;
}

/** Map of track_id -> requester name, for the track ids given. */
function getRequesterNames(trackIds) {
    const ids = [...new Set((trackIds || []).filter(Boolean))];
    if (ids.length === 0) return {};

    const placeholders = ids.map(() => '?').join(',');
    // SQLite returns the row belonging to MAX() when other columns are bare,
    // which gives us the latest requester per track in one pass.
    const rows = getDb().prepare(`
    SELECT qa.track_id AS track_id,
           MAX(qa.timestamp) AS ts,
           f.username AS username,
           f.github_username AS github_username,
           f.google_username AS google_username
    FROM queue_attempts qa
    JOIN fingerprints f ON f.id = qa.fingerprint_id
    WHERE qa.status = 'success' AND qa.track_id IN (${placeholders})
    GROUP BY qa.track_id
  `).all(...ids);

    const names = {};
    for (const row of rows) {
        const name = displayName(row);
        if (name) names[row.track_id] = name;
    }
    return names;
}

/** Requester name for a single fingerprint, used for moderation views. */
function getRequesterForFingerprint(fingerprintId) {
    if (!fingerprintId) return null;
    const row = getDb().prepare(
        'SELECT username, github_username, google_username FROM fingerprints WHERE id = ?'
    ).get(fingerprintId);
    return row ? displayName(row) : null;
}

module.exports = { getRequesterNames, getRequesterForFingerprint };