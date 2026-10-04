<?php
/* werewolf / lib/bootstrap.php - config, PDO connection, constants, schema.
   Included FIRST by backend.php; sets $pdo + constants in the caller scope.
   NOTE: this file sits in lib/, so the config path is ../../config.ini */
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$configFile = __DIR__ . '/../../config.ini';
if (!file_exists($configFile)) {
    die(json_encode([
        "status" => "error",
        "message" => "Missing ../config.ini file.",
        "cutscene" => "scene_error"
    ]));
}

$lines = file($configFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$db_user = trim($lines[0] ?? '');
$db_pass = trim($lines[1] ?? '');
$db_host = '127.0.0.1';
$db_name = 'werewolf_db';

try {
    $pdo = new PDO("mysql:host=$db_host;dbname=$db_name;charset=utf8mb4", $db_user, $db_pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
    ]);
} catch (PDOException $e) {
    die(json_encode([
        "status" => "error",
        "message" => "Database connection error: " . $e->getMessage(),
        "cutscene" => "scene_error"
    ]));
}

/* ---------------------------------------------------------------------------
   Schema.

   This used to re-run ~26 ALTER/CREATE statements on EVERY request.  Even as
   no-ops each one costs a round trip plus a metadata check, and ALTER takes a
   metadata lock that serialises concurrent requests — pure latency added to
   every single poll.  Now the migrations run once per schema version; every
   later request pays only one primary-key lookup (sub-millisecond).
   Bump SCHEMA_VERSION when adding columns/indexes below.
--------------------------------------------------------------------------- */
const SCHEMA_VERSION = 11;

// --- Auth / accounts -------------------------------------------------------
// Accounts are OPTIONAL: a guest can play forever, they just don't get a win
// rate or a rank. Sign-in is PASSWORDLESS: an emailed 6-digit code is the only
// credential (see lib/auth-mail.php). Sessions are opaque tokens in a HttpOnly
// cookie backed by a DB row — deliberately NOT PHP native sessions, because
// file sessions lock and our poll long-polls for over a second, which would
// serialise a player's own requests.
const AUTH_SESSION_TTL = 2592000;   // 30 days
const AUTH_RATING_START = 1000;
const AUTH_K = 32;                  // Elo K-factor

// --- XP / levels -----------------------------------------------------------
// XP belongs to the ACCOUNT, so guests (who have no account) never earn any —
// that's the whole point of the progression being account-bound.
const AUTH_XP_PLAY    = 20;   // for finishing a match
const AUTH_XP_WIN     = 30;   // extra when your side wins
const AUTH_XP_SURVIVE = 10;   // extra if you were still alive at the end

// --- Avatars ---------------------------------------------------------------
// A FIXED set of built-in ids. Only the id is stored; the client draws it (a
// coloured badge + a self-hosted lucide glyph). Uploads were deliberately not
// offered: no storage, no resizing, and nothing to moderate.
const AUTH_AVATARS = ['paw', 'moon', 'skull', 'ghost', 'blade', 'ember', 'warden',
                      'royal', 'seer', 'hunter', 'raven', 'cat', 'hound', 'bone',
                      'forest', 'frost'];

// --- Game modes ------------------------------------------------------------
// 'classic' is the original game and its code path must never change behaviour.
// 'chaos' (Chaos Night) replaces the nightly guaranteed kill with HIDDEN HP:
// nights wound instead of execute, so nobody can tell whether an attack landed.
const MODE_CLASSIC = 'classic';
const MODE_CHAOS   = 'chaos';
const GAME_MODES   = [MODE_CLASSIC, MODE_CHAOS];

// Chaos Night tuning. 34 x3 = 102, so one wolf needs three bites while three
// wolves focusing the same target kill them in a single night.
const CHAOS_HP     = 100;   // everyone starts (and caps) here
const CHAOS_BITE   = 34;    // damage per werewolf attack
const CHAOS_HEAL   = 30;    // HP restored by the Doctor's nightly heal
const CHAOS_POISON = 60;    // damage from the Witch's one-shot poison

function validMode($m) {
    $m = strtolower(trim((string)$m));
    return in_array($m, GAME_MODES, true) ? $m : MODE_CLASSIC;
}

$schemaOk = false;
try {
    $schemaOk = ((int)$pdo->query("SELECT v FROM schema_meta WHERE id = 1")->fetchColumn()) >= SCHEMA_VERSION;
} catch (Exception $e) {
    $schemaOk = false;   // table does not exist yet
}

