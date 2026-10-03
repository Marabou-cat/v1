<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$configFile = __DIR__ . '/../config.ini';
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
} catch (Exception $e) {}

function calculateRoles($playerCount) {
    if ($playerCount < 4) return null;
    $werewolves = 1 + (int)floor(($playerCount - 4) / 3);
    $specials = ($playerCount === 4) ? 0 : (int)floor(($playerCount - 3) / 2);
    $villagers = $playerCount - ($werewolves + $specials);

    $specialPool = ['Seer', 'Doctor', 'Witch', 'Hunter', 'Cupid'];
    $assignedSpecials = array_slice($specialPool, 0, $specials);

    return [
        "werewolves" => $werewolves,
        "specials" => $specials,
        "special_cards" => $assignedSpecials,
        "villagers" => $villagers
    ];
}

/* ================= MATCHMAKING + BOTS ================= */
const MATCH_WAIT_SECONDS = 30;

// Top-level (global) pool of bot nicknames. Helper functions below must pull
// it in with `global $BOT_NAMES;` — PHP functions do NOT see top-level vars
// automatically (referencing it without `global` yields null).
// Names are deliberately realistic / human-sounding (casual gamer handles),
// so AI fillers are indistinguishable from real players.
$BOT_NAMES = [
    'Mia Chen', 'Leo Park', 'Sofia', 'Jack', 'Emma', 'Lucas', 'Ava', 'Noah',
    'Mason', 'Isabella', 'Ethan', 'Olivia', 'Liam', 'Sophia', 'Mateo', 'Aria',
    'Kai', 'Nina', 'Diego', 'Chloe', 'Ryan', 'Ella', 'Max', 'Lena',
    'Theo', 'Ivy', 'Owen', 'Ruby', 'Felix', 'Hana', 'Marco', 'Priya',
    'Dylan', 'Grace', 'Oscar', 'Lily', 'Victor', 'Maya', 'Andre', 'Tara',
    'Sam', 'Nora', 'Cole', 'Iris', 'Ezra', 'Dana', 'Rex', 'Bella',
    'Nico', 'Faye', 'Gus', 'Ivy Rose', 'Jude', 'Kira', 'Luca', 'Mila'
];

// Add a single AI player to a lobby room. Returns the bot row or null.
function addBot(PDO $pdo, $roomCode) {
    global $BOT_NAMES;
    $stmt = $pdo->prepare("SELECT nickname FROM players WHERE room_code = ?");
    $stmt->execute([$roomCode]);
    $used = $stmt->fetchAll(PDO::FETCH_COLUMN);
    $name = null;
    $guard = 0;
    do {
        $name = $BOT_NAMES[array_rand($BOT_NAMES)];
    } while (in_array($name, $used, true) && $guard++ < 100);

    $stmt = $pdo->prepare("INSERT INTO players (room_code, session_token, nickname, is_alive, is_bot) VALUES (?, ?, ?, 1, 1)");
    $stmt->execute([$roomCode, 'bot_' . bin2hex(random_bytes(8)), $name]);
    $id = (int)$pdo->lastInsertId();
    $stmt = $pdo->prepare("SELECT * FROM players WHERE id = ?");
    $stmt->execute([$id]);
    return $stmt->fetch();
}

// If a matchmade lobby is past its 30s deadline and not full, fill with bots.
// The count is re-read on EVERY iteration so two concurrent polls (two humans
// in one match) can't both top up from a stale count and double-fill the room.
function fillBotsIfNeeded(PDO $pdo, $room) {
    if (empty($room['is_match']) || $room['status'] !== 'lobby') return;
    $deadline = (int)($room['mm_deadline'] ?? 0);
    if ($deadline <= 0 || time() < $deadline) return;

    for (;;) {
        $stmt = $pdo->prepare("SELECT COUNT(*) AS c FROM players WHERE room_code = ?");
        $stmt->execute([$room['room_code']]);
        if ((int)$stmt->fetch()['c'] >= (int)$room['max_players']) break;
        addBot($pdo, $room['room_code']);
    }
}

/* ================= PRESENCE + STALE-ROOM REAPING ================= */

// How long a human may go without polling before we treat them as gone
// (tab closed / phone locked). Comfortably above the ~1.5s client poll.
const PLAYER_TIMEOUT = 45;
// A live game whose room has had no client poll for this long is abandoned:
// bots only move when a client polls, so without this the game would freeze in
// night/day for hours (the "ran for 2h and never ended" report).
const GAME_TIMEOUT = 150;
// Finished rooms older than this are deleted so the table can't grow forever.
const ENDED_TTL = 1800;
// Max time the night "actions" step waits for everyone (wolves/Seer/Witch).
// On expiry the night force-resolves so an AFK player can't stall the game.
const NIGHT_SECONDS = 35;
// Extra window for the Doctor's revive decision (generous: the 15s pre-night
// chat overlaps the start of the night, so the prompt may only appear later).
const DOCTOR_SECONDS = 25;

// Stamp a room (and optionally one player) as "seen just now". Called from
// every poll/action so the reaper can tell a live participant from a ghost.
function touchPresence(PDO $pdo, $roomCode, $token = '') {
    if ($roomCode === '') return;
    $now = time();
    try {
        $pdo->prepare("UPDATE rooms SET last_activity = ? WHERE room_code = ?")->execute([$now, $roomCode]);
        if ($token !== '') {
            $pdo->prepare("UPDATE players SET last_seen = ? WHERE room_code = ? AND session_token = ?")->execute([$now, $roomCode, $token]);
        }
    } catch (Exception $e) {}
}

