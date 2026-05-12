<?php
header('Content-Type: application/json');
error_reporting(E_ALL);
ini_set('display_errors', 0);

// --- LOAD CONFIG ---
$host = 'localhost';
$db   = 'schoolexams';
$user = 'root';
$pass = '';

$configFile = 'config.ini';
if (file_exists($configFile)) {
    $lines = file($configFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (isset($lines[0])) $user = trim($lines[0]);
    if (isset($lines[1])) $pass = trim($lines[1]);
}

try {
    $pdo = new PDO("mysql:host=$host;dbname=$db;charset=utf8mb4", $user, $pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch(Exception $e) {
    echo json_encode(["success" => false, "message" => "DB Error"]);
    exit;
}

// --- CREATE TABLES IF MISSING ---
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_servers (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50), owner VARCHAR(50))");
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_channels (id INT AUTO_INCREMENT PRIMARY KEY, server_id INT, name VARCHAR(50))");
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_messages (id INT AUTO_INCREMENT PRIMARY KEY, channel_id INT, sender VARCHAR(50), content TEXT, created_at BIGINT)");
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_server_members (server_id INT, username VARCHAR(50), PRIMARY KEY(server_id, username))");
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_friends (user1 VARCHAR(50), user2 VARCHAR(50), status VARCHAR(20) DEFAULT 'pending', PRIMARY KEY(user1, user2))");

$action = $_POST['action'] ?? '';
$username = $_POST['username'] ?? '';

if (!$username) {
    echo json_encode(["success" => false, "message" => "Not logged in"]);
    exit;
}

// --- API ROUTER ---

// 1. Create a new Server
if ($action === 'create_server') {
    $name = strip_tags($_POST['server_name'] ?? 'New Server');
    
    // Insert Server
    $stmt = $pdo->prepare("INSERT INTO sc_servers (name, owner) VALUES (?, ?)");
    $stmt->execute([$name, $username]);
    $server_id = $pdo->lastInsertId();

    // Create default 'general' channel
    $stmt = $pdo->prepare("INSERT INTO sc_channels (server_id, name) VALUES (?, 'general')");
    $stmt->execute([$server_id]);

    // Add creator as member
    $stmt = $pdo->prepare("INSERT INTO sc_server_members (server_id, username) VALUES (?, ?)");
    $stmt->execute([$server_id, $username]);

    echo json_encode(["success" => true, "server_id" => $server_id]);
    exit;
}

// 2. Load User's Servers
if ($action === 'load_servers') {
    $stmt = $pdo->prepare("SELECT s.id, s.name FROM sc_servers s JOIN sc_server_members m ON s.id = m.server_id WHERE m.username = ?");
    $stmt->execute([$username]);
    $servers = $stmt->fetchAll(PDO::FETCH_ASSOC);
    echo json_encode(["success" => true, "servers" => $servers]);
    exit;
}

// 3. Load Channels for a Server
if ($action === 'load_channels') {
    $server_id = (int)$_POST['server_id'];
    $stmt = $pdo->prepare("SELECT id, name FROM sc_channels WHERE server_id = ?");
    $stmt->execute([$server_id]);
    $channels = $stmt->fetchAll(PDO::FETCH_ASSOC);
    echo json_encode(["success" => true, "channels" => $channels]);
    exit;
}

// 4. Send Message
if ($action === 'send_message') {
    $channel_id = (int)$_POST['channel_id'];
    $content = strip_tags($_POST['content'] ?? '');
    
    if ($content && $channel_id) {
        $stmt = $pdo->prepare("INSERT INTO sc_messages (channel_id, sender, content, created_at) VALUES (?, ?, ?, ?)");
        $stmt->execute([$channel_id, $username, $content, time()]);
    }
    echo json_encode(["success" => true]);
    exit;
}

// 5. Fetch Messages
if ($action === 'fetch_messages') {
    $channel_id = (int)$_POST['channel_id'];
    $last_time = (int)($_POST['last_time'] ?? 0);
    
    // Get messages newer than the last check
    $stmt = $pdo->prepare("SELECT id, sender, content, created_at FROM sc_messages WHERE channel_id = ? AND created_at > ? ORDER BY created_at ASC");
    $stmt->execute([$channel_id, $last_time]);
    $messages = $stmt->fetchAll(PDO::FETCH_ASSOC);
    
    echo json_encode(["success" => true, "messages" => $messages, "current_time" => time()]);
    exit;
}

// 6. Add Friend
if ($action === 'add_friend') {
    $target = strip_tags($_POST['target'] ?? '');
    if ($target && $target !== $username) {
        // Prevent duplicate requests
        $stmt = $pdo->prepare("REPLACE INTO sc_friends (user1, user2, status) VALUES (?, ?, 'pending')");
        $stmt->execute([$username, $target]);
    }
    echo json_encode(["success" => true]);
    exit;
}

echo json_encode(["success" => false, "message" => "Unknown action"]);
?>
