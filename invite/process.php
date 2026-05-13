<?php
error_reporting(E_ALL);
ini_set('display_errors', 0);

// --- LOAD CONFIG ---
$host = 'localhost';
$db   = 'schoolexams';
$user = 'root';
$pass = '';

$configFile = '../config.ini';
if (file_exists($configFile)) {
    $lines = file($configFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (isset($lines[0])) $user = trim($lines[0]);
    if (isset($lines[1])) $pass = trim($lines[1]);
}

try {
    $pdo = new PDO("mysql:host=$host;dbname=$db;charset=utf8mb4", $user, $pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch(Exception $e) {
    header("Location: ../index.html");
    exit;
}

$ref = strip_tags($_GET['ref'] ?? '');
$clicker_ip = $_SERVER['REMOTE_ADDR'];

if ($ref) {
    // 1. Check if this IP has ALREADY been invited by ANYONE
    $stmt = $pdo->prepare("SELECT id FROM invites WHERE invited_ip = ?");
    $stmt->execute([$clicker_ip]);
    
    if (!$stmt->fetch()) {
        // 2. Check the Inviter's IP (Prevent inviting yourself on the same network)
        $stmt = $pdo->prepare("SELECT ip_address FROM user_ips WHERE username = ?");
        $stmt->execute([$ref]);
        $inviter_data = $stmt->fetch();

        if ($inviter_data && $inviter_data['ip_address'] !== $clicker_ip) {
            
            // 3. Log the successful invite
            $stmt = $pdo->prepare("INSERT INTO invites (inviter, invited_ip, created_at) VALUES (?, ?, ?)");
            $stmt->execute([$ref, $clicker_ip, time()]);

            // 4. SAFELY REWARD GEMS (Read first to prevent overlaps)
            // Note: Make sure your main table is called `users` and the column is `gems`. Change if needed!
            try {
                $stmt = $pdo->prepare("SELECT gems FROM users WHERE username = ?");
                $stmt->execute([$ref]);
                $row = $stmt->fetch();

                if ($row !== false) {
                    $current_gems = (int)$row['gems'];
                    $new_gems = $current_gems + 200;

                    $update_stmt = $pdo->prepare("UPDATE users SET gems = ? WHERE username = ?");
                    $update_stmt->execute([$new_gems, $ref]);
                }
            } catch (Exception $e) {
                // Ignore errors if the 'users' table is named differently in your setup
            }
        }
    }
}

// Finally, redirect the new player to the main portal!
header("Location: ../index.html");
exit;
?>
