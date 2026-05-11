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

$now = round(microtime(true) * 1000); // Current time in MS

// --- CREATE ROOM ---
if ($action === 'create') {
    $code = strtoupper(substr(md5(uniqid()), 0, 6)); // Random 6 letter code
    $pdo->prepare("INSERT INTO lobbies (room_code, player_count) VALUES (?, 1)")->execute([$code]);
    
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
    if ((int)$lobby['player_count'] >= 30) die(json_encode(["success" => false, "message" => "Room is full (Max 30)."]));

    $pdo->prepare("UPDATE lobbies SET player_count = player_count + 1 WHERE room_code = ?")->execute([$code]);
    
    $stmt = $pdo->prepare("INSERT INTO lobby_players (user_id, username, room_code, x, y, last_update) VALUES (?, ?, ?, 400, 300, ?) ON DUPLICATE KEY UPDATE room_code=?, last_update=?");
    $stmt->execute([$user_id, $username, $code, $now, $code, $now]);
    
    echo json_encode(["success" => true, "room_code" => $code]);
    exit;
}

// --- SEND MESSAGE ---
if ($action === 'chat') {
    $code = $_POST['room_code'] ?? '';
    $msg = substr(htmlspecialchars($_POST['message'] ?? ''), 0, 100); // Limit length and sanitize
    
    if ($msg && $code) {
        $stmt = $pdo->prepare("INSERT INTO lobby_messages (user_id, room_code, message, created_at) VALUES (?, ?, ?, ?)");
        $stmt->execute([$user_id, $code, $msg, $now]);
    }
    echo json_encode(["success" => true]);
    exit;
}

// --- SYNC STATE (Moves player, fetches others, deletes old stuff) ---
if ($action === 'sync') {
    $code = $_POST['room_code'] ?? '';
    $x = (int)($_POST['x'] ?? 400);
    $y = (int)($_POST['y'] ?? 300);

    // Update my position
    $stmt = $pdo->prepare("UPDATE lobby_players SET x=?, y=?, last_update=? WHERE user_id=?");
    $stmt->execute([$x, $y, $now, $user_id]);

    // Cleanup: Delete messages older than 10 seconds (10000ms)
    $pdo->prepare("DELETE FROM lobby_messages WHERE created_at < ?")->execute([$now - 10000]);

    // Cleanup: Remove players who haven't synced in 5 seconds (5000ms)
    $pdo->prepare("DELETE FROM lobby_players WHERE last_update < ?")->execute([$now - 5000]);

    // Fetch all active players in this room
    $stmtP = $pdo->prepare("SELECT user_id, username, x, y FROM lobby_players WHERE room_code = ?");
    $stmtP->execute([$code]);
    $players = $stmtP->fetchAll(PDO::FETCH_ASSOC);

    // Fetch latest active message for each player
    $stmtM = $pdo->prepare("
        SELECT user_id, message FROM lobby_messages 
        WHERE room_code = ? 
        AND id IN (SELECT MAX(id) FROM lobby_messages GROUP BY user_id)
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
