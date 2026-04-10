<?php
session_start();
header('Content-Type: application/json');

// INSERT YOUR DATABASE PASSWORD IN THE QUOTES BELOW
$pdo = new PDO("mysql:host=localhost;dbname=schoolexams;charset=utf8mb4", 'root', '');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

if (!isset($_SESSION['user_id'])) die(json_encode(["success" => false, "message" => "Not logged in."]));

$action = $_POST['action'] ?? '';
$user_id = $_SESSION['user_id'];

// --- 0. GET REAL INVENTORY ---
if ($action === 'get_inventory') {
    $stmt = $pdo->prepare("SELECT owned_cursors, owned_pets FROM users WHERE id = ?");
    $stmt->execute([$user_id]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);
    
    $cursors = json_decode($user['owned_cursors'] ?? '[]', true) ?: [];
    $pets = json_decode($user['owned_pets'] ?? '[]', true) ?: [];
    
    // Combine both arrays to send to the frontend
    echo json_encode(["success" => true, "inventory" => array_merge($cursors, $pets)]);
    exit;
}

// --- 1. HOST A ROOM ---
if ($action === 'create_room') {
    $code = substr(str_shuffle("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), 0, 6);
    $stmt = $pdo->prepare("INSERT INTO trade_sessions (room_code, p1_id) VALUES (?, ?)");
    $stmt->execute([$code, $user_id]);
    echo json_encode(["success" => true, "room_code" => $code]);
    exit;
}

// --- 2. JOIN A ROOM ---
if ($action === 'join_room') {
    $code = strtoupper(trim($_POST['room_code']));
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
    
    echo json_encode([
        "success" => true,
        "status" => $room['status'],
        "my_offer" => json_decode($is_p1 ? $room['p1_offer'] : $room['p2_offer']),
        "their_offer" => json_decode($is_p1 ? $room['p2_offer'] : $room['p1_offer']),
        "my_accept" => $is_p1 ? $room['p1_accept'] : $room['p2_accept'],
        "their_accept" => $is_p1 ? $room['p2_accept'] : $room['p1_accept']
    ]);
    exit;
}

// --- 4. UPDATE OFFER ---
if ($action === 'update_offer') {
    $code = $_POST['room_code'];
    $offer = $_POST['offer']; // JSON string
    
    $stmt = $pdo->prepare("SELECT p1_id FROM trade_sessions WHERE room_code = ?");
    $stmt->execute([$code]);
    $room = $stmt->fetch(PDO::FETCH_ASSOC);
    
    $col = ($room['p1_id'] == $user_id) ? 'p1_offer' : 'p2_offer';
    
    // Update offer and UN-READY both players
    $stmt = $pdo->prepare("UPDATE trade_sessions SET $col = ?, p1_accept = 0, p2_accept = 0 WHERE room_code = ?");
    $stmt->execute([$offer, $code]);
    echo json_encode(["success" => true]);
    exit;
}

// --- 5. TOGGLE ACCEPT & EXECUTE ACTUAL ITEM SWAP ---
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
            $p1_offer = json_decode($room['p1_offer'], true) ?? [];
            $p2_offer = json_decode($room['p2_offer'], true) ?? [];

            // Define which items are pets and which are cursors so the DB updates the right column
            $item_types = [
                // PETS
                'midas' => 'pet', 
                'phoenix' => 'pet',
                
                // CURSORS
                'dragon' => 'cursor', 
                'prism' => 'cursor',
                'bp1' => 'cursor', 
                'bp2' => 'cursor', 
                'bp3' => 'cursor', 
                'bp4' => 'cursor', 
                'bp5' => 'cursor', 
                'bp6' => 'cursor'
            ];

            // Helper function to swap items for a user
            function processInventory($pdo, $uid, $giving, $receiving, $item_types) {
                $stmt = $pdo->prepare("SELECT owned_cursors, owned_pets FROM users WHERE id = ? FOR UPDATE");
                $stmt->execute([$uid]);
                $u = $stmt->fetch(PDO::FETCH_ASSOC);

                $cursors = json_decode($u['owned_cursors'], true) ?? [];
                $pets = json_decode($u['owned_pets'], true) ?? [];

                // Remove items they are giving away
                foreach ($giving as $item) {
                    $type = $item_types[$item] ?? null;
                    if ($type === 'cursor') $cursors = array_diff($cursors, [$item]);
                    if ($type === 'pet') $pets = array_diff($pets, [$item]);
                }

                // Add items they are receiving
                foreach ($receiving as $item) {
                    $type = $item_types[$item] ?? null;
                    if ($type === 'cursor' && !in_array($item, $cursors)) $cursors[] = $item;
                    if ($type === 'pet' && !in_array($item, $pets)) $pets[] = $item;
                }

                // Save back to DB (array_values ensures JSON stays as an array, not an object)
                $stmt = $pdo->prepare("UPDATE users SET owned_cursors = ?, owned_pets = ? WHERE id = ?");
                $stmt->execute([json_encode(array_values($cursors)), json_encode(array_values($pets)), $uid]);
            }

            // Move P1's offer to P2, and P2's offer to P1
            processInventory($pdo, $p1_id, $p1_offer, $p2_offer, $item_types);
            processInventory($pdo, $p2_id, $p2_offer, $p1_offer, $item_types);

            // Mark room as complete
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
?>
