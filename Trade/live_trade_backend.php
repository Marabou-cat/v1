<?php
session_start();
header('Content-Type: application/json');

$pdo = new PDO("mysql:host=localhost;dbname=schoolexams;charset=utf8mb4", 'root', '');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

if (!isset($_SESSION['user_id'])) die(json_encode(["success" => false, "message" => "Not logged in."]));

$action = $_POST['action'] ?? '';
$user_id = $_SESSION['user_id'];

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

// --- 3. SYNC DATA (Called every 1.5 seconds) ---
if ($action === 'sync') {
    $code = $_POST['room_code'];
    $stmt = $pdo->prepare("SELECT * FROM trade_sessions WHERE room_code = ?");
    $stmt->execute([$code]);
    $room = $stmt->fetch(PDO::FETCH_ASSOC);
    
    if (!$room) die(json_encode(["success" => false, "message" => "Room closed."]));

    // Determine if I am P1 or P2
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
    $accept_col = ($room['p1_id'] == $user_id) ? 'p1_accept' : 'p2_accept';
    
    // Update offer and UN-READY both players if offer changes
    $stmt = $pdo->prepare("UPDATE trade_sessions SET $col = ?, p1_accept = 0, p2_accept = 0 WHERE room_code = ?");
    $stmt->execute([$offer, $code]);
    echo json_encode(["success" => true]);
    exit;
}

// --- 5. TOGGLE ACCEPT & EXECUTE TRADE ---
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
        
        // Toggle my status
        $new_status = $is_p1 ? !$room['p1_accept'] : !$room['p2_accept'];
        $stmt = $pdo->prepare("UPDATE trade_sessions SET $my_accept_col = ? WHERE room_code = ?");
        $stmt->execute([(int)$new_status, $code]);
        
        // CHECK IF BOTH ACCEPTED
        if ($new_status == true && $room[$their_accept_col] == 1) {
            // Mark as complete (In a real production app, you swap the items in the DB right here)
            $stmt = $pdo->prepare("UPDATE trade_sessions SET status = 'completed' WHERE room_code = ?");
            $stmt->execute([$code]);
        }
        
        $pdo->commit();
        echo json_encode(["success" => true]);
    } catch (Exception $e) {
        $pdo->rollBack();
        echo json_encode(["success" => false]);
    }
    exit;
}
?>
