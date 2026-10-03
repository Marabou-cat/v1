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
function fillBotsIfNeeded(PDO $pdo, $room) {
    if (empty($room['is_match']) || $room['status'] !== 'lobby') return;
    $deadline = (int)($room['mm_deadline'] ?? 0);
    if ($deadline <= 0 || time() < $deadline) return;

    $stmt = $pdo->prepare("SELECT COUNT(*) AS c FROM players WHERE room_code = ?");
    $stmt->execute([$room['room_code']]);
    $count = (int)$stmt->fetch()['c'];
    $target = (int)$room['max_players'];
    for ($i = $count; $i < $target; $i++) {
        addBot($pdo, $room['room_code']);
    }
}

// Deal cards and flip a full room into the night phase (shared by manual
// start and the matchmaker auto-start).
function beginGame(PDO $pdo, $roomCode) {
    $stmt = $pdo->prepare("SELECT id FROM players WHERE room_code = ? ORDER BY id ASC");
    $stmt->execute([$roomCode]);
    $players = $stmt->fetchAll();
    $total = count($players);

    $breakdown = calculateRoles($total);
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

    $stmt = $pdo->prepare("UPDATE rooms SET status = 'night', last_event = 'Night falls upon the village...' WHERE room_code = ?");
    $stmt->execute([$roomCode]);
}

