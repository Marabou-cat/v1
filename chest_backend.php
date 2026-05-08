<?php
session_start();
header('Content-Type: application/json');

$config_file = 'config.ini';

if (!file_exists($config_file)) {
    die(json_encode(["success" => false, "message" => "Server Error: Configuration missing."]));
}

$lines = file($config_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$db_user = trim($lines[0]);
$db_pass = trim($lines[1]);

try {
    $pdo = new PDO("mysql:host=localhost;dbname=schoolexams;charset=utf8mb4", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch (PDOException $e) {
    die(json_encode(["success" => false, "message" => "Database connection failed."]));
}

if (!isset($_SESSION['user_id'])) die(json_encode(["success" => false, "message" => "Not logged in."]));

$action = $_POST['action'] ?? '';
$user_id = $_SESSION['user_id'];

// Inventory Limits
$MAX_PETS = 50;
$MAX_CURSORS = 40;

// --- DYNAMIC CHEST CATALOG ---
$CHESTS = [
    "basic" => [
        "name" => "Basic Chest",
        "desc" => "Contains Basic Cursors & Pets from shop, maybe a cursor costing 1m?",
        "price" => 1000, 
        "currency" => "coins",
        "img" => "../png/basic_chest.png",
        "color" => "#fff"
    ],
    "premium" => [
        "name" => "Premium Chest",
        "desc" => "Is There really just gold ingots? Yeah, the 90%",
        "price" => 100, 
        "currency" => "gems",
        "img" => "../png/premium_chest.png",
        "color" => "#00ffcc"
    ],
    "seasonal" => [
        "name" => "Seasonal Chest",
        "desc" => "High chance for season limited Items!",
        "price" => 250, 
        "currency" => "gems",
        "img" => "../png/seasonal_chest.png",
        "color" => "#fff200"
    ],
    "sakura" => [
        "name" => "Sakura Chest",
        "desc" => "Contains Event Limited Kawaii Items 2026",
        "price" => "Sakura Coins at the Kawaii Festival Event",
        "currency" => "gems",
        "img" => "../png/sakura_chest.png",
        "color" => "#ffb7b2"
    ],
    "arcade" => [
        "name" => "Arcade Chest",
        "desc" => "Contains Event Limited Arcade Items 2026",
        "price" => "Obtained with 500 Arcade Coins In Arcade Shop",
        "currency" => "gems",
        "img" => "../png/arcade_chest.png",
        "color" => "#ffb7b2"
    ]
];

// Helper to get user data (FIXED: Added owned_items)
function getUser($pdo, $uid) {
    $stmt = $pdo->prepare("SELECT coins, gems, owned_chests, owned_cursors, owned_pets, pet_ages, owned_items FROM users WHERE id = ?");
    $stmt->execute([$uid]);
    return $stmt->fetch(PDO::FETCH_ASSOC);
}

// --- LOAD INVENTORY ---
if ($action === 'load') {
    $user = getUser($pdo, $user_id);
    
    $chests = json_decode($user['owned_chests'], true);
    if (!is_array($chests)) {
        $chests = [];
        foreach ($CHESTS as $key => $val) {
            $chests[$key] = 0;
        }
    }

    echo json_encode([
        "success" => true, 
        "coins" => (int)$user['coins'], 
        "gems" => (int)$user['gems'], 
        "chests" => $chests,
        "catalog" => $CHESTS
    ]);
    exit;
}

// --- BUY CHEST ---
if ($action === 'buy') {
    $type = $_POST['chest_type'] ?? '';
    if (!isset($CHESTS[$type])) die(json_encode(["success" => false, "message" => "Invalid chest."]));

    try {
        $pdo->beginTransaction();
        
        // --- SECURITY BLOCK ---
        if (!is_numeric($CHESTS[$type]['price'])) {
            throw new Exception("Nice try! This chest cannot be purchased with standard currency.");
        }
        
        $user = getUser($pdo, $user_id);
        
        $price = (int)$CHESTS[$type]['price'];
        $currency = $CHESTS[$type]['currency'];
        $current_balance = (int)$user[$currency];

        if ($current_balance < $price) {
            throw new Exception("Not enough $currency!");
        }

        // Deduct currency
        $new_balance = $current_balance - $price;
        
        // Add Chest
        $chests = json_decode($user['owned_chests'], true) ?: [];
        $chests[$type] = ($chests[$type] ?? 0) + 1;

        $stmt = $pdo->prepare("UPDATE users SET $currency = ?, owned_chests = ? WHERE id = ?");
        $stmt->execute([$new_balance, json_encode($chests), $user_id]);
        
        $pdo->commit();
        echo json_encode(["success" => true, "new_balance" => $new_balance, "currency" => $currency, "chests" => $chests]);
    } catch (Exception $e) {
        $pdo->rollBack();
        echo json_encode(["success" => false, "message" => $e->getMessage()]);
    }
    exit;
}

// --- OPEN CHEST ---
if ($action === 'open') {
    $type = $_POST['chest_type'] ?? '';
    
    try {
        $pdo->beginTransaction();
        
        // Fetch inventory (FIXED: Added owned_items to SELECT)
        $stmt = $pdo->prepare("SELECT owned_chests, owned_cursors, owned_pets, pet_ages, owned_items FROM users WHERE id = ? FOR UPDATE");
        $stmt->execute([$user_id]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        
        $chests = json_decode($user['owned_chests'], true) ?: [];
        
        if (!isset($chests[$type]) || $chests[$type] <= 0) {
            throw new Exception("You don't own any of these chests!");
        }
        
        // Remove 1 chest
        $chests[$type] -= 1;
        
        // --- RNG LOOT LOGIC ---
        $roll = mt_rand(1, 100);
        $reward_type = '';
        $reward_id = '';
        $reward_name = '';
        
        if ($type === 'basic') {
            if ($roll <= 97) {
                $pool = ['m1' => 'Egg Twins', 'm2' => 'Gold Ingot', 'm3' => 'Cheesy Cursor', 'm4' => 'Sword Cursor', 'm5' => 'Pizza Slice'];
                $reward_type = 'cursor';
            } else {
                $pool = ['m6' => 'Sign Of Greed'];
                $reward_type = 'cursor';
            }
        } else if ($type === 'premium') {
            if ($roll <= 90) {
                $pool = ['lt' => 'Living Treasure'];
                $reward_type = 'pet';
            } else if ($roll <= 97) {
                $pool = ['midas' => 'King Midas'];
                $reward_type = 'pet';
            } else {
                $pool = ['dragon' => 'Mythic Dragon'];
                $reward_type = 'mythic';
            }
        } else if ($type === 'seasonal') {
            if ($roll <= 60) {
                $pool = ['gs' => 'Glowing Shadow'];
                $reward_type = 'pet';
            } else if ($roll <= 95) {
                $pool = ['stick' => 'Stick of Darkness'];
                $reward_type = 'cursor';
            } else {
                $pool = ['hs' => 'The Hound From Void'];
                $reward_type = 'pet';
            }
        } else if ($type === 'sakura') {
            if ($roll <= 50) {
                $pool = ['sakura_star' => 'Sakura Star', 'sakura_ribbon' => 'Sakura Ribbon'];
                $reward_type = 'cursor';
            } else if ($roll <= 95) {
                $pool = ['blossom' => 'Elder Sakura Blossom', 'katanaspirit' => 'Katana Spirit'];
                $reward_type = 'pet';
            } else {
                $pool = ['kitsune' => 'Sakura kitsune'];
                $reward_type = 'pet';
            }
        } else if ($type === 'arcade') {
            if ($roll <= 60) {
                $pool = ['usb' => 'USB']; // FIXED: Changed ID to VirusUSB
                $reward_type = 'cursor';              // FIXED: Changed type to item
            } else if ($roll <= 95) {
                $pool = ['digital_minion' => 'Digital Minion'];
                $reward_type = 'pet';
            } else {
                $pool = ['claws_machine' => 'Claws Machine'];
                $reward_type = 'pet';
            }
        }

        if (!isset($pool)) {
            throw new Exception("This chest is empty!");
        }

        $keys = array_keys($pool);
        $reward_id = $keys[array_rand($keys)];
        $reward_name = $pool[$reward_id];
        
        if ($reward_type === 'mythic') {
            $reward_type = ($reward_id === 'dragon') ? 'cursor' : 'pet';
        }

        // FIXED: Added 'item' logic to the column routing
        if ($reward_type === 'cursor') {
            $inv_column = 'owned_cursors';
        } else if ($reward_type === 'pet') {
            $inv_column = 'owned_pets';
        } else if ($reward_type === 'item') {
            $inv_column = 'owned_items';
        }

        $inventory = json_decode($user[$inv_column], true) ?: [];
        $pet_ages = json_decode($user['pet_ages'], true) ?: [];
        
        $is_discarded = false;

        // --- APPLY INVENTORY LIMITS AND UNIQUE PET IDs ---
        if ($reward_type === 'cursor') {
            if (count($inventory) >= $MAX_CURSORS) {
                $is_discarded = true; // Inventory full, discard it!
            } else {
                $inventory[] = $reward_id; // Add duplicate cursor
            }
        } else if ($reward_type === 'pet') {
            if (count($inventory) >= $MAX_PETS) {
                $is_discarded = true; // Inventory full, discard it!
            } else {
                // Generate a unique ID for the new separated pet
                $uid = $reward_id . '::' . round(microtime(true) * 1000) . '_' . mt_rand(100, 999);
                $inventory[] = $uid;
                $pet_ages[$uid] = 0; // Initialize age to 0
            }
        } else if ($reward_type === 'item') {
            // Items don't have a strict inventory limit in this build, just add it!
            $inventory[] = $reward_id;
        }

        // Save everything back to the database
        $stmt = $pdo->prepare("UPDATE users SET owned_chests = ?, $inv_column = ?, pet_ages = ? WHERE id = ?");
        $stmt->execute([json_encode($chests), json_encode(array_values($inventory)), json_encode($pet_ages), $user_id]);
        
        $pdo->commit();
        
        echo json_encode([
            "success" => true, 
            "chests" => $chests, 
            "reward" => [
                "id" => $reward_id,
                "name" => $reward_name,
                "type" => $reward_type,
                "is_duplicate" => $is_discarded // Reused to tell the frontend it was discarded
            ]
        ]);
    } catch (Exception $e) {
        $pdo->rollBack(); 
        echo json_encode(["success" => false, "message" => $e->getMessage()]);
    }
    exit;
}
?>