if (!$schemaOk) {
    try {
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS is_alive TINYINT DEFAULT 1");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS target_id INT DEFAULT NULL");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS vote_id INT DEFAULT NULL");
        $pdo->exec("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS last_event VARCHAR(255) DEFAULT NULL");
        // Matchmaking + bot columns
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS is_bot TINYINT DEFAULT 0");
        $pdo->exec("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_match TINYINT DEFAULT 0");
        $pdo->exec("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS mm_deadline INT DEFAULT NULL");
        $pdo->exec("CREATE TABLE IF NOT EXISTS messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            room_code VARCHAR(10) NOT NULL,
            sender_name VARCHAR(50) NOT NULL,
            message TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )");
        // Human-like bot behaviour: bots arm a random "thinking" delay before
        // acting (bot_ready_at) and throttle their chat (bot_last_chat).
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS bot_ready_at INT DEFAULT NULL");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS bot_last_chat INT DEFAULT 0");
        // Presence tracking: last_seen (per player) + last_activity (per room) let
        // the reaper tell a live player from a ghost seat, and end games that every
        // human has walked away from (bots only act when a client polls, so a
        // deserted game would otherwise sit in night/day forever).
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS last_seen INT DEFAULT 0");
        $pdo->exec("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS last_activity INT DEFAULT 0");
        // Shared phase clocks: started_at = when the game began (anchors the
        // pre-night chat window), phase_started_at = when the current night/day
        // began. Both let every client derive the SAME timer from server time.
        $pdo->exec("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS started_at INT DEFAULT 0");
        $pdo->exec("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS phase_started_at INT DEFAULT 0");
        // Night skills (Seer / Doctor / Witch). Per-night choices are cleared each
        // night; the *_used flags are the once-per-game one-shots.
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS check_target INT DEFAULT NULL");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS seer_target INT DEFAULT NULL");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS seer_result VARCHAR(16) DEFAULT NULL");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS poison_target INT DEFAULT NULL");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS poison_skip TINYINT DEFAULT 0");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS poison_used TINYINT DEFAULT 0");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS revive_used TINYINT DEFAULT 0");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS doctor_choice TINYINT DEFAULT NULL");
        $pdo->exec("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS night_step VARCHAR(12) DEFAULT 'actions'");
        $pdo->exec("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS pending_victim INT DEFAULT NULL");
        $pdo->exec("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS night_deadline INT DEFAULT 0");
        // "Sleep" tap: everyone without a night action (villagers, the Doctor)
        // must tap sleep so the night's click-sounds are masked (voice-call safe).
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS asleep TINYINT DEFAULT 0");
        // Voice chat: voice_on flags who has joined the voice room, and
        // voice_signals relays WebRTC offer/answer/ICE between peers (the client
        // poll is the signalling channel — no extra server/socket needed).
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS voice_on TINYINT DEFAULT 0");
        // Day vote: vote_skip records an abstention ("Skip Vote"); last_vote
        // carries the resolved outcome (lynched / tie / skip) so the client can
        // play the vote-result cutscene.
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS vote_skip TINYINT DEFAULT 0");
        $pdo->exec("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS last_vote TEXT DEFAULT NULL");
        // --- Accounts ------------------------------------------------------
        $pdo->exec("CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(24) NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            display_name VARCHAR(24) DEFAULT NULL,
            status TINYINT DEFAULT 1,
            games INT DEFAULT 0,
            wins INT DEFAULT 0,
            rating INT DEFAULT 1000,
            peak_rating INT DEFAULT 1000,
            created_at INT DEFAULT 0,
            last_login_at INT DEFAULT 0,
            UNIQUE KEY uniq_username (username)
        )");
        $pdo->exec("CREATE TABLE IF NOT EXISTS auth_sessions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            token_hash CHAR(64) NOT NULL,
            created_at INT DEFAULT 0,
            expires_at INT DEFAULT 0,
            revoked_at INT DEFAULT 0,
            ip VARCHAR(45) DEFAULT NULL,
            UNIQUE KEY uniq_token (token_hash),
            INDEX idx_user (user_id)
        )");
        $pdo->exec("CREATE TABLE IF NOT EXISTS auth_attempts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(24) DEFAULT NULL,
            ip VARCHAR(45) DEFAULT NULL,
            ok TINYINT DEFAULT 0,
            created_at INT DEFAULT 0,
            INDEX idx_user_time (username, created_at)
        )");
        // players.user_id links a seat to an account (NULL = guest, no stats).
        // rating_delta/user_won are written at game end so the result screen can
        // show what the match did to your rank.
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS user_id INT DEFAULT NULL");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS rating_delta INT DEFAULT NULL");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS user_won TINYINT DEFAULT NULL");
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_players_user ON players (user_id)");
        // --- v5: passwordless email-code auth -------------------------------
        // email becomes the account identity; username is now a legacy column
        // (kept, relaxed, no longer unique) and password_hash is unused.
        $pdo->exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(190) DEFAULT NULL");
        $pdo->exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at INT DEFAULT 0");
        $pdo->exec("ALTER TABLE users MODIFY username VARCHAR(190) DEFAULT NULL");
        $pdo->exec("ALTER TABLE users MODIFY password_hash VARCHAR(255) DEFAULT NULL");
        try { $pdo->exec("ALTER TABLE users DROP INDEX uniq_username"); } catch (Exception $e) {}
        $hasEmailIdx = (int)$pdo->query("SELECT COUNT(*) FROM information_schema.STATISTICS
                                          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
                                            AND INDEX_NAME = 'uniq_email'")->fetchColumn();
        if ($hasEmailIdx === 0) $pdo->exec("CREATE UNIQUE INDEX uniq_email ON users (email)");
        // v6: the in-game handle lives on the ACCOUNT (not in browser storage).
        // Guests have no account, so their nickname is simply a fresh default
        // every time they load the page — nothing is persisted for them.
        $pdo->exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname VARCHAR(24) DEFAULT NULL");
        // v7: XP + levels. Level is DERIVED from xp (never stored) so the two can
        // never drift apart. players.xp_delta mirrors rating_delta so the result
        // screen can show "+50 XP" without another request.
        $pdo->exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INT DEFAULT 0");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS xp_delta INT DEFAULT NULL");
        // v8: avatars. Chosen from a fixed built-in set — no uploads means no file
        // storage, no image processing, and nothing to moderate (important on a
        // school site). Denormalised onto the seat so the hot poll needs no join.
        $pdo->exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar VARCHAR(24) DEFAULT NULL");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar VARCHAR(24) DEFAULT NULL");
        // v9: settlement stats for the end-of-match screen.
        //   wolf_votes    - times this seat's DAY vote landed on a werewolf
        //   special_kills - power roles (Seer/Witch/Doctor) this wolf's call killed
        //   winner        - 'villagers' | 'werewolves', so the client doesn't have
        //                   to parse the prose in last_event
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS wolf_votes INT DEFAULT 0");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS special_kills INT DEFAULT 0");
        $pdo->exec("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS winner VARCHAR(12) DEFAULT NULL");
        // v10: Chaos Night. rooms.mode defaults to 'classic', so every existing
        // room keeps the original rules. HP columns stay NULL in classic.
        // IMPORTANT: other players' HP must NEVER be sent to the client — only
        // my_hp for your own seat (and the Seer's one checked target) travels.
        $pdo->exec("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS mode VARCHAR(16) NOT NULL DEFAULT 'classic'");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS hp INT DEFAULT NULL");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS max_hp INT DEFAULT NULL");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS heal_target INT DEFAULT NULL");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS seer_hp INT DEFAULT NULL");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS hp_delta INT DEFAULT NULL");
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS damage_done INT DEFAULT 0");

        // v11: Chaos Night distrust — a PUBLIC standing meter. Unlike HP it is sent
        // to every client. Each day a seat's votes push it up by that vote's share
        // of the day's total; reaching 100% is the only way the day removes anyone.
        $pdo->exec("ALTER TABLE players ADD COLUMN IF NOT EXISTS distrust DECIMAL(6,2) NOT NULL DEFAULT 0");

        $pdo->exec("CREATE TABLE IF NOT EXISTS email_codes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(190) NOT NULL,
            code_hash CHAR(64) NOT NULL,
            purpose VARCHAR(16) DEFAULT 'login',
            attempts TINYINT DEFAULT 0,
            created_at INT DEFAULT 0,
            expires_at INT DEFAULT 0,
            used_at INT DEFAULT 0,
            INDEX idx_email_time (email, created_at)
        )");
        $pdo->exec("CREATE TABLE IF NOT EXISTS email_sends (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(190) DEFAULT NULL,
            ip VARCHAR(45) DEFAULT NULL,
            ok TINYINT DEFAULT 0,
            created_at INT DEFAULT 0,
            INDEX idx_email_time (email, created_at),
            INDEX idx_ip_time (ip, created_at)
        )");
        $pdo->exec("CREATE TABLE IF NOT EXISTS voice_signals (
            id INT AUTO_INCREMENT PRIMARY KEY,
            room_code VARCHAR(10) NOT NULL,
            from_id INT NOT NULL,
            to_id INT NOT NULL,
            kind VARCHAR(12) NOT NULL,
            payload TEXT,
            delivered TINYINT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_to (to_id, delivered)
        )");
        // Indexes the hot paths lean on. session_token had NO index, so every
        // "who am I?" lookup was a full table scan; messages/players reads want
        // the (room_code, id) order; the reaper scans last_activity.
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_players_token ON players (session_token)");
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_players_room_id ON players (room_code, id)");
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages (room_code, id)");
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_rooms_activity ON rooms (last_activity)");
        $pdo->exec("CREATE TABLE IF NOT EXISTS schema_meta (id TINYINT PRIMARY KEY, v INT NOT NULL)");
        $pdo->prepare("INSERT INTO schema_meta (id, v) VALUES (1, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)")
            ->execute([SCHEMA_VERSION]);
    } catch (Exception $e) {
        // Never fatal: a half-applied migration must not take the API down.
    }
}
