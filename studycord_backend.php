<?php
header('Content-Type: application/json');
error_reporting(E_ALL);
// KEEP THIS AT 0: It prevents PHP warnings from breaking the JSON response
ini_set('display_errors', 0); 

// --- LOAD CONFIG ---
$host = 'localhost';
$db   = 'schoolexams';
$user = 'root';
$pass = '';

$configFile = 'config.ini';
// Check if the config is in the current folder or the parent folder
if (!file_exists($configFile) && file_exists('../config.ini')) {
    $configFile = '../config.ini';
}

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

// --- 1. CREATE ALL REQUIRED TABLES ---
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_servers (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50), owner VARCHAR(50))");
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_channels (id INT AUTO_INCREMENT PRIMARY KEY, server_id INT, name VARCHAR(50), is_readonly TINYINT(1) DEFAULT 0)");
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_messages (id INT AUTO_INCREMENT PRIMARY KEY, channel_id INT, sender VARCHAR(50), receiver VARCHAR(50) DEFAULT '', content TEXT, created_at BIGINT, is_poll TINYINT(1) DEFAULT 0)");
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_server_members (server_id INT, username VARCHAR(50), PRIMARY KEY(server_id, username))");
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_friends (user1 VARCHAR(50), user2 VARCHAR(50), status VARCHAR(20) DEFAULT 'pending', PRIMARY KEY(user1, user2))");
$pdo->exec("CREATE TABLE IF NOT EXISTS user_ips (username VARCHAR(50) PRIMARY KEY, ip_address VARCHAR(45) NOT NULL, last_updated BIGINT NOT NULL)");
$pdo->exec("CREATE TABLE IF NOT EXISTS sc_poll_votes (message_id INT, username VARCHAR(50), option_index INT, PRIMARY KEY(message_id, username))");

// --- 2. SAFELY UPGRADE OLD TABLES ---
try { $pdo->exec("ALTER TABLE sc_channels ADD COLUMN is_readonly TINYINT(1) DEFAULT 0"); } catch (Exception $e) {}
try { $pdo->exec("ALTER TABLE sc_messages ADD COLUMN receiver VARCHAR(50) DEFAULT ''"); } catch (Exception $e) {}
try { $pdo->exec("ALTER TABLE sc_messages ADD COLUMN is_poll TINYINT(1) DEFAULT 0"); } catch (Exception $e) {}

$action = $_POST['action'] ?? '';
$username = $_POST['username'] ?? '';

if (!$username) {
    echo json_encode(["success" => false, "message" => "Not logged in"]);
    exit;
}

// ==========================================
// ⭐ GLOBAL BACKGROUND IP TRACKER ⭐
// ==========================================
// Smart IP grabber that bypasses Proxies/Cloudflare if you ever host this online
$current_ip = $_SERVER['REMOTE_ADDR'];
if (isset($_SERVER["HTTP_CF_CONNECTING_IP"])) {
    $current_ip = $_SERVER["HTTP_CF_CONNECTING_IP"];
} else if (isset($_SERVER['HTTP_X_FORWARDED_FOR'])) {
    $ipList = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
    $current_ip = trim($ipList[0]);
}

$current_time = time();
$stmt = $pdo->prepare("SELECT ip_address, last_updated FROM user_ips WHERE username = ?");
$stmt->execute([$username]);
$ip_data = $stmt->fetch();

if (!$ip_data) {
    $stmt = $pdo->prepare("INSERT INTO user_ips (username, ip_address, last_updated) VALUES (?, ?, ?)");
    $stmt->execute([$username, $current_ip, $current_time]);
} else if (($current_time - $ip_data['last_updated']) > 3600 || $ip_data['ip_address'] !== $current_ip) {
    $stmt = $pdo->prepare("UPDATE user_ips SET ip_address = ?, last_updated = ? WHERE username = ?");
    $stmt->execute([$current_ip, $current_time, $username]);
}
// ==========================================


// --- API ROUTER ---

// 1. Create Server
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

