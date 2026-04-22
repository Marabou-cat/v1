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
$user_id = $_SESSION['user_id'];
$action = $_POST['action'] ?? '';

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
    // NEW EVOLUTION: Mysterious Seed -> Full Moon Flytrap
    "seed" => [
        "base_name" => "Mysterious Seed",
        "target_id" => "flytrap",
        "target_name" => "Moonlight Flytrap",
        "req_level" => 20,
        "req_item" => "Moonstone", // The required item
        "cost" => 500,
        "currency" => "gems",
        "img" => "../png/flytrap.png",
        "color" => "#3ba55c"
    ],
    "flytrap" => [
        "base_name" => "Moonlight Flytrap",
        "target_id" => "mboe",
        "target_name" => "Moonlight Beast Of Eclipse",
        "req_level" => 75,
        "req_item" => "Moonstone", // The required item
        "cost" => 1250,
        "currency" => "gems",
        "img" => "../png/mboe.png",
        "color" => "#3ba55c"
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
        "req_level" => 35,
        "cost" => 450,
        "currency" => "gems",
        "img" => "../png/griffin.png",
        "color" => "#00ffcc"
    ],
    "griffin" => [
        "base_name" => "Flaming Griffin",
        "target_id" => "aerodactylus",
        "target_name" => "Eruption Aerodactylus",
        "req_level" => 75,
        "cost" => 1250,
        "currency" => "gems",
        "img" => "../png/aerodactylus.png",
        "color" => "#00ffcc"
    ]
];

function getUser($pdo, $uid) {
    // Added owned_items to the select
    $stmt = $pdo->prepare("SELECT coins, gems, owned_pets, pet_ages, active_pet, owned_items FROM users WHERE id = ?");
    $stmt->execute([$uid]);
    return $stmt->fetch(PDO::FETCH_ASSOC);
}

if ($action === 'load') {
    $user = getUser($pdo, $user_id);
    $pet_ages = json_decode($user['pet_ages'], true) ?: [];
    $owned_pets = json_decode($user['owned_pets'], true) ?: [];
    
    $current_levels = [];
    foreach ($owned_pets as $pet_uid) {
        $age = $pet_ages[$pet_uid] ?? 0;
        $current_levels[$pet_uid] = floor($age / 600) + 1;
    }

    echo json_encode([
        "success" => true, 
        "coins" => (int)$user['coins'], 
        "gems" => (int)$user['gems'], 
        "owned_pets" => $owned_pets, 
        "levels" => $current_levels, 
        "catalog" => $EVOLUTIONS
    ]);
    exit;
}

if ($action === 'evolve') {
    $uid = $_POST['uid'] ?? ''; 
    $parts = explode('::', $uid);
    $base_id = $parts[0];

    if (!isset($EVOLUTIONS[$base_id])) die(json_encode(["success" => false, "message" => "Invalid evolution."]));

    try {
        $pdo->beginTransaction();
        
        $stmt = $pdo->prepare("SELECT coins, gems, owned_pets, pet_ages, active_pet, owned_items FROM users WHERE id = ? FOR UPDATE");
        $stmt->execute([$user_id]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        
        $owned_pets = json_decode($user['owned_pets'], true) ?: [];
        $pet_ages = json_decode($user['pet_ages'], true) ?: [];
        $owned_items = json_decode($user['owned_items'], true) ?: [];
        
        $evo_data = $EVOLUTIONS[$base_id];
        
        // 1. Verify Ownership
        if (!in_array($uid, $owned_pets)) throw new Exception("You don't own this specific pet!");
        
        // 2. Verify Level
        $current_age = $pet_ages[$uid] ?? 0;
        $current_level = floor($current_age / 600) + 1;
        if ($current_level < $evo_data['req_level']) throw new Exception("Pet level low! Needs Level " . $evo_data['req_level']);
        
        // 3. NEW: Verify Required Item
        if (isset($evo_data['req_item'])) {
            $required = $evo_data['req_item'];
            if (!in_array($required, $owned_items)) {
                throw new Exception("Missing required item: " . $required);
            }
            // Consume the item? (Uncomment below if the item should be destroyed on use)
            /*
            $key = array_search($required, $owned_items);
            unset($owned_items[$key]);
            */
        }

        // 4. Verify & Deduct Currency
        $currency = $evo_data['currency'];
        $cost = $evo_data['cost'];
        if ((int)$user[$currency] < $cost) throw new Exception("Not enough $currency!");
        $new_balance = (int)$user[$currency] - $cost;
        
        // 5. Execute Mutation
        $owned_pets = array_filter($owned_pets, function($p) use ($uid) { return $p !== $uid; });
        $new_uid = $evo_data['target_id'] . '::' . round(microtime(true) * 1000) . '_' . mt_rand(100, 999);
        $owned_pets[] = $new_uid;
        
        $pet_ages[$new_uid] = $current_age; 
        unset($pet_ages[$uid]);
        
        $active_pet = $user['active_pet'];
        if ($active_pet === $uid) $active_pet = $new_uid;

        // Save back
        $stmt = $pdo->prepare("UPDATE users SET $currency = ?, owned_pets = ?, pet_ages = ?, active_pet = ?, owned_items = ? WHERE id = ?");
        $stmt->execute([$new_balance, json_encode(array_values($owned_pets)), json_encode($pet_ages), $active_pet, json_encode(array_values($owned_items)), $user_id]);
        
        $pdo->commit();
        echo json_encode(["success" => true, "new_balance" => $new_balance, "currency" => $currency, "target_name" => $evo_data['target_name']]);
    } catch (Exception $e) {
        $pdo->rollBack(); echo json_encode(["success" => false, "message" => $e->getMessage()]);
    }
    exit;
}
?>
