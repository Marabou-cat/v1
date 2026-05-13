<?php
header('Content-Type: application/json');
error_reporting(E_ALL);
ini_set('display_errors', 0);

// --- LOAD CONFIG ---
$host = 'localhost';
$db   = 'schoolexams';
$user = 'root';
$pass = '';

$configFile = '../config.ini'; // Path points to the main folder
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

// --- CREATE TABLES ---
$pdo->exec("CREATE TABLE IF NOT EXISTS user_ips (
    username VARCHAR(50) PRIMARY KEY,
    ip_address VARCHAR(45) NOT NULL,
    last_updated BIGINT NOT NULL
)");

$pdo->exec("CREATE TABLE IF NOT EXISTS invites (
    id INT AUTO_INCREMENT PRIMARY KEY,
    inviter VARCHAR(50) NOT NULL,
    invited_ip VARCHAR(45) NOT NULL,
    created_at BIGINT NOT NULL
)");

$action = $_POST['action'] ?? '';
$username = strip_tags($_POST['username'] ?? '');

if (!$username) {
    echo json_encode(["success" => false, "message" => "Not logged in"]);
    exit;
}

if ($action === 'init_invite_panel') {
    $current_ip = $_SERVER['REMOTE_ADDR'];
    $current_time = time();

    // 1. Check & Update IP (Only if 1 hour / 3600 seconds has passed)
    $stmt = $pdo->prepare("SELECT ip_address, last_updated FROM user_ips WHERE username = ?");
    $stmt->execute([$username]);
    $ip_data = $stmt->fetch();

    if (!$ip_data) {
        // First time logging IP
        $stmt = $pdo->prepare("INSERT INTO user_ips (username, ip_address, last_updated) VALUES (?, ?, ?)");
        $stmt->execute([$username, $current_ip, $current_time]);
    } else if (($current_time - $ip_data['last_updated']) > 3600 || $ip_data['ip_address'] !== $current_ip) {
        // Update IP if an hour has passed OR if their IP changed
        $stmt = $pdo->prepare("UPDATE user_ips SET ip_address = ?, last_updated = ? WHERE username = ?");
        $stmt->execute([$current_ip, $current_time, $username]);
    }

    // 2. Fetch total invites for this user
    $stmt = $pdo->prepare("SELECT COUNT(*) FROM invites WHERE inviter = ?");
    $stmt->execute([$username]);
    $total_invites = $stmt->fetchColumn();

    echo json_encode([
        "success" => true, 
        "total_invites" => $total_invites,
        "gems_earned" => $total_invites * 200
    ]);
    exit;
}

echo json_encode(["success" => false, "message" => "Unknown action"]);
?>
