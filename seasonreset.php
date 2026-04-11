<?php
// admin_season_reset.php
session_start();

// 1. VERY IMPORTANT: Protect this page!
$admin_user = "Furry_Myrg"; // Change this to your exact login username

if (!isset($_SESSION['username']) || $_SESSION['username'] !== $admin_user) {
    die("<h1>❌ Access Denied</h1><p>You must be logged in as the administrator to run a seasonal reset.</p>");
}

// 2. Connect to Database (using your existing config.ini)
$config_path = __DIR__ . '/config.ini';

if (!file_exists($config_path)) {
    die("Error: config.ini missing.");
}

$config_lines = file($config_path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$db_user = isset($config_lines[0]) ? trim($config_lines[0]) : '';
$db_pass = isset($config_lines[1]) ? trim($config_lines[1]) : '';
$db_host = 'localhost';
$db_name = 'schoolexams'; // Ensure this matches your database name

try {
    $pdo = new PDO("mysql:host=$db_host;dbname=$db_name;charset=utf8mb4", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    
    // 3. Execute the Hard Reset
    // This resets the Battle Pass arrays, revokes Premium, AND wipes lifetime playtime to 0.
    $stmt = $pdo->prepare("UPDATE users SET 
        bp_premium = 'false', 
        bp_claimed_normal = '[]', 
        bp_claimed_premium = '[]', 
        playtime = 0");
        
    $stmt->execute();
    
    // 4. Success Output
    echo "<div style='font-family: sans-serif; text-align: center; margin-top: 50px;'>";
    echo "<h1 style='color: #3ba55c;'>✅ SUCCESS: SEASON RESET COMPLETE!</h1>";
    echo "<p>All players have had their Playtime reset to 0.</p>";
    echo "<p>Premium passes have been revoked, and all Battle Pass tiers are locked and ready to be claimed again.</p>";
    echo "<a href='index.html' style='display: inline-block; margin-top: 20px; padding: 10px 20px; background: #0077b6; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;'>Return to Portal</a>";
    echo "</div>";
    
} catch(PDOException $e) {
    echo "Database Error: " . $e->getMessage();
}
?>
