<?php
header('Content-Type: application/json');
error_reporting(E_ALL);
ini_set('display_errors', 0); // Hide errors from breaking JSON

// ==========================================
// 1. DATABASE CONFIGURATION
// ==========================================
$host = 'localhost';
$db   = 'schoolexams'; // Change this if your database name is different
$user = 'root';        // Fallback default
$pass = '';            // Fallback default

// Read the first line as username, second line as password
$configFile = 'config.ini';
if (file_exists($configFile)) {
    // Read file into an array, ignoring empty lines and newlines
    $lines = file($configFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    
    if (isset($lines[0])) {
        $user = trim($lines[0]);
    }
    if (isset($lines[1])) {
        $pass = trim($lines[1]);
    }
} else {
    echo json_encode(["success" => false, "message" => "Server Error: config.ini missing."]);
    exit;
}

try {
    $pdo = new PDO("mysql:host=$host;dbname=$db;charset=utf8mb4", $user, $pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch(Exception $e) {
    echo json_encode(["success" => false, "message" => "Database connection failed. Check config.ini credentials."]);
    exit;
}

// Automatically create tables if they don't exist
$pdo->exec("CREATE TABLE IF NOT EXISTS lobbies (
    room_code VARCHAR(6) PRIMARY KEY,
    room_name VARCHAR(30) DEFAULT 'Local Server',
    is_public TINYINT(1) DEFAULT 1,
    player_count INT DEFAULT 1
)");

$pdo->exec("CREATE TABLE IF NOT EXISTS lobby_players (
    username VARCHAR(50) PRIMARY KEY,
    room_code VARCHAR(6) NOT NULL,
    x INT DEFAULT 400,
    y INT DEFAULT 300,
    active_pet VARCHAR(50) DEFAULT '',
    last_update BIGINT NOT NULL
)");

$pdo->exec("CREATE TABLE IF NOT EXISTS lobby_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    room_code VARCHAR(6) NOT NULL,
    message VARCHAR(100) NOT NULL,
    created_at BIGINT NOT NULL
)");

// ==========================================
// 2. CRITICAL FIX: GHOST CLEANUP
// ==========================================
// Delete players who haven't pinged in the last 5 seconds (Tab closed, crashed, etc.)
$cutoff_time = time() - 5;
$pdo->exec("DELETE FROM lobby_players WHERE last_update < $cutoff_time");

// Dynamically update all room player counts to match reality
$pdo->exec("UPDATE lobbies l SET player_count = (SELECT COUNT(*) FROM lobby_players lp WHERE lp.room_code = l.room_code)");

// Delete empty rooms
$pdo->exec("DELETE FROM lobbies WHERE player_count <= 0");

// ==========================================
// 3. API ROUTER
// ==========================================
$action = $_POST['action'] ?? '';
$username = $_POST['username'] ?? 'Guest_' . rand(1000,9999);

if ($action === 'list_public') {
    $stmt = $pdo->query("SELECT * FROM lobbies WHERE is_public = 1 AND player_count > 0 LIMIT 20");
    $servers = $stmt->fetchAll(PDO::FETCH_ASSOC);
    echo json_encode(["success" => true, "servers" => $servers]);
    exit;
}

if ($action === 'create') {
    $room_code = strtoupper(substr(md5(uniqid()), 0, 6));
    $room_name = $_POST['room_name'] ?? "$username's Server";
    $is_public = $_POST['is_public'] ?? 1;

    $stmt = $pdo->prepare("INSERT INTO lobbies (room_code, room_name, is_public, player_count) VALUES (?, ?, ?, 1)");
    $stmt->execute([$room_code, $room_name, $is_public]);

    // Force player into room
    $stmt = $pdo->prepare("REPLACE INTO lobby_players (username, room_code, last_update) VALUES (?, ?, ?)");
    $stmt->execute([$username, $room_code, time()]);

    echo json_encode(["success" => true, "room_code" => $room_code]);
    exit;
}

if ($action === 'join') {
    $room_code = strtoupper($_POST['room_code'] ?? '');
    
    $stmt = $pdo->prepare("SELECT * FROM lobbies WHERE room_code = ?");
    $stmt->execute([$room_code]);
    if (!$stmt->fetch()) {
        echo json_encode(["success" => false, "message" => "Room not found or expired."]);
        exit;
    }

    $stmt = $pdo->prepare("REPLACE INTO lobby_players (username, room_code, last_update) VALUES (?, ?, ?)");
    $stmt->execute([$username, $room_code, time()]);
    
    echo json_encode(["success" => true, "room_code" => $room_code]);
    exit;
}

if ($action === 'sync') {
    $room_code = $_POST['room_code'] ?? '';
    $x = (int)($_POST['x'] ?? 400);
    $y = (int)($_POST['y'] ?? 300);
    $active_pet = $_POST['active_pet'] ?? '';

    // 1. Update this player's position and reset their death-timer
    $stmt = $pdo->prepare("UPDATE lobby_players SET x = ?, y = ?, active_pet = ?, last_update = ? WHERE username = ? AND room_code = ?");
    $stmt->execute([$x, $y, $active_pet, time(), $username, $room_code]);

    // 2. Fetch all other players in this room
    $stmt = $pdo->prepare("SELECT username, x, y, active_pet FROM lobby_players WHERE room_code = ?");
    $stmt->execute([$room_code]);
    $players = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // 3. Fetch recent chat messages (last 8 seconds only)
    $chat_cutoff = time() - 8;
    $stmt = $pdo->prepare("SELECT username, message FROM lobby_messages WHERE room_code = ? AND created_at >= ?");
    $stmt->execute([$room_code, $chat_cutoff]);
    $raw_messages = $stmt->fetchAll(PDO::FETCH_ASSOC);
    
    // Format messages for JS { "username1": "Hello", "username2": "Hi" }
    $messages = [];
    foreach($raw_messages as $msg) {
        $messages[$msg['username']] = $msg['message'];
    }

    echo json_encode(["success" => true, "players" => $players, "messages" => $messages]);
    exit;
}

if ($action === 'chat') {
    $room_code = $_POST['room_code'] ?? '';
    $message = substr(strip_tags($_POST['message'] ?? ''), 0, 50);

    if ($message && $room_code) {
        $stmt = $pdo->prepare("INSERT INTO lobby_messages (username, room_code, message, created_at) VALUES (?, ?, ?, ?)");
        $stmt->execute([$username, $room_code, $message, time()]);
    }
    echo json_encode(["success" => true]);
    exit;
}

if ($action === 'leave') {
    $stmt = $pdo->prepare("DELETE FROM lobby_players WHERE username = ?");
    $stmt->execute([$username]);
    echo json_encode(["success" => true]);
    exit;
}

echo json_encode(["success" => false, "message" => "Unknown action"]);
?>
