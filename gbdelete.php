<?php
// --- ONE-TIME CLEANUP SCRIPT ---
// This will remove EVERY Gem Beast (gb) from all accounts.

$config_file = 'config.ini'; 
if (!file_exists($config_file)) die("Config missing.");

$lines = file($config_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$db_user = trim($lines[0]); 
$db_pass = trim($lines[1]); 

try {
    $pdo = new PDO("mysql:host=localhost;dbname=schoolexams;charset=utf8mb4", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch (PDOException $e) {
    die("Database connection failed.");
}

// 1. Get all users
$stmt = $pdo->query("SELECT id, owned_pets, pet_ages, active_pet FROM users");
$users = $stmt->fetchAll(PDO::FETCH_ASSOC);

$accounts_fixed = 0;
$total_gb_removed = 0;

foreach ($users as $user) {
    $pets = json_decode($user['owned_pets'], true) ?: [];
    $ages = json_decode($user['pet_ages'], true) ?: [];
    $active = $user['active_pet'];
    
    $changed = false;
    $new_pets = [];

    // 2. Loop through their pets
    foreach ($pets as $pet) {
        // If the pet is "gb" or starts with "gb::"
        if ($pet === 'gb' || strpos($pet, 'gb::') === 0) {
            // Remove its age/level
            if (isset($ages[$pet])) {
                unset($ages[$pet]);
            }
            // Unequip it if they are using it
            if ($active === $pet) {
                $active = '';
            }
            $changed = true;
            $total_gb_removed++;
        } else {
            // Keep normal pets
            $new_pets[] = $pet;
        }
    }

    // 3. Save the fixed data back to the database
    if ($changed) {
        $upd = $pdo->prepare("UPDATE users SET owned_pets = ?, pet_ages = ?, active_pet = ? WHERE id = ?");
        $upd->execute([json_encode(array_values($new_pets)), json_encode($ages), $active, $user['id']]);
        $accounts_fixed++;
    }
}

// 4. Reset the monthly timer so the top 10 can get their ONE legitimate Gem Beast back
$pdo->exec("DELETE FROM global_state WHERE key_name = 'last_reward_month'");

echo "<h1>✅ Cleanup Complete!</h1>";
echo "<p>Successfully removed <strong>$total_gb_removed</strong> glitched Gem Beasts across <strong>$accounts_fixed</strong> accounts.</p>";
echo "<p>The monthly timer has been reset. The next time you open the leaderboard, the Top 10 will receive exactly ONE Gem Beast.</p>";
echo "<p style='color: red;'><strong>IMPORTANT:</strong> You can now delete this cleanup_gb.php file from your server!</p>";
?>
