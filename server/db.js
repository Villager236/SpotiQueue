const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/queue.db');
const dbDir = path.dirname(dbPath);

// Ensure data directory exists
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

function initDatabase() {
  // Fingerprints table
  db.exec(`
    CREATE TABLE IF NOT EXISTS fingerprints (
      id TEXT PRIMARY KEY,
      first_seen INTEGER NOT NULL,
      last_queue_attempt INTEGER,
      cooldown_expires INTEGER,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'blocked')),
      username TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  
  try { db.exec(`ALTER TABLE fingerprints ADD COLUMN username TEXT`); } catch (e) { if (!e.message.includes('duplicate')) console.warn(e.message); }
  try { db.exec(`ALTER TABLE fingerprints ADD COLUMN github_id TEXT`); } catch (e) { if (!e.message.includes('duplicate')) console.warn(e.message); }
  try { db.exec(`ALTER TABLE fingerprints ADD COLUMN github_username TEXT`); } catch (e) { if (!e.message.includes('duplicate')) console.warn(e.message); }
  try { db.exec(`ALTER TABLE fingerprints ADD COLUMN github_avatar TEXT`); } catch (e) { if (!e.message.includes('duplicate')) console.warn(e.message); }
  try { db.exec(`ALTER TABLE fingerprints ADD COLUMN google_id TEXT`); } catch (e) { if (!e.message.includes('duplicate')) console.warn(e.message); }
  try { db.exec(`ALTER TABLE fingerprints ADD COLUMN google_username TEXT`); } catch (e) { if (!e.message.includes('duplicate')) console.warn(e.message); }
  try { db.exec(`ALTER TABLE fingerprints ADD COLUMN google_avatar TEXT`); } catch (e) { if (!e.message.includes('duplicate')) console.warn(e.message); }

  // Queue attempts log
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint_id TEXT NOT NULL,
      track_id TEXT,
      track_name TEXT,
      artist_name TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      timestamp INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (fingerprint_id) REFERENCES fingerprints(id)
    )
  `);

  // Votes (for song voting) - direction: 1 = upvote, -1 = downvote
  db.exec(`
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT NOT NULL,
      fingerprint_id TEXT NOT NULL,
      direction INTEGER NOT NULL DEFAULT 1 CHECK(direction IN (1, -1)),
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(track_id, fingerprint_id)
    )
  `);
  try { db.exec(`ALTER TABLE votes ADD COLUMN direction INTEGER NOT NULL DEFAULT 1`); } catch (e) { if (!e.message?.includes('duplicate')) console.warn(e.message); }

  // Pending queues (grace period before adding to Spotify)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_queues (
      id TEXT PRIMARY KEY,
      fingerprint_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      track_name TEXT NOT NULL,
      artist_name TEXT NOT NULL,
      album_art TEXT,
      track_uri TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'cancelled', 'failed')),
      execute_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (fingerprint_id) REFERENCES fingerprints(id)
    )
  `);

  // One-at-a-time lock so concurrent confirm paths cannot double-add to Spotify
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_queue_locks (
      pending_id TEXT PRIMARY KEY,
      locked_at INTEGER NOT NULL
    )
  `);

  // Prequeue (moderation before adding to Spotify)
  db.exec(`
    CREATE TABLE IF NOT EXISTS prequeue (
      id TEXT PRIMARY KEY,
      fingerprint_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      track_name TEXT NOT NULL,
      artist_name TEXT NOT NULL,
      album_art TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'declined')),
      approved_by TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (fingerprint_id) REFERENCES fingerprints(id)
    )
  `);


  // 1 = synced lyrics found, 0 = none found, NULL = not checked
  try { db.exec(`ALTER TABLE prequeue ADD COLUMN has_lyrics INTEGER`); } catch (e) { if (!e.message.includes('duplicate')) console.warn(e.message); }

  // Cached "does this track have synced lyrics" answers so the check at request
  // time costs nothing for tracks we have already looked up.
  db.exec(`
    CREATE TABLE IF NOT EXISTS lyrics_availability (
      track_id TEXT PRIMARY KEY,
      has_synced INTEGER NOT NULL,
      checked_at INTEGER NOT NULL
    )
  `);

  // The lyrics themselves, so a restart mid-event does not re-fetch the whole
  // night's worth from an external service.
  db.exec(`
    CREATE TABLE IF NOT EXISTS lyrics_cache (
      track_id TEXT PRIMARY KEY,
      provider TEXT,
      sync_type TEXT,
      lines_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);

  // Banned tracks
  db.exec(`
    CREATE TABLE IF NOT EXISTS banned_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT UNIQUE NOT NULL,
      artist_id TEXT,
      reason TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // Configuration
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // Initialize default config
  const defaultConfig = [
    { key: 'cooldown_duration', value: '300' }, // 5 minutes in seconds
    { key: 'songs_before_cooldown', value: '1' }, // Number of songs allowed before cooldown starts
    { key: 'fingerprinting_enabled', value: 'true' },
    { key: 'url_input_enabled', value: 'true' },
    { key: 'search_ui_enabled', value: 'true' },
    { key: 'queueing_enabled', value: 'true' },
    { key: 'admin_panel_url', value: '' }, // Empty by default, will use placeholder if not configured
    { key: 'rate_limit_redirect_to_admin', value: 'false' },
    { key: 'rate_limit_custom_message_enabled', value: 'false' },
    { key: 'rate_limit_custom_message', value: '' },
    { key: 'admin_password', value: 'admin' },
    { key: 'require_username', value: 'false' }, // Require username on first visit
    { key: 'voting_enabled', value: 'false' },
    { key: 'voting_downvote_enabled', value: 'true' },
    { key: 'require_github_auth', value: 'false' },
    { key: 'require_google_auth', value: 'false' },
    { key: 'prequeue_enabled', value: 'false' },
    { key: 'aura_enabled', value: 'false' },
    { key: 'queue_url', value: '' },
    { key: 'queue_grace_period_enabled', value: 'true' },
    { key: 'queue_grace_period_seconds', value: '5' },
    { key: 'require_synced_lyrics', value: 'false' },
    { key: 'lyrics_providers', value: 'lrclib,netease' },
    { key: 'lyric_sync_offset_ms', value: '-220' },
    { key: 'prequeue_max_pending_per_guest', value: '2' } //!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  ];

  const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  const insertMany = db.transaction((configs) => {
    for (const config of configs) {
      stmt.run(config.key, config.value);
    }
  });
  insertMany(defaultConfig);

  console.log('Database initialized');
}

function getDb() {
  return db;
}

module.exports = { initDatabase, getDb };

