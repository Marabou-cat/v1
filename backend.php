<?php
session_start();
header('Content-Type: application/json');

// --- READ CONFIG FILE ---
$config_file = 'config.ini'; 

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
    $pdo = new PDO("mysql:host=$db_host;dbname=$db_name;charset=utf8mb4", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    
    // Auto-create a small table to securely track server states (like the monthly reset)
    $pdo->exec("CREATE TABLE IF NOT EXISTS global_state (
        key_name VARCHAR(50) PRIMARY KEY,
        key_value VARCHAR(255)
    )");
    
} catch (PDOException $e) {
    die(json_encode(["success" => false, "message" => "Database connection failed."]));
}

$action = $_POST['action'] ?? '';

// --- REGISTER ---
if ($action === 'register') {
    $username = trim($_POST['username'] ?? '');
    $password = $_POST['password'] ?? '';

    if (strlen($username) < 3 || strlen($password) < 4) {
        echo json_encode(["success" => false, "message" => "Username >= 3 chars, Password >= 4 chars."]);
        exit;
    }

    $stmt = $pdo->prepare("SELECT id FROM users WHERE username = ?");
    $stmt->execute([$username]);
    if ($stmt->fetch()) {
        echo json_encode(["success" => false, "message" => "Username already exists!"]);
        exit;
    }

    $hashed = password_hash($password, PASSWORD_DEFAULT);
    $stmt = $pdo->prepare("INSERT INTO users (username, password, last_online) VALUES (?, ?, ?)");
    if ($stmt->execute([$username, $hashed, time() * 1000])) {
        $_SESSION['user_id'] = $pdo->lastInsertId();
        $_SESSION['username'] = $username;
        echo json_encode(["success" => true, "message" => "Registration successful!"]);
    } else {
        echo json_encode(["success" => false, "message" => "Error creating account."]);
    }
    exit;
}

