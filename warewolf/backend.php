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
    $pdo->exec("CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        room_code VARCHAR(10) NOT NULL,
        sender_name VARCHAR(50) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");
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

$action = $_POST['action'] ?? $_GET['action'] ?? '';

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
            $assignedRole = $deck[$index];
            $stmt = $pdo->prepare("UPDATE players SET role = ?, is_alive = 1, target_id = NULL, vote_id = NULL WHERE id = ?");
            $stmt->execute([$assignedRole, $player['id']]);
        }

        $stmt = $pdo->prepare("UPDATE rooms SET status = 'night', last_event = 'Night falls upon the village...' WHERE room_code = ?");
        $stmt->execute([$roomCode]);

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

        $stmt = $pdo->prepare("SELECT id, nickname, session_token, role, is_alive, target_id, vote_id FROM players WHERE room_code = ? ORDER BY id ASC");
        $stmt->execute([$roomCode]);
        $players = $stmt->fetchAll();

        // Fetch room messages
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
                "role" => $p['role']
            ];
        }, $players);

        $roleBreakdown = calculateRoles(count($players));

        echo json_encode([
            "status" => "success",
            "room_status" => $room['status'],
            "is_host" => ($room['host_token'] === $token),
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

        $stmt = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND role = 'Werewolf' AND is_alive = 1");
        $stmt->execute([$roomCode]);
        $werewolves = $stmt->fetchAll();

        $allVoted = true;
        $targetVotes = [];
        foreach ($werewolves as $w) {
            if (!$w['target_id']) {
                $allVoted = false;
            } else {
                $targetVotes[$w['target_id']] = ($targetVotes[$w['target_id']] ?? 0) + 1;
            }
        }

        if ($allVoted && count($werewolves) > 0) {
            arsort($targetVotes);
            $victimId = array_key_first($targetVotes);

            $stmt = $pdo->prepare("UPDATE players SET is_alive = 0 WHERE id = ?");
            $stmt->execute([$victimId]);

            $stmt = $pdo->prepare("SELECT nickname FROM players WHERE id = ?");
            $stmt->execute([$victimId]);
            $victim = $stmt->fetch();
            $victimName = $victim ? $victim['nickname'] : 'Someone';

            $pdo->prepare("UPDATE players SET target_id = NULL")->execute();
            $stmt = $pdo->prepare("UPDATE rooms SET status = 'day', last_event = ? WHERE room_code = ?");
            $stmt->execute(["During the night, werewolves attacked and killed **{$victimName}**!", $roomCode]);
        }

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

        $stmt = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND is_alive = 1");
        $stmt->execute([$roomCode]);
        $livingPlayers = $stmt->fetchAll();

        $allVoted = true;
        $voteCounts = [];
        foreach ($livingPlayers as $p) {
            if ($p['vote_id'] === null) {
                $allVoted = false;
            } else {
                $voteCounts[$p['vote_id']] = ($voteCounts[$p['vote_id']] ?? 0) + 1;
            }
        }

        if ($allVoted && count($livingPlayers) > 0) {
            arsort($voteCounts);
            $lynchedId = array_key_first($voteCounts);

            $stmt = $pdo->prepare("UPDATE players SET is_alive = 0 WHERE id = ?");
            $stmt->execute([$lynchedId]);

            $stmt = $pdo->prepare("SELECT nickname, role FROM players WHERE id = ?");
            $stmt->execute([$lynchedId]);
            $lynched = $stmt->fetch();
            $lynchedName = $lynched ? $lynched['nickname'] : 'Someone';
            $lynchedRole = $lynched ? $lynched['role'] : 'Villager';

            $pdo->prepare("UPDATE players SET vote_id = NULL")->execute();
            $stmt = $pdo->prepare("UPDATE rooms SET status = 'night', last_event = ? WHERE room_code = ?");
            $stmt->execute(["The village voted and lynched **{$lynchedName}**. They were a **{$lynchedRole}**! Night falls again...", $roomCode]);
        }

        echo json_encode(["status" => "success", "message" => "Vote submitted."]);
        break;

    default:
        echo json_encode(["status" => "error", "message" => "Invalid API action."]);
        break;
}
?>
