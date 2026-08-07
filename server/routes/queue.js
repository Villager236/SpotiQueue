const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');
const { getConfig } = require('../utils/config');
const { searchTracks, getTrack, parseSpotifyUrl, addToQueue, getQueue } = require('../utils/spotify');
const { getGuestAuthRequirements, sendAuthRequiredResponse } = require('../utils/guest-auth');
const { getRemainingCooldown, hasExhaustedQuota, applyCooldownAfterSuccess, getCooldownSettings } = require('../utils/cooldown');
const { checkAvailability, warmAvailability } = require('../utils/lyricsAvailability');
const { getRequesterNames } = require('../utils/requesters');

const router = express.Router();
const db = getDb();

function isGracePeriodEnabled() {
  if (getConfig('queue_grace_period_enabled') === 'false') return false;
  const seconds = parseInt(getConfig('queue_grace_period_seconds') || '5', 10);
  return seconds > 0;
}

function getGracePeriodSeconds() {
  return Math.max(0, parseInt(getConfig('queue_grace_period_seconds') || '5', 10));
}

const STALE_LOCK_SECONDS = 120;
const confirmingPendingIds = new Set();

function clearStalePendingLocks(now) {
  db.prepare('DELETE FROM pending_queue_locks WHERE locked_at < ?').run(now - STALE_LOCK_SECONDS);
}

function tryAcquirePendingLock(pendingId, now) {
  clearStalePendingLocks(now);
  try {
    db.prepare('INSERT INTO pending_queue_locks (pending_id, locked_at) VALUES (?, ?)').run(pendingId, now);
    return true;
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.message?.includes('UNIQUE')) {
      return false;
    }
    throw error;
  }
}

function releasePendingLock(pendingId) {
  db.prepare('DELETE FROM pending_queue_locks WHERE pending_id = ?').run(pendingId);
}

function pendingTrackPayload(pending) {
  return {
    id: pending.track_id,
    name: pending.track_name,
    artists: pending.artist_name,
    album_art: pending.album_art,
    uri: pending.track_uri
  };
}

