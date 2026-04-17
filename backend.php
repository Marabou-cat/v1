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
    
    $prestige_level = (int)($_POST['prestige_level'] ?? 0);
    $profile_pic = $_POST['profile_pic'] ?? '';

    $stmt = $pdo->prepare("UPDATE users SET coins=?, gems=?, playtime=?, owned_cursors=?, equipped_cursor=?, owned_pets=?, active_pet=?, pet_ages=?, last_online=?, sakura_coins=?, event_tasks=?, owned_chests=?, prestige_level=?, profile_pic=? WHERE id=?");
    $stmt->execute([
        $coins, $gems, $playtime, $owned_cursors, $equipped_cursor, $owned_pets, $active_pet, $pet_ages, $last_online, $sakura_coins, $event_tasks, $owned_chests, $prestige_level, $profile_pic, $_SESSION['user_id']
    ]);

    echo json_encode(["success" => true]);
    exit;
}

// --- GET LEADERBOARD & DISTRIBUTE MONTHLY REWARDS ---
if ($action === 'get_leaderboard') {
    
    // 1. Check if the month has rolled over
    $current_month = date('Y-m'); // Example: "2026-04"
    $reward_file = 'last_reward_month.txt';
    $last_reward = file_exists($reward_file) ? file_get_contents($reward_file) : '';

    // If it's a new month, give out the rewards!
    if ($last_reward !== $current_month) {
        // Grab the top 10 players
        $top_stmt = $pdo->query("SELECT id, owned_pets, pet_ages FROM users ORDER BY prestige_level DESC, coins DESC LIMIT 10");
        $top_players = $top_stmt->fetchAll(PDO::FETCH_ASSOC);

        $pdo->beginTransaction();
        try {
            foreach ($top_players as $p) {
                $pets = json_decode($p['owned_pets'], true) ?: [];
                $ages = json_decode($p['pet_ages'], true) ?: [];
                
                // Ensure inventory cap isn't exceeded, or just force the reward in
                if (count($pets) < 50) {
                    // Generate unique Gem Beast pet ID
                    $uid = 'gb::' . round(microtime(true) * 1000) . '_' . mt_rand(100, 999);
                    $pets[] = $uid;
                    $ages[$uid] = 0; // Level 1
                    
                    $upd = $pdo->prepare("UPDATE users SET owned_pets = ?, pet_ages = ? WHERE id = ?");
                    $upd->execute([json_encode(array_values($pets)), json_encode($ages), $p['id']]);
                }
            }
            // Update the tracker file so it doesn't trigger again this month
            file_put_contents($reward_file, $current_month);
            $pdo->commit();
        } catch (Exception $e) {
            $pdo->rollBack();
        }
    }

    // 2. Fetch the Leaderboard normally
    $stmt = $pdo->query("SELECT username, prestige_level, profile_pic, coins FROM users ORDER BY prestige_level DESC, coins DESC LIMIT 100");
    $leaderboardData = $stmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode(["success" => true, "data" => $leaderboardData]);
    exit;
}

echo json_encode(["success" => false, "message" => "Invalid action."]);
?>
