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
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_channels (id INT AUTO_INCREMENT PRIMARY KEY, server_id INT, name VARCHAR(50), is_readonly TINYINT(1) DEFAULT 0)");
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_messages (id INT AUTO_INCREMENT PRIMARY KEY, channel_id INT, sender VARCHAR(50), content TEXT, created_at BIGINT)");
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_server_members (server_id INT, username VARCHAR(50), PRIMARY KEY(server_id, username))");
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_friends (user1 VARCHAR(50), user2 VARCHAR(50), status VARCHAR(20) DEFAULT 'pending', PRIMARY KEY(user1, user2))");

// Upgrade existing tables safely if they were made in the previous version
try { $pdo->exec("ALTER TABLE sc_channels ADD COLUMN is_readonly TINYINT(1) DEFAULT 0"); } catch (Exception $e) {}

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
    
    $stmt = $pdo->prepare("INSERT INTO sc_servers (name, owner) VALUES (?, ?)");
    $stmt->execute([$name, $username]);
    $server_id = $pdo->lastInsertId();

    $stmt = $pdo->prepare("INSERT INTO sc_channels (server_id, name, is_readonly) VALUES (?, 'general', 0)");
    $stmt->execute([$server_id]);

    $stmt = $pdo->prepare("INSERT INTO sc_server_members (server_id, username) VALUES (?, ?)");
    $stmt->execute([$server_id, $username]);

    echo json_encode(["success" => true, "server_id" => $server_id]);
    exit;
}

// 2. Create a new Channel
if ($action === 'create_channel') {
    $server_id = (int)$_POST['server_id'];
    $name = strip_tags($_POST['channel_name'] ?? 'new-channel');
    $is_readonly = (int)($_POST['is_readonly'] ?? 0);

    // Verify ownership
    $stmt = $pdo->prepare("SELECT owner FROM sc_servers WHERE id = ?");
    $stmt->execute([$server_id]);
    $server = $stmt->fetch();

    if ($server && $server['owner'] === $username) {
        $stmt = $pdo->prepare("INSERT INTO sc_channels (server_id, name, is_readonly) VALUES (?, ?, ?)");
        $stmt->execute([$server_id, $name, $is_readonly]);
        echo json_encode(["success" => true]);
    } else {
        echo json_encode(["success" => false, "message" => "Only the server owner can create channels."]);
    }
    exit;
}

// 3. Load User's Servers (WITH AUTO-JOIN SERVER 16 LOGIC)
if ($action === 'load_servers') {
    
    // --- AUTO JOIN SERVER 16 LOGIC ---
    // Check if Server 16 exists first
    $stmt = $pdo->query("SELECT id FROM sc_servers WHERE id = 16");
    if ($stmt->fetch()) {
        // If it exists, force the user into the members list (IGNORE prevents errors if they are already in it)
        $stmt = $pdo->prepare("INSERT IGNORE INTO sc_server_members (server_id, username) VALUES (16, ?)");
        $stmt->execute([$username]);
    }
    // ----------------------------------

    $stmt = $pdo->prepare("SELECT s.id, s.name FROM sc_servers s JOIN sc_server_members m ON s.id = m.server_id WHERE m.username = ?");
    $stmt->execute([$username]);
    $servers = $stmt->fetchAll(PDO::FETCH_ASSOC);
    echo json_encode(["success" => true, "servers" => $servers]);
    exit;
}

// 4. Load Channels for a Server
if ($action === 'load_channels') {
    $server_id = (int)$_POST['server_id'];
    
    // Get owner to inform frontend who has permissions
    $stmt = $pdo->prepare("SELECT owner FROM sc_servers WHERE id = ?");
    $stmt->execute([$server_id]);
    $owner = $stmt->fetchColumn();

    $stmt = $pdo->prepare("SELECT id, name, is_readonly FROM sc_channels WHERE server_id = ?");
    $stmt->execute([$server_id]);
    $channels = $stmt->fetchAll(PDO::FETCH_ASSOC);
    
    echo json_encode(["success" => true, "channels" => $channels, "owner" => $owner]);
    exit;
}

// 5. Send Message
if ($action === 'send_message') {
    $channel_id = (int)$_POST['channel_id'];
    $content = strip_tags($_POST['content'] ?? '');
    
    if ($content && $channel_id) {
        // SECURITY: Check if channel is read-only and if sender is the owner
        $stmt = $pdo->prepare("SELECT c.is_readonly, s.owner FROM sc_channels c JOIN sc_servers s ON c.server_id = s.id WHERE c.id = ?");
        $stmt->execute([$channel_id]);
        $chanInfo = $stmt->fetch();

        if ($chanInfo) {
            // Block if read-only and user is NOT the owner
            if ($chanInfo['is_readonly'] == 1 && $chanInfo['owner'] !== $username) {
                echo json_encode(["success" => false, "message" => "This channel is read-only."]);
                exit;
            }

            $stmt = $pdo->prepare("INSERT INTO sc_messages (channel_id, sender, content, created_at) VALUES (?, ?, ?, ?)");
            $stmt->execute([$channel_id, $username, $content, time()]);
            echo json_encode(["success" => true]);
            exit;
        }
    }
    echo json_encode(["success" => false]);
    exit;
}

// 6. Fetch Messages
if ($action === 'fetch_messages') {
    $channel_id = (int)$_POST['channel_id'];
    $last_time = (int)($_POST['last_time'] ?? 0);
    
    $stmt = $pdo->prepare("SELECT id, sender, content, created_at FROM sc_messages WHERE channel_id = ? AND created_at > ? ORDER BY created_at ASC");
    $stmt->execute([$channel_id, $last_time]);
    $messages = $stmt->fetchAll(PDO::FETCH_ASSOC);
    
    echo json_encode(["success" => true, "messages" => $messages, "current_time" => time()]);
    exit;
}

// 7. Add Friend
if ($action === 'add_friend') {
    $target = strip_tags($_POST['target'] ?? '');
    if ($target && $target !== $username) {
        $stmt = $pdo->prepare("REPLACE INTO sc_friends (user1, user2, status) VALUES (?, ?, 'pending')");
        $stmt->execute([$username, $target]);
    }
    echo json_encode(["success" => true]);
    exit;
}

echo json_encode(["success" => false, "message" => "Unknown action"]);
?>
