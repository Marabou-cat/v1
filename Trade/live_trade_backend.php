<?php
session_start();
header('Content-Type: application/json');

// --- READ CONFIG FILE ---
$config_file = '../config.ini';

if (!file_exists($config_file)) {
    die(json_encode(["success" => false, "message" => "Server Error: Configuration file missing."]));
}

$lines = file($config_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
if (count($lines) < 2) {
    die(json_encode(["success" => false, "message" => "Server Error: Invalid configuration file format."]));
}

$db_user = trim($lines[0]);
$db_pass = trim($lines[1]);

// --- ESTABLISH DATABASE CONNECTION ---
try {
    $pdo = new PDO("mysql:host=localhost;dbname=schoolexams;charset=utf8mb4", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch (PDOException $e) {
    die(json_encode(["success" => false, "message" => "Database connection failed."]));
}

// Security Check: Must be logged in to access the trade API
if (!isset($_SESSION['user_id'])) {
    die(json_encode(["success" => false, "message" => "Not logged in."]));
}

$action = $_POST['action'] ?? '';
$user_id = $_SESSION['user_id'];

// --- 0. GET REAL INVENTORY ---
if ($action === 'get_inventory') {
    $stmt = $pdo->prepare("SELECT owned_cursors, owned_pets, gems FROM users WHERE id = ?");
    $stmt->execute([$user_id]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);
    
    if (!$user) {
        echo json_encode(["success" => true, "inventory" => [], "gems" => 0]);
        exit;
    }

    $cursors = json_decode($user['owned_cursors'], true);
    $pets = json_decode($user['owned_pets'], true);
    
    // Bulletproof array enforcement 
    if (!is_array($cursors)) $cursors = [];
    if (!is_array($pets)) $pets = [];
    
    // Merge, remove duplicates, and reset keys
    $combined = array_values(array_unique(array_merge($cursors, $pets)));
    
    echo json_encode(["success" => true, "inventory" => $combined, "gems" => (int)$user['gems']]);
    exit;
}

// --- 1. HOST A ROOM (With Automatic Cleanup) ---
if ($action === 'create_room') {
    
    // 🧹 THE JANITOR: Clean up dead rooms before creating a new one!
    // This keeps your database small and fast.
    $cleanup_stmt = $pdo->prepare("
        DELETE FROM trade_sessions 
        WHERE status = 'completed' 
        OR created_at < NOW() - INTERVAL 24 HOUR
    ");
    $cleanup_stmt->execute();

    // Generate room code and create room
    $code = substr(str_shuffle("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), 0, 6);
    $stmt = $pdo->prepare("INSERT INTO trade_sessions (room_code, p1_id) VALUES (?, ?)");
    $stmt->execute([$code, $user_id]);
    
    echo json_encode(["success" => true, "room_code" => $code]);
    exit;
}

// --- 2. JOIN A ROOM ---
if ($action === 'join_room') {
    $code = strtoupper(trim($_POST['room_code']));
    
    // Only allow joining if room is waiting and the user isn't already player 1
    $stmt = $pdo->prepare("UPDATE trade_sessions SET p2_id = ?, status = 'trading' WHERE room_code = ? AND status = 'waiting' AND p1_id != ?");
    $stmt->execute([$user_id, $code, $user_id]);
    
    if ($stmt->rowCount() > 0) {
        echo json_encode(["success" => true, "room_code" => $code]);
    } else {
        echo json_encode(["success" => false, "message" => "Invalid room or already full."]);
    }
    exit;
}

// --- 3. SYNC DATA ---
if ($action === 'sync') {
    $code = $_POST['room_code'];
    $stmt = $pdo->prepare("SELECT * FROM trade_sessions WHERE room_code = ?");
    $stmt->execute([$code]);
    $room = $stmt->fetch(PDO::FETCH_ASSOC);
    
    if (!$room) die(json_encode(["success" => false, "message" => "Room closed."]));

    $is_p1 = ($room['p1_id'] == $user_id);
    
    // Decode item offers
    $my_offer = json_decode($is_p1 ? $room['p1_offer'] : $room['p2_offer'], true);
    $their_offer = json_decode($is_p1 ? $room['p2_offer'] : $room['p1_offer'], true);
    
    // Get gem offers
    $my_gems = $is_p1 ? $room['p1_gems'] : $room['p2_gems'];
    $their_gems = $is_p1 ? $room['p2_gems'] : $room['p1_gems'];
    
    echo json_encode([
        "success" => true,
        "status" => $room['status'],
        "my_offer" => is_array($my_offer) ? $my_offer : [],
        "their_offer" => is_array($their_offer) ? $their_offer : [],
        "my_gems" => (int)$my_gems,
        "their_gems" => (int)$their_gems,
        "my_accept" => $is_p1 ? $room['p1_accept'] : $room['p2_accept'],
        "their_accept" => $is_p1 ? $room['p2_accept'] : $room['p1_accept']
    ]);
    exit;
}

// --- 4. UPDATE OFFER ---
if ($action === 'update_offer') {
    $code = $_POST['room_code'];
    $offer = $_POST['offer']; 
    $gems = (int)($_POST['gems'] ?? 0); 
    
    $stmt = $pdo->prepare("SELECT p1_id FROM trade_sessions WHERE room_code = ?");
    $stmt->execute([$code]);
    $room = $stmt->fetch(PDO::FETCH_ASSOC);
    
    $offer_col = ($room['p1_id'] == $user_id) ? 'p1_offer' : 'p2_offer';
    $gems_col = ($room['p1_id'] == $user_id) ? 'p1_gems' : 'p2_gems';
    
    // Whenever an offer changes, un-ready both players for safety
    $stmt = $pdo->prepare("UPDATE trade_sessions SET $offer_col = ?, $gems_col = ?, p1_accept = 0, p2_accept = 0 WHERE room_code = ?");
    $stmt->execute([$offer, $gems, $code]);
    
    echo json_encode(["success" => true]);
    exit;
}

// --- 5. TOGGLE ACCEPT & EXECUTE ACTUAL SWAP ---
if ($action === 'toggle_accept') {
    $code = $_POST['room_code'];
    
    try {
        $pdo->beginTransaction();
        
        $stmt = $pdo->prepare("SELECT * FROM trade_sessions WHERE room_code = ? FOR UPDATE");
        $stmt->execute([$code]);
        $room = $stmt->fetch(PDO::FETCH_ASSOC);
        
        $is_p1 = ($room['p1_id'] == $user_id);
        $my_accept_col = $is_p1 ? 'p1_accept' : 'p2_accept';
        $their_accept_col = $is_p1 ? 'p2_accept' : 'p1_accept';
        
        $new_status = $is_p1 ? !$room['p1_accept'] : !$room['p2_accept'];
        $stmt = $pdo->prepare("UPDATE trade_sessions SET $my_accept_col = ? WHERE room_code = ?");
        $stmt->execute([(int)$new_status, $code]);
        
        // IF BOTH USERS ARE READY -> EXECUTE TRADE
        if ($new_status == true && $room[$their_accept_col] == 1) {
            
            $p1_id = $room['p1_id'];
            $p2_id = $room['p2_id'];
            
            $p1_offer = json_decode($room['p1_offer'], true);
            $p2_offer = json_decode($room['p2_offer'], true);
            
            $p1_gems_offered = (int)$room['p1_gems'];
            $p2_gems_offered = (int)$room['p2_gems'];
            
            if(!is_array($p1_offer)) $p1_offer = [];
            if(!is_array($p2_offer)) $p2_offer = [];

            // Master list of tradeable IDs
            $item_types = [
                'midas' => 'pet', 'phoenix' => 'pet', 'gb' => 'pet',
                'dragon' => 'cursor', 'prism' => 'cursor',
                'bp1' => 'cursor', 'bp2' => 'cursor', 'bp3' => 'cursor', 
                'bp4' => 'cursor', 'bp5' => 'cursor', 'bp6' => 'cursor',
                'gb' => 'pet', 'hs' => 'pet', 'gs' => 'pet', 'stick' => 'cursor'
            ];

            function processTrade($pdo, $uid, $giving_items, $receiving_items, $giving_gems, $receiving_gems, $item_types) {
                $stmt = $pdo->prepare("SELECT owned_cursors, owned_pets, gems FROM users WHERE id = ? FOR UPDATE");
                $stmt->execute([$uid]);
                $u = $stmt->fetch(PDO::FETCH_ASSOC);

                $cursors = json_decode($u['owned_cursors'], true);
                $pets = json_decode($u['owned_pets'], true);
                $current_gems = (int)$u['gems'];
                
                if (!is_array($cursors)) $cursors = [];
                if (!is_array($pets)) $pets = [];

                // Process Items
                foreach ($giving_items as $item) {
                    $type = $item_types[$item] ?? null;
                    if ($type === 'cursor') $cursors = array_diff($cursors, [$item]);
                    if ($type === 'pet') $pets = array_diff($pets, [$item]);
                }

                foreach ($receiving_items as $item) {
                    $type = $item_types[$item] ?? null;
                    if ($type === 'cursor' && !in_array($item, $cursors)) $cursors[] = $item;
                    if ($type === 'pet' && !in_array($item, $pets)) $pets[] = $item;
                }
                
                // Process Gems (Subtract given, add received)
                $new_gems = $current_gems - $giving_gems + $receiving_gems;
                
                if ($new_gems < 0) {
                    throw new Exception("Insufficient gems to complete transaction.");
                }

                $stmt = $pdo->prepare("UPDATE users SET owned_cursors = ?, owned_pets = ?, gems = ? WHERE id = ?");
                $stmt->execute([json_encode(array_values($cursors)), json_encode(array_values($pets)), $new_gems, $uid]);
            }

            // Run the trade logic for both players
            processTrade($pdo, $p1_id, $p1_offer, $p2_offer, $p1_gems_offered, $p2_gems_offered, $item_types);
            processTrade($pdo, $p2_id, $p2_offer, $p1_offer, $p2_gems_offered, $p1_gems_offered, $item_types);

            // Close the room
            $stmt = $pdo->prepare("UPDATE trade_sessions SET status = 'completed' WHERE room_code = ?");
            $stmt->execute([$code]);
        }
        
        $pdo->commit();
        echo json_encode(["success" => true]);
    } catch (Exception $e) {
        $pdo->rollBack();
        echo json_encode(["success" => false, "error" => $e->getMessage()]);
    }
    exit;
}

// Fallback if no valid action is sent
echo json_encode(["success" => false, "message" => "Invalid action."]);
?>
