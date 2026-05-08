<?php
// Load database configuration
$config_file = 'config.ini'; 
if (!file_exists($config_file)) {
    die("Server Error: Configuration file missing.");
}

$lines = file($config_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
if (count($lines) < 2) {
    die("Server Error: Invalid configuration file format.");
}

$db_host = 'localhost';
$db_name = 'schoolexams';
$db_user = trim($lines[0]); 
$db_pass = trim($lines[1]); 

try {
    // Connect to the database
    $pdo = new PDO("mysql:host=$db_host;dbname=$db_name;charset=utf8mb4", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    
    // 1. Safely replace "VirusUSB" with "usb" in the JSON array for EVERYONE
    // We use \"VirusUSB\" to ensure we only replace the exact item in the list and don't break the JSON format
    $sql1 = "UPDATE users SET owned_cursors = REPLACE(owned_cursors, '\"VirusUSB\"', '\"usb\"')";
    $stmt1 = $pdo->prepare($sql1);
    $stmt1->execute();
    
    // 2. Safely fix anyone who currently has the broken cursor equipped
    $sql2 = "UPDATE users SET equipped_cursor = 'usb' WHERE equipped_cursor = 'VirusUSB'";
    $stmt2 = $pdo->prepare($sql2);
    $stmt2->execute();

    // 3. Optional fix (uncomment the next two lines if you also want to fix the "owned_items" inventory)
    // $sql3 = "UPDATE users SET owned_items = REPLACE(owned_items, '\"VirusUSB\"', '\"usb\"')";
    // $pdo->exec($sql3);

    // Output Success
    echo "<div style='font-family: sans-serif; text-align: center; margin-top: 50px;'>";
    echo "<h1 style='color: #3ba55c;'>✅ Fix Applied Successfully!</h1>";
    echo "<p>All instances of <strong>VirusUSB</strong> have been safely changed to <strong>usb</strong> in the database.</p>";
    echo "<p>Rows updated (Inventories): " . $stmt1->rowCount() . "</p>";
    echo "<p>Rows updated (Equipped): " . $stmt2->rowCount() . "</p>";
    echo "<br><p><em>You can now safely delete this file from your server.</em></p>";
    echo "</div>";

} catch (PDOException $e) {
    die("Database error: " . $e->getMessage());
}
?>