// Sweep away dead weight. Without this the rooms table grows forever AND
// matchmaking keeps pairing new players with long-abandoned "ghost" lobbies
// (they look populated, but every seat belongs to someone who closed the tab),
// which is what made "Find Match" look broken and kept offering non-existent
// rooms. Cheap enough to run on a short throttle from the poll path.
function reapStaleRooms(PDO $pdo) {
    $now = time();
    try {
        // 1) Ghost humans sitting in a lobby (stopped polling).
        $pdo->prepare("DELETE p FROM players p JOIN rooms r ON r.room_code = p.room_code
                        WHERE p.is_bot = 0 AND r.status = 'lobby' AND p.last_seen < ?")
            ->execute([$now - PLAYER_TIMEOUT]);

        // 2) End lobbies that no longer hold a single human.
        $pdo->prepare("UPDATE rooms SET status = 'ended', last_event = 'This lobby was abandoned.', last_activity = ?
                        WHERE status = 'lobby'
                          AND room_code NOT IN (SELECT room_code FROM (SELECT DISTINCT room_code FROM players WHERE is_bot = 0) h)")
            ->execute([$now]);

        // 3) Force-end live games every human has walked away from.
        $pdo->prepare("UPDATE rooms SET status = 'ended', last_event = 'This game was abandoned by its players.', last_activity = ?
                        WHERE status IN ('night','day') AND last_activity < ?")
            ->execute([$now, $now - GAME_TIMEOUT]);

        // 4) Delete long-finished rooms + any orphaned player rows.
        $pdo->prepare("DELETE FROM rooms WHERE status = 'ended' AND last_activity < ?")->execute([$now - ENDED_TTL]);
        $pdo->prepare("DELETE FROM players WHERE room_code NOT IN (SELECT room_code FROM rooms)")->execute();
    } catch (Exception $e) {}
}

// Run the reaper at most once every 20s (the poll path fires every ~1.5s).
function maybeReap(PDO $pdo) {
    $marker = sys_get_temp_dir() . '/wolf_last_reap';
    $last = @filemtime($marker) ?: 0;
    if (time() - $last < 20) return;
    @touch($marker);
    reapStaleRooms($pdo);
}

// Deal cards and flip a full room into the night phase (shared by manual
// start and the matchmaker auto-start).
//
// The claim AND the whole deal run in ONE transaction. The claim's UPDATE
// takes a row lock on the rooms row, so a concurrent poll that loses the
// claim BLOCKS until the winner's deal has committed — which guarantees the
// loser can never read a pre-deal "all unassigned" snapshot and falsely
// declare a winner (the old 0-werewolf race).
function beginGame(PDO $pdo, $roomCode) {
    $pdo->beginTransaction();
    try {
        $claim = $pdo->prepare("UPDATE rooms SET status = 'night' WHERE room_code = ? AND status = 'lobby'");
        $claim->execute([$roomCode]);
        if ((int)$claim->rowCount() === 0) {
            $pdo->rollBack();
            return; // already started by another poll (its deal is committed)
        }

        $stmt = $pdo->prepare("SELECT id FROM players WHERE room_code = ? ORDER BY id ASC");
        $stmt->execute([$roomCode]);
        $players = $stmt->fetchAll();
        $total = count($players);

        $breakdown = calculateRoles($total);
        if ($breakdown === null || $total < 4) {
            $pdo->rollBack();
            return;
        }
        $deck = array_fill(0, $breakdown['werewolves'], 'Werewolf');
        foreach ($breakdown['special_cards'] as $card) {
            $deck[] = $card;
        }
        while (count($deck) < $total) {
            $deck[] = 'Villager';
        }
        shuffle($deck);

        foreach ($players as $index => $player) {
            // bot_ready_at is reset to NULL so each bot re-arms its own random
            // "thinking" delay on the very first night (see processNightBots).
            $stmt = $pdo->prepare("UPDATE players SET role = ?, is_alive = 1, target_id = NULL, vote_id = NULL, bot_ready_at = NULL WHERE id = ?");
            $stmt->execute([$deck[$index], $player['id']]);
        }

        $now = time();
        $stmt = $pdo->prepare("UPDATE rooms SET status = 'night', last_event = 'Night falls upon the village...', started_at = ?, phase_started_at = ? WHERE room_code = ?");
        $stmt->execute([$now, $now, $roomCode]);
        // Arm the first night's skill state (clears per-night fields, sets deadline).
        resetNightState($pdo, $roomCode);

        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        throw $e;
    }
}

// Night AI: every alive bot acts with a random 2-8s "thinking" delay so the
// actions trickle in like real players. Wolves lock a victim (preferring a
// non-werewolf), the Seer divines a random player, the Witch may spend her
// one poison (or pass). Does NOT resolve the phase — advanceNight() does that.
function processNightBots(PDO $pdo, $roomCode) {
    $now = time();
    $stmt = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND is_bot = 1 AND is_alive = 1");
    $stmt->execute([$roomCode]);
    $bots = $stmt->fetchAll();
    if (count($bots) === 0) return;

    foreach ($bots as $bot) {
        $role = $bot['role'];
        if ($role === 'Werewolf') {
            if ($bot['target_id'] !== null) continue;
        } elseif ($role === 'Seer') {
            if ($bot['check_target'] !== null) continue;
        } elseif ($role === 'Witch') {
            if ((int)$bot['poison_used'] || $bot['poison_target'] !== null || (int)$bot['poison_skip']) continue;
        } else {
            continue;
        }

        // Arm / wait out this bot's personal "thinking" delay.
        if (empty($bot['bot_ready_at'])) {
            $pdo->prepare("UPDATE players SET bot_ready_at = ? WHERE id = ?")->execute([$now + random_int(2, 8), $bot['id']]);
            continue;
        }
        if ($now < (int)$bot['bot_ready_at']) continue;

        if ($role === 'Werewolf') {
            $s = $pdo->prepare("SELECT id FROM players WHERE room_code = ? AND is_alive = 1 AND id != ? AND role != 'Werewolf'");
            $s->execute([$roomCode, $bot['id']]);
            $options = $s->fetchAll(PDO::FETCH_COLUMN);
            if (count($options) === 0) {
                $s = $pdo->prepare("SELECT id FROM players WHERE room_code = ? AND is_alive = 1 AND id != ?");
                $s->execute([$roomCode, $bot['id']]);
                $options = $s->fetchAll(PDO::FETCH_COLUMN);
            }
            if (count($options) === 0) continue;
            $victim = $options[array_rand($options)];
            $pdo->prepare("UPDATE players SET target_id = ? WHERE id = ?")->execute([$victim, $bot['id']]);
        } elseif ($role === 'Seer') {
            $s = $pdo->prepare("SELECT id, role FROM players WHERE room_code = ? AND is_alive = 1 AND id != ?");
            $s->execute([$roomCode, $bot['id']]);
            $options = $s->fetchAll();
            if (count($options) === 0) continue;
            $pick = $options[array_rand($options)];
            $res = ($pick['role'] === 'Werewolf') ? 'wolf' : 'good';
            $pdo->prepare("UPDATE players SET check_target = ?, seer_target = ?, seer_result = ? WHERE id = ?")
                ->execute([$pick['id'], $pick['id'], $res, $bot['id']]);
        } elseif ($role === 'Witch') {
            $s = $pdo->prepare("SELECT id FROM players WHERE room_code = ? AND is_alive = 1 AND id != ?");
            $s->execute([$roomCode, $bot['id']]);
            $options = $s->fetchAll(PDO::FETCH_COLUMN);
            if (count($options) > 0 && random_int(1, 100) <= 35) {
                $pick = $options[array_rand($options)];
                $pdo->prepare("UPDATE players SET poison_target = ? WHERE id = ?")->execute([$pick, $bot['id']]);
            } else {
                $pdo->prepare("UPDATE players SET poison_skip = 1 WHERE id = ?")->execute([$bot['id']]);
            }
        }
    }
}

// Doctor bot: in the doctor step, decide after a short delay (70% revive).
function processDoctorBot(PDO $pdo, $roomCode) {
    $s = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND role = 'Doctor' AND is_alive = 1 AND is_bot = 1");
    $s->execute([$roomCode]);
    $doc = $s->fetch();
    if (!$doc || $doc['doctor_choice'] !== null) return;

    $now = time();
    if (empty($doc['bot_ready_at'])) {
        $pdo->prepare("UPDATE players SET bot_ready_at = ? WHERE id = ?")->execute([$now + random_int(3, 9), $doc['id']]);
        return;
    }
    if ($now < (int)$doc['bot_ready_at']) return;

    $choice = (random_int(1, 100) <= 70) ? 1 : 0;
    $pdo->prepare("UPDATE players SET doctor_choice = ? WHERE id = ?")->execute([$choice, $doc['id']]);
}

// Make every alive bot cast a day vote (random living player, never itself).
// Each bot "thinks" for a random 2-8s so the votes trickle in naturally.
function processDayBots(PDO $pdo, $roomCode) {
    $now = time();
    $stmt = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND is_bot = 1 AND is_alive = 1");
    $stmt->execute([$roomCode]);
    $bots = $stmt->fetchAll();
    if (count($bots) === 0) return;

    $stmt = $pdo->prepare("SELECT id FROM players WHERE room_code = ? AND is_alive = 1");
    $stmt->execute([$roomCode]);
    $aliveIds = $stmt->fetchAll(PDO::FETCH_COLUMN);
    if (count($aliveIds) === 0) return;

    foreach ($bots as $bot) {
        if ($bot['vote_id'] !== null) continue;

        // Arm this bot's "thinking" delay once; on later polls just wait for
        // it to elapse (never reset the clock mid-phase).
        if (empty($bot['bot_ready_at'])) {
            $readyAt = $now + random_int(2, 8);
            $pdo->prepare("UPDATE players SET bot_ready_at = ? WHERE id = ?")->execute([$readyAt, $bot['id']]);
            if ($now < $readyAt) continue;
        } elseif ($now < (int)$bot['bot_ready_at']) {
            continue;
        }

        $options = array_values(array_diff($aliveIds, [$bot['id']]));
        if (count($options) === 0) continue;
        $target = $options[array_rand($options)];
        $pdo->prepare("UPDATE players SET vote_id = ? WHERE id = ?")->execute([$target, $bot['id']]);
    }
}

// Casual lines a bot might drop in room chat, so the table feels alive.
const BOT_CHAT_LINES = [
    'gg last night was wild', 'who do yall think it is?', 'i really trust my gut on this one',
    'no way that was a coincidence', 'my role is strong, i promise', 'someone is lying to us',
    'i will not be the one to get it next', 'this is getting close', 'ok my turn to talk',
    'brb my cat jumped on the keyboard', 'trust me, vote with me this time',
    'the seer should speak up already', 'i felt something off about that vote',
    'not dead yet, keep it coming', 'my hands are literally shaking rn',
    'if i were you i would check that person', 'classic play', 'lets keep the momentum',
    'i have a theory but i need one more day', 'the wolf is trying to bait us',
];

// Occasionally have a living bot post a short chat line (throttled per bot so
// it reads like a person, not a script). No-op when there is no one to talk.
function botChat(PDO $pdo, $roomCode, array $players) {
    $now = time();
    $candidates = array_values(array_filter($players, function ($p) use ($now) {
        return (int)$p['is_bot'] === 1 && (int)$p['is_alive'] === 1
            && ($now - (int)($p['bot_last_chat'] ?? 0)) >= 12;
    }));
    if (count($candidates) === 0) return;
    if (random_int(1, 100) > 30) return; // ~30% of polls a bot says something

    $bot = $candidates[array_rand($candidates)];
    $line = BOT_CHAT_LINES[array_rand(BOT_CHAT_LINES)];
    $pdo->prepare("UPDATE players SET bot_last_chat = ? WHERE id = ?")->execute([$now, $bot['id']]);
    $pdo->prepare("INSERT INTO messages (room_code, sender_name, message) VALUES (?, ?, ?)")
        ->execute([$roomCode, $bot['nickname'], htmlspecialchars($line)]);
}

// Clear the per-night action state (called the moment night begins).
function resetNightState(PDO $pdo, $roomCode) {
    $pdo->prepare("UPDATE players SET target_id = NULL, check_target = NULL, poison_target = NULL, poison_skip = 0, doctor_choice = NULL WHERE room_code = ?")
        ->execute([$roomCode]);
    $pdo->prepare("UPDATE rooms SET night_step = 'actions', pending_victim = NULL, night_deadline = ? WHERE room_code = ?")
        ->execute([time() + NIGHT_SECONDS, $roomCode]);
}

// Has every night actor finished? Alive wolves must have locked a victim,
// an alive Seer must have divined, an alive Witch must have spent or passed
// her poison. (Bots are filled in by processNightBots first.)
function nightActionsComplete(PDO $pdo, $roomCode) {
    $s = $pdo->prepare("SELECT role, target_id, check_target, poison_target, poison_skip, poison_used
                          FROM players WHERE room_code = ? AND is_alive = 1");
    $s->execute([$roomCode]);
    foreach ($s->fetchAll() as $p) {
        if ($p['role'] === 'Werewolf' && $p['target_id'] === null) return false;
        if ($p['role'] === 'Seer' && $p['check_target'] === null) return false;
        if ($p['role'] === 'Witch' && !(int)$p['poison_used'] && $p['poison_target'] === null && !(int)$p['poison_skip']) return false;
    }
    return true;
}

// The werewolves' majority victim among targets that are still alive (null if none).
function computeWolfVictim(PDO $pdo, $roomCode) {
    $s = $pdo->prepare("SELECT target_id FROM players WHERE room_code = ? AND role = 'Werewolf' AND is_alive = 1 AND target_id IS NOT NULL");
    $s->execute([$roomCode]);
    $targets = $s->fetchAll(PDO::FETCH_COLUMN);
    if (count($targets) === 0) return null;

    $a = $pdo->prepare("SELECT id FROM players WHERE room_code = ? AND is_alive = 1");
    $a->execute([$roomCode]);
    $alive = array_flip($a->fetchAll(PDO::FETCH_COLUMN));

    $counts = [];
    foreach ($targets as $id) { $counts[$id] = ($counts[$id] ?? 0) + 1; }
    $best = null; $bestN = 0;
    foreach ($counts as $id => $n) {
        if (!isset($alive[$id])) continue;
        if ($n > $bestN) { $bestN = $n; $best = (int)$id; }
    }
    return $best;
}

// Drive the night forward (called from poll_game while status == 'night').
// Step order: 'actions' (wolves + Seer + Witch) → 'doctor' (revive window) →
// finalize. Returns true if the phase advanced to day.
function advanceNight(PDO $pdo, $roomCode) {
    $now = time();
    $r = $pdo->prepare("SELECT status, night_step, night_deadline FROM rooms WHERE room_code = ?");
    $r->execute([$roomCode]);
    $room = $r->fetch();
    if (!$room || $room['status'] !== 'night') return false;

    // ---- Doctor step: waiting on the revive decision ----
    if ($room['night_step'] === 'doctor') {
        processDoctorBot($pdo, $roomCode);
        $d = $pdo->prepare("SELECT doctor_choice FROM players WHERE room_code = ? AND role = 'Doctor' AND is_alive = 1");
        $d->execute([$roomCode]);
        $doc = $d->fetch();
        $decided = (!$doc) || ($doc['doctor_choice'] !== null);
        if ($decided || $now >= (int)$room['night_deadline']) {
            return finalizeNight($pdo, $roomCode);
        }
        return false;
    }

    // ---- Actions step ----
    processNightBots($pdo, $roomCode);
    $timedOut = ($now >= (int)$room['night_deadline']);
    if (!nightActionsComplete($pdo, $roomCode) && !$timedOut) return false;

    // Timeout safety: give any silent wolf a random target so the night still
    // resolves (an AFK werewolf must not stall the game forever).
    if ($timedOut) {
        $ws = $pdo->prepare("SELECT id FROM players WHERE room_code = ? AND role = 'Werewolf' AND is_alive = 1 AND target_id IS NULL");
        $ws->execute([$roomCode]);
        foreach ($ws->fetchAll(PDO::FETCH_COLUMN) as $wid) {
            $o = $pdo->prepare("SELECT id FROM players WHERE room_code = ? AND is_alive = 1 AND id != ? ORDER BY RAND() LIMIT 1");
            $o->execute([$roomCode, $wid]);
            $tid = $o->fetchColumn();
            if ($tid) $pdo->prepare("UPDATE players SET target_id = ? WHERE id = ?")->execute([$tid, $wid]);
        }
    }

    $victimId = computeWolfVictim($pdo, $roomCode);

    // If a living Doctor still holds their revive, hand them the victim first.
    $d = $pdo->prepare("SELECT id FROM players WHERE room_code = ? AND role = 'Doctor' AND is_alive = 1 AND revive_used = 0 LIMIT 1");
    $d->execute([$roomCode]);
    $hasDoctor = (bool)$d->fetch();

    if ($victimId && $hasDoctor) {
        $pdo->prepare("UPDATE rooms SET night_step = 'doctor', pending_victim = ?, night_deadline = ? WHERE room_code = ?")
            ->execute([$victimId, $now + DOCTOR_SECONDS, $roomCode]);
        return false; // wait for the Doctor's revive decision
    }

    return finalizeNight($pdo, $roomCode);
}

// Apply the night's deaths (werewolf victim unless revived + Witch poison),
// write the narrative, clear all per-night state and flip to day.
function finalizeNight(PDO $pdo, $roomCode) {
    $now = time();
    $r = $pdo->prepare("SELECT pending_victim FROM rooms WHERE room_code = ?");
    $r->execute([$roomCode]);
    $row = $r->fetch();
    $victimId = $row ? (int)$row['pending_victim'] : 0;

    // Doctor revive — the once-per-game one-shot.
    $revived = false;
    $docId = 0;
    if ($victimId) {
        $d = $pdo->prepare("SELECT id, doctor_choice, revive_used FROM players WHERE room_code = ? AND role = 'Doctor' AND is_alive = 1");
        $d->execute([$roomCode]);
        $doc = $d->fetch();
        if ($doc && (int)$doc['doctor_choice'] === 1 && !(int)$doc['revive_used']) {
            $revived = true;
            $docId = (int)$doc['id'];
        }
    }

    $deaths = [];
    if ($victimId && !$revived) $deaths[$victimId] = true;

    // Witch poison (one-shot; spent once applied).
    $poisonId = 0;
    $w = $pdo->prepare("SELECT id, poison_target, poison_used FROM players WHERE room_code = ? AND role = 'Witch' AND poison_target IS NOT NULL LIMIT 1");
    $w->execute([$roomCode]);
    $witch = $w->fetch();
    if ($witch && !(int)$witch['poison_used'] && (int)$witch['poison_target'] > 0) {
        $poisonId = (int)$witch['poison_target'];
        $deaths[$poisonId] = true;
        $pdo->prepare("UPDATE players SET poison_used = 1 WHERE id = ?")->execute([$witch['id']]);
    }

    $nameOf = function ($id) use ($pdo, $roomCode) {
        $s = $pdo->prepare("SELECT nickname FROM players WHERE id = ? AND room_code = ?");
        $s->execute([$id, $roomCode]);
        $x = $s->fetch();
        return $x ? $x['nickname'] : 'Someone';
    };

    foreach (array_keys($deaths) as $id) {
        $pdo->prepare("UPDATE players SET is_alive = 0 WHERE id = ? AND room_code = ?")->execute([$id, $roomCode]);
    }
    if ($revived && $docId) {
        $pdo->prepare("UPDATE players SET revive_used = 1 WHERE id = ?")->execute([$docId]);
    }

    // Narrative
    $parts = [];
    if ($victimId) {
        $vn = $nameOf($victimId);
        $parts[] = $revived
            ? "During the night, the werewolves attacked **{$vn}**, but the Doctor saved them!"
            : "During the night, the werewolves attacked and killed **{$vn}**!";
    } else {
        $parts[] = "The night passed quietly — nobody was attacked.";
    }
    if ($poisonId) $parts[] = "**" . $nameOf($poisonId) . "** was found dead, poisoned!";
    $event = implode(' ', $parts);

    // Clear per-night state and flip to day.
    $pdo->prepare("UPDATE players SET target_id = NULL, check_target = NULL, poison_target = NULL, poison_skip = 0, doctor_choice = NULL, bot_ready_at = NULL WHERE room_code = ?")
        ->execute([$roomCode]);
    $pdo->prepare("UPDATE rooms SET status = 'day', phase_started_at = ?, night_step = 'actions', pending_victim = NULL, night_deadline = 0, last_event = ? WHERE room_code = ?")
        ->execute([$now, $event, $roomCode]);
    return true;
}

// Resolve the day: every alive player has voted -> lynch the top target,
// wipe votes, flip to night. Returns true if the phase advanced.
function resolveDay(PDO $pdo, $roomCode) {
    $stmt = $pdo->prepare("SELECT id, vote_id FROM players WHERE room_code = ? AND is_alive = 1");
    $stmt->execute([$roomCode]);
    $living = $stmt->fetchAll();
    if (count($living) === 0) return false;

    $voteCounts = [];
    foreach ($living as $p) {
        if ($p['vote_id'] === null) return false; // someone has not voted yet
        $voteCounts[$p['vote_id']] = ($voteCounts[$p['vote_id']] ?? 0) + 1;
    }

    arsort($voteCounts);
    $lynchedId = array_key_first($voteCounts);

    $pdo->prepare("UPDATE players SET is_alive = 0 WHERE id = ?")->execute([$lynchedId]);

    $stmt = $pdo->prepare("SELECT nickname, role FROM players WHERE id = ?");
    $stmt->execute([$lynchedId]);
    $lynched = $stmt->fetch();
    $lynchedName = $lynched ? $lynched['nickname'] : 'Someone';
    $lynchedRole = $lynched ? $lynched['role'] : 'Villager';

    $pdo->prepare("UPDATE players SET vote_id = NULL WHERE room_code = ?")->execute([$roomCode]);
    // New night: reset bot "thinking" timers so kills land at varying times.
    $pdo->prepare("UPDATE players SET bot_ready_at = NULL WHERE room_code = ? AND is_bot = 1")->execute([$roomCode]);
    $pdo->prepare("UPDATE rooms SET status = 'night', phase_started_at = ?, last_event = ? WHERE room_code = ?")
        ->execute([time(), "The village voted and lynched **{$lynchedName}**. They were a **{$lynchedRole}**! Night falls again...", $roomCode]);
    // Arm the new night's skill state.
    resetNightState($pdo, $roomCode);
    return true;
}

$action = $_POST['action'] ?? $_GET['action'] ?? '';

try {
switch ($action) {

    case 'create_room':
        $nickname = trim($_POST['nickname'] ?? 'Host');
        $maxPlayers = (int)($_POST['max_players'] ?? 4);

        if ($maxPlayers < 4) {
            echo json_encode(["status" => "error", "message" => "Room must allow at least 4 players.", "cutscene" => "scene_error"]);
            exit;
        }

        $roomCode = strtoupper(substr(bin2hex(random_bytes(3)), 0, 5));
        $sessionToken = bin2hex(random_bytes(16));

        $stmt = $pdo->prepare("INSERT INTO rooms (room_code, host_token, max_players, status) VALUES (?, ?, ?, 'lobby')");
        $stmt->execute([$roomCode, $sessionToken, $maxPlayers]);

        $stmt = $pdo->prepare("INSERT INTO players (room_code, session_token, nickname, is_alive) VALUES (?, ?, ?, 1)");
        $stmt->execute([$roomCode, $sessionToken, $nickname]);
        touchPresence($pdo, $roomCode, $sessionToken);

        echo json_encode([
            "status" => "success",
            "room_code" => $roomCode,
            "token" => $sessionToken,
            "max_players" => $maxPlayers,
            "message" => "Room created! Share your code.",
            "cutscene" => "scene_room_created"
        ]);
        break;

    case 'matchmake':
        $nickname = trim($_POST['nickname'] ?? 'Player');
        $count = (int)($_POST['count'] ?? 0);

        if ($count < 4 || $count > 10) {
            echo json_encode(["status" => "error", "message" => "Choose 4 to 10 players."]);
            exit;
        }

        // Clear out dead lobbies first so we never match into a ghost room.
        reapStaleRooms($pdo);

        // 1) Join an existing matchmade lobby that wants exactly this count AND
        //    actually has a live human waiting (last_seen recent). Rooms whose
        //    only occupants closed the tab are skipped — that is what used to
        //    match two live players into different abandoned rooms.
        $stmt = $pdo->prepare("SELECT r.* FROM rooms r
            WHERE r.is_match = 1 AND r.status = 'lobby' AND r.max_players = ?
              AND EXISTS (SELECT 1 FROM players p
                          WHERE p.room_code = r.room_code AND p.is_bot = 0 AND p.last_seen >= ?)
            ORDER BY r.created_at ASC");
        $stmt->execute([$count, time() - PLAYER_TIMEOUT]);
        $candidates = $stmt->fetchAll();

        foreach ($candidates as $room) {
            $stmt = $pdo->prepare("SELECT COUNT(*) AS c FROM players WHERE room_code = ?");
            $stmt->execute([$room['room_code']]);
            $c = (int)$stmt->fetch()['c'];
            if ($c >= (int)$room['max_players']) continue;

            // Defensive: clear any stale same-nickname seat so a player can't
            // duplicate themselves when re-queueing.
            $pdo->prepare("DELETE FROM players WHERE room_code = ? AND nickname = ?")->execute([$room['room_code'], $nickname]);

            $sessionToken = bin2hex(random_bytes(16));
            $stmt = $pdo->prepare("INSERT INTO players (room_code, session_token, nickname, is_alive) VALUES (?, ?, ?, 1)");
            $stmt->execute([$room['room_code'], $sessionToken, $nickname]);
            touchPresence($pdo, $room['room_code'], $sessionToken);

            echo json_encode([
                "status" => "success",
                "joined" => true,
                "room_code" => $room['room_code'],
                "token" => $sessionToken,
                "max_players" => (int)$room['max_players'],
                "server_now" => time(),
                "mm_started_at" => max(0, (int)$room['mm_deadline'] - MATCH_WAIT_SECONDS),
                "message" => "Matched with a waiting lobby!",
                "cutscene" => "scene_door_open"
            ]);
            exit;
        }

        // 2) Nobody waiting at this size: note the nearest busy size so the
        //    client can offer a quick switch. Only sizes with a live human
        //    count — otherwise we'd dangle a non-existent room in front of the
        //    player ("a 10-player lobby is waiting" that is actually empty).
        $stmt = $pdo->prepare("SELECT r.max_players FROM rooms r
            WHERE r.is_match = 1 AND r.status = 'lobby'
              AND EXISTS (SELECT 1 FROM players p
                          WHERE p.room_code = r.room_code AND p.is_bot = 0 AND p.last_seen >= ?)
            GROUP BY r.max_players");
        $stmt->execute([time() - PLAYER_TIMEOUT]);
        $busySizes = $stmt->fetchAll(PDO::FETCH_COLUMN);
        $suggest = null;
        $best = PHP_INT_MAX;
        foreach ($busySizes as $mp) {
            $diff = abs((int)$mp - $count);
            if ($diff < $best) { $best = $diff; $suggest = (int)$mp; }
        }

        // 3) Create a fresh matchmade room with a 30s fill deadline.
        $roomCode = strtoupper(substr(bin2hex(random_bytes(3)), 0, 5));
        $sessionToken = bin2hex(random_bytes(16));
        // One timestamp drives both the deadline and the shared match clock, so
        // a joiner (mm_deadline - MATCH_WAIT_SECONDS) and the creator always
        // agree on when the queue started.
        $mmStartedAt = time();

        $stmt = $pdo->prepare("INSERT INTO rooms (room_code, host_token, max_players, status, is_match, mm_deadline) VALUES (?, ?, ?, 'lobby', 1, ?)");
        $stmt->execute([$roomCode, $sessionToken, $count, $mmStartedAt + MATCH_WAIT_SECONDS]);

        $stmt = $pdo->prepare("INSERT INTO players (room_code, session_token, nickname, is_alive) VALUES (?, ?, ?, 1)");
        $stmt->execute([$roomCode, $sessionToken, $nickname]);
        touchPresence($pdo, $roomCode, $sessionToken);

        $payload = [
            "status" => "success",
            "joined" => false,
            "created" => true,
            "room_code" => $roomCode,
            "token" => $sessionToken,
            "max_players" => $count,
            "mm_wait_seconds" => MATCH_WAIT_SECONDS,
            "message" => "No open lobby for " . $count . " players. You are first — waiting for others (bots fill the room if it is not full in " . MATCH_WAIT_SECONDS . "s)."
        ];
        if ($suggest !== null && $suggest !== $count) {
            $payload["suggest_count"] = $suggest;
        }
        $payload["server_now"] = time();
        $payload["mm_started_at"] = $mmStartedAt;
        echo json_encode($payload);
        break;

    case 'join_room':
        $nickname = trim($_POST['nickname'] ?? 'Villager');
        $roomCode = strtoupper(trim($_POST['room_code'] ?? ''));

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room) {
            echo json_encode(["status" => "error", "message" => "Room code not found.", "cutscene" => "scene_error"]);
            exit;
        }

        if ($room['status'] !== 'lobby') {
            echo json_encode(["status" => "error", "message" => "Game is already in progress.", "cutscene" => "scene_error"]);
            exit;
        }

        $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM players WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $currentPlayers = $stmt->fetch()['count'];

        if ($currentPlayers >= $room['max_players']) {
            echo json_encode(["status" => "error", "message" => "Room is full!", "cutscene" => "scene_error"]);
            exit;
        }

        $sessionToken = bin2hex(random_bytes(16));

        // Defensive: drop any stale leftover entry with the same nickname in
        // this lobby (e.g. a previous session that crashed before leaving),
        // so a player can never "duplicate" themselves by rejoining.
        if ($room['status'] === 'lobby') {
            $stmt = $pdo->prepare("DELETE FROM players WHERE room_code = ? AND nickname = ?");
            $stmt->execute([$roomCode, $nickname]);
        }

        $stmt = $pdo->prepare("INSERT INTO players (room_code, session_token, nickname, is_alive) VALUES (?, ?, ?, 1)");
        $stmt->execute([$roomCode, $sessionToken, $nickname]);
        touchPresence($pdo, $roomCode, $sessionToken);

        echo json_encode([
            "status" => "success",
            "room_code" => $roomCode,
            "token" => $sessionToken,
            "message" => "Welcome to the village!",
            "cutscene" => "scene_door_open"
        ]);
        break;

    case 'leave_room':
        $roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');

        if ($roomCode === '' || $token === '') {
            echo json_encode(["status" => "success", "message" => "Nothing to leave."]);
            exit;
        }

        $stmt = $pdo->prepare("SELECT id, room_code, role, is_bot, is_alive FROM players WHERE room_code = ? AND session_token = ?");
        $stmt->execute([$roomCode, $token]);
        $me = $stmt->fetch();

        if ($me) {
            // Remove this player's chat so the room history stays clean.
            $stmt = $pdo->prepare("DELETE FROM messages WHERE room_code = ? AND sender_name = (SELECT nickname FROM players WHERE id = ?)");
            $stmt->execute([$me['room_code'], $me['id']]);

            // Remove the player itself.
            $stmt = $pdo->prepare("DELETE FROM players WHERE id = ?");
            $stmt->execute([$me['id']]);

            // Keep a full, balanced table: if a LIVING player leaves
            // mid-game, seat a bot with the SAME role in their place. This
            // is what stops the "no werewolf left / unbalanced" tables —
            // e.g. a human werewolf quitting no longer leaves a 0-wolf room
            // that instantly ends "Villagers win".
            if ((int)$me['is_bot'] === 0 && (int)$me['is_alive'] === 1) {
                $ri = $pdo->prepare("SELECT status FROM rooms WHERE room_code = ?");
                $ri->execute([$roomCode]);
                $roomInfo = $ri->fetch();
                if ($roomInfo && in_array($roomInfo['status'], ['night', 'day'], true)
                    && !empty($me['role']) && $me['role'] !== 'unassigned') {
                    $bot = addBot($pdo, $roomCode);
                    if ($bot) {
                        // Inherit the leaver's role so the role counts never shift.
                        $pdo->prepare("UPDATE players SET role = ?, bot_last_chat = 0 WHERE id = ?")
                            ->execute([$me['role'], $bot['id']]);
                        $pdo->prepare("UPDATE rooms SET last_event = ? WHERE room_code = ?")
                            ->execute(["A new villager slipped into the seat...", $roomCode]);
                    }
                }
            }
        }

        // If a lobby is now empty, dissolve the room entirely (codes are
        // one-shot, so an empty lobby has no reason to live on).
        $stmt = $pdo->prepare("SELECT status, (SELECT COUNT(*) FROM players WHERE room_code = ?) AS pc FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode, $roomCode]);
        $room = $stmt->fetch();
        if ($room && $room['status'] === 'lobby' && (int)$room['pc'] === 0) {
            $pdo->prepare("DELETE FROM messages WHERE room_code = ?")->execute([$roomCode]);
            $pdo->prepare("DELETE FROM rooms WHERE room_code = ?")->execute([$roomCode]);
        }

        echo json_encode(["status" => "success", "message" => "You have left the room."]);
        break;

    case 'start_game':
        $roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room || $room['host_token'] !== $token) {
            echo json_encode(["status" => "error", "message" => "Only the room host can start the game.", "cutscene" => "scene_error"]);
            exit;
        }

        $stmt = $pdo->prepare("SELECT id FROM players WHERE room_code = ? ORDER BY id ASC");
        $stmt->execute([$roomCode]);
        $players = $stmt->fetchAll();
        $total = count($players);

        if ($total < 4) {
            echo json_encode(["status" => "error", "message" => "At least 4 players are required to start.", "cutscene" => "scene_error"]);
            exit;
        }

        beginGame($pdo, $roomCode);

        $rs = $pdo->prepare("SELECT started_at FROM rooms WHERE room_code = ?");
        $rs->execute([$roomCode]);
        $rd = $rs->fetch();

        echo json_encode([
            "status" => "success",
            "message" => "Cards dealt! Night falls upon the village...",
            "cutscene" => "scene_night_falls",
            "server_now" => time(),
            "started_at" => (int)($rd['started_at'] ?? 0)
        ]);
        break;

    case 'send_message':
        $roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');
        $messageText = trim($_POST['message'] ?? '');

        if ($messageText === '') {
            echo json_encode(["status" => "error", "message" => "Message cannot be empty."]);
            exit;
        }

        $stmt = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND session_token = ?");
        $stmt->execute([$roomCode, $token]);
        $me = $stmt->fetch();

        if (!$me) {
            echo json_encode(["status" => "error", "message" => "Unauthorized sender."]);
            exit;
        }

        $stmt = $pdo->prepare("INSERT INTO messages (room_code, sender_name, message) VALUES (?, ?, ?)");
        $stmt->execute([$roomCode, $me['nickname'], htmlspecialchars($messageText)]);

        echo json_encode(["status" => "success", "message" => "Message sent."]);
        break;

    case 'poll_game':
    case 'poll_lobby':
        $roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room) {
            echo json_encode(["status" => "error", "message" => "Room collapsed."]);
            exit;
        }

        // Heartbeat: mark this room (and player) live so the reaper never
        // mistakes an active lobby/game for an abandoned one, then sweep any
        // stale rooms on a short throttle.
        touchPresence($pdo, $roomCode, $token);
        maybeReap($pdo);

        // Matchmaker: once the 30s window is up, top up with bots...
        fillBotsIfNeeded($pdo, $room);
        // ...and auto-start the moment the room is full.
        if (!empty($room['is_match']) && $room['status'] === 'lobby') {
            $stmt = $pdo->prepare("SELECT COUNT(*) AS c FROM players WHERE room_code = ?");
            $stmt->execute([$roomCode]);
            if ((int)$stmt->fetch()['c'] >= (int)$room['max_players']) {
                beginGame($pdo, $roomCode);
                // Re-read the room: beginGame may have been a no-op because a
                // concurrent poll already started the game (atomic claim). The
                // stale in-memory copy must never be used for win checks.
                $ri = $pdo->prepare("SELECT status, last_event FROM rooms WHERE room_code = ?");
                $ri->execute([$roomCode]);
                $fresh = $ri->fetch();
                $room['status'] = $fresh['status'];
                if ($fresh['last_event'] !== null) $room['last_event'] = $fresh['last_event'];
            }
        }

        // Drive the AI so a match never stalls waiting on a bot, then let the
        // phase resolve as soon as every actor has acted (this also covers the
        // "everyone who can act is a bot" case, which no client call would
        // otherwise ever trigger).
        if ($room['status'] === 'night') {
            if (advanceNight($pdo, $roomCode)) $room['status'] = 'day';
        } elseif ($room['status'] === 'day') {
            processDayBots($pdo, $roomCode);
            if (resolveDay($pdo, $roomCode)) $room['status'] = 'night';
        }

        // Refresh the room's phase clocks after any phase change so the client
        // always receives the authoritative server timestamps for the CURRENT
        // phase (status/last_event/started_at/phase_started_at + night step).
        $ri2 = $pdo->prepare("SELECT status, last_event, started_at, phase_started_at, night_step, pending_victim, night_deadline FROM rooms WHERE room_code = ?");
        $ri2->execute([$roomCode]);
        $fresh2 = $ri2->fetch();
        if ($fresh2) {
            $room['status'] = $fresh2['status'];
            if ($fresh2['last_event'] !== null) $room['last_event'] = $fresh2['last_event'];
            $room['started_at'] = (int)$fresh2['started_at'];
            $room['phase_started_at'] = (int)$fresh2['phase_started_at'];
            $room['night_step'] = $fresh2['night_step'];
            $room['pending_victim'] = $fresh2['pending_victim'];
            $room['night_deadline'] = (int)$fresh2['night_deadline'];
        }

        // Players are read AFTER deal/phase resolution so the win check below
        // never runs on the stale pre-deal snapshot (all "unassigned" roles) —
        // that race could falsely mark a fresh game as 'ended'.
        $stmt = $pdo->prepare("SELECT id, nickname, session_token, role, is_alive, target_id, vote_id, is_bot, bot_ready_at, bot_last_chat, check_target, seer_target, seer_result, poison_target, poison_skip, poison_used, revive_used, doctor_choice FROM players WHERE room_code = ? ORDER BY id ASC");
        $stmt->execute([$roomCode]);
        $players = $stmt->fetchAll();

        // Let a bot occasionally drop a chat line while the game is live.
        if ($room['status'] === 'night' || $room['status'] === 'day') {
            botChat($pdo, $roomCode, $players);
        }

        // Fetch room messages (runs after botChat so a fresh bot line can be
        // included in this same poll).
        $stmtMsg = $pdo->prepare("SELECT sender_name, message, created_at FROM messages WHERE room_code = ? ORDER BY id ASC LIMIT 50");
        $stmtMsg->execute([$roomCode]);
        $messages = $stmtMsg->fetchAll();

        $myRole = 'unassigned';
        $myId = null;
        $isAlive = 1;
        $myTargetId = null;
        $myVoteId = null;
        $hasVoted = false;
        $myCheckTarget = null;
        $mySeerTarget = null;
        $mySeerResult = null;
        $myPoisonTarget = null;
        $myPoisonUsed = 0;
        $myPoisonSkip = 0;
        $myReviveUsed = 0;
        $myDoctorChoice = null;

        foreach ($players as $p) {
            if ($p['session_token'] === $token) {
                $myRole = $p['role'];
                $myId = $p['id'];
                $isAlive = (int)$p['is_alive'];
                $myTargetId = $p['target_id'];
                $myVoteId = $p['vote_id'];
                $myCheckTarget = $p['check_target'];
                $mySeerTarget = $p['seer_target'];
                $mySeerResult = $p['seer_result'];
                $myPoisonTarget = $p['poison_target'];
                $myPoisonUsed = (int)$p['poison_used'];
                $myPoisonSkip = (int)$p['poison_skip'];
                $myReviveUsed = (int)$p['revive_used'];
                $myDoctorChoice = $p['doctor_choice'];

                if ($room['status'] === 'night' && $p['role'] === 'Werewolf') {
                    $hasVoted = ($p['target_id'] !== null);
                } elseif ($room['status'] === 'day') {
                    $hasVoted = ($p['vote_id'] !== null);
                }
                break;
            }
        }

        // Skill info for THIS player only (never leaked to other seats).
        $mySeerTargetName = null;
        if ($mySeerTarget) {
            foreach ($players as $p) { if ((int)$p['id'] === (int)$mySeerTarget) { $mySeerTargetName = $p['nickname']; break; } }
        }
        // The Doctor only learns tonight's victim while the night is waiting on
        // their revive decision.
        $doctorVictimName = null;
        if ($myRole === 'Doctor' && $isAlive && ($room['night_step'] ?? '') === 'doctor' && (int)($room['pending_victim'] ?? 0) > 0) {
            foreach ($players as $p) { if ((int)$p['id'] === (int)$room['pending_victim']) { $doctorVictimName = $p['nickname']; break; } }
        }

        if ($room['status'] !== 'lobby' && $room['status'] !== 'ended') {
            $aliveWerewolves = 0;
            $aliveVillagersOrSpecials = 0;
            foreach ($players as $p) {
                if ($p['is_alive'] == 1) {
                    if ($p['role'] === 'Werewolf') {
                        $aliveWerewolves++;
                    } else {
                        $aliveVillagersOrSpecials++;
                    }
                }
            }

            if ($aliveWerewolves === 0) {
                $stmt = $pdo->prepare("UPDATE rooms SET status = 'ended', last_event = 'Villagers win! All werewolves have been eliminated.' WHERE room_code = ?");
                $stmt->execute([$roomCode]);
                $room['status'] = 'ended';
                $room['last_event'] = 'Villagers win! All werewolves have been eliminated.';
            } elseif ($aliveWerewolves >= $aliveVillagersOrSpecials) {
                $stmt = $pdo->prepare("UPDATE rooms SET status = 'ended', last_event = 'Werewolves win! They have outnumbered the villagers.' WHERE room_code = ?");
                $stmt->execute([$roomCode]);
                $room['status'] = 'ended';
                $room['last_event'] = 'Werewolves win! They have outnumbered the villagers.';
            }
        }

        // Role visibility: your own card is always real. Others' roles are
        // only revealed at the END (final reveal); during night/day they are
        // masked so no client can read the table from the poll payload.
        $playerData = array_map(function($p) use ($room, $myId) {
            $role = $p['role'];
            if ($p['id'] !== $myId
                && !in_array($room['status'], ['lobby', 'ended'], true)
                && $role !== 'unassigned') {
                $role = 'Hidden';
            }
            return [
                "id" => $p['id'],
                "nickname" => $p['nickname'],
                "is_alive" => (int)$p['is_alive'],
                "role" => $role,
                "is_bot" => (int)($p['is_bot'] ?? 0)
            ];
        }, $players);

        $roleBreakdown = calculateRoles(count($players));

        $mmRemaining = 0;
        if (!empty($room['is_match']) && $room['status'] === 'lobby') {
            $mmRemaining = max(0, (int)$room['mm_deadline'] - time());
        }

        // Shared clocks. Every client derives the match timer and the
        // pre-night chat countdown from these SERVER timestamps (never a local
        // "when did *I* join" timestamp), so two players in the same room can
        // never show different elapsed times or different phases.
        $serverNow = time();
        $mmStartedAt = 0;
        if (!empty($room['is_match']) && $room['status'] === 'lobby' && !empty($room['mm_deadline'])) {
            $mmStartedAt = max(0, (int)$room['mm_deadline'] - MATCH_WAIT_SECONDS);
        }

        echo json_encode([
            "status" => "success",
            "room_status" => $room['status'],
            "is_host" => ($room['host_token'] === $token),
            "is_match" => (int)($room['is_match'] ?? 0),
            "mm_remaining" => $mmRemaining,
            "server_now" => $serverNow,
            "mm_started_at" => $mmStartedAt,
            "started_at" => (int)($room['started_at'] ?? 0),
            "phase_started_at" => (int)($room['phase_started_at'] ?? 0),
            "pre_night_seconds" => 15,
            "max_players" => (int)$room['max_players'],
            "current_count" => count($players),
            "players" => $playerData,
            "role_breakdown" => $roleBreakdown,
            "my_role" => $myRole,
            "my_id" => $myId,
            "is_alive" => $isAlive,
            "my_target_id" => $myTargetId,
            "my_vote_id" => $myVoteId,
            "has_voted" => $hasVoted,
            "night_step" => $room['night_step'] ?? 'actions',
            "my_check_target" => $myCheckTarget,
            "my_seer_target" => $mySeerTarget,
            "my_seer_target_name" => $mySeerTargetName,
            "my_seer_result" => $mySeerResult,
            "my_poison_target" => $myPoisonTarget,
            "my_poison_used" => $myPoisonUsed,
            "my_poison_skip" => $myPoisonSkip,
            "my_revive_used" => $myReviveUsed,
            "my_doctor_choice" => $myDoctorChoice,
            "doctor_victim_name" => $doctorVictimName,
            "last_event" => $room['last_event'] ?? '',
            "messages" => $messages
        ]);
        break;

    case 'night_action':
        $roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');
        $targetId = (int)($_POST['target_id'] ?? 0);
        $skip = (int)($_POST['skip'] ?? 0);

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room || $room['status'] !== 'night') {
            echo json_encode(["status" => "error", "message" => "It is not night phase."]);
            exit;
        }

        $stmt = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND session_token = ?");
        $stmt->execute([$roomCode, $token]);
        $me = $stmt->fetch();

        if (!$me || $me['is_alive'] == 0) {
            echo json_encode(["status" => "error", "message" => "You are dead or invalid."]);
            exit;
        }

        $myId = (int)$me['id'];

        if ($me['role'] === 'Werewolf') {
            // Werewolves secretly vote for tonight's victim.
            $pdo->prepare("UPDATE players SET target_id = ? WHERE id = ?")->execute([$targetId, $myId]);

        } elseif ($me['role'] === 'Seer') {
            // Divine one player: learn whether they are a werewolf.
            if ($targetId <= 0) {
                echo json_encode(["status" => "error", "message" => "Pick a player to divine."]);
                exit;
            }
            $t = $pdo->prepare("SELECT id, role FROM players WHERE id = ? AND room_code = ? AND is_alive = 1");
            $t->execute([$targetId, $roomCode]);
            $target = $t->fetch();
            if (!$target) {
                echo json_encode(["status" => "error", "message" => "Invalid target."]);
                exit;
            }
            $result = ($target['role'] === 'Werewolf') ? 'wolf' : 'good';
            $pdo->prepare("UPDATE players SET check_target = ?, seer_target = ?, seer_result = ? WHERE id = ?")
                ->execute([$targetId, $targetId, $result, $myId]);

        } elseif ($me['role'] === 'Witch') {
            // One poison per game. Either name a victim or explicitly pass.
            if ((int)$me['poison_used']) {
                echo json_encode(["status" => "error", "message" => "Your poison is already spent."]);
                exit;
            }
            if ($skip) {
                $pdo->prepare("UPDATE players SET poison_skip = 1 WHERE id = ?")->execute([$myId]);
            } else {
                if ($targetId <= 0) {
                    echo json_encode(["status" => "error", "message" => "Pick a player to poison, or skip."]);
                    exit;
                }
                if ($targetId === $myId) {
                    echo json_encode(["status" => "error", "message" => "You cannot poison yourself."]);
                    exit;
                }
                $pdo->prepare("UPDATE players SET poison_target = ? WHERE id = ?")->execute([$targetId, $myId]);
            }

        } else {
            // Villagers and the Doctor have no action in this step.
            echo json_encode(["status" => "success", "message" => "Nothing to do."]);
            exit;
        }

        // Advance the night if every night actor has now finished.
        advanceNight($pdo, $roomCode);

        echo json_encode(["status" => "success", "message" => "Night action submitted."]);
        break;

    case 'doctor_action':
        $roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');
        $revive = (int)($_POST['revive'] ?? 0);

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room || $room['status'] !== 'night' || ($room['night_step'] ?? '') !== 'doctor') {
            echo json_encode(["status" => "error", "message" => "There is no revive decision to make right now."]);
            exit;
        }

        $stmt = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND session_token = ?");
        $stmt->execute([$roomCode, $token]);
        $me = $stmt->fetch();

        if (!$me || $me['role'] !== 'Doctor' || $me['is_alive'] == 0) {
            echo json_encode(["status" => "error", "message" => "Only the living Doctor may decide."]);
            exit;
        }

        $pdo->prepare("UPDATE players SET doctor_choice = ? WHERE id = ?")->execute([$revive ? 1 : 0, (int)$me['id']]);

        advanceNight($pdo, $roomCode);

        echo json_encode(["status" => "success", "message" => $revive ? "You chose to save them." : "You chose not to intervene."]);
        break;

    case 'day_vote':
        $roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');
        $voteId = (int)($_POST['vote_id'] ?? 0);

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room || $room['status'] !== 'day') {
            echo json_encode(["status" => "error", "message" => "It is not day voting phase."]);
            exit;
        }

        $stmt = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND session_token = ?");
        $stmt->execute([$roomCode, $token]);
        $me = $stmt->fetch();

        if (!$me || $me['is_alive'] == 0) {
            echo json_encode(["status" => "error", "message" => "You are dead and cannot vote."]);
            exit;
        }

        $stmt = $pdo->prepare("UPDATE players SET vote_id = ? WHERE id = ?");
        $stmt->execute([$voteId, $me['id']]);

        // Bots may have already voted; resolve if everyone acted.
        processDayBots($pdo, $roomCode);
        resolveDay($pdo, $roomCode);

        echo json_encode(["status" => "success", "message" => "Vote submitted."]);
        break;

    default:
        echo json_encode(["status" => "error", "message" => "Invalid API action."]);
        break;
}
} catch (Throwable $e) {
    // Surface the real error instead of a silent 500 (helps production
    // debugging; clients still get a JSON error they can display).
    http_response_code(500);
    echo json_encode([
        "status" => "error",
        "message" => "Server error: " . $e->getMessage(),
        "cutscene" => "scene_error"
    ]);
}
?>
