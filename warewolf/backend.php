<?php
header('Content-Type: application/json');
session_start();

// 1. Read Database Credentials from ../config.ini
$configFile = '../config.ini';
if (!file_exists($configFile)) {
    die(json_encode([
        "status" => "error", 
        "message" => "Config file missing.", 
        "cutscene" => "scene_error_glitch"
    ]));
}

// Read file line by line, ignoring empty lines
$lines = file($configFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$db_user = $lines[0] ?? '';
$db_pass = $lines[1] ?? '';
$db_host = 'localhost';
$db_name = 'werewolf_db';

// 2. Connect to Database
try {
    $pdo = new PDO("mysql:host=$db_host;dbname=$db_name;charset=utf8", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch (PDOException $e) {
    die(json_encode([
        "status" => "error", 
        "message" => "Database connection failed.", 
        "cutscene" => "scene_server_crash"
    ]));
}

// 3. Helper: Role Calculation Rule
function calculateRoles($playerCount) {
    if ($playerCount < 4) return false;
    $werewolves = 1 + floor(($playerCount - 4) / 3);
    $specials = ($playerCount === 4) ? 0 : floor(($playerCount - 3) / 2);
    $villagers = $playerCount - ($werewolves + $specials);
    return ["werewolves" => $werewolves, "specials" => $specials, "villagers" => $villagers];
}

// 4. API Router
$action = $_POST['action'] ?? $_GET['action'] ?? '';

switch ($action) {
    case 'create_room':
        $host_id = session_id();
        $room_code = strtoupper(substr(md5(uniqid()), 0, 5));
        
        // TODO: Insert into database logic here
        
        echo json_encode([
            "status" => "success",
            "room_code" => $room_code,
            "cutscene" => "scene_room_created",
            "message" => "Lobby generated successfully."
        ]);
        break;

    case 'join_room':
        $room_code = $_POST['room_code'] ?? '';
        echo json_encode([
            "status" => "success",
            "cutscene" => "scene_door_open",
            "message" => "Joined room $room_code"
        ]);
        break;

    case 'start_game':
        $playerCount = (int)($_POST['player_count'] ?? 0);
        $roles = calculateRoles($playerCount);
        
        if (!$roles) {
            echo json_encode([
                "status" => "error",
                "message" => "Need at least 4 players.",
                "cutscene" => "scene_angry_mob"
            ]);
            exit;
        }

        echo json_encode([
            "status" => "success",
            "roles" => $roles,
            "cutscene" => "scene_night_falls",
            "message" => "The village goes to sleep..."
        ]);
        break;

    default:
        echo json_encode([
            "status" => "error",
            "message" => "Unknown action.",
            "cutscene" => "scene_confused_villager"
        ]);
        break;
}
?>
