<?php
session_start();
header('Content-Type: application/json');

// --- 1. CONFIG & CONNECTION (SCHOOLEXAMS DB) ---
$config_file = '../config.ini'; 
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
    $pdo = new PDO("mysql:host=$db_host;charset=utf8mb4", $db_user, $db_pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
    ]);
    
    $pdo->exec("CREATE DATABASE IF NOT EXISTS `$db_name` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    $pdo->exec("USE `$db_name`");

    $pdo->exec("CREATE TABLE IF NOT EXISTS `petgame_users` (
        `id` INT AUTO_INCREMENT PRIMARY KEY,
        `username` VARCHAR(50) NOT NULL UNIQUE,
        `password` VARCHAR(255) NOT NULL,
        `coins` INT DEFAULT 100,
        `balls` INT DEFAULT 5,
        `current_route` INT DEFAULT 1,
        `pos_x` FLOAT DEFAULT 1.5,
        `pos_y` FLOAT DEFAULT 15.0,
        `party_data` LONGTEXT NOT NULL,
        `last_online` BIGINT NOT NULL,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    // Create pet_box table for storing overflow and excess caught pets (Max 100 handled via logic)
    $pdo->exec("CREATE TABLE IF NOT EXISTS `pet_box` (
        `id` INT AUTO_INCREMENT PRIMARY KEY,
        `user_id` INT NOT NULL,
        `pet_data` LONGTEXT NOT NULL,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (`user_id`)
    )");

    // Safely ensure coordinate columns exist on older tables
    try { $pdo->exec("ALTER TABLE `petgame_users` ADD COLUMN `pos_x` FLOAT DEFAULT 1.5"); } catch (PDOException $e) {}
    try { $pdo->exec("ALTER TABLE `petgame_users` ADD COLUMN `pos_y` FLOAT DEFAULT 15.0"); } catch (PDOException $e) {}

} catch (PDOException $e) {
    die(json_encode(["success" => false, "message" => "Database connection failed: " . $e->getMessage()]));
}

// --- HELPER FUNCTION: GET PET BOX ---
function getUserPetBox($pdo, $user_id) {
    $stmt = $pdo->prepare("SELECT id, pet_data FROM pet_box WHERE user_id = ? ORDER BY id ASC");
    $stmt->execute([$user_id]);
    $rows = $stmt->fetchAll();
    $box = [];
    foreach ($rows as $row) {
        $pet = json_decode($row['pet_data'], true);
        if (is_array($pet)) {
            $pet['box_id'] = (int)$row['id']; // Attach database box ID for reference
            $box[] = $pet;
        }
    }
    return $box;
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

    $starter_party = [];
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
        
        $user['party_data'] = json_decode($user['party_data'], true);
        $user['pet_box'] = getUserPetBox($pdo, $user['id']);
        unset($user['password']);

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

    $stmt = $pdo->prepare("SELECT id, username, coins, balls, current_route, pos_x, pos_y, party_data, last_online FROM petgame_users WHERE id = ?");
    $stmt->execute([$_SESSION['pet_user_id']]);
    $data = $stmt->fetch();
    
    if ($data) {
        $data['party_data'] = json_decode($data['party_data'], true);
        $data['pet_box'] = getUserPetBox($pdo, $_SESSION['pet_user_id']);
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

    $user_id = $_SESSION['pet_user_id'];
    $coins = (int)($_POST['coins'] ?? 100);
    $balls = (int)($_POST['balls'] ?? 5);
    $current_route = (int)($_POST['current_route'] ?? 1);
    $pos_x = (float)($_POST['pos_x'] ?? 1.5);
    $pos_y = (float)($_POST['pos_y'] ?? 15.0);
    $party_data = $_POST['party_data'] ?? '[]';
    $pc_storage_data = $_POST['pc_storage'] ?? null;
    $last_online = time() * 1000;

    $stmt = $pdo->prepare("UPDATE petgame_users SET coins = ?, balls = ?, current_route = ?, pos_x = ?, pos_y = ?, party_data = ?, last_online = ? WHERE id = ?");
    $stmt->execute([$coins, $balls, $current_route, $pos_x, $pos_y, $party_data, $last_online, $user_id]);

    // Sync PC storage (pet_box table) if provided during save
    if ($pc_storage_data !== null) {
        $pc_array = json_decode($pc_storage_data, true);
        if (is_array($pc_array)) {
            $del_stmt = $pdo->prepare("DELETE FROM pet_box WHERE user_id = ?");
            $del_stmt->execute([$user_id]);

            $ins_stmt = $pdo->prepare("INSERT INTO pet_box (user_id, pet_data) VALUES (?, ?)");
            $count = 0;
            foreach ($pc_array as $pet) {
                if ($count >= 100) break;
                unset($pet['box_id']);
                $ins_stmt->execute([$user_id, json_encode($pet)]);
                $count++;
            }
        }
    }

    echo json_encode([
        "success" => true, 
        "message" => "Progress and PC storage saved successfully!",
        "pet_box" => getUserPetBox($pdo, $user_id)
    ]);
    exit;
}

// --- 7. ADD PET TO BOX (Overflow / Full Team Catch) ---
if ($action === 'add_to_box') {
    if (!isset($_SESSION['pet_user_id'])) {
        die(json_encode(["success" => false, "message" => "Not logged in."]));
    }

    $user_id = $_SESSION['pet_user_id'];

    // Enforce max 100 pets rule in box
    $stmt = $pdo->prepare("SELECT COUNT(*) FROM pet_box WHERE user_id = ?");
    $stmt->execute([$user_id]);
    $count = $stmt->fetchColumn();

    if ($count >= 100) {
        die(json_encode(["success" => false, "message" => "Pet Box is full! (Maximum 100 pets reached). Release pets to make space."]));
    }

    $pet_data = $_POST['pet_data'] ?? '';
    if (empty($pet_data)) {
        die(json_encode(["success" => false, "message" => "Invalid pet data provided."]));
    }

    if (is_array($pet_data)) {
        $pet_data = json_encode($pet_data);
    }

    $stmt = $pdo->prepare("INSERT INTO pet_box (user_id, pet_data) VALUES (?, ?)");
    if ($stmt->execute([$user_id, $pet_data])) {
        echo json_encode([
            "success" => true, 
            "message" => "Pet successfully sent to the Pet Box!", 
            "pet_box" => getUserPetBox($pdo, $user_id)
        ]);
    } else {
        echo json_encode(["success" => false, "message" => "Failed to store pet in box."]);
    }
    exit;
}

// --- 8. RELEASE PET FROM BOX ---
if ($action === 'release_pet') {
    if (!isset($_SESSION['pet_user_id'])) {
        die(json_encode(["success" => false, "message" => "Not logged in."]));
    }

    $box_id = (int)($_POST['box_id'] ?? 0);
    if ($box_id <= 0) {
        die(json_encode(["success" => false, "message" => "Invalid box ID."]));
    }

    $stmt = $pdo->prepare("DELETE FROM pet_box WHERE id = ? AND user_id = ?");
    $stmt->execute([$box_id, $_SESSION['pet_user_id']]);

    if ($stmt->rowCount() > 0) {
        echo json_encode([
            "success" => true, 
            "message" => "Pet released and made space in the box.", 
            "pet_box" => getUserPetBox($pdo, $_SESSION['pet_user_id'])
        ]);
    } else {
        echo json_encode(["success" => false, "message" => "Pet not found in your box."]);
    }
    exit;
}

// --- 9. SWAP PET BETWEEN TEAM (PARTY) AND BOX ---
if ($action === 'swap_pet') {
    if (!isset($_SESSION['pet_user_id'])) {
        die(json_encode(["success" => false, "message" => "Not logged in."]));
    }

    $user_id = $_SESSION['pet_user_id'];
    $party_index = (int)($_POST['party_index'] ?? -1);
    $box_id = (int)($_POST['box_id'] ?? -1);

    if ($party_index < 0 || $box_id <= 0) {
        die(json_encode(["success" => false, "message" => "Invalid swap configuration."]));
    }

    $stmt = $pdo->prepare("SELECT party_data FROM petgame_users WHERE id = ?");
    $stmt->execute([$user_id]);
    $user_row = $stmt->fetch();
    if (!$user_row) {
        die(json_encode(["success" => false, "message" => "User data not found."]));
    }

    $party = json_decode($user_row['party_data'], true);
    if (!isset($party[$party_index])) {
        die(json_encode(["success" => false, "message" => "Invalid party slot index."]));
    }

    $stmt_box = $pdo->prepare("SELECT id, pet_data FROM pet_box WHERE id = ? AND user_id = ?");
    $stmt_box->execute([$box_id, $user_id]);
    $box_row = $stmt_box->fetch();
    if (!$box_row) {
        die(json_encode(["success" => false, "message" => "Target pet not found in box."]));
    }

    $box_pet_data = json_decode($box_row['pet_data'], true);
    $party_pet_data = $party[$party_index];

    $update_box = $pdo->prepare("UPDATE pet_box SET pet_data = ? WHERE id = ? AND user_id = ?");
    $update_box->execute([json_encode($party_pet_data), $box_id, $user_id]);

    $party[$party_index] = $box_pet_data;

    $update_party = $pdo->prepare("UPDATE petgame_users SET party_data = ? WHERE id = ?");
    $update_party.execute([json_encode($party), $user_id]);

    echo json_encode([
        "success" => true,
        "message" => "Equipped pet successfully!",
        "party_data" => $party,
        "pet_box" => getUserPetBox($pdo, $user_id)
    ]);
    exit;
}

echo json_encode(["success" => false, "message" => "Invalid action."]);
?>
