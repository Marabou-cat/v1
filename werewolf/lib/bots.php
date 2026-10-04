<?php
/* werewolf / lib/bots.php - addBot, fillBotsIfNeeded, botChat, processNightBots, processDoctorBot, processDayBots
   Included by backend.php into its scope (shares $pdo and constants).
   Split out of the old monolithic backend.php. */

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
// The whole top-up runs under a room-row lock: the count-then-insert is then
// atomic, so two concurrent polls (two humans in one match) can never both add
// a bot from the same "not full" reading and overshoot max_players by one.
function fillBotsIfNeeded(PDO $pdo, $room) {
    if (empty($room['is_match']) || $room['status'] !== 'lobby') return;
    $deadline = (int)($room['mm_deadline'] ?? 0);
    if ($deadline <= 0 || time() < $deadline) return;

    $roomCode = $room['room_code'];
    $max = (int)$room['max_players'];

    try {
        $pdo->beginTransaction();
        $pdo->prepare("SELECT room_code FROM rooms WHERE room_code = ? FOR UPDATE")->execute([$roomCode]);
        for (;;) {
            $stmt = $pdo->prepare("SELECT COUNT(*) AS c FROM players WHERE room_code = ?");
            $stmt->execute([$roomCode]);
            if ((int)$stmt->fetch()['c'] >= $max) break;
            addBot($pdo, $roomCode);
        }
        $pdo->commit();
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
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
            // Villager / Doctor: their "action" is bunking down for the night.
            if ((int)$bot['asleep']) continue;
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
        } else {
            // Villager / Doctor bot: tap sleep.
            $pdo->prepare("UPDATE players SET asleep = 1 WHERE id = ?")->execute([$bot['id']]);
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
        if ($bot['vote_id'] !== null || (int)$bot['vote_skip']) continue;

        // Arm this bot's "thinking" delay once; on later polls just wait for
        // it to elapse (never reset the clock mid-phase).
        if (empty($bot['bot_ready_at'])) {
            $readyAt = $now + random_int(2, 8);
            $pdo->prepare("UPDATE players SET bot_ready_at = ? WHERE id = ?")->execute([$readyAt, $bot['id']]);
            if ($now < $readyAt) continue;
        } elseif ($now < (int)$bot['bot_ready_at']) {
            continue;
        }

        // Mostly they pile onto a target, but occasionally abstain — otherwise
        // the "skip beats the top vote" rule could never fire in a bot-heavy
        // table and the new outcome would be dead code in practice.
        if (random_int(1, 100) <= 15) {
            $pdo->prepare("UPDATE players SET vote_skip = 1 WHERE id = ?")->execute([$bot['id']]);
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
