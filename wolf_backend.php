<?php
session_start();

// Set proper JSON and CORS headers
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// Helper to return consistent JSON response and terminate script
function sendJsonResponse(bool $success, $dataOrMessage, int$httpCode = 200) {
    http_response_code($httpCode);
    $response = ['success' =>$success];
    if ($success) {
        $response['data'] =$dataOrMessage['data'] ?? null;
        if (isset($dataOrMessage['message'])) {
            $response['message'] =$dataOrMessage['message'];
        }
    } else {
        $response['message'] = is_string($dataOrMessage) ? $dataOrMessage : ($dataOrMessage['message'] ?? 'An error occurred.');
    }
    echo json_encode($response, JSON_UNESCAPED_UNICODE);
    exit;
}

// --- 1. CONFIG & CONNECTION ---
$config_file = 'config.ini'; 
if (!file_exists($config_file)) {
    sendJsonResponse(false, "Server Error: Configuration file missing at config.ini.", 500);
}

$lines = file($config_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
if (count($lines) < 2) {
    sendJsonResponse(false, "Server Error: Invalid configuration file format.", 500);
}

$db_host = 'localhost';$db_name = 'werewolf_db'; 
$db_user = trim($lines[0]); 
$db_pass = trim($lines[1]); 

try {
    $pdo = new PDO("mysql:host=$db_host;charset=utf8mb4", $db_user,$db_pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
    ]);
    
    // Auto-Create Database and Select It
    $pdo->exec("CREATE DATABASE IF NOT EXISTS `$db_name` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    $pdo->exec("USE `$db_name`");

    // Auto-Create Rooms Table
    $pdo->exec("CREATE TABLE IF NOT EXISTS `rooms` (
        `id` INT AUTO_INCREMENT PRIMARY KEY,
        `code` VARCHAR(6) NOT NULL UNIQUE,
        `host_id` VARCHAR(64) NOT NULL,
        `status` ENUM('waiting', 'playing', 'ended') DEFAULT 'waiting',
        `max_players` INT DEFAULT 10,
        `werewolf_count` INT DEFAULT 2,
        `has_seer` TINYINT(1) DEFAULT 1,
        `has_doctor` TINYINT(1) DEFAULT 1,
        `phase` VARCHAR(30) DEFAULT 'lobby',
        `phase_end_time` INT DEFAULT 0,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // Auto-Create Players Table
    $pdo->exec("CREATE TABLE IF NOT EXISTS `players` (
        `id` INT AUTO_INCREMENT PRIMARY KEY,
        `room_code` VARCHAR(6) NOT NULL,
        `player_id` VARCHAR(64) NOT NULL,
        `username` VARCHAR(50) NOT NULL,
        `avatar` VARCHAR(50) DEFAULT 'shelly',
        `role` VARCHAR(30) DEFAULT 'Villager',
        `is_alive` TINYINT(1) DEFAULT 1,
        `is_ready` TINYINT(1) DEFAULT 0,
        `is_host` TINYINT(1) DEFAULT 0,
        `joined_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY `unique_room_player` (`room_code`, `player_id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // Auto-Create Messages Table
    $pdo->exec("CREATE TABLE IF NOT EXISTS `messages` (
        `id` INT AUTO_INCREMENT PRIMARY KEY,
        `room_code` VARCHAR(6) NOT NULL,
        `sender` VARCHAR(50) NOT NULL,
        `text` TEXT NOT NULL,
        `is_system` TINYINT(1) DEFAULT 0,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // Auto-Create Actions Table
    $pdo->exec("CREATE TABLE IF NOT EXISTS `actions` (
        `id` INT AUTO_INCREMENT PRIMARY KEY,
        `room_code` VARCHAR(6) NOT NULL,
        `actor_id` VARCHAR(64) NOT NULL,
        `target_id` VARCHAR(64) NOT NULL,
        `action_type` VARCHAR(30) NOT NULL,
        `phase` VARCHAR(30) NOT NULL,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

} catch (PDOException $e) {
    sendJsonResponse(false, "Database connection failed: " . $e->getMessage(), 500);
}

// Support both FormData ($_POST) and JSON Payload input$rawInput = file_get_contents('php://input');
$jsonInput = json_decode($rawInput, true) ?? [];
$req = array_merge($_GET, $_POST,$jsonInput);

$action =$req['action'] ?? '';

// Helper: Generate 6-digit room code
function generateRoomCode($pdo) {
    do {
        $code = str_pad((string)mt_rand(100000, 999999), 6, '0', STR_PAD_LEFT);
        $stmt =$pdo->prepare("SELECT id FROM rooms WHERE code = ?");
        $stmt->execute([$code]);
    } while ($stmt->fetch());
    return $code;
}

// --- 2. ACTIONS HANDLER ---

switch ($action) {

    // --- CREATE ROOM ---
    case 'create_room':
        $playerId = trim($req['player_id'] ?? '');
        $username = trim($req['username'] ?? 'Player');
        $avatar   = trim($req['avatar'] ?? 'shelly');

        if (empty($playerId)) sendJsonResponse(false, "Missing player_id", 400);

        $code = generateRoomCode($pdo);

        $stmt =$pdo->prepare("INSERT INTO rooms (code, host_id, status, phase) VALUES (?, ?, 'waiting', 'lobby')");
        $stmt->execute([$code,$playerId]);

        $stmt =$pdo->prepare("INSERT INTO players (room_code, player_id, username, avatar, is_host, is_ready) VALUES (?, ?, ?, ?, 1, 1)");
        $stmt->execute([$code,$playerId, $username,$avatar]);

        $stmt =$pdo->prepare("INSERT INTO messages (room_code, sender, text, is_system) VALUES (?, 'SYSTEM', ?, 1)");
        $stmt->execute([$code, "Room $code created. Welcome!"]);

        sendJsonResponse(true, [
            "message" => "Room created successfully.",
            "data" => ["room_code" => $code]
        ]);
        break;

    // --- JOIN ROOM ---
    case 'join_room':
        $code     = trim($req['room_code'] ?? '');
        $playerId = trim($req['player_id'] ?? '');
        $username = trim($req['username'] ?? 'Player');
        $avatar   = trim($req['avatar'] ?? 'shelly');

        if (empty($code) \vert{}\vert{} empty($playerId)) sendJsonResponse(false, "Missing room code or player ID", 400);

        $stmt =$pdo->prepare("SELECT * FROM rooms WHERE code = ?");
        $stmt->execute([$code]);
        $room =$stmt->fetch();

        if (!$room) sendJsonResponse(false, "Room not found!", 444);
        if ($room['status'] !== 'waiting') sendJsonResponse(false, "Game has already started", 400);

        $stmt =$pdo->prepare("SELECT COUNT(*) as count FROM players WHERE room_code = ?");
        $stmt->execute([$code]);
        $pCount =$stmt->fetch()['count'];

        if ($pCount >=$room['max_players']) sendJsonResponse(false, "Room is full!", 400);

        $stmt =$pdo->prepare("INSERT INTO players (room_code, player_id, username, avatar) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=?, avatar=?");
        $stmt->execute([$code,$playerId, $username,$avatar, $username,$avatar]);

        $stmt =$pdo->prepare("INSERT INTO messages (room_code, sender, text, is_system) VALUES (?, 'SYSTEM', ?, 1)");
        $stmt->execute([$code, "$username joined the room"]);

        sendJsonResponse(true, [
            "message" => "Joined room successfully.",
            "data" => ["room_code" => $code]
        ]);
        break;

    // --- FIND GAME ---
    case 'find_game':
        $playerId = trim($req['player_id'] ?? '');
        $username = trim($req['username'] ?? 'Player');
        $avatar   = trim($req['avatar'] ?? 'shelly');

        if (empty($playerId)) sendJsonResponse(false, "Missing player_id", 400);

        $stmt =$pdo->prepare("SELECT r.code FROM rooms r JOIN players p ON r.code = p.room_code WHERE r.status = 'waiting' GROUP BY r.code HAVING COUNT(p.id) < 10 LIMIT 1");
        $stmt->execute();
        $room =$stmt->fetch();

        if ($room) {
            $code =$room['code'];
            $stmt =$pdo->prepare("INSERT INTO players (room_code, player_id, username, avatar) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=?, avatar=?");
            $stmt->execute([$code,$playerId, $username,$avatar, $username,$avatar]);
        } else {
            $code = generateRoomCode($pdo);
            $stmt =$pdo->prepare("INSERT INTO rooms (code, host_id) VALUES (?, ?)");
            $stmt->execute([$code,$playerId]);

            $stmt =$pdo->prepare("INSERT INTO players (room_code, player_id, username, avatar, is_host, is_ready) VALUES (?, ?, ?, ?, 1, 1)");
            $stmt->execute([$code,$playerId, $username,$avatar]);
        }

        sendJsonResponse(true, [
            "message" => "Game found.",
            "data" => ["room_code" => $code]
        ]);
        break;

    // --- GET ROOM STATE ---
    case 'get_room':
        $code     = trim($req['room_code'] ?? '');
        $playerId = trim($req['player_id'] ?? '');

        if (empty($code)) sendJsonResponse(false, "Missing room code", 400);

        $stmt =$pdo->prepare("SELECT * FROM rooms WHERE code = ?");
        $stmt->execute([$code]);
        $room =$stmt->fetch();

        if (!$room) sendJsonResponse(false, "Room not found", 404);

        $stmt =$pdo->prepare("SELECT player_id, username, avatar, role, is_alive, is_ready, is_host FROM players WHERE room_code = ? ORDER BY id ASC");
        $stmt->execute([$code]);
        $players =$stmt->fetchAll();

        $stmt =$pdo->prepare("SELECT sender, text, is_system, created_at FROM messages WHERE room_code = ? ORDER BY id ASC LIMIT 50");
        $stmt->execute([$code]);
        $messages =$stmt->fetchAll();

        sendJsonResponse(true, [
            "data" => [
                "room"     => $room,
                "players"  => $players,
                "messages" => $messages
            ]
        ]);
        break;

    // --- TOGGLE READY ---
    case 'toggle_ready':
        $code     = trim($req['room_code'] ?? '');
        $playerId = trim($req['player_id'] ?? '');

        $stmt =$pdo->prepare("UPDATE players SET is_ready = NOT is_ready WHERE room_code = ? AND player_id = ?");
        $stmt->execute([$code,$playerId]);

        sendJsonResponse(true, ["message" => "Readiness updated."]);
        break;

    // --- SEND CHAT ---
    case 'send_chat':
        $code     = trim($req['room_code'] ?? '');
        $username = trim($req['username'] ?? 'Player');
        $text     = trim($req['text'] ?? '');

        if ($text !== '') {
            $stmt =$pdo->prepare("INSERT INTO messages (room_code, sender, text) VALUES (?, ?, ?)");
            $stmt->execute([$code, $username,$text]);
        }

        sendJsonResponse(true, ["message" => "Message sent."]);
        break;

    // --- START GAME ---
    case 'start_game':
        $code     = trim($req['room_code'] ?? '');
        $playerId = trim($req['player_id'] ?? '');

        $stmt =$pdo->prepare("SELECT host_id, werewolf_count, has_seer, has_doctor FROM rooms WHERE code = ?");
        $stmt->execute([$code]);
        $room =$stmt->fetch();

        if (!$room || $room['host_id'] !==$playerId) {
            sendJsonResponse(false, "Only the host can start the game", 403);
        }

        $stmt =$pdo->prepare("SELECT player_id FROM players WHERE room_code = ?");
        $stmt->execute([$code]);
        $pList =$stmt->fetchAll(PDO::FETCH_COLUMN);

        if (count($pList) < 3) {
            sendJsonResponse(false, "Need at least 3 players to start", 400);
        }

        shuffle($pList);
        $wolves  = (int)$room['werewolf_count'];
        $hasSeer = (bool)$room['has_seer'];
        $hasDoc  = (bool)$room['has_doctor'];

        foreach ($pList as$idx => $pid) {$role = 'Villager';
            if ($idx < $wolves) {$role = 'Werewolf';
            } elseif ($hasSeer &&$idx == $wolves) {$role = 'Seer';
            } elseif ($hasDoc &&$idx == ($wolves + ($hasSeer ? 1 : 0))) {
                $role = 'Doctor';
            }

            $upd =$pdo->prepare("UPDATE players SET role = ?, is_alive = 1 WHERE room_code = ? AND player_id = ?");
            $upd->execute([$role, $code,$pid]);
        }

        $stmt =$pdo->prepare("UPDATE rooms SET status = 'playing', phase = 'NIGHT' WHERE code = ?");
        $stmt->execute([$code]);

        $stmt =$pdo->prepare("INSERT INTO messages (room_code, sender, text, is_system) VALUES (?, 'SYSTEM', 'Night 1 has fallen. Use your abilities wisely!', 1)");
        $stmt->execute([$code]);

        sendJsonResponse(true, ["message" => "Game started."]);
        break;

    // --- SUBMIT ACTION ---
    case 'submit_action':
        $code       = trim($req['room_code'] ?? '');
        $actorId    = trim($req['player_id'] ?? '');
        $targetId   = trim($req['target_id'] ?? '');
        $actionType = trim($req['action_type'] ?? '');
        $phase      = trim($req['phase'] ?? 'NIGHT');

        if (empty($code) || empty($actorId) \vert{}\vert{} empty($targetId)) {
            sendJsonResponse(false, "Missing action parameters", 400);
        }

        $stmt =$pdo->prepare("INSERT INTO actions (room_code, actor_id, target_id, action_type, phase) VALUES (?, ?, ?, ?, ?)");
        $stmt->execute([$code, $actorId,$targetId, $actionType,$phase]);

        sendJsonResponse(true, ["message" => "Action recorded."]);
        break;

    default:
        sendJsonResponse(false, "Invalid action.", 400);
        break;
}
?>