async function confirmPendingQueue(pendingId) {
  let pending = db.prepare('SELECT * FROM pending_queues WHERE id = ?').get(pendingId);
  if (!pending) {
    return { ok: false, status: 404, error: 'Pending queue not found.' };
  }
  if (pending.status === 'confirmed') {
    return {
      ok: true,
      alreadyConfirmed: true,
      message: `Queued: ${pending.track_name} - ${pending.artist_name}`,
      track: pendingTrackPayload(pending)
    };
  }
  if (pending.status === 'cancelled') {
    return { ok: false, status: 410, error: 'This queue request was cancelled.' };
  }
  if (pending.status !== 'pending') {
    return { ok: false, status: 409, error: 'This queue request is no longer pending.' };
  }

  let now = Math.floor(Date.now() / 1000);
  if (now < pending.execute_at) {
    const waitSeconds = pending.execute_at - now;
    if (waitSeconds <= 3) {
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000 + 100));
      now = Math.floor(Date.now() / 1000);
    }
    if (now < pending.execute_at) {
      return { ok: false, status: 425, error: 'Grace period has not finished yet.', execute_at: pending.execute_at };
    }
  }

  if (!tryAcquirePendingLock(pendingId, now)) {
    pending = db.prepare('SELECT * FROM pending_queues WHERE id = ?').get(pendingId);
    if (pending?.status === 'confirmed') {
      return {
        ok: true,
        alreadyConfirmed: true,
        message: `Queued: ${pending.track_name} - ${pending.artist_name}`,
        track: pendingTrackPayload(pending)
      };
    }
    return { ok: false, status: 409, error: 'This queue request is already being processed.' };
  }

  try {
    pending = db.prepare('SELECT * FROM pending_queues WHERE id = ?').get(pendingId);
    if (!pending) {
      return { ok: false, status: 404, error: 'Pending queue not found.' };
    }
    if (pending.status === 'confirmed') {
      return {
        ok: true,
        alreadyConfirmed: true,
        message: `Queued: ${pending.track_name} - ${pending.artist_name}`,
        track: pendingTrackPayload(pending)
      };
    }
    if (pending.status === 'cancelled') {
      return { ok: false, status: 410, error: 'This queue request was cancelled.' };
    }
    if (pending.status !== 'pending') {
      return { ok: false, status: 409, error: 'This queue request is no longer pending.' };
    }

    const fingerprint = db.prepare('SELECT * FROM fingerprints WHERE id = ?').get(pending.fingerprint_id);
    if (!fingerprint) {
      db.prepare('UPDATE pending_queues SET status = ? WHERE id = ?').run('failed', pendingId);
      return { ok: false, status: 400, error: 'Could not fingerprint your device.' };
    }

    await addToQueue(pending.track_uri);

    db.prepare(`
      INSERT INTO queue_attempts (fingerprint_id, track_id, track_name, artist_name, status, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(pending.fingerprint_id, pending.track_id, pending.track_name, pending.artist_name, 'success', now);

    db.prepare(`
      UPDATE fingerprints SET last_queue_attempt = ? WHERE id = ?
    `).run(now, pending.fingerprint_id);

    applyCooldownAfterSuccess(fingerprint, now);
    db.prepare('UPDATE pending_queues SET status = ? WHERE id = ?').run('confirmed', pendingId);
    queueCacheExpiry = 0;

    return {
      ok: true,
      message: `Queued: ${pending.track_name} - ${pending.artist_name}`,
      track: pendingTrackPayload(pending)
    };
  } catch (error) {
    console.error('Confirm pending queue error:', error);
    db.prepare('UPDATE pending_queues SET status = ? WHERE id = ?').run('failed', pendingId);
    db.prepare(`
      INSERT INTO queue_attempts (fingerprint_id, track_id, status, error_message, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(pending.fingerprint_id, pending.track_id, 'error', error.message, now);
    return { ok: false, status: 500, error: error.message || 'Failed to queue track' };
  } finally {
    releasePendingLock(pendingId);
  }
}

async function processExpiredPendingQueues() {
  const now = Math.floor(Date.now() / 1000);
  const expired = db.prepare(`
    SELECT id FROM pending_queues
    WHERE status = 'pending' AND execute_at <= ?
  `).all(now);

  for (const row of expired) {
    if (confirmingPendingIds.has(row.id)) continue;
    confirmingPendingIds.add(row.id);
    try {
      await confirmPendingQueue(row.id);
    } catch (err) {
      console.error('processExpiredPendingQueues error:', err);
    } finally {
      confirmingPendingIds.delete(row.id);
    }
  }
}

let queueCache = null;
let queueCacheExpiry = 0;
const QUEUE_CACHE_TTL = 20000;

router.get('/current', async (req, res) => {
  try {
    const now = Date.now();

    if (queueCache && queueCacheExpiry > now) {
      return res.json(queueCache);
    }

    const queue = await getQueue();
    const guestQueuedIds = new Set(
        db.prepare("SELECT DISTINCT track_id FROM queue_attempts WHERE status = 'success' AND track_id IS NOT NULL").all().map(r => r.track_id)
    );

    const requesters = getRequesterNames([
      ...(queue?.queue || []).map(t => t.id),
      queue?.currently_playing?.id
    ]);

    if (queue?.queue?.length > 0) {
      queue.queue = queue.queue.map(t => ({
        ...t,
        votable: guestQueuedIds.has(t.id),
        requested_by: requesters[t.id] || null
      }));
    }
    if (queue?.currently_playing) {
      queue.currently_playing = {
        ...queue.currently_playing,
        votable: guestQueuedIds.has(queue.currently_playing.id),
        requested_by: requesters[queue.currently_playing.id] || null
      };
    }

    queueCache = queue;
    queueCacheExpiry = now + QUEUE_CACHE_TTL;

    res.json(queue);
  } catch (error) {
    console.error('Queue error:', error);

    if (queueCache) {
      return res.json(queueCache);
    }

    res.status(500).json({ error: error.message || 'Failed to get queue' });
  }
});

router.post('/search', async (req, res) => {
  try {
    const queueingEnabled = getConfig('queueing_enabled');
    if (queueingEnabled === 'false') {
      return res.status(503).json({ error: 'Queueing is currently disabled.' });
    }

    const { query } = req.body;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'Search query required' });
    }

    let tracks = await searchTracks(query, 10);

    const banExplicit = getConfig('ban_explicit') === 'true';
    if (banExplicit) {
      tracks = tracks.filter(track => !track.explicit);
    }

    // Start lyrics lookups now so the badges are ready by the time the guest
    // has finished reading the results.
    tracks.forEach(track => warmAvailability({
      id: track.id,
      name: track.name,
      artists: track.artists,
      durationMs: track.duration_ms
    }));

    res.json({ tracks });
  } catch (error) {
    console.error('Search error:', error);
    const statusCode = error.message.includes('authentication') ? 401 : 500;
    res.status(statusCode).json({ error: error.message || 'Failed to search tracks' });
  }
});

