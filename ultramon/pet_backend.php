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
function sendJsonResponse(bool $success, $dataOrMessage, int $httpCode = 200) {
    http_response_code($httpCode);
    $response = ['success' => $success];
    if ($success) {
        $response['data'] = $dataOrMessage['data'] ?? null;
        if (isset($dataOrMessage['message'])) {
            $response['message'] = $dataOrMessage['message'];
        }
    } else {
        $response['message'] = is_string($dataOrMessage) ? $dataOrMessage : ($dataOrMessage['message'] ?? 'An error occurred.');
    }
    echo json_encode($response, JSON_UNESCAPED_UNICODE);
    exit;
}

// Helper to safely parse JSON strings to native array/object for response payload
function parseJsonField($value) {
    if (is_array($value) || is_object($value)) {
        return $value;
    }
    $decoded = json_decode($value ?? '[]', true);
    return (json_last_error() === JSON_ERROR_NONE) ? $decoded : [];
}

// --- 1. CONFIG & CONNECTION ---
$config_file = '../config.ini'; 
if (!file_exists($config_file)) {
    sendJsonResponse(false, "Server Error: Configuration file missing.", 500);
}

$lines = file($config_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
if (count($lines) < 2) {
    sendJsonResponse(false, "Server Error: Invalid configuration file format.", 500);
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
        `last_online` BIGINT NOT NULL,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    try { $pdo->exec("ALTER TABLE `petgame_users` ADD COLUMN `pos_x` FLOAT DEFAULT 1.5"); } catch (PDOException $e) {}
    try { $pdo->exec("ALTER TABLE `petgame_users` ADD COLUMN `pos_y` FLOAT DEFAULT 15.0"); } catch (PDOException $e) {}
    try { $pdo->exec("ALTER TABLE `petgame_users` ADD COLUMN `pc_data` LONGTEXT NOT NULL DEFAULT '[]'"); } catch (PDOException $e) {}
    try { $pdo->exec("ALTER TABLE `petgame_users` ADD COLUMN `defeated_npcs` LONGTEXT NOT NULL DEFAULT '[]'"); } catch (PDOException $e) {}

} catch (PDOException $e) {
    sendJsonResponse(false, "Database connection failed: " . $e->getMessage(), 500);
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
        sendJsonResponse(false, "Username and password are required.", 400);
    }

    $hashedPassword = password_hash($password, PASSWORD_DEFAULT);
    $defaultParty = json_encode([]);
    $defaultPC = json_encode([]);
    $defaultNpcs = json_encode([]);
    $time = time();

    try {
        $stmt = $pdo->prepare("INSERT INTO petgame_users (username, password, party_data, pc_data, defeated_npcs, last_online) VALUES (?, ?, ?, ?, ?, ?)");
        $stmt->execute([$username, $hashedPassword, $defaultParty, $defaultPC, $defaultNpcs, $time]);
        sendJsonResponse(true, ["message" => "Account registered successfully."]);
    } catch (PDOException $e) {
        sendJsonResponse(false, "Username already exists or database error.", 400);
    }
}

if ($action === 'login') {
    $username = trim($_POST['username'] ?? '');
    $password = $_POST['password'] ?? '';

    if (empty($username) || empty($password)) {
        sendJsonResponse(false, "Username and password are required.", 400);
    }

    $stmt = $pdo->prepare("SELECT * FROM petgame_users WHERE username = ?");
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    if ($user && password_verify($password, $user['password'])) {
        $_SESSION['pet_user_id'] = $user['id'];
        $_SESSION['pet_username'] = $user['username'];

        sendJsonResponse(true, [
            "data" => [
                "username" => $user['username'],
                "coins" => (int)$user['coins'],
                "balls" => (int)$user['balls'],
                "current_route" => (int)$user['current_route'],
                "pos_x" => (float)$user['pos_x'],
                "pos_y" => (float)$user['pos_y'],
                "party_data" => parseJsonField($user['party_data']),
                "pc_data" => parseJsonField($user['pc_data']),
                "defeated_npcs" => parseJsonField($user['defeated_npcs'])
            ]
        ]);
    } else {
        sendJsonResponse(false, "Invalid username or password.", 401);
    }
}

if ($action === 'load') {
    $username = trim($_POST['username'] ?? '');
    if (empty($username)) {
        sendJsonResponse(false, "No username provided.", 400);
    }

    $stmt = $pdo->prepare("SELECT * FROM petgame_users WHERE username = ?");
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    if ($user) {
        sendJsonResponse(true, [
            "data" => [
                "username" => $user['username'],
                "coins" => (int)$user['coins'],
                "balls" => (int)$user['balls'],
                "current_route" => (int)$user['current_route'],
                "pos_x" => (float)$user['pos_x'],
                "pos_y" => (float)$user['pos_y'],
                "party_data" => parseJsonField($user['party_data']),
                "pc_data" => parseJsonField($user['pc_data']),
                "defeated_npcs" => parseJsonField($user['defeated_npcs'])
            ]
        ]);
    } else {
        sendJsonResponse(false, "User data not found.", 404);
    }
}

if ($action === 'save') {
    $username = trim($_POST['username'] ?? '');
    if (empty($username)) {
        sendJsonResponse(false, "No username provided.", 400);
    }

    $coins = (int)($_POST['coins'] ?? 100);
    $balls = (int)($_POST['balls'] ?? 5);
    $current_route = (int)($_POST['current_route'] ?? 1);
    $pos_x = (float)($_POST['pos_x'] ?? 1.5);
    $pos_y = (float)($_POST['pos_y'] ?? 15.0);

    // Normalize input to stored JSON strings
    $party_data = is_array($_POST['party_data'] ?? null) ? json_encode($_POST['party_data']) : ($_POST['party_data'] ?? '[]');
    $pc_data = is_array($_POST['pc_data'] ?? null) ? json_encode($_POST['pc_data']) : ($_POST['pc_data'] ?? '[]');
    $defeated_npcs = is_array($_POST['defeated_npcs'] ?? null) ? json_encode($_POST['defeated_npcs']) : ($_POST['defeated_npcs'] ?? '[]');
    $time = time();

    try {
        $stmt = $pdo->prepare("UPDATE petgame_users SET coins = ?, balls = ?, current_route = ?, pos_x = ?, pos_y = ?, party_data = ?, pc_data = ?, defeated_npcs = ?, last_online = ? WHERE username = ?");
        $stmt->execute([$coins, $balls, $current_route, $pos_x, $pos_y, $party_data, $pc_data, $defeated_npcs, $time, $username]);
        
        sendJsonResponse(true, [
            "message" => "Game saved successfully.",
            "data" => [
                "username" => $username,
                "coins" => $coins,
                "balls" => $balls,
                "current_route" => $current_route,
                "pos_x" => $pos_x,
                "pos_y" => $pos_y,
                "party_data" => parseJsonField($party_data),
                "pc_data" => parseJsonField($pc_data),
                "defeated_npcs" => parseJsonField($defeated_npcs)
            ]
        ]);
    } catch (PDOException $e) {
        sendJsonResponse(false, "Failed to save game data: " . $e->getMessage(), 500);
    }
}

sendJsonResponse(false, "Invalid action.", 400);
?>
