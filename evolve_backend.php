<?php
session_start();
header('Content-Type: application/json');

$config_file = 'config.ini';
if (!file_exists($config_file)) die(json_encode(["success" => false, "message" => "Config missing."]));

$lines = file($config_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$db_user = trim($lines[0]); $db_pass = trim($lines[1]);

try {
    $pdo = new PDO("mysql:host=localhost;dbname=schoolexams;charset=utf8mb4", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch (PDOException $e) {
    die(json_encode(["success" => false, "message" => "Database connection failed."]));
}

if (!isset($_SESSION['user_id'])) die(json_encode(["success" => false, "message" => "Not logged in."]));
$action = $_POST['action'] ?? '';
$user_id = $_SESSION['user_id'];

// --- EVOLUTION RECIPES ---
// Level Math: Level = floor(seconds / 600) + 1. 
// So Level 10 requires 5400 seconds of playtime.
$EVOLUTIONS = [
    "lt" => [
        "base_name" => "Living Treasure",
        "target_id" => "lva",
        "target_name" => "Living Vault",
        "req_level" => 30,
        "cost" => 150000,
        "currency" => "coins",
        "img" => "../png/lva.png",
        "color" => "#ffd700"
    ],
    "cat" => [
        "base_name" => "Cyber Kitty",
        "target_id" => "mecha_cat",
        "target_name" => "Mecha Cat",
        "req_level" => 12,
        "cost" => 35000,
        "currency" => "coins",
        "img" => "../png/mecha_cat.png",
        "color" => "#ff00ff"
    ],
    "frog" => [
        "base_name" => "Ninja Frog",
        "target_id" => "sage_toad",
        "target_name" => "Sage Toad",
        "req_level" => 15,
        "cost" => 500,
        "currency" => "gems",
        "img" => "../png/sage_toad.png",
        "color" => "#00ffcc"
    ]
];

function getUser($pdo, $uid) {
    $stmt = $pdo->prepare("SELECT coins, gems, owned_pets, pet_ages, active_pet FROM users WHERE id = ?");
    $stmt->execute([$uid]);
    return $stmt->fetch(PDO::FETCH_ASSOC);
}

if ($action === 'load') {
    $user = getUser($pdo, $user_id);
    $pet_ages = json_decode($user['pet_ages'], true) ?: [];
    $owned_pets = json_decode($user['owned_pets'], true) ?: [];
    
    // Calculate current levels for the frontend
    $current_levels = [];
    foreach ($owned_pets as $pet) {
        $age = $pet_ages[$pet] ?? 0;
        $current_levels[$pet] = floor($age / 600) + 1;
    }

    echo json_encode([
        "success" => true, "coins" => (int)$user['coins'], "gems" => (int)$user['gems'], 
        "owned_pets" => $owned_pets, "levels" => $current_levels, "catalog" => $EVOLUTIONS
    ]);
    exit;
}

if ($action === 'evolve') {
    $base_id = $_POST['base_id'] ?? '';
    if (!isset($EVOLUTIONS[$base_id])) die(json_encode(["success" => false, "message" => "Invalid evolution."]));

    try {
        $pdo->beginTransaction();
        
        $stmt = $pdo->prepare("SELECT coins, gems, owned_pets, pet_ages, active_pet FROM users WHERE id = ? FOR UPDATE");
        $stmt->execute([$user_id]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        
        $owned_pets = json_decode($user['owned_pets'], true) ?: [];
        $pet_ages = json_decode($user['pet_ages'], true) ?: [];
        
        $evo_data = $EVOLUTIONS[$base_id];
        $target_id = $evo_data['target_id'];
        
        // 1. Verify Ownership
        if (!in_array($base_id, $owned_pets)) throw new Exception("You don't own the base pet!");
        if (in_array($target_id, $owned_pets)) throw new Exception("You already evolved this pet!");
        
        // 2. Verify Level
        $current_level = floor(($pet_ages[$base_id] ?? 0) / 600) + 1;
        if ($current_level < $evo_data['req_level']) throw new Exception("Pet level is too low!");
        
        // 3. Verify & Deduct Currency
        $currency = $evo_data['currency'];
        $cost = $evo_data['cost'];
        if ((int)$user[$currency] < $cost) throw new Exception("Not enough $currency!");
        $new_balance = (int)$user[$currency] - $cost;
        
        // 4. Execute Evolution (Remove old, add new)
        $owned_pets = array_diff($owned_pets, [$base_id]); // Remove base
        $owned_pets[] = $target_id; // Add evolved
        
        // Reset age for the new evolved pet
        $pet_ages[$target_id] = 0; 
        unset($pet_ages[$base_id]);
        
        // If they had the base pet equipped, auto-equip the new one
        $active_pet = $user['active_pet'];
        if ($active_pet === $base_id) $active_pet = $target_id;

        $stmt = $pdo->prepare("UPDATE users SET $currency = ?, owned_pets = ?, pet_ages = ?, active_pet = ? WHERE id = ?");
        $stmt->execute([$new_balance, json_encode(array_values($owned_pets)), json_encode($pet_ages), $active_pet, $user_id]);
        
        $pdo->commit();
        echo json_encode(["success" => true, "new_balance" => $new_balance, "currency" => $currency, "target_name" => $evo_data['target_name']]);
    } catch (Exception $e) {
        $pdo->rollBack(); echo json_encode(["success" => false, "message" => $e->getMessage()]);
    }
    exit;
}
?>
