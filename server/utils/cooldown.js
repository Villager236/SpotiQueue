const { getDb } = require('../db');
const { getConfig } = require('./config');

/**
 * Cooldown is shared across every fingerprint linked to the same GitHub/Google
 * account, so clearing cookies does not hand you a fresh allowance.
 */
function getCooldownFingerprintIds(fingerprint) {
    const db = getDb();
    if (fingerprint.github_id) {
        return db.prepare('SELECT id FROM fingerprints WHERE github_id = ?').all(fingerprint.github_id).map(r => r.id);
    }
    if (fingerprint.google_id) {
        return db.prepare('SELECT id FROM fingerprints WHERE google_id = ?').all(fingerprint.google_id).map(r => r.id);
    }
    return [fingerprint.id];
}

function cooldownEnabled() {
    return getConfig('fingerprinting_enabled') === 'true';
}

function getCooldownSettings() {
    return {
        songsBeforeCooldown: parseInt(getConfig('songs_before_cooldown') || '1', 10),
        cooldownDuration: parseInt(getConfig('cooldown_duration') || '300', 10)
    };
}

/** Seconds left on an active cooldown, or 0 when the guest is free to queue. */
function getRemainingCooldown(fingerprint, now) {
    if (!cooldownEnabled()) return 0;
    const ids = getCooldownFingerprintIds(fingerprint);
    if (ids.length === 0) return 0;

    const placeholders = ids.map(() => '?').join(',');
    const row = getDb().prepare(`
    SELECT MAX(cooldown_expires) as mx FROM fingerprints
    WHERE id IN (${placeholders}) AND cooldown_expires > ?
  `).get(...ids, now);

    return row?.mx ? row.mx - now : 0;
}

function countRecentSuccesses(ids, since) {
    const placeholders = ids.map(() => '?').join(',');
    const row = getDb().prepare(`
    SELECT COUNT(*) as count
    FROM queue_attempts
    WHERE fingerprint_id IN (${placeholders})
      AND status = 'success'
      AND timestamp > ?
  `).get(...ids, since);
    return row ? row.count : 0;
}

function startCooldown(ids, expiresAt) {
    const placeholders = ids.map(() => '?').join(',');
    getDb().prepare(`
    UPDATE fingerprints SET cooldown_expires = ?
    WHERE id IN (${placeholders})
  `).run(expiresAt, ...ids);
}

/**
 * True when the guest has already used up their allowance in the current window.
 * Starts the cooldown clock as a side effect, matching the previous inline behaviour.
 */
function hasExhaustedQuota(fingerprint, now) {
    if (!cooldownEnabled()) return false;
    const ids = getCooldownFingerprintIds(fingerprint);
    if (ids.length === 0) return false;

    const { songsBeforeCooldown, cooldownDuration } = getCooldownSettings();
    if (countRecentSuccesses(ids, now - cooldownDuration) < songsBeforeCooldown) return false;

    startCooldown(ids, now + cooldownDuration);
    return true;
}

/** Begin a cooldown once a guest's song actually made it into Spotify. */
function applyCooldownAfterSuccess(fingerprint, now) {
    if (!cooldownEnabled()) return;
    const ids = getCooldownFingerprintIds(fingerprint);
    if (ids.length === 0) return;

    const { songsBeforeCooldown, cooldownDuration } = getCooldownSettings();
    if (countRecentSuccesses(ids, now - cooldownDuration) >= songsBeforeCooldown) {
        startCooldown(ids, now + cooldownDuration);
    }
}

module.exports = {
    getCooldownFingerprintIds,
    cooldownEnabled,
    getCooldownSettings,
    getRemainingCooldown,
    hasExhaustedQuota,
    applyCooldownAfterSuccess
};