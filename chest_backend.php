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

// --- DYNAMIC CHEST CATALOG ---
// The HTML page reads this array to automatically draw the store!
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
        "desc" => "Contains Event Limited Kawaii Items",
        "price" => "Get From Kawaii Festival", // <--- Fixed syntax error and set to text
        "currency" => "gems",
        "img" => "../png/sakura_chest.png",
        "color" => "#ffb7b2"
    ]
];

// Helper to get user data
function getUser($pdo, $uid) {
    $stmt = $pdo->prepare("SELECT coins, gems, owned_chests, owned_cursors, owned_pets FROM users WHERE id = ?");
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
        // If the price is text (like "Event Only") instead of a number, block it!
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
        
        $stmt = $pdo->prepare("SELECT owned_chests, owned_cursors, owned_pets FROM users WHERE id = ? FOR UPDATE");
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
        }

        // Catch-all just in case a chest has no pool defined here
        if (!isset($pool)) {
            throw new Exception("This chest is empty!");
        }

        $keys = array_keys($pool);
        $reward_id = $keys[array_rand($keys)];
        $reward_name = $pool[$reward_id];
        
        if ($reward_type === 'mythic') {
            $reward_type = ($reward_id === 'dragon') ? 'cursor' : 'pet';
        }

        $inv_column = ($reward_type === 'cursor') ? 'owned_cursors' : 'owned_pets';
        $inventory = json_decode($user[$inv_column], true) ?: [];
        
        $is_duplicate = in_array($reward_id, $inventory);
        if (!$is_duplicate) {
            $inventory[] = $reward_id;
        }

        $stmt = $pdo->prepare("UPDATE users SET owned_chests = ?, $inv_column = ? WHERE id = ?");
        $stmt->execute([json_encode($chests), json_encode(array_values($inventory)), $user_id]);
        
        $pdo->commit();
        echo json_encode([
            "success" => true, 
            "chests" => $chests, 
            "reward" => [
                "id" => $reward_id,
                "name" => $reward_name,
                "type" => $reward_type,
                "is_duplicate" => $is_duplicate
            ]
        ]);
    } catch (Exception $e) {
        $pdo->rollBack(); 
        echo json_encode(["success" => false, "message" => $e->getMessage()]);
    }
    exit;
}
?>
