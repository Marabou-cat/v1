<?php
header('Content-Type: application/json');

// 1. Read credentials from config.ini (Line 1: User, Line 2: Pass)
$configFile = 'config.ini';
if (!file_exists($configFile)) {
    echo json_encode(['success' => false, 'message' => 'Config file missing.']);
    exit;
}

$configLines = file($configFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$dbUser = $configLines[0] ?? '';
$dbPass = $configLines[1] ?? '';
$dbHost = 'localhost';
$dbName = 'schoolexams';

// 2. Connect to the Database
try {
    $dsn = "mysql:host=$dbHost;dbname=$dbName;charset=utf8mb4";
    $pdo = new PDO($dsn, $dbUser, $dbPass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch (PDOException $e) {
    echo json_encode(['success' => false, 'message' => 'Database connection failed.']);
    exit;
}

// 3. Handle the Request
$action = $_POST['action'] ?? '';
$username = $_POST['username'] ?? '';

if ($action === 'enter_evolution_event') {
    if (empty($username)) {
        echo json_encode(['success' => false, 'message' => 'Username required.']);
        exit;
    }

    try {
        // Update the user's status to show they have entered the event
        $stmt = $pdo->prepare("UPDATE users SET has_entered_event = 1 WHERE username = :username");
        $stmt->execute([':username' => $username]);
        
        echo json_encode(['success' => true, 'message' => 'Event entry saved successfully.']);
    } catch (PDOException $e) {
        echo json_encode(['success' => false, 'message' => 'Failed to save event entry.']);
    }
    exit;
}

// Fallback for unknown actions
echo json_encode(['success' => false, 'message' => 'Invalid action.']);
?>
