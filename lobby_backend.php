<?php
session_start();
header('Content-Type: application/json');

$config_file = 'config.ini'; 
if (!file_exists($config_file)) die(json_encode(["success" => false, "message" => "Config missing."]));

$lines = file($config_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$db_user = trim($lines[0]); $db_pass = trim($lines[1]);

try {
    $pdo = new PDO("mysql:host=localhost;dbname=schoolexams;charset=utf8mb4", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch (PDOException $e) {
    die(json_encode(["success" => false, "message" => "Database connection failed."]));
}

if (!isset($_SESSION['user_id'])) die(json_encode(["success" => false, "message" => "Not logged in."]));
$user_id = $_SESSION['user_id'];
$username = $_SESSION['username'] ?? 'Guest';
$action = $_POST['action'] ?? '';

$now = round(microtime(true) * 1000); 

// --- FETCH PUBLIC SERVERS ---
if ($action === 'list_public') {
    // Clean up empty lobbies first
    $pdo->query("DELETE FROM lobbies WHERE player_count <= 0");
    
    // Fetch up to 10 public lobbies
    $stmt = $pdo->query("SELECT room_code, room_name, player_count FROM lobbies WHERE is_public = 1 AND player_count < 10 ORDER BY RAND() LIMIT 10");
    $servers = $stmt->fetchAll(PDO::FETCH_ASSOC);
    
    echo json_encode(["success" => true, "servers" => $servers]);
    exit;
}

// --- CREATE ROOM ---
if ($action === 'create') {
    $code = strtoupper(substr(md5(uniqid()), 0, 6)); 
    $room_name = substr(htmlspecialchars($_POST['room_name'] ?? 'My Server'), 0, 30);
    $is_public = (int)($_POST['is_public'] ?? 1);

    $pdo->prepare("INSERT INTO lobbies (room_code, room_name, is_public, player_count) VALUES (?, ?, ?, 1)")->execute([$code, $room_name, $is_public]);
    
    $stmt = $pdo->prepare("INSERT INTO lobby_players (user_id, username, room_code, x, y, last_update) VALUES (?, ?, ?, 400, 300, ?) ON DUPLICATE KEY UPDATE room_code=?, last_update=?");
    $stmt->execute([$user_id, $username, $code, $now, $code, $now]);
    
    echo json_encode(["success" => true, "room_code" => $code]);
    exit;
}

// --- JOIN ROOM ---
if ($action === 'join') {
    $code = strtoupper($_POST['room_code'] ?? '');
    
    $stmt = $pdo->prepare("SELECT player_count FROM lobbies WHERE room_code = ?");
    $stmt->execute([$code]);
    $lobby = $stmt->fetch();
    
    if (!$lobby) die(json_encode(["success" => false, "message" => "Room not found."]));
    if ((int)$lobby['player_count'] >= 10) die(json_encode(["success" => false, "message" => "Room is full (Max 10)."])); // LIMIT SET TO 10

    $pdo->prepare("UPDATE lobbies SET player_count = player_count + 1 WHERE room_code = ?")->execute([$code]);
    
    $stmt = $pdo->prepare("INSERT INTO lobby_players (user_id, username, room_code, x, y, last_update) VALUES (?, ?, ?, 400, 300, ?) ON DUPLICATE KEY UPDATE room_code=?, last_update=?");
    $stmt->execute([$user_id, $username, $code, $now, $code, $now]);
    
    echo json_encode(["success" => true, "room_code" => $code]);
    exit;
}

// --- SEND CHAT ---
if ($action === 'chat') {
    $code = $_POST['room_code'] ?? '';
    $msg = substr(htmlspecialchars($_POST['message'] ?? ''), 0, 100); 
    
    if ($msg && $code) {
        $stmt = $pdo->prepare("INSERT INTO lobby_messages (user_id, room_code, message, created_at) VALUES (?, ?, ?, ?)");
        $stmt->execute([$user_id, $code, $msg, $now]);
    }
    echo json_encode(["success" => true]);
    exit;
}

// --- SYNC STATE ---
if ($action === 'sync') {
    $code = $_POST['room_code'] ?? '';
    $x = (int)($_POST['x'] ?? 400);
    $y = (int)($_POST['y'] ?? 300);

    // Update my position
    $stmt = $pdo->prepare("UPDATE lobby_players SET x=?, y=?, last_update=? WHERE user_id=?");
    $stmt->execute([$x, $y, $now, $user_id]);

    // Cleanup old messages & idle players
    $pdo->prepare("DELETE FROM lobby_messages WHERE created_at < ?")->execute([$now - 10000]);
    $pdo->prepare("DELETE FROM lobby_players WHERE last_update < ?")->execute([$now - 5000]);

    // FETCH PLAYERS AND THEIR EQUIPPED PETS!
    $stmtP = $pdo->prepare("
        SELECT lp.user_id, lp.username, lp.x, lp.y, u.active_pet 
        FROM lobby_players lp 
        JOIN users u ON lp.user_id = u.id 
        WHERE lp.room_code = ?
    ");
    $stmtP->execute([$code]);
    $players = $stmtP->fetchAll(PDO::FETCH_ASSOC);

    $stmtM = $pdo->prepare("
        SELECT user_id, message FROM lobby_messages 
        WHERE room_code = ? AND id IN (SELECT MAX(id) FROM lobby_messages GROUP BY user_id)
    ");
    $stmtM->execute([$code]);
    
    $messages = [];
    foreach($stmtM->fetchAll(PDO::FETCH_ASSOC) as $m) {
        $messages[$m['user_id']] = $m['message'];
    }

    echo json_encode(["success" => true, "players" => $players, "messages" => $messages]);
    exit;
}

echo json_encode(["success" => false, "message" => "Invalid action."]);
?>
