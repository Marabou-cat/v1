<?php
session_start();
header('Content-Type: application/json');

// --- 1. CONFIG & CONNECTION ---
$config_file = '../config.ini'; 
if (!file_exists($config_file)) {
    die(json_encode(["success" => false, "message" => "Server Error: Configuration file missing."]));
}

$lines = file($config_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
if (count($lines) < 2) {
    die(json_encode(["success" => false, "message" => "Server Error: Invalid configuration file format."]));
}

$db_host = 'localhost';
$db_name = 'schoolexams'; 
$db_user = trim($lines[0]); 
$db_pass = trim($lines[1]); 

try {
    $pdo = new PDO("mysql:host=$db_host;charset=utf8mb4", $db_user, $db_pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
    ]);
    
    $pdo->exec("CREATE DATABASE IF NOT EXISTS `$db_name` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    $pdo->exec("USE `$db_name`");

    $pdo->exec("CREATE TABLE IF NOT EXISTS `petgame_users` (
        `id` INT AUTO_INCREMENT PRIMARY KEY,
        `username` VARCHAR(50) NOT NULL UNIQUE,
        `password` VARCHAR(255) NOT NULL,
        `coins` INT DEFAULT 100,
        `balls` INT DEFAULT 5,
        `current_route` INT DEFAULT 1,
        `pos_x` FLOAT DEFAULT 1.5,
        `pos_y` FLOAT DEFAULT 15.0,
        `party_data` LONGTEXT NOT NULL,
        `pc_data` LONGTEXT NOT NULL DEFAULT '[]',
        `defeated_npcs` LONGTEXT NOT NULL DEFAULT '[]',
        `quest_data` LONGTEXT NOT NULL DEFAULT '{}',
        `last_online` BIGINT NOT NULL,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    // Ensure columns exist on older tables
    try { $pdo->exec("ALTER TABLE `petgame_users` ADD COLUMN `pos_x` FLOAT DEFAULT 1.5"); } catch (PDOException $e) {}
    try { $pdo->exec("ALTER TABLE `petgame_users` ADD COLUMN `pos_y` FLOAT DEFAULT 15.0"); } catch (PDOException $e) {}
    try { $pdo->exec("ALTER TABLE `petgame_users` ADD COLUMN `pc_data` LONGTEXT NOT NULL DEFAULT '[]'"); } catch (PDOException $e) {}
    try { $pdo->exec("ALTER TABLE `petgame_users` ADD COLUMN `defeated_npcs` LONGTEXT NOT NULL DEFAULT '[]'"); } catch (PDOException $e) {}
    try { $pdo->exec("ALTER TABLE `petgame_users` ADD COLUMN `quest_data` LONGTEXT NOT NULL DEFAULT '{}'"); } catch (PDOException $e) {}

} catch (PDOException $e) {
    die(json_encode(["success" => false, "message" => "Database connection failed: " . $e->getMessage()]));
}

$action = $_POST['action'] ?? '';

// --- 2. INSTANT RECONNECT & LOAD HELPER ---
if (($action === 'load' || $action === 'save') && !isset($_SESSION['pet_user_id']) && !empty($_POST['username'])) {
    $stmt = $pdo->prepare("SELECT * FROM petgame_users WHERE username = ?");
    $stmt->execute([$_POST['username']]);
    $user = $stmt->fetch();
    if ($user) {
        $_SESSION['pet_user_id'] = $user['id'];
        $_SESSION['pet_username'] = $user['username'];
    }
}

// --- 3. ACTIONS HANDLER ---
if ($action === 'register') {
    $username = trim($_POST['username'] ?? '');
    $password = $_POST['password'] ?? '';

    if (empty($username) || empty($password)) {
        echo json_encode(["success" => false, "message" => "Username and password are required."]);
        exit;
    }

    $hashedPassword = password_hash($password, PASSWORD_DEFAULT);
    $defaultParty = json_encode([]);
    $defaultPC = json_encode([]);
    $defaultNpcs = json_encode([]);
    $defaultQuest = json_encode({});
    $time = time();

    try {
        $stmt = $pdo->prepare("INSERT INTO petgame_users (username, password, party_data, pc_data, defeated_npcs, quest_data, last_online) VALUES (?, ?, ?, ?, ?, ?, ?)");
        $stmt->execute([$username, $hashedPassword, $defaultParty, $defaultPC, $defaultNpcs, $defaultQuest, $time]);
        echo json_encode(["success" => true, "message" => "Account registered successfully."]);
    } catch (PDOException $e) {
        echo json_encode(["success" => false, "message" => "Username already exists or database error."]);
    }
    exit;
}

if ($action === 'login') {
    $username = trim($_POST['username'] ?? '');
    $password = $_POST['password'] ?? '';

    $stmt = $pdo->prepare("SELECT * FROM petgame_users WHERE username = ?");
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    if ($user && password_verify($password, $user['password'])) {
        $_SESSION['pet_user_id'] = $user['id'];
        $_SESSION['pet_username'] = $user['username'];

        echo json_encode([
            "success" => true,
            "data" => [
                "username" => $user['username'],
                "coins" => (int)$user['coins'],
                "balls" => (int)$user['balls'],
                "current_route" => (int)$user['current_route'],
                "pos_x" => (float)$user['pos_x'],
                "pos_y" => (float)$user['pos_y'],
                "party_data" => $user['party_data'],
                "pc_data" => $user['pc_data'],
                "defeated_npcs" => $user['defeated_npcs'],
                "quest_data" => $user['quest_data']
            ]
        ]);
    } else {
        echo json_encode(["success" => false, "message" => "Invalid username or password."]);
    }
    exit;
}

if ($action === 'load') {
    $username = trim($_POST['username'] ?? '');
    if (empty($username)) {
        echo json_encode(["success" => false, "message" => "No username provided."]);
        exit;
    }

    $stmt = $pdo->prepare("SELECT * FROM petgame_users WHERE username = ?");
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    if ($user) {
        echo json_encode([
            "success" => true,
            "data" => [
                "username" => $user['username'],
                "coins" => (int)$user['coins'],
                "balls" => (int)$user['balls'],
                "current_route" => (int)$user['current_route'],
                "pos_x" => (float)$user['pos_x'],
                "pos_y" => (float)$user['pos_y'],
                "party_data" => $user['party_data'],
                "pc_data" => $user['pc_data'],
                "defeated_npcs" => $user['defeated_npcs'],
                "quest_data" => $user['quest_data']
            ]
        ]);
    } else {
        echo json_encode(["success" => false, "message" => "User data not found."]);
    }
    exit;
}

if ($action === 'save') {
    $username = trim($_POST['username'] ?? '');
    if (empty($username)) {
        echo json_encode(["success" => false, "message" => "No username provided."]);
        exit;
    }

    $coins = (int)($_POST['coins'] ?? 100);
    $balls = (int)($_POST['balls'] ?? 5);
    $current_route = (int)($_POST['current_route'] ?? 1);
    $pos_x = (float)($_POST['pos_x'] ?? 1.5);
    $pos_y = (float)($_POST['pos_y'] ?? 15.0);
    $party_data = $_POST['party_data'] ?? '[]';
    $pc_data = $_POST['pc_data'] ?? '[]';
    $defeated_npcs = $_POST['defeated_npcs'] ?? '[]';
    $quest_data = $_POST['quest_data'] ?? '{}';
    $time = time();

    try {
        $stmt = $pdo->prepare("UPDATE petgame_users SET coins = ?, balls = ?, current_route = ?, pos_x = ?, pos_y = ?, party_data = ?, pc_data = ?, defeated_npcs = ?, quest_data = ?, last_online = ? WHERE username = ?");
        $stmt->execute([$coins, $balls, $current_route, $pos_x, $pos_y, $party_data, $pc_data, $defeated_npcs, $quest_data, $time, $username]);
        echo json_encode(["success" => true, "message" => "Game saved successfully."]);
    } catch (PDOException $e) {
        echo json_encode(["success" => false, "message" => "Failed to save game data: " . $e->getMessage()]);
    }
    exit;
}

echo json_encode(["success" => false, "message" => "Invalid action."]);
?>
