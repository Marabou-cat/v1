<?php
session_start();
header('Content-Type: application/json');

$config_file = 'config.ini'; // Make sure this path is correct for your folder structure
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
        "req_level" => 25,
        "cost" => 350,
        "currency" => "gems",
        "img" => "../png/mc.png",
        "color" => "#ff00ff"
    ],
    "kitsune" => [
        "base_name" => "Sakura Kitsune",
        "target_id" => "bn",
        "target_name" => "Blossom Ninetails",
        "req_level" => 40,
        "cost" => 600,
        "currency" => "gems",
        "img" => "../png/blossom_ninetails.png",
        "color" => "#00ffcc"
    ],
    "gb" => [
        "base_name" => "Gem Beast",
        "target_id" => "crystal_dragon",
        "target_name" => "Crystal Dragon",
        "req_level" => 60,
        "cost" => 2000,
        "currency" => "gems",
        "img" => "../png/crystal_dragon.png",
        "color" => "#00ffcc"
    ],
    "phoenix" => [
        "base_name" => "Mythic Phoenix",
        "target_id" => "griffin",
        "target_name" => "Flaming Griffin",
        "req_level" => 30,
        "cost" => 145000,
        "currency" => "coins",
        "img" => "../png/griffin.png",
        "color" => "#00ffcc"
    ],
    "griffin" => [
        "base_name" => "Flaming Griffin",
        "target_id" => "aerodactylus",
        "target_name" => "Eruption Aerodactylus",
        "req_level" => 75,
        "cost" => 2000,
        "currency" => "gems",
        "img" => "../png/aerodactylus.png",
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
    
    // Calculate current levels for the frontend based on Unique IDs
    $current_levels = [];
    foreach ($owned_pets as $pet_uid) {
        $age = $pet_ages[$pet_uid] ?? 0;
        $current_levels[$pet_uid] = floor($age / 600) + 1;
    }

    echo json_encode([
        "success" => true, "coins" => (int)$user['coins'], "gems" => (int)$user['gems'], 
        "owned_pets" => $owned_pets, "levels" => $current_levels, "catalog" => $EVOLUTIONS
    ]);
    exit;
}

if ($action === 'evolve') {
    // NEW: We now expect the specific Unique ID (e.g., cat::12345678)
    $uid = $_POST['uid'] ?? ''; 
    $parts = explode('::', $uid);
    $base_id = $parts[0]; // Extracts "cat" from "cat::12345678"

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
        
        // 1. Verify Ownership using the Unique ID
        if (!in_array($uid, $owned_pets)) throw new Exception("You don't own this specific pet!");
        
        // 2. Verify Level
        $current_age = $pet_ages[$uid] ?? 0;
        $current_level = floor($current_age / 600) + 1;
        if ($current_level < $evo_data['req_level']) throw new Exception("Pet level is too low! Needs Level " . $evo_data['req_level']);
        
        // 3. Verify & Deduct Currency
        $currency = $evo_data['currency'];
        $cost = $evo_data['cost'];
        if ((int)$user[$currency] < $cost) throw new Exception("Not enough $currency!");
        $new_balance = (int)$user[$currency] - $cost;
        
        // 4. Execute Evolution (Remove old, generate completely new separated ID)
        $owned_pets = array_filter($owned_pets, function($p) use ($uid) { return $p !== $uid; }); // Remove old specific pet
        
        $new_uid = $target_id . '::' . round(microtime(true) * 1000) . '_' . mt_rand(100, 999);
        $owned_pets[] = $new_uid; // Add new evolved pet
        
        // 5. TRANSFER AGE! Do not reset it to 0!
        $pet_ages[$new_uid] = $current_age; 
        unset($pet_ages[$uid]);
        
        // If they had the base pet equipped, auto-equip the new one
        $active_pet = $user['active_pet'];
        if ($active_pet === $uid) $active_pet = $new_uid;

        // Save back to database
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