// --- LOGIN ---
if ($action === 'login') {
    $username = trim($_POST['username'] ?? '');
    $password = $_POST['password'] ?? '';

    $stmt = $pdo->prepare("SELECT * FROM users WHERE username = ?");
    $stmt->execute([$username]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($user && password_verify($password, $user['password'])) {
        $_SESSION['user_id'] = $user['id'];
        $_SESSION['username'] = $user['username'];
        echo json_encode(["success" => true, "data" => $user]);
    } else {
        echo json_encode(["success" => false, "message" => "Invalid username or password."]);
    }
    exit;
}

// --- LOAD DATA ---
if ($action === 'load') {
    if (!isset($_SESSION['user_id'])) {
        echo json_encode(["success" => false, "message" => "Not logged in."]);
        exit;
    }

    $stmt = $pdo->prepare("SELECT coins, gems, playtime, owned_cursors, equipped_cursor, owned_pets, active_pet, pet_ages, last_online, sakura_coins, event_tasks, owned_chests, prestige_level, profile_pic FROM users WHERE id = ?");
    $stmt->execute([$_SESSION['user_id']]);
    $data = $stmt->fetch(PDO::FETCH_ASSOC);
    
    echo json_encode(["success" => true, "data" => $data]);
    exit;
}

// --- SAVE DATA ---
if ($action === 'save') {
    if (!isset($_SESSION['user_id'])) {
        echo json_encode(["success" => false, "message" => "Not logged in."]);
        exit;
    }

    // THE SAFETY NET: Grab the existing data first so we don't accidentally wipe it!
    $stmt = $pdo->prepare("SELECT prestige_level, profile_pic FROM users WHERE id = ?");
    $stmt->execute([$_SESSION['user_id']]);
    $existing = $stmt->fetch(PDO::FETCH_ASSOC);

    $coins = (int)$_POST['coins'];
    $gems = (int)$_POST['gems'];
    $playtime = (int)$_POST['playtime'];
    $owned_cursors = $_POST['owned_cursors'];
    $equipped_cursor = $_POST['equipped_cursor'];
    $owned_pets = $_POST['owned_pets'];
    $active_pet = $_POST['active_pet'];
    $pet_ages = $_POST['pet_ages'];
    $last_online = time() * 1000;
    
    $sakura_coins = (int)($_POST['sakura_coins'] ?? 0);
    $event_tasks = $_POST['event_tasks'] ?? '[]';
    $owned_chests = $_POST['owned_chests'] ?? '{}';
    
    // If the HTML page sending the save request (like Event or Evolve) didn't include prestige/pfp, 
    // it will automatically fallback to whatever is already saved in the database!
    $prestige_level = isset($_POST['prestige_level']) ? (int)$_POST['prestige_level'] : (int)$existing['prestige_level'];
    $profile_pic = isset($_POST['profile_pic']) ? $_POST['profile_pic'] : $existing['profile_pic'];

    $stmt = $pdo->prepare("UPDATE users SET coins=?, gems=?, playtime=?, owned_cursors=?, equipped_cursor=?, owned_pets=?, active_pet=?, pet_ages=?, last_online=?, sakura_coins=?, event_tasks=?, owned_chests=?, prestige_level=?, profile_pic=? WHERE id=?");
    $stmt->execute([
        $coins, $gems, $playtime, $owned_cursors, $equipped_cursor, $owned_pets, $active_pet, $pet_ages, $last_online, $sakura_coins, $event_tasks, $owned_chests, $prestige_level, $profile_pic, $_SESSION['user_id']
    ]);

    echo json_encode(["success" => true]);
    exit;
}

// --- GET LEADERBOARD & DISTRIBUTE MONTHLY REWARDS ---
if ($action === 'get_leaderboard') {
    
    // 1. Check if the month has rolled over (Using Database)
    $current_month = date('Y-m'); // Example: "2026-04"
    
    $stmt = $pdo->query("SELECT key_value FROM global_state WHERE key_name = 'last_reward_month'");
    $last_reward = $stmt->fetchColumn() ?: '';

    // If it's a new month in the database, give out the rewards!
    if ($last_reward !== $current_month) {
        $pdo->beginTransaction();
        try {
            // Grab the top 10 players
            $top_stmt = $pdo->query("SELECT id, owned_pets, pet_ages FROM users ORDER BY prestige_level DESC, coins DESC LIMIT 10");
            $top_players = $top_stmt->fetchAll(PDO::FETCH_ASSOC);

            foreach ($top_players as $p) {
                $pets = json_decode($p['owned_pets'], true) ?: [];
                $ages = json_decode($p['pet_ages'], true) ?: [];
                
                // Prevent going over the 50 pet limit
                if (count($pets) < 50) {
                    // Generate unique Gem Beast pet ID
                    $uid = 'gb::' . round(microtime(true) * 1000) . '_' . mt_rand(100, 999);
                    $pets[] = $uid;
                    $ages[$uid] = 0; // Level 1
                    
                    $upd = $pdo->prepare("UPDATE users SET owned_pets = ?, pet_ages = ? WHERE id = ?");
                    $upd->execute([json_encode(array_values($pets)), json_encode($ages), $p['id']]);
                }
            }
            
            // Save the current month into the database so it doesn't trigger again!
            $stmt = $pdo->prepare("INSERT INTO global_state (key_name, key_value) VALUES ('last_reward_month', ?) ON DUPLICATE KEY UPDATE key_value = ?");
            $stmt->execute([$current_month, $current_month]);
            
            $pdo->commit();
        } catch (Exception $e) {
            $pdo->rollBack();
        }
    }

    // 2. Fetch the Leaderboard normally (Ranked by Prestige first, then Coins)
    $stmt = $pdo->query("SELECT username, prestige_level, profile_pic, coins FROM users ORDER BY prestige_level DESC, coins DESC LIMIT 100");
    $leaderboardData = $stmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode(["success" => true, "data" => $leaderboardData]);
    exit;
}

echo json_encode(["success" => false, "message" => "Invalid action."]);
?>
