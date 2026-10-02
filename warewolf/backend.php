<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

try {
    // Read Credentials strictly from ../config.ini
    $configFile = __DIR__ . '/../config.ini';
    if (!file_exists($configFile) || !is_readable($configFile)) {
        die(json_encode([
            "status" => "error", 
            "message" => "Missing or unreadable ../config.ini", 
            "cutscene" => "scene_error"
        ]));
    }

    $lines = @file($configFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false || count($lines) < 2) {
        die(json_encode([
            "status" => "error", 
            "message" => "Invalid ../config.ini formatting (requires username on line 1, password on line 2)", 
            "cutscene" => "scene_error"
        ]));
    }

    $db_user = trim($lines[0]);
    $db_pass = trim($lines[1]);
    $db_host = 'localhost';
    $db_name = 'werewolf_db';

    $pdo = new PDO("mysql:host=$db_host;dbname=$db_name;charset=utf8mb4", $db_user, $db_pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
    ]);
} catch (Throwable $e) {
    die(json_encode([
        "status" => "error", 
        "message" => "Database Connection Error: " . $e->getMessage(), 
        "cutscene" => "scene_error"
    ]));
}

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

$action = $_REQUEST['action'] ?? '';

switch ($action) {

    case 'create_room':
        $nickname = trim($_REQUEST['nickname'] ?? 'Brawler');
        $maxPlayers = (int)($_REQUEST['max_players'] ?? 6);
        $isPublic = (int)($_REQUEST['is_public'] ?? 0);

        if ($maxPlayers < 4) {
            echo json_encode(["status" => "error", "message" => "Room requires at least 4 players.", "cutscene" => "scene_error"]);
            exit;
        }

        $roomCode = strtoupper(substr(bin2hex(random_bytes(3)), 0, 5));
        $sessionToken = bin2hex(random_bytes(16));

        // FIX: Explicitly set status to 'lobby'
        $stmt = $pdo->prepare("INSERT INTO rooms (room_code, host_token, max_players, is_public, status) VALUES (?, ?, ?, ?, 'lobby')");
        $stmt->execute([$roomCode, $sessionToken, $maxPlayers, $isPublic]);

        $stmt = $pdo->prepare("INSERT INTO players (room_code, session_token, nickname) VALUES (?, ?, ?)");
        $stmt->execute([$roomCode, $sessionToken, $nickname]);

        echo json_encode([
            "status" => "success",
            "room_code" => $roomCode,
            "token" => $sessionToken,
            "max_players" => $maxPlayers,
            "cutscene" => "scene_room_created",
            "message" => "Custom Room Ready!"
        ]);
        break;

    case 'join_room':
        $nickname = trim($_REQUEST['nickname'] ?? 'Brawler');
        $roomCode = strtoupper(trim($_REQUEST['room_code'] ?? ''));

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room || $room['status'] !== 'lobby') {
            echo json_encode(["status" => "error", "message" => "Lobby unavailable or full.", "cutscene" => "scene_error"]);
            exit;
        }

        $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM players WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $count = $stmt->fetch()['count'];

        if ($count >= $room['max_players']) {
            echo json_encode(["status" => "error", "message" => "Room is full!", "cutscene" => "scene_error"]);
            exit;
        }

        $sessionToken = bin2hex(random_bytes(16));
        $stmt = $pdo->prepare("INSERT INTO players (room_code, session_token, nickname) VALUES (?, ?, ?)");
        $stmt->execute([$roomCode, $sessionToken, $nickname]);

        echo json_encode([
            "status" => "success",
            "room_code" => $roomCode,
            "token" => $sessionToken,
            "cutscene" => "scene_joining_room",
            "message" => "Lobby Joined!"
        ]);
        break;

    // --- MATCHMAKING: FIND ONLINE PLAYERS ---
    case 'find_online_game':
        $nickname = trim($_REQUEST['nickname'] ?? 'Brawler');

        $stmt = $pdo->query("
            SELECT r.room_code, r.max_players, COUNT(p.id) as current_players 
            FROM rooms r 
            LEFT JOIN players p ON r.room_code = p.room_code 
            WHERE r.is_public = 1 AND r.status = 'lobby' 
            GROUP BY r.room_code, r.max_players 
            HAVING current_players < r.max_players 
            LIMIT 1
        ");
        $openRoom = $stmt->fetch();

        if ($openRoom) {
            $roomCode = $openRoom['room_code'];
            $sessionToken = bin2hex(random_bytes(16));

            $stmt = $pdo->prepare("INSERT INTO players (room_code, session_token, nickname) VALUES (?, ?, ?)");
            $stmt->execute([$roomCode, $sessionToken, $nickname]);

            echo json_encode([
                "status" => "success",
                "room_code" => $roomCode,
                "token" => $sessionToken,
                "cutscene" => "scene_match_found",
                "message" => "Match Found!"
            ]);
        } else {
            $roomCode = strtoupper(substr(bin2hex(random_bytes(3)), 0, 5));
            $sessionToken = bin2hex(random_bytes(16));

            // FIX: Explicitly set status to 'lobby'
            $stmt = $pdo->prepare("INSERT INTO rooms (room_code, host_token, max_players, is_public, status) VALUES (?, ?, 6, 1, 'lobby')");
            $stmt->execute([$roomCode, $sessionToken]);

            $stmt = $pdo->prepare("INSERT INTO players (room_code, session_token, nickname) VALUES (?, ?, ?)");
            $stmt->execute([$roomCode, $sessionToken, $nickname]);

            echo json_encode([
                "status" => "success",
                "room_code" => $roomCode,
                "token" => $sessionToken,
                "cutscene" => "scene_matchmaking_search",
                "message" => "Created Matchmaking Lobby!"
            ]);
        }
        break;

    case 'poll_lobby':
        $roomCode = strtoupper(trim($_REQUEST['room_code'] ?? ''));
        $token = trim($_REQUEST['token'] ?? '');

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room) {
            echo json_encode(["status" => "error", "message" => "Lobby disbanded."]);
            exit;
        }

        $stmt = $pdo->prepare("SELECT nickname, session_token, role FROM players WHERE room_code = ? ORDER BY id ASC");
        $stmt->execute([$roomCode]);
        $players = $stmt->fetchAll();

        $myRole = 'unassigned';
        foreach ($players as $p) {
            if ($p['session_token'] === $token) {
                $myRole = $p['role'];
                break;
            }
        }

        $playerNames = array_map(function($p) {
            return $p['nickname'];
        }, $players);

        echo json_encode([
            "status" => "success",
            "room_status" => $room['status'],
            "is_host" => ($room['host_token'] === $token),
            "max_players" => (int)$room['max_players'],
            "current_count" => count($players),
            "players" => $playerNames,
            "role_breakdown" => calculateRoles(count($players)),
            "my_role" => $myRole
        ]);
        break;

    case 'start_game':
        $roomCode = strtoupper(trim($_REQUEST['room_code'] ?? ''));
        $token = trim($_REQUEST['token'] ?? '');

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room || $room['host_token'] !== $token) {
            echo json_encode(["status" => "error", "message" => "Host permission required.", "cutscene" => "scene_error"]);
            exit;
        }

        $stmt = $pdo->prepare("SELECT id FROM players WHERE room_code = ? ORDER BY id ASC");
        $stmt->execute([$roomCode]);
        $players = $stmt->fetchAll();
        $total = count($players);

        if ($total < 4) {
            echo json_encode(["status" => "error", "message" => "Min 4 Brawlers required to Play!", "cutscene" => "scene_error"]);
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
            $stmt = $pdo->prepare("UPDATE players SET role = ? WHERE id = ?");
            $stmt->execute([$deck[$index], $player['id']]);
        }

        $stmt = $pdo->prepare("UPDATE rooms SET status = 'night' WHERE room_code = ?");
        $stmt->execute([$roomCode]);

        echo json_encode([
            "status" => "success",
            "cutscene" => "scene_night_falls",
            "message" => "BRAWL START!"
        ]);
        break;

    default:
        echo json_encode(["status" => "error", "message" => "Invalid Route."]);
        break;
}
?>
