<?php
session_start();
header('Content-Type: application/json');

// --- 1. CONFIG & SEPARATE DATABASE INITIALIZATION ---
$config_file = '../config.ini'; 
if (!file_exists($config_file)) {
    die(json_encode(["success" => false, "message" => "Server Error: Configuration file missing."]));
}

$lines = file($config_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
if (count($lines) < 2) {
    die(json_encode(["success" => false, "message" => "Server Error: Invalid configuration file format."]));
}

$db_host = 'localhost';
$db_name = 'petgame_db'; // Separate database isolated from schoolexams
$db_user = trim($lines[0]); 
$db_pass = trim($lines[1]); 

try {
    // Connect to MySQL server without selecting a DB first
    $pdo = new PDO("mysql:host=$db_host;charset=utf8mb4", $db_user, $db_pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
    ]);
    
    // Automatically create and select the isolated pet game database
    $pdo->exec("CREATE DATABASE IF NOT EXISTS `$db_name` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    $pdo->exec("USE `$db_name`");

    // Create the pet game users table if it does not exist
    $pdo->exec("CREATE TABLE IF NOT EXISTS `petgame_users` (
        `id` INT AUTO_INCREMENT PRIMARY KEY,
        `username` VARCHAR(50) NOT NULL UNIQUE,
        `password` VARCHAR(255) NOT NULL,
        `coins` INT DEFAULT 100,
        `balls` INT DEFAULT 5,
        `current_route` INT DEFAULT 1,
        `party_data` LONGTEXT NOT NULL,
        `last_online` BIGINT NOT NULL,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

} catch (PDOException $e) {
    die(json_encode(["success" => false, "message" => "Database connection failed: " . $e->getMessage()]));
}

$action = $_POST['action'] ?? '';

// --- 2. INSTANT RECONNECT HELPER ---
if (($action === 'load' || $action === 'save') && !isset($_SESSION['pet_user_id']) && !empty($_POST['username'])) {
    $stmt = $pdo->prepare("SELECT id, username FROM petgame_users WHERE username = ?");
    $stmt->execute([$_POST['username']]);
    $u = $stmt->fetch();
    if ($u) {
        $_SESSION['pet_user_id'] = $u['id'];
        $_SESSION['pet_username'] = $u['username'];
    }
}

// --- 3. REGISTER ---
if ($action === 'register') {
    $username = trim($_POST['username'] ?? '');
    $password = $_POST['password'] ?? '';

    if (strlen($username) < 3 || strlen($password) < 4) {
        die(json_encode(["success" => false, "message" => "Username must be >= 3 chars, Password >= 4 chars."]));
    }

    $stmt = $pdo->prepare("SELECT id FROM petgame_users WHERE username = ?");
    $stmt->execute([$username]);
    if ($stmt->fetch()) {
        die(json_encode(["success" => false, "message" => "Username already exists in Pet RPG!"]));
    }

    // Default starter pet structure
    $starter_party = [
        [
            "name" => "Emberkin",
            "level" => 5,
            "hp" => 45,
            "currentHp" => 45,
            "attack" => 52,
            "defense" => 43,
            "spAttack" => 60,
            "spDefense" => 50,
            "speed" => 65,
            "type" => "Fire"
        ]
    ];

    $hashed = password_hash($password, PASSWORD_DEFAULT);
    $stmt = $pdo->prepare("INSERT INTO petgame_users (username, password, party_data, last_online) VALUES (?, ?, ?, ?)");
    
    if ($stmt->execute([$username, $hashed, json_encode($starter_party), time() * 1000])) {
        $_SESSION['pet_user_id'] = $pdo->lastInsertId();
        $_SESSION['pet_username'] = $username;
        echo json_encode(["success" => true, "message" => "Registration successful!"]);
    } else {
        echo json_encode(["success" => false, "message" => "Error creating game account."]);
    }
    exit;
}

// --- 4. LOGIN ---
if ($action === 'login') {
    $username = trim($_POST['username'] ?? '');
    $password = $_POST['password'] ?? '';

    $stmt = $pdo->prepare("SELECT * FROM petgame_users WHERE username = ?");
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    if ($user && password_verify($password, $user['password'])) {
        $_SESSION['pet_user_id'] = $user['id'];
        $_SESSION['pet_username'] = $user['username'];
        
        // Decode JSON party data before sending back to client
        $user['party_data'] = json_decode($user['party_data'], true);
        unset($user['password']); // Exclude hashed password from response

        echo json_encode(["success" => true, "data" => $user]);
    } else {
        echo json_encode(["success" => false, "message" => "Invalid username or password."]);
    }
    exit;
}

// --- 5. LOAD GAME DATA ---
if ($action === 'load') {
    if (!isset($_SESSION['pet_user_id'])) {
        die(json_encode(["success" => false, "message" => "Not logged in."]));
    }

    $stmt = $pdo->prepare("SELECT id, username, coins, balls, current_route, party_data, last_online FROM petgame_users WHERE id = ?");
    $stmt->execute([$_SESSION['pet_user_id']]);
    $data = $stmt->fetch();
    
    if ($data) {
        $data['party_data'] = json_decode($data['party_data'], true);
        echo json_encode(["success" => true, "data" => $data]);
    } else {
        echo json_encode(["success" => false, "message" => "User data not found."]);
    }
    exit;
}

// --- 6. SAVE GAME DATA ---
if ($action === 'save') {
    if (!isset($_SESSION['pet_user_id'])) {
        die(json_encode(["success" => false, "message" => "Not logged in."]));
    }

    $coins = (int)($_POST['coins'] ?? 100);
    $balls = (int)($_POST['balls'] ?? 5);
    $current_route = (int)($_POST['current_route'] ?? 1);
    $party_data = $_POST['party_data'] ?? '[]';
    $last_online = time() * 1000;

    $stmt = $pdo->prepare("UPDATE petgame_users SET coins = ?, balls = ?, current_route = ?, party_data = ?, last_online = ? WHERE id = ?");
    $stmt->execute([$coins, $balls, $current_route, $party_data, $last_online, $_SESSION['pet_user_id']]);

    echo json_encode(["success" => true, "message" => "Progress saved successfully!"]);
    exit;
}

echo json_encode(["success" => false, "message" => "Invalid action."]);
?>