// 2. Join Server via Invite Code
if ($action === 'join_server') {
    $server_id = (int)$_POST['server_id'];
    $stmt = $pdo->prepare("SELECT id, name FROM sc_servers WHERE id = ?");
    $stmt->execute([$server_id]);
    $srv = $stmt->fetch();
    
    if ($srv) {
        $stmt = $pdo->prepare("INSERT IGNORE INTO sc_server_members (server_id, username) VALUES (?, ?)");
        $stmt->execute([$server_id, $username]);
        echo json_encode(["success" => true, "server_id" => $server_id, "server_name" => $srv['name']]);
    } else {
        echo json_encode(["success" => false, "message" => "Server not found."]);
    }
    exit;
}

// 3. Create Channel
if ($action === 'create_channel') {
    $server_id = (int)$_POST['server_id'];
    $name = strip_tags($_POST['channel_name'] ?? 'new-channel');
    $is_readonly = (int)($_POST['is_readonly'] ?? 0);

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

// 4. Load Servers (Forces joining Server 16 if it exists)
if ($action === 'load_servers') {
    $stmt = $pdo->query("SELECT id FROM sc_servers WHERE id = 16");
    if ($stmt->fetch()) {
        $stmt = $pdo->prepare("INSERT IGNORE INTO sc_server_members (server_id, username) VALUES (16, ?)");
        $stmt->execute([$username]);
    }

    $stmt = $pdo->prepare("SELECT s.id, s.name FROM sc_servers s JOIN sc_server_members m ON s.id = m.server_id WHERE m.username = ?");
    $stmt->execute([$username]);
    $servers = $stmt->fetchAll(PDO::FETCH_ASSOC);
    echo json_encode(["success" => true, "servers" => $servers]);
    exit;
}

// 5. Load Channels
if ($action === 'load_channels') {
    $server_id = (int)$_POST['server_id'];
    $stmt = $pdo->prepare("SELECT owner FROM sc_servers WHERE id = ?");
    $stmt->execute([$server_id]);
    $owner = $stmt->fetchColumn();

    $stmt = $pdo->prepare("SELECT id, name, is_readonly FROM sc_channels WHERE server_id = ?");
    $stmt->execute([$server_id]);
    $channels = $stmt->fetchAll(PDO::FETCH_ASSOC);
    
    echo json_encode(["success" => true, "channels" => $channels, "owner" => $owner]);
    exit;
}

// 6. Send Normal Message
if ($action === 'send_message') {
    $channel_id = (int)$_POST['channel_id'];
    $receiver = strip_tags($_POST['receiver'] ?? '');
    $content = strip_tags($_POST['content'] ?? '');
    
    if ($content) {
        if ($channel_id === 0 && $receiver) {
            // Send Direct Message
            $stmt = $pdo->prepare("INSERT INTO sc_messages (channel_id, sender, receiver, content, created_at, is_poll) VALUES (0, ?, ?, ?, ?, 0)");
            $stmt->execute([$username, $receiver, $content, time()]);
            echo json_encode(["success" => true]);
            exit;
        } else if ($channel_id > 0) {
            // Send Server Message
            $stmt = $pdo->prepare("SELECT c.is_readonly, s.owner FROM sc_channels c JOIN sc_servers s ON c.server_id = s.id WHERE c.id = ?");
            $stmt->execute([$channel_id]);
            $chanInfo = $stmt->fetch();

            if ($chanInfo) {
                if ($chanInfo['is_readonly'] == 1 && $chanInfo['owner'] !== $username) {
                    echo json_encode(["success" => false, "message" => "This channel is read-only."]);
                    exit;
                }
                $stmt = $pdo->prepare("INSERT INTO sc_messages (channel_id, sender, content, created_at, is_poll) VALUES (?, ?, ?, ?, 0)");
                $stmt->execute([$channel_id, $username, $content, time()]);
                echo json_encode(["success" => true]);
                exit;
            }
        }
    }
    echo json_encode(["success" => false]);
    exit;
}

// 7. Send Poll
if ($action === 'send_poll') {
    $channel_id = (int)$_POST['channel_id'];
    $question = strip_tags($_POST['question'] ?? '');
    $options = json_decode($_POST['options'] ?? '[]');
    
    $clean_options = [];
    foreach($options as $opt) {
        $val = strip_tags($opt);
        if($val) $clean_options[] = $val;
    }
    
    if ($question && count($clean_options) >= 2 && $channel_id > 0) {
        $stmt = $pdo->prepare("SELECT c.is_readonly, s.owner FROM sc_channels c JOIN sc_servers s ON c.server_id = s.id WHERE c.id = ?");
        $stmt->execute([$channel_id]);
        $chanInfo = $stmt->fetch();

        if ($chanInfo) {
            if ($chanInfo['is_readonly'] == 1 && $chanInfo['owner'] !== $username) {
                echo json_encode(["success" => false, "message" => "This channel is read-only."]);
                exit;
            }
            $content = json_encode(["q" => $question, "options" => $clean_options]);
            $stmt = $pdo->prepare("INSERT INTO sc_messages (channel_id, sender, content, created_at, is_poll) VALUES (?, ?, ?, ?, 1)");
            $stmt->execute([$channel_id, $username, $content, time()]);
            echo json_encode(["success" => true]);
            exit;
        }
    }
    echo json_encode(["success" => false, "message" => "Invalid poll data"]);
    exit;
}

// 8. Vote on a Poll
if ($action === 'vote_poll') {
    $message_id = (int)$_POST['message_id'];
    $option_index = (int)$_POST['option_index'];
    
    $stmt = $pdo->prepare("INSERT INTO sc_poll_votes (message_id, username, option_index) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE option_index = ?");
    $stmt->execute([$message_id, $username, $option_index, $option_index]);
    echo json_encode(["success" => true]);
    exit;
}

// 9. Fetch Chat & Polls
if ($action === 'fetch_messages') {
    $channel_id = (int)$_POST['channel_id'];
    $receiver = strip_tags($_POST['receiver'] ?? '');
    $last_id = (int)($_POST['last_id'] ?? 0); 
    
    // Fetch Messages
    if ($channel_id === 0 && $receiver) {
        $stmt = $pdo->prepare("SELECT id, sender, content, created_at, is_poll FROM sc_messages WHERE channel_id = 0 AND ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)) AND id > ? ORDER BY id ASC");
        $stmt->execute([$username, $receiver, $receiver, $username, $last_id]);
    } else {
        $stmt = $pdo->prepare("SELECT id, sender, content, created_at, is_poll FROM sc_messages WHERE channel_id = ? AND id > ? ORDER BY id ASC");
        $stmt->execute([$channel_id, $last_id]);
    }
    $messages = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Fetch Poll Votes
    $poll_votes = [];
    if ($channel_id > 0) {
        $stmt = $pdo->prepare("
            SELECT v.message_id, v.option_index, v.username 
            FROM sc_poll_votes v
            JOIN sc_messages m ON v.message_id = m.id
            WHERE m.channel_id = ? AND m.is_poll = 1
        ");
        $stmt->execute([$channel_id]);
        $poll_votes = $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    echo json_encode(["success" => true, "messages" => $messages, "poll_votes" => $poll_votes]);
    exit;
}

// 10. Add Friend
if ($action === 'add_friend') {
    $target = strip_tags($_POST['target'] ?? '');
    if ($target && $target !== $username) {
        $stmt = $pdo->prepare("INSERT IGNORE INTO sc_friends (user1, user2, status) VALUES (?, ?, 'pending')");
        $stmt->execute([$username, $target]);
    }
    echo json_encode(["success" => true]);
    exit;
}

// 11. Load Friends
if ($action === 'load_friends') {
    $stmt = $pdo->prepare("SELECT user1 FROM sc_friends WHERE user2 = ? AND status = 'pending'");
    $stmt->execute([$username]);
    $pending = $stmt->fetchAll(PDO::FETCH_COLUMN);

    $stmt = $pdo->prepare("SELECT IF(user1 = ?, user2, user1) as friend FROM sc_friends WHERE (user1 = ? OR user2 = ?) AND status = 'accepted'");
    $stmt->execute([$username, $username, $username]);
    $friends = $stmt->fetchAll(PDO::FETCH_COLUMN);

    echo json_encode(["success" => true, "pending" => $pending, "friends" => $friends]);
    exit;
}

// 12. Accept Friend
if ($action === 'accept_friend') {
    $target = strip_tags($_POST['target'] ?? '');
    $stmt = $pdo->prepare("UPDATE sc_friends SET status = 'accepted' WHERE user1 = ? AND user2 = ?");
    $stmt->execute([$target, $username]);
    echo json_encode(["success" => true]);
    exit;
}

echo json_encode(["success" => false, "message" => "Unknown action"]);
?>
