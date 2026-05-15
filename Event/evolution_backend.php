<?php
header('Content-Type: application/json');
error_reporting(E_ALL);
ini_set('display_errors', 0);

// --- LOAD CONFIG ---
$host = 'localhost';
$db   = 'schoolexams';
$user = 'root';
$pass = '';

$configFile = 'config.ini';
if (!file_exists($configFile) && file_exists('../config.ini')) {
    $configFile = '../config.ini';
}

if (file_exists($configFile)) {
    $lines = file($configFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (isset($lines[0])) $user = trim($lines[0]);
    if (isset($lines[1])) $pass = trim($lines[1]);
}

try {
    $pdo = new PDO("mysql:host=$host;dbname=$db;charset=utf8mb4", $user, $pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch(Exception $e) {
    echo json_encode(["success" => false, "message" => "DB Error"]);
    exit;
}

// --- CREATE REQUIRED TABLES & COLUMNS ---
// 1. Ensure a basic users table exists with the needed currencies
$pdo->exec("CREATE TABLE IF NOT EXISTS users (username VARCHAR(50) PRIMARY KEY, gems INT DEFAULT 0, sakura_coins INT DEFAULT 0)");
try { $pdo->exec("ALTER TABLE users ADD COLUMN sakura_coins INT DEFAULT 0"); } catch (Exception $e) {}
try { $pdo->exec("ALTER TABLE users ADD COLUMN gems INT DEFAULT 0"); } catch (Exception $e) {}

// 2. Evolution Event Tracking Table
$pdo->exec("CREATE TABLE IF NOT EXISTS evolution_event (
    username VARCHAR(50) PRIMARY KEY,
    pet_id VARCHAR(50) DEFAULT NULL,
    playtime_seconds INT DEFAULT 0,
    last_claim_seconds INT DEFAULT 0
)");

// 3. User Inventory for the Items
$pdo->exec("CREATE TABLE IF NOT EXISTS user_inventory (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50),
    item_name VARCHAR(100),
    quantity INT DEFAULT 1,
    UNIQUE KEY(username, item_name)
)");

$action = $_POST['action'] ?? '';
$username = strip_tags($_POST['username'] ?? '');

if (!$username) {
    echo json_encode(["success" => false, "message" => "Not logged in"]);
    exit;
}

// Ensure user exists in tables
$stmt = $pdo->prepare("INSERT IGNORE INTO users (username) VALUES (?)");
$stmt->execute([$username]);

$stmt = $pdo->prepare("INSERT IGNORE INTO evolution_event (username) VALUES (?)");
$stmt->execute([$username]);

// --- API ACTIONS ---

if ($action === 'init') {
    // Get Currency
    $stmt = $pdo->prepare("SELECT sakura_coins, gems FROM users WHERE username = ?");
    $stmt->execute([$username]);
    $currency = $stmt->fetch(PDO::FETCH_ASSOC);

    // Get Event Data
    $stmt = $pdo->prepare("SELECT pet_id, playtime_seconds, last_claim_seconds FROM evolution_event WHERE username = ?");
    $stmt->execute([$username]);
    $event = $stmt->fetch(PDO::FETCH_ASSOC);

    echo json_encode([
        "success" => true,
        "dna_points" => (int)$currency['sakura_coins'], // Expose sakura coins as DNA points
        "gems" => (int)$currency['gems'],
        "pet_id" => $event['pet_id'],
        "playtime" => (int)$event['playtime_seconds'],
        "last_claim" => (int)$event['last_claim_seconds']
    ]);
    exit;
}

if ($action === 'choose_pet') {
    $pet_id = strip_tags($_POST['pet_id'] ?? '');
    $valid_pets = ['paint_cat', 'ember_caterpillar', 'dreaming_chick'];
    
    if (in_array($pet_id, $valid_pets)) {
        $stmt = $pdo->prepare("UPDATE evolution_event SET pet_id = ? WHERE username = ?");
        $stmt->execute([$pet_id, $username]);
        echo json_encode(["success" => true]);
    } else {
        echo json_encode(["success" => false, "message" => "Invalid pet selection"]);
    }
    exit;
}

if ($action === 'ping_playtime') {
    // Adds 10 seconds of playtime (Called by JS every 10s)
    $stmt = $pdo->prepare("UPDATE evolution_event SET playtime_seconds = playtime_seconds + 10 WHERE username = ?");
    $stmt->execute([$username]);
    echo json_encode(["success" => true]);
    exit;
}

if ($action === 'claim_reward') {
    // Lock row to prevent double-clicking exploits
    $pdo->beginTransaction();
    
    $stmt = $pdo->prepare("SELECT playtime_seconds, last_claim_seconds FROM evolution_event WHERE username = ? FOR UPDATE");
    $stmt->execute([$username]);
    $event = $stmt->fetch();

    $unclaimed_time = $event['playtime_seconds'] - $event['last_claim_seconds'];

    if ($unclaimed_time >= 300) { // 5 minutes = 300 seconds
        // Update claim tracker (+300s so they can claim multiple times if they afk'd long enough)
        $stmt = $pdo->prepare("UPDATE evolution_event SET last_claim_seconds = last_claim_seconds + 300 WHERE username = ?");
        $stmt->execute([$username]);

        // Base Reward: 100 DNA Points (Sakura Coins)
        $stmt = $pdo->prepare("UPDATE users SET sakura_coins = sakura_coins + 100 WHERE username = ?");
        $stmt->execute([$username]);
        
        $reward_text = "You earned 100 🧬 DNA Points!";
        $extra_reward = null;

        // 10% Chance for Additional Reward
        if (rand(1, 100) <= 10) {
            $roll = rand(1, 3);
            if ($roll === 1) {
                $extra_reward = "Wish Stone";
                $stmt = $pdo->prepare("INSERT INTO user_inventory (username, item_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE quantity = quantity + 1");
                $stmt->execute([$username, "Wish Stone"]);
            } else if ($roll === 2) {
                $extra_reward = "Wish Meteor";
                $stmt = $pdo->prepare("INSERT INTO user_inventory (username, item_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE quantity = quantity + 1");
                $stmt->execute([$username, "Wish Meteor"]);
            } else if ($roll === 3) {
                $extra_reward = "100 Gems";
                $stmt = $pdo->prepare("UPDATE users SET gems = gems + 100 WHERE username = ?");
                $stmt->execute([$username]);
            }
            $reward_text .= " AND found a rare drop: " . $extra_reward . "!";
        }

        $pdo->commit();
        echo json_encode(["success" => true, "message" => $reward_text]);
    } else {
        $pdo->rollBack();
        echo json_encode(["success" => false, "message" => "Not enough playtime elapsed yet."]);
    }
    exit;
}

if ($action === 'buy_item') {
    $item_id = strip_tags($_POST['item_id'] ?? '');
    
    // Shop Config
    $shop = [
        "100_gems" => ["price" => 500, "name" => "100 Gems", "type" => "gem"],
        "evo_stone" => ["price" => 1500, "name" => "Evolution Stone", "type" => "item"],
        "dna_mutator" => ["price" => 1500, "name" => "DNA Mutator", "type" => "item"],
        "growth_serum" => ["price" => 1500, "name" => "Growth Serum", "type" => "item"]
    ];

    if (!isset($shop[$item_id])) {
        echo json_encode(["success" => false, "message" => "Item not found."]);
        exit;
    }

    $product = $shop[$item_id];
    $price = $product['price'];

    $pdo->beginTransaction();
    $stmt = $pdo->prepare("SELECT sakura_coins FROM users WHERE username = ? FOR UPDATE");
    $stmt->execute([$username]);
    $coins = $stmt->fetchColumn();

    if ($coins >= $price) {
        // Deduct Price
        $stmt = $pdo->prepare("UPDATE users SET sakura_coins = sakura_coins - ? WHERE username = ?");
        $stmt->execute([$price, $username]);

        // Deliver Product
        if ($product['type'] === 'gem') {
            $stmt = $pdo->prepare("UPDATE users SET gems = gems + 100 WHERE username = ?");
            $stmt->execute([$username]);
        } else {
            $stmt = $pdo->prepare("INSERT INTO user_inventory (username, item_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE quantity = quantity + 1");
            $stmt->execute([$username, $product['name']]);
        }

        $pdo->commit();
        echo json_encode(["success" => true, "message" => "Successfully purchased " . $product['name'] . "!"]);
    } else {
        $pdo->rollBack();
        echo json_encode(["success" => false, "message" => "Not enough DNA Points!"]);
    }
    exit;
}

echo json_encode(["success" => false, "message" => "Unknown action"]);
?>
