<?php
session_start();
header('Content-Type: application/json');

// --- CONFIG & CONNECTION ---
$config_file = '../config.ini'; 

if (!file_exists($config_file)) {
    die(json_encode(["success" => false, "message" => "Server Error: Configuration missing."]));
}

$lines = file($config_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$db_user = trim($lines[0]);
$db_pass = trim($lines[1]);

try {
    $pdo = new PDO("mysql:host=localhost;dbname=schoolexams;charset=utf8mb4", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    
    // Auto-setup trade rooms table
    $pdo->exec("CREATE TABLE IF NOT EXISTS trade_rooms (
        id INT AUTO_INCREMENT PRIMARY KEY,
        room_code VARCHAR(10) NOT NULL UNIQUE,
        player1_id INT NOT NULL,
        player2_id INT DEFAULT NULL,
        p1_offer JSON,
        p2_offer JSON,
        p1_pet_ages JSON,
        p2_pet_ages JSON,
        p1_gems INT DEFAULT 0,
        p2_gems INT DEFAULT 0,
        p1_ready TINYINT(1) DEFAULT 0,
        p2_ready TINYINT(1) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'waiting',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    try {
        $pdo->exec("ALTER TABLE trade_rooms ADD COLUMN p1_pet_ages JSON AFTER p2_offer, ADD COLUMN p2_pet_ages JSON AFTER p1_pet_ages");
    } catch (Exception $e) { /* Ignore if columns already exist */ }

} catch (PDOException $e) {
    die(json_encode(["success" => false, "message" => "Database connection failed."]));
}

// --- SESSION LOCK RELEASE ---
if (!isset($_SESSION['user_id'])) die(json_encode(["success" => false, "message" => "Not logged in."]));
$user_id = $_SESSION['user_id'];
session_write_close(); // Kills the lag by letting other scripts run!

$action = $_POST['action'] ?? '';

// --- HELPER FUNCTIONS ---
function getRoom($pdo, $code) {
    $stmt = $pdo->prepare("SELECT * FROM trade_rooms WHERE room_code = ? LIMIT 1");
    $stmt->execute([$code]);
    return $stmt->fetch(PDO::FETCH_ASSOC);
}

function getUserData($pdo, $uid) {
    $stmt = $pdo->prepare("SELECT gems, owned_pets, owned_cursors, owned_items, pet_ages, active_pet, equipped_cursor FROM users WHERE id = ?");
    $stmt->execute([$uid]);
    return $stmt->fetch(PDO::FETCH_ASSOC);
}

// Transfer Logic Engine (Moved here so it's clean and globally accessible)
function transferItems($offer, &$from_pets, &$from_cursors, &$from_items, &$from_ages, &$from_active_pet, &$from_eq_cursor, &$to_pets, &$to_cursors, &$to_items, &$to_ages) {
    foreach($offer as $item) {
        if (strpos($item, 'item::') === 0) { 
            $itemName = substr($item, 6); 
            $idx = array_search($itemName, $from_items);
            if ($idx !== false) {
                array_splice($from_items, $idx, 1);
                $to_items[] = $itemName;
            }
        } else if (strpos($item, '::') !== false) { 
            $idx = array_search($item, $from_pets);
            if ($idx !== false) {
                array_splice($from_pets, $idx, 1);
                $to_pets[] = $item;
                if (isset($from_ages[$item])) {
                    $to_ages[$item] = $from_ages[$item];
                    unset($from_ages[$item]);
                }
                if ($from_active_pet === $item) $from_active_pet = '';
            }
        } else { 
            $idx = array_search($item, $from_cursors);
            if ($idx !== false) {
                array_splice($from_cursors, $idx, 1);
                $to_cursors[] = $item;
                if ($from_eq_cursor === $item) $from_eq_cursor = 'def';
            }
        }
    }
}

// --- CREATE ROOM ---
if ($action === 'create_room') {
    $code = strtoupper(substr(md5(uniqid(mt_rand(), true)), 0, 5));
    $stmt = $pdo->prepare("INSERT INTO trade_rooms (room_code, player1_id, p1_offer, p2_offer, p1_pet_ages, p2_pet_ages) VALUES (?, ?, '[]', '[]', '{}', '{}')");
    $stmt->execute([$code, $user_id]);
    echo json_encode(["success" => true, "room_code" => $code]);
    exit;
}

// --- JOIN ROOM ---
if ($action === 'join_room') {
    $code = $_POST['room_code'] ?? '';
    $room = getRoom($pdo, $code);
    
    if (!$room) die(json_encode(["success" => false, "message" => "Room not found."]));
    if ($room['status'] !== 'waiting') die(json_encode(["success" => false, "message" => "Room is no longer available."]));
    if ($room['player1_id'] == $user_id) {
        echo json_encode(["success" => true]); 
        exit;
    }
    if ($room['player2_id'] && $room['player2_id'] != $user_id) die(json_encode(["success" => false, "message" => "Room is full."]));

    $stmt = $pdo->prepare("UPDATE trade_rooms SET player2_id = ?, status = 'active' WHERE id = ?");
    $stmt->execute([$user_id, $room['id']]);
    echo json_encode(["success" => true]);
    exit;
}

// --- UPDATE OFFER ---
if ($action === 'update_offer') {
    $code = $_POST['room_code'] ?? '';
    $offer = $_POST['offer'] ?? '[]';
    $gems = (int)($_POST['gems'] ?? 0);
    $pet_ages = $_POST['pet_ages'] ?? '{}';
    
    $room = getRoom($pdo, $code);
    if (!$room) die(json_encode(["success" => false]));

    if ($room['player1_id'] == $user_id) {
        $stmt = $pdo->prepare("UPDATE trade_rooms SET p1_offer = ?, p1_gems = ?, p1_pet_ages = ?, p1_ready = 0, p2_ready = 0 WHERE id = ?");
        $stmt->execute([$offer, $gems, $pet_ages, $room['id']]);
    } else if ($room['player2_id'] == $user_id) {
        $stmt = $pdo->prepare("UPDATE trade_rooms SET p2_offer = ?, p2_gems = ?, p2_pet_ages = ?, p1_ready = 0, p2_ready = 0 WHERE id = ?");
        $stmt->execute([$offer, $gems, $pet_ages, $room['id']]);
    }
    
    echo json_encode(["success" => true]);
    exit;
}

// --- TOGGLE ACCEPT / EXECUTE TRADE ---
if ($action === 'toggle_accept') {
    $code = $_POST['room_code'] ?? '';
    $room = getRoom($pdo, $code);
    if (!$room) die(json_encode(["success" => false]));

    $p1_ready = $room['p1_ready'];
    $p2_ready = $room['p2_ready'];

    if ($room['player1_id'] == $user_id) {
        $p1_ready = $p1_ready ? 0 : 1;
        $stmt = $pdo->prepare("UPDATE trade_rooms SET p1_ready = ? WHERE id = ?");
        $stmt->execute([$p1_ready, $room['id']]);
    } else if ($room['player2_id'] == $user_id) {
        $p2_ready = $p2_ready ? 0 : 1;
        $stmt = $pdo->prepare("UPDATE trade_rooms SET p2_ready = ? WHERE id = ?");
        $stmt->execute([$p2_ready, $room['id']]);
    }

    // IF BOTH READY -> EXECUTE TRADE!
    if ($p1_ready && $p2_ready && $room['status'] !== 'completed') {
        try {
            $pdo->beginTransaction();

            // 1. LOCK THE ROOM
            $stmt = $pdo->prepare("SELECT status, p1_offer, p2_offer, p1_gems, p2_gems FROM trade_rooms WHERE id = ? FOR UPDATE");
            $stmt->execute([$room['id']]);
            $lockedRoom = $stmt->fetch(PDO::FETCH_ASSOC);

            if ($lockedRoom['status'] === 'completed' || $lockedRoom['status'] === 'processing') {
                $pdo->rollBack();
                echo json_encode(["success" => true]);
                exit;
            }

            $stmt = $pdo->prepare("UPDATE trade_rooms SET status='processing' WHERE id=?");
            $stmt->execute([$room['id']]);

            // 2. LOCK THE USERS
            $stmt = $pdo->prepare("SELECT id, gems, owned_pets, owned_cursors, owned_items, pet_ages, active_pet, equipped_cursor FROM users WHERE id IN (?, ?) FOR UPDATE");
            $stmt->execute([$room['player1_id'], $room['player2_id']]);
            $users = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $p1 = $users[0]['id'] == $room['player1_id'] ? $users[0] : $users[1];
            $p2 = $users[0]['id'] == $room['player2_id'] ? $users[0] : $users[1];

            // 3. GET OFFERS
            $p1_offer = json_decode($lockedRoom['p1_offer'], true) ?: [];
            $p2_offer = json_decode($lockedRoom['p2_offer'], true) ?: [];
            $p1_gems_offer = (int)$lockedRoom['p1_gems'];
            $p2_gems_offer = (int)$lockedRoom['p2_gems'];

            // Decode Player 1 Inv
            $p1_pets = json_decode($p1['owned_pets'], true) ?: [];
            $p1_cursors = json_decode($p1['owned_cursors'], true) ?: [];
            $p1_items = json_decode($p1['owned_items'], true) ?: [];
            $p1_ages = json_decode($p1['pet_ages'], true) ?: [];
            $p1_active_pet = $p1['active_pet'];
            $p1_equipped_cursor = $p1['equipped_cursor'];

            // Decode Player 2 Inv
            $p2_pets = json_decode($p2['owned_pets'], true) ?: [];
            $p2_cursors = json_decode($p2['owned_cursors'], true) ?: [];
            $p2_items = json_decode($p2['owned_items'], true) ?: []; 
            $p2_ages = json_decode($p2['pet_ages'], true) ?: [];
            $p2_active_pet = $p2['active_pet'];
            $p2_equipped_cursor = $p2['equipped_cursor'];

            // 4. SWAP ITEMS
            transferItems($p1_offer, $p1_pets, $p1_cursors, $p1_items, $p1_ages, $p1_active_pet, $p1_equipped_cursor, $p2_pets, $p2_cursors, $p2_items, $p2_ages);
            transferItems($p2_offer, $p2_pets, $p2_cursors, $p2_items, $p2_ages, $p2_active_pet, $p2_equipped_cursor, $p1_pets, $p1_cursors, $p1_items, $p1_ages);

            // 5. SWAP GEMS
            $p1_final_gems = max(0, $p1['gems'] - $p1_gems_offer + $p2_gems_offer);
            $p2_final_gems = max(0, $p2['gems'] - $p2_gems_offer + $p1_gems_offer);

            // 6. SAVE P1
            $stmt = $pdo->prepare("UPDATE users SET gems=?, owned_pets=?, owned_cursors=?, owned_items=?, pet_ages=?, active_pet=?, equipped_cursor=? WHERE id=?");
            $stmt->execute([$p1_final_gems, json_encode(array_values($p1_pets)), json_encode(array_values($p1_cursors)), json_encode(array_values($p1_items)), json_encode($p1_ages), $p1_active_pet, $p1_equipped_cursor, $room['player1_id']]);

            // 7. SAVE P2
            $stmt = $pdo->prepare("UPDATE users SET gems=?, owned_pets=?, owned_cursors=?, owned_items=?, pet_ages=?, active_pet=?, equipped_cursor=? WHERE id=?");
            $stmt->execute([$p2_final_gems, json_encode(array_values($p2_pets)), json_encode(array_values($p2_cursors)), json_encode(array_values($p2_items)), json_encode($p2_ages), $p2_active_pet, $p2_equipped_cursor, $room['player2_id']]);

            // 8. CLOSE ROOM
            $stmt = $pdo->prepare("UPDATE trade_rooms SET status='completed' WHERE id=?");
            $stmt->execute([$room['id']]);

            $pdo->commit();
        } catch (Exception $e) {
            $pdo->rollBack();
        }
    }

    echo json_encode(["success" => true]);
    exit;
}

// --- SYNC ROOM STATE ---
if ($action === 'sync') {
    $code = $_POST['room_code'] ?? '';
    $room = getRoom($pdo, $code);
    if (!$room) die(json_encode(["success" => false]));

    $is_p1 = ($room['player1_id'] == $user_id);
    
    $their_offer = json_decode($is_p1 ? $room['p2_offer'] : $room['p1_offer'], true) ?: [];
    $their_gems = $is_p1 ? $room['p2_gems'] : $room['p1_gems'];
    $their_pet_ages = $is_p1 ? ($room['p2_pet_ages'] ?? '{}') : ($room['p1_pet_ages'] ?? '{}');
    $my_accept = $is_p1 ? $room['p1_ready'] : $room['p2_ready'];
    $their_accept = $is_p1 ? $room['p2_ready'] : $room['p1_ready'];

    echo json_encode([
        "success" => true,
        "status" => $room['status'],
        "their_offer" => $their_offer,
        "their_gems" => $their_gems,
        "their_pet_ages" => $their_pet_ages,
        "my_accept" => (bool)$my_accept,
        "their_accept" => (bool)$their_accept
    ]);
    exit;
}
?>
