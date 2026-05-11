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

// --- MONTHLY RESET & REWARD LOGIC ---
$current_month = date('Y-m');
$stmt = $pdo->query("SELECT key_value FROM global_state WHERE key_name = 'teams_reward_month'");
$last_reward_month = $stmt->fetchColumn();

// If a new month has started, calculate winners and give the Reaper!
if ($last_reward_month !== $current_month) {
    $pdo->beginTransaction();
    try {
        // Get points
        $stmtR = $pdo->query("SELECT key_value FROM global_state WHERE key_name = 'team_red_points'");
        $red_pts = (int)$stmtR->fetchColumn();
        
        $stmtB = $pdo->query("SELECT key_value FROM global_state WHERE key_name = 'team_blue_points'");
        $blue_pts = (int)$stmtB->fetchColumn();
        
        $winner = '';
        if ($red_pts > $blue_pts) $winner = 'red';
        else if ($blue_pts > $red_pts) $winner = 'blue';
        else if ($red_pts > 0 && $red_pts === $blue_pts) $winner = 'tie'; // If tie, both get it!
        
        if ($winner !== '') {
            // Find all players on the winning team(s)
            $query = "SELECT id, owned_pets, pet_ages FROM users WHERE team = ?";
            if ($winner === 'tie') $query = "SELECT id, owned_pets, pet_ages FROM users WHERE team IN ('red', 'blue')";
            
            $stmtWin = $pdo->prepare($query);
            $stmtWin->execute($winner === 'tie' ? [] : [$winner]);
            $winning_players = $stmtWin->fetchAll(PDO::FETCH_ASSOC);
            
            foreach ($winning_players as $p) {
                $pets = json_decode($p['owned_pets'], true) ?: [];
                $ages = json_decode($p['pet_ages'], true) ?: [];
                
                // Give them the Reaper pet!
                if (count($pets) < 50) {
                    $uid = 'reaper::' . round(microtime(true) * 1000) . '_' . mt_rand(100, 999);
                    $pets[] = $uid;
                    $ages[$uid] = 0; 
                    
                    $upd = $pdo->prepare("UPDATE users SET owned_pets = ?, pet_ages = ? WHERE id = ?");
                    $upd->execute([json_encode(array_values($pets)), json_encode($ages), $p['id']]);
                }
            }
        }
        
        // Reset points to 0 and update month
        $pdo->query("UPDATE global_state SET key_value = '0' WHERE key_name IN ('team_red_points', 'team_blue_points')");
        $stmtUpdateMonth = $pdo->prepare("UPDATE global_state SET key_value = ? WHERE key_name = 'teams_reward_month'");
        $stmtUpdateMonth->execute([$current_month]);
        
        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
    }
}

// Helper to get Global Points
function getPoints($pdo) {
    $stmtR = $pdo->query("SELECT key_value FROM global_state WHERE key_name = 'team_red_points'");
    $stmtB = $pdo->query("SELECT key_value FROM global_state WHERE key_name = 'team_blue_points'");
    return [
        "red" => (int)$stmtR->fetchColumn(),
        "blue" => (int)$stmtB->fetchColumn()
    ];
}

if ($action === 'load') {
    $stmt = $pdo->prepare("SELECT coins, team FROM users WHERE id = ?");
    $stmt->execute([$user_id]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);
    
    echo json_encode([
        "success" => true,
        "coins" => (int)$user['coins'],
        "team" => $user['team'],
        "points" => getPoints($pdo)
    ]);
    exit;
}

if ($action === 'choose_team') {
    $team = $_POST['team'] ?? '';
    if ($team !== 'red' && $team !== 'blue') die(json_encode(["success" => false, "message" => "Invalid team."]));
    
    $stmt = $pdo->prepare("SELECT team FROM users WHERE id = ?");
    $stmt->execute([$user_id]);
    $current_team = $stmt->fetchColumn();
    
    if (!empty($current_team)) die(json_encode(["success" => false, "message" => "You are already on a team!"]));
    
    $stmt = $pdo->prepare("UPDATE users SET team = ? WHERE id = ?");
    $stmt->execute([$team, $user_id]);
    
    echo json_encode(["success" => true, "team" => $team]);
    exit;
}

if ($action === 'donate') {
    try {
        $pdo->beginTransaction();
        
        $stmt = $pdo->prepare("SELECT coins, team FROM users WHERE id = ? FOR UPDATE");
        $stmt->execute([$user_id]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        
        if (empty($user['team'])) throw new Exception("You must choose a team first!");
        if ((int)$user['coins'] < 10000) throw new Exception("You need 10,000 ExamCoins to donate!");
        
        // Deduct coins
        $new_coins = (int)$user['coins'] - 10000;
        $stmtUpdate = $pdo->prepare("UPDATE users SET coins = ? WHERE id = ?");
        $stmtUpdate->execute([$new_coins, $user_id]);
        
        // Add point to global state
        $key = $user['team'] === 'red' ? 'team_red_points' : 'team_blue_points';
        $stmtPoint = $pdo->prepare("UPDATE global_state SET key_value = key_value + 1 WHERE key_name = ?");
        $stmtPoint->execute([$key]);
        
        $pdo->commit();
        echo json_encode(["success" => true, "coins" => $new_coins, "points" => getPoints($pdo)]);
    } catch (Exception $e) {
        $pdo->rollBack();
        echo json_encode(["success" => false, "message" => $e->getMessage()]);
    }
    exit;
}
?>
