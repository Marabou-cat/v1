<?php
// battlepass_backend.php
session_start();
header('Content-Type: application/json');

// ==========================================
// 1. DATABASE CONNECTION (Via config.ini)
// ==========================================
$db_host = 'localhost';
$db_name = 'schoolexams_db'; // Ensure this matches your actual database name

// Read config.ini from the exact same folder as this script
$config_path = __DIR__ . '/config.ini';

if (!file_exists($config_path)) {
    echo json_encode(["success" => false, "message" => "Database config missing. Please create config.ini."]);
    exit;
}

// Read the file (Line 1 = User, Line 2 = Pass)
$config_lines = file($config_path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$db_user = isset($config_lines[0]) ? trim($config_lines[0]) : '';
$db_pass = isset($config_lines[1]) ? trim($config_lines[1]) : '';

try {
    $pdo = new PDO("mysql:host=$db_host;dbname=$db_name;charset=utf8mb4", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch(PDOException $e) {
    echo json_encode(["success" => false, "message" => "Database connection failed."]);
    exit;
}

$action = isset($_POST['action']) ? $_POST['action'] : '';

// Check if user is authenticated
if (!isset($_SESSION['username'])) {
    echo json_encode(["success" => false, "message" => "NOT_LOGGED_IN"]);
    exit;
}

$username = $_SESSION['username'];

// ==========================================
// ACTION: LOAD BATTLE PASS DATA
// ==========================================
if ($action === 'load') {
    $stmt = $pdo->prepare("SELECT coins, gems, playtime, owned_cursors, equipped_cursor, owned_pets, active_pet, pet_ages, bp_premium, bp_claimed_normal, bp_claimed_premium FROM users WHERE username = ?");
    $stmt->execute([$username]);
    $userData = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($userData) {
        echo json_encode(["success" => true, "data" => $userData]);
    } else {
        echo json_encode(["success" => false, "message" => "User profile not found."]);
    }
    exit;
}

// ==========================================
// ACTION: SAVE BATTLE PASS DATA
// ==========================================
if ($action === 'save') {
    $coins = isset($_POST['coins']) ? (int)$_POST['coins'] : 0;
    $gems = isset($_POST['gems']) ? (int)$_POST['gems'] : 0;
    $owned_cursors = isset($_POST['owned_cursors']) ? $_POST['owned_cursors'] : '["def"]';
    $owned_pets = isset($_POST['owned_pets']) ? $_POST['owned_pets'] : '[]';
    
    // Battle Pass Specific Data
    $bp_premium = isset($_POST['bp_premium']) ? $_POST['bp_premium'] : 'false';
    $bp_claimed_normal = isset($_POST['bp_claimed_normal']) ? $_POST['bp_claimed_normal'] : '[]';
    $bp_claimed_premium = isset($_POST['bp_claimed_premium']) ? $_POST['bp_claimed_premium'] : '[]';

    $stmt = $pdo->prepare("UPDATE users SET 
        coins = ?, gems = ?, 
        owned_cursors = ?, owned_pets = ?, 
        bp_premium = ?, bp_claimed_normal = ?, bp_claimed_premium = ? 
        WHERE username = ?");
        
    $success = $stmt->execute([
        $coins, $gems, $owned_cursors, $owned_pets, 
        $bp_premium, $bp_claimed_normal, $bp_claimed_premium, 
        $username
    ]);

    if ($success) {
        echo json_encode(["success" => true, "message" => "Battle Pass progress saved."]);
    } else {
        echo json_encode(["success" => false, "message" => "Database save failed."]);
    }
    exit;
}

echo json_encode(["success" => false, "message" => "Invalid action."]);
?>