async function queueTrackImmediately(fingerprintId, fingerprint, trackId, trackInfo, now, res) {
  await addToQueue(trackInfo.uri);

  db.prepare(`
    INSERT INTO queue_attempts (fingerprint_id, track_id, track_name, artist_name, status, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(fingerprintId, trackId, trackInfo.name, trackInfo.artists, 'success', now);

  db.prepare(`
    UPDATE fingerprints SET last_queue_attempt = ? WHERE id = ?
  `).run(now, fingerprintId);

  applyCooldownAfterSuccess(fingerprint, now);
  queueCacheExpiry = 0;

  res.json({
    success: true,
    pending: false,
    message: `Queued: ${trackInfo.name} - ${trackInfo.artists}`,
    track: trackInfo
  });
}

router.post('/add', async (req, res) => {
  const queueingEnabled = getConfig('queueing_enabled');
  if (queueingEnabled === 'false') {
    return res.status(503).json({ error: 'Queueing is currently disabled.' });
  }

  const fingerprintId = req.body.fingerprint_id || req.cookies.fingerprint_id;

  if (!fingerprintId) {
    return res.status(400).json({ error: 'Could not fingerprint your device.' });
  }

  const fingerprint = db.prepare('SELECT * FROM fingerprints WHERE id = ?').get(fingerprintId);

  if (!fingerprint) {
    return res.status(400).json({ error: 'Could not fingerprint your device.' });
  }

  const authReq = getGuestAuthRequirements(fingerprint);
  if (authReq.authRequired) {
    return sendAuthRequiredResponse(res, authReq);
  }

  const requireUsername = getConfig('require_username') === 'true';
  if (requireUsername && !fingerprint.username) {
    return res.status(400).json({
      error: 'Username is required. Please refresh the page and enter your username.'
    });
  }

  if (fingerprint.status === 'blocked') {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO queue_attempts (fingerprint_id, status, error_message, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(fingerprintId, 'blocked', 'Device blocked', now);

    return res.status(403).json({ error: 'This device is blocked from queueing songs.' });
  }

  const now = Math.floor(Date.now() / 1000);

  const remainingCooldown = getRemainingCooldown(fingerprint, now);
  if (remainingCooldown > 0) {
    db.prepare(`
      INSERT INTO queue_attempts (fingerprint_id, status, error_message, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(fingerprintId, 'rate_limited', 'Cooldown active', now);
    return res.status(429).json({
      error: 'Please wait before queueing another song!',
      cooldown_remaining: remainingCooldown
    });
  }

  if (hasExhaustedQuota(fingerprint, now)) {
    const { songsBeforeCooldown, cooldownDuration } = getCooldownSettings();
    db.prepare(`
      INSERT INTO queue_attempts (fingerprint_id, status, error_message, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(fingerprintId, 'rate_limited', 'Cooldown limit reached', now);

    return res.status(429).json({
      error: `You've reached the limit of ${songsBeforeCooldown} song${songsBeforeCooldown > 1 ? 's' : ''} before cooldown. Please wait!`,
      cooldown_remaining: cooldownDuration
    });
  }

  const existingPending = db.prepare(`
    SELECT id FROM pending_queues WHERE fingerprint_id = ? AND status = 'pending'
  `).get(fingerprintId);
  if (existingPending) {
    return res.status(409).json({ error: 'You already have a song waiting to be queued. Cancel it or wait for it to finish.' });
  }

  let trackId = req.body.track_id;

  if (!trackId && req.body.track_url) {
    trackId = parseSpotifyUrl(req.body.track_url);
    if (!trackId) {
      return res.status(400).json({
        error: 'Invalid Spotify URL. Use format: https://open.spotify.com/track/TRACK_ID or spotify:track:TRACK_ID'
      });
    }
  }

  if (!trackId) {
    return res.status(400).json({ error: 'Track ID or URL required' });
  }

  const banned = db.prepare('SELECT * FROM banned_tracks WHERE track_id = ?').get(trackId);
  if (banned) {
    db.prepare(`
      INSERT INTO queue_attempts (fingerprint_id, track_id, status, error_message, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(fingerprintId, trackId, 'banned', 'Track banned', now);

    return res.status(403).json({ error: 'This song is not allowed.' });
  }

  try {
    const trackInfo = await getTrack(trackId);

    const banExplicit = getConfig('ban_explicit') === 'true';
    if (banExplicit && trackInfo.explicit) {
      db.prepare(`
        INSERT INTO queue_attempts (fingerprint_id, track_id, track_name, artist_name, status, error_message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(fingerprintId, trackId, trackInfo.name, trackInfo.artists, 'blocked', 'Explicit content not allowed', now);

      return res.status(403).json({ error: 'Explicit songs are not allowed.' });
    }

    const hasLyrics = await checkAvailability({
      id: trackId,
      name: trackInfo.name,
      artists: trackInfo.artists,
      durationMs: trackInfo.duration_ms
    });
    if (!hasLyrics && getConfig('require_synced_lyrics') === 'true') {
      db.prepare(`
        INSERT INTO queue_attempts (fingerprint_id, track_id, track_name, artist_name, status, error_message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(fingerprintId, trackId, trackInfo.name, trackInfo.artists, 'blocked', 'No synced lyrics', now);

      return res.status(403).json({
        error: 'No synced lyrics available for this song, so it cannot be shown on the screen. Please pick another one.',
        no_lyrics: true
      });
    }
    trackInfo.has_lyrics = hasLyrics;

    if (!isGracePeriodEnabled()) {
      return queueTrackImmediately(fingerprintId, fingerprint, trackId, trackInfo, now, res);
    }

    const graceSeconds = getGracePeriodSeconds();
    const executeAt = now + graceSeconds;
    const pendingId = crypto.randomBytes(8).toString('hex');

    db.prepare(`
      INSERT INTO pending_queues (id, fingerprint_id, track_id, track_name, artist_name, album_art, track_uri, status, execute_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
        pendingId,
        fingerprintId,
        trackId,
        trackInfo.name,
        trackInfo.artists,
        trackInfo.album_art || null,
        trackInfo.uri,
        executeAt,
        now
    );

    res.json({
      success: true,
      pending: true,
      pending_id: pendingId,
      execute_at: executeAt,
      grace_seconds: graceSeconds,
      message: `Adding in ${graceSeconds}s. Cancel if you changed your mind`,
      track: trackInfo
    });
  } catch (error) {
    console.error('Queue error:', error);

    db.prepare(`
      INSERT INTO queue_attempts (fingerprint_id, track_id, status, error_message, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(fingerprintId, trackId, 'error', error.message, now);

    res.status(500).json({ error: error.message || 'Failed to queue track' });
  }
});

router.get('/pending/:pendingId', async (req, res) => {
  const pendingId = req.params.pendingId;
  const fingerprintId = req.query.fingerprint_id || req.cookies.fingerprint_id;

  if (!fingerprintId) {
    return res.status(400).json({ error: 'Could not fingerprint your device.' });
  }

  let pending = db.prepare('SELECT * FROM pending_queues WHERE id = ?').get(pendingId);
  if (!pending) {
    return res.status(404).json({ error: 'Pending queue not found.' });
  }
  if (pending.fingerprint_id !== fingerprintId) {
    return res.status(403).json({ error: 'Not allowed to view this queue request.' });
  }

  const now = Math.floor(Date.now() / 1000);
  if (pending.status === 'pending' && now >= pending.execute_at) {
    await confirmPendingQueue(pendingId);
    pending = db.prepare('SELECT * FROM pending_queues WHERE id = ?').get(pendingId);
  }

  const track = pendingTrackPayload(pending);
  const message = pending.status === 'confirmed'
      ? `Queued: ${pending.track_name} - ${pending.artist_name}`
      : undefined;

  res.json({
    status: pending.status,
    execute_at: pending.execute_at,
    track,
    message
  });
});

router.post('/cancel/:pendingId', (req, res) => {
  const pendingId = req.params.pendingId;
  const fingerprintId = req.body.fingerprint_id || req.cookies.fingerprint_id;

  if (!fingerprintId) {
    return res.status(400).json({ error: 'Could not fingerprint your device.' });
  }

  const pending = db.prepare('SELECT * FROM pending_queues WHERE id = ?').get(pendingId);
  if (!pending) {
    return res.status(404).json({ error: 'Pending queue not found.' });
  }
  if (pending.fingerprint_id !== fingerprintId) {
    return res.status(403).json({ error: 'Not allowed to cancel this queue request.' });
  }
  if (pending.status === 'cancelled') {
    return res.json({ success: true, message: 'Queue request cancelled.' });
  }
  if (pending.status !== 'pending') {
    return res.status(409).json({ error: 'This queue request can no longer be cancelled.' });
  }

  const now = Math.floor(Date.now() / 1000);
  if (now >= pending.execute_at) {
    return res.status(409).json({ error: 'Grace period has ended. The song may already be queued.' });
  }

  db.prepare('UPDATE pending_queues SET status = ? WHERE id = ?').run('cancelled', pendingId);
  res.json({ success: true, message: 'Queue request cancelled. Your queue slot was restored.' });
});

router.post('/confirm/:pendingId', async (req, res) => {
  const pendingId = req.params.pendingId;
  const fingerprintId = req.body.fingerprint_id || req.cookies.fingerprint_id;

  if (!fingerprintId) {
    return res.status(400).json({ error: 'Could not fingerprint your device.' });
  }

  const pending = db.prepare('SELECT * FROM pending_queues WHERE id = ?').get(pendingId);
  if (!pending) {
    return res.status(404).json({ error: 'Pending queue not found.' });
  }
  if (pending.fingerprint_id !== fingerprintId) {
    return res.status(403).json({ error: 'Not allowed to confirm this queue request.' });
  }

  const result = await confirmPendingQueue(pendingId);
  if (!result.ok) {
    return res.status(result.status || 500).json({
      error: result.error,
      execute_at: result.execute_at
    });
  }

  res.json({
    success: true,
    pending: false,
    message: result.message,
    track: result.track
  });
});

router.post('/vote', (req, res) => {
  const votingEnabled = getConfig('voting_enabled') === 'true';
  if (!votingEnabled) {
    return res.status(503).json({ error: 'Voting is currently disabled.' });
  }

  const { track_id, direction: dir } = req.body;
  const fingerprintId = req.body.fingerprint_id || req.cookies.fingerprint_id;
  const downvoteEnabled = getConfig('voting_downvote_enabled') !== 'false';

  if (!track_id || !fingerprintId) {
    return res.status(400).json({ error: 'Track ID and fingerprint required' });
  }

  const direction = dir === -1 ? -1 : 1;
  if (dir === -1 && !downvoteEnabled) {
    return res.status(400).json({ error: 'Downvotes are disabled.' });
  }

  const fingerprint = db.prepare('SELECT * FROM fingerprints WHERE id = ?').get(fingerprintId);
  if (!fingerprint) {
    return res.status(400).json({ error: 'Invalid fingerprint' });
  }

  const authReq = getGuestAuthRequirements(fingerprint);
  if (authReq.authRequired) {
    return sendAuthRequiredResponse(res, authReq);
  }

  const guestQueued = db.prepare("SELECT 1 FROM queue_attempts WHERE track_id = ? AND status = 'success' LIMIT 1").get(track_id);
  if (!guestQueued) {
    return res.status(400).json({ error: 'Voting is only available for songs queued by guests.' });
  }

  try {
    const existing = db.prepare('SELECT id, direction FROM votes WHERE track_id = ? AND fingerprint_id = ?').get(track_id, fingerprintId);

    if (existing) {
      if (existing.direction === direction) {
        db.prepare('DELETE FROM votes WHERE track_id = ? AND fingerprint_id = ?').run(track_id, fingerprintId);
        const net = db.prepare('SELECT COALESCE(SUM(direction), 0) as net FROM votes WHERE track_id = ?').get(track_id);
        return res.json({ userVote: null, votes: net?.net ?? 0 });
      }
      db.prepare('UPDATE votes SET direction = ? WHERE track_id = ? AND fingerprint_id = ?').run(direction, track_id, fingerprintId);
    } else {
      const voteNow = Math.floor(Date.now() / 1000);
      db.prepare('INSERT INTO votes (track_id, fingerprint_id, direction, created_at) VALUES (?, ?, ?, ?)').run(track_id, fingerprintId, direction, voteNow);
    }
    const net = db.prepare('SELECT COALESCE(SUM(direction), 0) as net FROM votes WHERE track_id = ?').get(track_id);
    res.json({ userVote: direction, votes: net?.net ?? 0 });
  } catch (error) {
    console.error('Vote error:', error);
    res.status(500).json({ error: 'Failed to vote' });
  }
});

router.get('/votes', (req, res) => {
  const fingerprintId = req.query.fingerprint_id || req.cookies.fingerprint_id;
  const votingEnabled = getConfig('voting_enabled') === 'true';
  const downvoteEnabled = getConfig('voting_downvote_enabled') !== 'false';

  if (!votingEnabled) {
    return res.json({ votes: {}, userVotes: {}, enabled: false, downvoteEnabled: false });
  }

  try {
    const voteCounts = db.prepare('SELECT track_id, COALESCE(SUM(direction), 0) as net FROM votes GROUP BY track_id').all();
    const votes = {};
    voteCounts.forEach(row => { votes[row.track_id] = row.net; });

    let userVotes = {};
    if (fingerprintId) {
      const rows = db.prepare('SELECT track_id, direction FROM votes WHERE fingerprint_id = ?').all(fingerprintId);
      rows.forEach(row => { userVotes[row.track_id] = row.direction; });
    }

    res.json({ votes, userVotes, enabled: true, downvoteEnabled });
  } catch (error) {
    console.error('Get votes error:', error);
    res.json({ votes: {}, userVotes: {} });
  }
});

/** Force the next /current call to re-read Spotify, e.g. right after a skip. */
function invalidateQueueCache() {
  queueCacheExpiry = 0;
}


module.exports = router;
module.exports.processExpiredPendingQueues = processExpiredPendingQueues;
module.exports.invalidateQueueCache = invalidateQueueCache;