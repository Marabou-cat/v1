<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

// 1. Read Database Credentials from ../config.ini
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

// 2. Helper: Calculate Role Distribution
function calculateRoles($playerCount) {
    if ($playerCount < 4) return null;
    $werewolves = 1 + (int)floor(($playerCount - 4) / 3);
    $specials = ($playerCount === 4) ? 0 : (int)floor(($playerCount - 3) / 2);
    $villagers = $playerCount - ($werewolves + $specials);
    
    // Select special roles sequentially from pool
    $specialPool = ['Seer', 'Doctor', 'Witch', 'Hunter', 'Cupid'];
    $assignedSpecials = array_slice($specialPool, 0, $specials);
    
    return [
        "werewolves" => $werewolves,
        "specials" => $specials,
        "special_cards" => $assignedSpecials,
        "villagers" => $villagers
    ];
}

// 3. Request Routing
$action = $_POST['action'] ?? $_GET['action'] ?? '';

switch ($action) {

    // --- BUTTON 1: CREATE ROOM ---
    case 'create_room':
        $nickname = trim($_POST['nickname'] ?? 'Host');
        $maxPlayers = (int)($_POST['max_players'] ?? 4);

        if ($maxPlayers < 4) {
            echo json_encode(["status" => "error", "message" => "Room must allow at least 4 players.", "cutscene" => "scene_error"]);
            exit;
        }

        $roomCode = strtoupper(substr(bin2hex(random_bytes(3)), 0, 5));
        $sessionToken = bin2hex(random_bytes(16));

        // Create Room
        $stmt = $pdo->prepare("INSERT INTO rooms (room_code, host_token, max_players) VALUES (?, ?, ?)");
        $stmt->execute([$roomCode, $sessionToken, $maxPlayers]);

        // Add Host as Player #1
        $stmt = $pdo->prepare("INSERT INTO players (room_code, session_token, nickname) VALUES (?, ?, ?)");
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

    // --- BUTTON 2: JOIN ROOM ---
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

        // Check Capacity
        $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM players WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $currentPlayers = $stmt->fetch()['count'];

        if ($currentPlayers >= $room['max_players']) {
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
            "message" => "Welcome to the village!",
            "cutscene" => "scene_door_open"
        ]);
        break;

    // --- REAL-TIME LOBBY POLLING ---
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

        $stmt = $pdo->prepare("SELECT nickname, session_token, role FROM players WHERE room_code = ? ORDER BY id ASC");
        $stmt->execute([$roomCode]);
        $players = $stmt->fetchAll();

        // Identify current player's role
        $myRole = 'unassigned';
        foreach ($players as $p) {
            if ($p['session_token'] === $token) {
                $myRole = $p['role'];
                break;
            }
        }

        $playerNames = array_map(function($p) { return $p['nickname']; }, $players);
        $roleBreakdown = calculateRoles(count($players));

        echo json_encode([
            "status" => "success",
            "room_status" => $room['status'],
            "is_host" => ($room['host_token'] === $token),
            "max_players" => (int)$room['max_players'],
            "current_count" => count($players),
            "players" => $playerNames,
            "role_breakdown" => $roleBreakdown,
            "my_role" => $myRole
        ]);
        break;

    // --- BUTTON 3: START GAME ---
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

        // Role Distribution Assignment
        $breakdown = calculateRoles($total);
        $deck = array_fill(0, $breakdown['werewolves'], 'Werewolf');
        foreach ($breakdown['special_cards'] as $card) {
            $deck[] = $card;
        }
        while (count($deck) < $total) {
            $deck[] = 'Villager';
        }

        shuffle($deck);

        // Assign shuffled cards to players in DB
        foreach ($players as $index => $player) {
            $assignedRole = $deck[$index];
            $stmt = $pdo->prepare("UPDATE players SET role = ? WHERE id = ?");
            $stmt->execute([$assignedRole, $player['id']]);
        }

        // Update room status
        $stmt = $pdo->prepare("UPDATE rooms SET status = 'night' WHERE room_code = ?");
        $stmt->execute([$roomCode]);

        echo json_encode([
            "status" => "success",
            "message" => "Cards dealt! Night falls upon the village...",
            "cutscene" => "scene_night_falls"
        ]);
        break;

    default:
        echo json_encode(["status" => "error", "message" => "Invalid API action."]);
        break;
}
?>
