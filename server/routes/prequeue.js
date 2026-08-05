const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');
const { getConfig } = require('../utils/config');
const { getGuestAuthRequirements, sendAuthRequiredResponse } = require('../utils/guest-auth');
const { getTrack, addToQueue, getQueue, parseSpotifyUrl } = require('../utils/spotify');
const { requireAdminSession } = require('../middleware/adminSession');
const { getRemainingCooldown, hasExhaustedQuota, getCooldownSettings } = require('../utils/cooldown');
const { checkAvailability } = require('../utils/lyricsAvailability');

const router = express.Router();

router.post('/submit', async (req, res) => {
  const db = getDb();
  const prequeueEnabled = getConfig('prequeue_enabled') === 'true';

  if (!prequeueEnabled) {
    return res.status(503).json({ error: 'Prequeue is currently disabled.' });
  }

  const fingerprintId = req.body.fingerprint_id || req.cookies.fingerprint_id;
  let trackId = req.body.track_id;

  if (!fingerprintId) return res.status(400).json({ error: 'Missing fingerprint' });

  const fingerprint = db.prepare('SELECT * FROM fingerprints WHERE id = ?').get(fingerprintId);
  if (!fingerprint) return res.status(400).json({ error: 'Could not fingerprint your device.' });

  const authReq = getGuestAuthRequirements(fingerprint);
  if (authReq.authRequired) return sendAuthRequiredResponse(res, authReq);

  const requireUsername = getConfig('require_username') === 'true';
  if (requireUsername && !fingerprint.username) {
    return res.status(400).json({ error: 'Username is required. Please refresh the page and enter your username.' });
  }

  const now = Math.floor(Date.now() / 1000);

  if (fingerprint.status === 'blocked') {
    db.prepare(`
      INSERT INTO queue_attempts (fingerprint_id, status, error_message, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(fingerprintId, 'blocked', 'Device blocked', now);
    return res.status(403).json({ error: 'This device is blocked from queueing songs.' });
  }

  // Cap the un-reviewed backlog per guest, otherwise one person can bury the
  // approval list faster than it can be worked through.
  const maxPending = Math.max(1, parseInt(getConfig('prequeue_max_pending_per_guest') || '2', 10));
  const pendingCount = db.prepare(
      "SELECT COUNT(*) as count FROM prequeue WHERE fingerprint_id = ? AND status = 'pending'"
  ).get(fingerprintId).count;
  if (pendingCount >= maxPending) {
    return res.status(429).json({
      error: `You already have ${pendingCount} song${pendingCount > 1 ? 's' : ''} waiting for approval. Please wait for those to be reviewed.`
    });
  }

  const remainingCooldown = getRemainingCooldown(fingerprint, now);
  if (remainingCooldown > 0) {
    db.prepare(`
      INSERT INTO queue_attempts (fingerprint_id, status, error_message, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(fingerprintId, 'rate_limited', 'Cooldown active', now);
    return res.status(429).json({
      error: 'Please wait before requesting another song!',
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

  if (!trackId && req.body.track_url) {
    trackId = parseSpotifyUrl(req.body.track_url);
    if (!trackId) return res.status(400).json({ error: 'Invalid Spotify URL.' });
  }

  if (!trackId) return res.status(400).json({ error: 'Missing track ID or URL' });

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

    if (getConfig('ban_explicit') === 'true' && trackInfo.explicit) {
      db.prepare(`
        INSERT INTO queue_attempts (fingerprint_id, track_id, track_name, artist_name, status, error_message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(fingerprintId, trackId, trackInfo.name, trackInfo.artists, 'blocked', 'Explicit content not allowed', now);
      return res.status(403).json({ error: 'Explicit songs are not allowed.' });
    }

    const maxDuration = parseInt(getConfig('max_song_duration') || '0');
    if (maxDuration > 0 && trackInfo.duration_ms > maxDuration * 1000) {
      return res.status(403).json({ error: 'Song is too long.' });
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

    try {
      const currentQueue = await getQueue();
      const isDup = currentQueue.queue.some(t => t.id === trackId) ||
          (currentQueue.currently_playing && currentQueue.currently_playing.id === trackId);
      if (isDup) return res.status(409).json({ error: 'This song is already in the queue.' });
    } catch (e) { /* ignore */ }

    const existingPending = db.prepare("SELECT * FROM prequeue WHERE track_id = ? AND status = 'pending'").get(trackId);
    if (existingPending) return res.status(409).json({ error: 'This song is already pending approval.' });

    const prequeueId = crypto.randomBytes(8).toString('hex');

    db.prepare(`
      INSERT INTO prequeue (id, fingerprint_id, track_id, track_name, artist_name, album_art, status, created_at, has_lyrics)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
        prequeueId,
        fingerprintId,
        trackId,
        trackInfo.name,
        trackInfo.artists,
        trackInfo.album_art || null,
        now,
        hasLyrics ? 1 : 0
    );

    res.json({
      success: true,
      prequeue_id: prequeueId,
      has_lyrics: hasLyrics,
      message: 'Track submitted for approval'
    });
  } catch (error) {
    console.error('Prequeue error:', error);
    res.status(500).json({ error: error.message || 'Failed to submit track' });
  }
});

router.post('/approve/:prequeueId', requireAdminSession, async (req, res) => {
  const db = getDb();
  const { prequeueId } = req.params;

  try {
    const prequeue = db.prepare('SELECT * FROM prequeue WHERE id = ?').get(prequeueId);
    if (!prequeue) return res.status(404).json({ error: 'Prequeue entry not found' });
    if (prequeue.status !== 'pending') return res.status(400).json({ error: 'Track already processed' });

    const trackInfo = await getTrack(prequeue.track_id);
    await addToQueue(trackInfo.uri);

    db.prepare('UPDATE prequeue SET status = ?, approved_by = ? WHERE id = ?').run('approved', req.body.approved_by || 'admin', prequeueId);

    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO queue_attempts (fingerprint_id, track_id, track_name, artist_name, status, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(prequeue.fingerprint_id, prequeue.track_id, prequeue.track_name, prequeue.artist_name, 'success', now);

    res.json({ success: true, message: `Approved: ${prequeue.track_name}` });
  } catch (error) {
    console.error('Approve error:', error);
    res.status(500).json({ error: error.message || 'Failed to approve track' });
  }
});

router.post('/decline/:prequeueId', requireAdminSession, async (req, res) => {
  const db = getDb();
  const { prequeueId } = req.params;

  try {
    const prequeue = db.prepare('SELECT * FROM prequeue WHERE id = ?').get(prequeueId);
    if (!prequeue) return res.status(404).json({ error: 'Prequeue entry not found' });
    if (prequeue.status !== 'pending') return res.status(400).json({ error: 'Track already processed' });

    db.prepare('UPDATE prequeue SET status = ?, approved_by = ? WHERE id = ?').run('declined', req.body.approved_by || 'admin', prequeueId);

    res.json({ success: true, message: `Declined: ${prequeue.track_name}` });
  } catch (error) {
    console.error('Decline error:', error);
    res.status(500).json({ error: error.message || 'Failed to decline track' });
  }
});

router.get('/pending', requireAdminSession, (req, res) => {
  const db = getDb();
  try {
    const pending = db.prepare("SELECT * FROM prequeue WHERE status = 'pending' ORDER BY created_at DESC").all();
    res.json({ pending });
  } catch (error) {
    console.error('Pending error:', error);
    res.status(500).json({ error: 'Failed to get pending requests' });
  }
});

module.exports = router;