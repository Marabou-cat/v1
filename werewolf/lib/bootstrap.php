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
const SCHEMA_VERSION = 3;

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