// Make every alive bot werewolf lock a victim (never itself, prefers a
// non-werewolf). Each bot "thinks" for a random 2-8s before acting so the
// kills are spread out instead of landing all at once (reads human-like).
// Does NOT resolve the phase — resolveNight() does that.
function processNightBots(PDO $pdo, $roomCode) {
    $now = time();
    $stmt = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND is_bot = 1 AND is_alive = 1");
    $stmt->execute([$roomCode]);
    $bots = $stmt->fetchAll();
    if (count($bots) === 0) return;

    foreach ($bots as $bot) {
        if ($bot['role'] !== 'Werewolf' || $bot['target_id']) continue;

        // Arm / wait out this bot's personal "thinking" delay.
        if (empty($bot['bot_ready_at'])) {
            $readyAt = $now + random_int(2, 8);
            $pdo->prepare("UPDATE players SET bot_ready_at = ? WHERE id = ?")->execute([$readyAt, $bot['id']]);
            if ($now < $readyAt) continue;
        } elseif ($now < (int)$bot['bot_ready_at']) {
            continue;
        }

        $stmt = $pdo->prepare("SELECT id FROM players WHERE room_code = ? AND is_alive = 1 AND id != ? AND role != 'Werewolf'");
        $stmt->execute([$roomCode, $bot['id']]);
        $options = $stmt->fetchAll(PDO::FETCH_COLUMN);
        if (count($options) === 0) {
            $stmt = $pdo->prepare("SELECT id FROM players WHERE room_code = ? AND is_alive = 1 AND id != ?");
            $stmt->execute([$roomCode, $bot['id']]);
            $options = $stmt->fetchAll(PDO::FETCH_COLUMN);
        }
        if (count($options) === 0) continue;
        $victim = $options[array_rand($options)];
        $pdo->prepare("UPDATE players SET target_id = ? WHERE id = ?")->execute([$victim, $bot['id']]);
    }
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

// Resolve the night: every alive werewolf has a victim -> kill the top
// target, wipe targets, flip to day. Returns true if the phase advanced.
function resolveNight(PDO $pdo, $roomCode) {
    $stmt = $pdo->prepare("SELECT id, target_id FROM players WHERE room_code = ? AND role = 'Werewolf' AND is_alive = 1");
    $stmt->execute([$roomCode]);
    $werewolves = $stmt->fetchAll();
    if (count($werewolves) === 0) return false;

    $targetVotes = [];
    foreach ($werewolves as $w) {
        if (!$w['target_id']) return false; // someone has not acted yet
        $targetVotes[$w['target_id']] = ($targetVotes[$w['target_id']] ?? 0) + 1;
    }

    arsort($targetVotes);
    $victimId = array_key_first($targetVotes);

    $pdo->prepare("UPDATE players SET is_alive = 0 WHERE id = ?")->execute([$victimId]);

    $stmt = $pdo->prepare("SELECT nickname FROM players WHERE id = ?");
    $stmt->execute([$victimId]);
    $victim = $stmt->fetch();
    $victimName = $victim ? $victim['nickname'] : 'Someone';

    $pdo->prepare("UPDATE players SET target_id = NULL WHERE room_code = ?")->execute([$roomCode]);
    // New day: reset bot "thinking" timers so votes trickle in again.
    $pdo->prepare("UPDATE players SET bot_ready_at = NULL WHERE room_code = ? AND is_bot = 1")->execute([$roomCode]);
    $pdo->prepare("UPDATE rooms SET status = 'day', last_event = ? WHERE room_code = ?")
        ->execute(["During the night, werewolves attacked and killed **{$victimName}**!", $roomCode]);
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
    $pdo->prepare("UPDATE rooms SET status = 'night', last_event = ? WHERE room_code = ?")
        ->execute(["The village voted and lynched **{$lynchedName}**. They were a **{$lynchedRole}**! Night falls again...", $roomCode]);
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

        // 1) Join an existing matchmade lobby that wants exactly this count.
        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE is_match = 1 AND status = 'lobby' AND max_players = ? ORDER BY created_at ASC");
        $stmt->execute([$count]);
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

            echo json_encode([
                "status" => "success",
                "joined" => true,
                "room_code" => $room['room_code'],
                "token" => $sessionToken,
                "max_players" => (int)$room['max_players'],
                "message" => "Matched with a waiting lobby!",
                "cutscene" => "scene_door_open"
            ]);
            exit;
        }

        // 2) Nobody waiting at this size: note the nearest busy size so the
        //    client can offer a quick switch.
        $stmt = $pdo->prepare("SELECT max_players FROM rooms WHERE is_match = 1 AND status = 'lobby' GROUP BY max_players");
        $stmt->execute();
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

        $stmt = $pdo->prepare("INSERT INTO rooms (room_code, host_token, max_players, status, is_match, mm_deadline) VALUES (?, ?, ?, 'lobby', 1, ?)");
        $stmt->execute([$roomCode, $sessionToken, $count, time() + MATCH_WAIT_SECONDS]);

        $stmt = $pdo->prepare("INSERT INTO players (room_code, session_token, nickname, is_alive) VALUES (?, ?, ?, 1)");
        $stmt->execute([$roomCode, $sessionToken, $nickname]);

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

        $stmt = $pdo->prepare("SELECT id, room_code FROM players WHERE room_code = ? AND session_token = ?");
        $stmt->execute([$roomCode, $token]);
        $me = $stmt->fetch();

        if ($me) {
            // Remove this player's chat so the room history stays clean.
            $stmt = $pdo->prepare("DELETE FROM messages WHERE room_code = ? AND sender_name = (SELECT nickname FROM players WHERE id = ?)");
            $stmt->execute([$me['room_code'], $me['id']]);

            // Remove the player itself.
            $stmt = $pdo->prepare("DELETE FROM players WHERE id = ?");
            $stmt->execute([$me['id']]);
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

        echo json_encode([
            "status" => "success",
            "message" => "Cards dealt! Night falls upon the village...",
            "cutscene" => "scene_night_falls"
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

        // Matchmaker: once the 30s window is up, top up with bots...
        fillBotsIfNeeded($pdo, $room);
        // ...and auto-start the moment the room is full.
        if (!empty($room['is_match']) && $room['status'] === 'lobby') {
            $stmt = $pdo->prepare("SELECT COUNT(*) AS c FROM players WHERE room_code = ?");
            $stmt->execute([$roomCode]);
            if ((int)$stmt->fetch()['c'] >= (int)$room['max_players']) {
                beginGame($pdo, $roomCode);
                $room['status'] = 'night';
                $room['last_event'] = 'Room full — the match begins!';
            }
        }

        // Drive the AI so a match never stalls waiting on a bot, then let the
        // phase resolve as soon as every actor has acted (this also covers the
        // "everyone who can act is a bot" case, which no client call would
        // otherwise ever trigger).
        if ($room['status'] === 'night') {
            processNightBots($pdo, $roomCode);
            if (resolveNight($pdo, $roomCode)) $room['status'] = 'day';
        } elseif ($room['status'] === 'day') {
            processDayBots($pdo, $roomCode);
            if (resolveDay($pdo, $roomCode)) $room['status'] = 'night';
        }

        $stmt = $pdo->prepare("SELECT id, nickname, session_token, role, is_alive, target_id, vote_id, is_bot, bot_ready_at, bot_last_chat FROM players WHERE room_code = ? ORDER BY id ASC");
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

        foreach ($players as $p) {
            if ($p['session_token'] === $token) {
                $myRole = $p['role'];
                $myId = $p['id'];
                $isAlive = (int)$p['is_alive'];
                $myTargetId = $p['target_id'];
                $myVoteId = $p['vote_id'];

                if ($room['status'] === 'night' && $p['role'] === 'Werewolf') {
                    $hasVoted = ($p['target_id'] !== null);
                } elseif ($room['status'] === 'day') {
                    $hasVoted = ($p['vote_id'] !== null);
                }
                break;
            }
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

        $playerData = array_map(function($p) {
            return [
                "id" => $p['id'],
                "nickname" => $p['nickname'],
                "is_alive" => (int)$p['is_alive'],
                "role" => $p['role'],
                "is_bot" => (int)($p['is_bot'] ?? 0)
            ];
        }, $players);

        $roleBreakdown = calculateRoles(count($players));

        $mmRemaining = 0;
        if (!empty($room['is_match']) && $room['status'] === 'lobby') {
            $mmRemaining = max(0, (int)$room['mm_deadline'] - time());
        }

        echo json_encode([
            "status" => "success",
            "room_status" => $room['status'],
            "is_host" => ($room['host_token'] === $token),
            "is_match" => (int)($room['is_match'] ?? 0),
            "mm_remaining" => $mmRemaining,
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
            "last_event" => $room['last_event'] ?? '',
            "messages" => $messages
        ]);
        break;

    case 'night_action':
        $roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');
        $targetId = (int)($_POST['target_id'] ?? 0);

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

        if ($me['role'] !== 'Werewolf') {
            echo json_encode(["status" => "success", "message" => "Night action recorded."]);
            exit;
        }

        $stmt = $pdo->prepare("UPDATE players SET target_id = ? WHERE id = ?");
        $stmt->execute([$targetId, $me['id']]);

        // Bots may have already locked victims; resolve if everyone acted.
        processNightBots($pdo, $roomCode);
        resolveNight($pdo, $roomCode);

        echo json_encode(["status" => "success", "message" => "Night action submitted."]);
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
