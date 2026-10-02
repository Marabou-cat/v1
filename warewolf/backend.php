<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

// 1. Read Database credentials from config.ini
$config_file = __DIR__ . '/config.ini';
$db_user = 'root';
$db_pass = '';

if (file_exists($config_file)) {
    $lines = file($config_file, FILE_IGNORE_NEW_LINES);
    if (isset($lines[0])) $db_user = trim($lines[0]);
    if (isset($lines[1])) $db_pass = trim($lines[1]);
}

$db_host = 'localhost';
$db_name = 'werewolf_db';

// 2. Connect to MySQL & ensure database exists
try {
    $pdo_init = new PDO("mysql:host=$db_host;charset=utf8mb4", $db_user, $db_pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION
    ]);
    $pdo_init->exec("CREATE DATABASE IF NOT EXISTS `$db_name` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;");

    $pdo = new PDO("mysql:host=$db_host;dbname=$db_name;charset=utf8mb4", $db_user, $db_pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
    ]);
} catch (PDOException $e) {
    echo json_encode(['success' => false, 'error' => 'Database Connection Failed: ' . $e->getMessage()]);
    exit;
}

// 3. Initialize Tables
$pdo->exec("
    CREATE TABLE IF NOT EXISTS games (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(10) UNIQUE NOT NULL,
        status ENUM('lobby', 'night', 'day_vote', 'ended') DEFAULT 'lobby',
        round INT DEFAULT 1,
        winner VARCHAR(20) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS players (
        id INT AUTO_INCREMENT PRIMARY KEY,
        game_id INT NOT NULL,
        name VARCHAR(50) NOT NULL,
        session_token VARCHAR(64) NOT NULL,
        role ENUM('werewolf', 'villager', 'seer', 'doctor') DEFAULT 'villager',
        is_alive TINYINT(1) DEFAULT 1,
        is_host TINYINT(1) DEFAULT 0,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS actions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        game_id INT NOT NULL,
        round INT NOT NULL,
        phase VARCHAR(20) NOT NULL,
        actor_id INT NOT NULL,
        action_type ENUM('kill', 'heal', 'check', 'vote') NOT NULL,
        target_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        game_id INT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        game_id INT NOT NULL,
        player_name VARCHAR(50) NOT NULL,
        message TEXT NOT NULL,
        is_werewolf_chat TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    );
");

// Parse JSON input or POST parameters
$raw_input = file_get_contents('php://input');
$input = json_decode($raw_input, true) ?? $_REQUEST;
$action = $input['action'] ?? '';

// Helper Functions
function get_player_by_token($pdo, $token) {
    if (empty($token)) return null;
    $stmt = $pdo->prepare("SELECT p.*, g.code as game_code, g.status as game_status, g.round as game_round, g.winner as game_winner 
                           FROM players p JOIN games g ON p.game_id = g.id WHERE p.session_token = ?");
    $stmt->execute([$token]);
    return $stmt->fetch();
}

function check_win_conditions($pdo, $game_id) {
    $stmt = $pdo->prepare("SELECT role, is_alive FROM players WHERE game_id = ?");
    $stmt->execute([$game_id]);
    $players = $stmt->fetchAll();

    $alive_wolves = 0;
    $alive_villagers = 0;

    foreach ($players as $p) {
        if ($p['is_alive']) {
            if ($p['role'] === 'werewolf') {
                $alive_wolves++;
            } else {
                $alive_villagers++;
            }
        }
    }

    if ($alive_wolves === 0) {
        $pdo->prepare("UPDATE games SET status = 'ended', winner = 'Villagers' WHERE id = ?")->execute([$game_id]);
        $pdo->prepare("INSERT INTO logs (game_id, message) VALUES (?, ?)")->execute([$game_id, "🎉 VILLAGERS WIN! All Werewolves have been eliminated."]);
        return true;
    } else if ($alive_wolves >= $alive_villagers) {
        $pdo->prepare("UPDATE games SET status = 'ended', winner = 'Werewolves' WHERE id = ?")->execute([$game_id]);
        $pdo->prepare("INSERT INTO logs (game_id, message) VALUES (?, ?)")->execute([$game_id, "🐺 WEREWOLVES WIN! The Werewolves equal or outnumber the Villagers."]);
        return true;
    }
    return false;
}

function resolve_night($pdo, $game_id, $round) {
    $stmt = $pdo->prepare("SELECT * FROM actions WHERE game_id = ? AND round = ? AND phase = 'night'");
    $stmt->execute([$game_id, $round]);
    $actions = $stmt->fetchAll();

    $kill_target_id = null;
    $heal_target_id = null;

    foreach ($actions as $act) {
        if ($act['action_type'] === 'kill') $kill_target_id = $act['target_id'];
        if ($act['action_type'] === 'heal') $heal_target_id = $act['target_id'];
    }

    if ($kill_target_id !== null && $kill_target_id != $heal_target_id) {
        $pdo->prepare("UPDATE players SET is_alive = 0 WHERE id = ? AND game_id = ?")->execute([$kill_target_id, $game_id]);
        $stmt = $pdo->prepare("SELECT name FROM players WHERE id = ?");
        $stmt->execute([$kill_target_id]);
        $victim = $stmt->fetch();
        $v_name = $victim ? $victim['name'] : 'Someone';
        $pdo->prepare("INSERT INTO logs (game_id, message) VALUES (?, ?)")
            ->execute([$game_id, "☀️ Morning arrives. 🩸 $v_name was killed during the night!"]);
    } else {
        $pdo->prepare("INSERT INTO logs (game_id, message) VALUES (?, ?)")
            ->execute([$game_id, "☀️ Morning arrives. 🛡️ Miraculously, no one died last night!"]);
    }

    if (!check_win_conditions($pdo, $game_id)) {
        $pdo->prepare("UPDATE games SET status = 'day_vote' WHERE id = ?")->execute([$game_id]);
        $pdo->prepare("INSERT INTO logs (game_id, message) VALUES (?, ?)")
            ->execute([$game_id, "🗳️ Day Voting Phase: Discuss and cast your vote on who to lynch!"]);
    }
}

function resolve_day_vote($pdo, $game_id, $round) {
    $stmt = $pdo->prepare("SELECT target_id, COUNT(*) as vote_count FROM actions WHERE game_id = ? AND round = ? AND phase = 'day_vote' GROUP BY target_id ORDER BY vote_count DESC");
    $stmt->execute([$game_id, $round]);
    $votes = $stmt->fetchAll();

    if (!empty($votes)) {
        $top_target_id = $votes[0]['target_id'];
        $pdo->prepare("UPDATE players SET is_alive = 0 WHERE id = ? AND game_id = ?")->execute([$top_target_id, $game_id]);

        $stmt = $pdo->prepare("SELECT name, role FROM players WHERE id = ?");
        $stmt->execute([$top_target_id]);
        $lynched = $stmt->fetch();
        $l_name = $lynched ? $lynched['name'] : 'Someone';
        $l_role = $lynched ? strtoupper($lynched['role']) : 'UNKNOWN';

        $pdo->prepare("INSERT INTO logs (game_id, message) VALUES (?, ?)")
            ->execute([$game_id, "⚖️ The villagers lynched $l_name! They were a $l_role."]);
    } else {
        $pdo->prepare("INSERT INTO logs (game_id, message) VALUES (?, ?)")
            ->execute([$game_id, "⚖️ No votes were cast. Nobody was lynched today."]);
    }

    if (!check_win_conditions($pdo, $game_id)) {
        $next_round = $round + 1;
        $pdo->prepare("UPDATE games SET status = 'night', round = ? WHERE id = ?")->execute([$next_round, $game_id]);
        $pdo->prepare("INSERT INTO logs (game_id, message) VALUES (?, ?)")
            ->execute([$game_id, "🌙 Night $next_round falls. Werewolves, Doctor, and Seer, make your moves!"]);
    }
}

// 4. API Endpoints Logic
switch ($action) {

    case 'create_game':
        $name = trim($input['player_name'] ?? 'Host');
        if (empty($name)) $name = 'Host';

        $code = strtoupper(substr(md5(uniqid(rand(), true)), 0, 6));
        $token = bin2hex(random_bytes(16));

        $pdo->prepare("INSERT INTO games (code, status) VALUES (?, 'lobby')")->execute([$code]);
        $game_id = $pdo->lastInsertId();

        $pdo->prepare("INSERT INTO players (game_id, name, session_token, is_host) VALUES (?, ?, ?, 1)")
            ->execute([$game_id, $name, $token]);
        $player_id = $pdo->lastInsertId();

        $pdo->prepare("INSERT INTO logs (game_id, message) VALUES (?, ?)")
            ->execute([$game_id, "🎮 Game room created. Waiting for players..."]);

        echo json_encode(['success' => true, 'game_code' => $code, 'session_token' => $token, 'player_id' => $player_id]);
        break;

    case 'join_game':
        $code = strtoupper(trim($input['game_code'] ?? ''));
        $name = trim($input['player_name'] ?? 'Player');

        $stmt = $pdo->prepare("SELECT * FROM games WHERE code = ?");
        $stmt->execute([$code]);
        $game = $stmt->fetch();

        if (!$game) {
            echo json_encode(['success' => false, 'error' => 'Game room not found.']);
            exit;
        }
        if ($game['status'] !== 'lobby') {
            echo json_encode(['success' => false, 'error' => 'Game has already started.']);
            exit;
        }

        $token = bin2hex(random_bytes(16));
        $pdo->prepare("INSERT INTO players (game_id, name, session_token) VALUES (?, ?, ?)")
            ->execute([$game['id'], $name, $token]);
        $player_id = $pdo->lastInsertId();

        $pdo->prepare("INSERT INTO logs (game_id, message) VALUES (?, ?)")
            ->execute([$game['id'], "👤 $name joined the lobby."]);

        echo json_encode(['success' => true, 'game_code' => $code, 'session_token' => $token, 'player_id' => $player_id]);
        break;

    case 'start_game':
        $player = get_player_by_token($pdo, $input['session_token'] ?? '');
        if (!$player || !$player['is_host']) {
            echo json_encode(['success' => false, 'error' => 'Only the host can start the game.']);
            exit;
        }

        $stmt = $pdo->prepare("SELECT id FROM players WHERE game_id = ?");
        $stmt->execute([$player['game_id']]);
        $players = $stmt->fetchAll(PDO::FETCH_COLUMN);

        if (count($players) < 3) {
            echo json_encode(['success' => false, 'error' => 'Need at least 3 players to start.']);
            exit;
        }

        shuffle($players);
        $total = count($players);

        // Assign Roles
        $roles = [];
        $roles[] = 'werewolf';
        if ($total >= 7) $roles[] = 'werewolf'; // 2nd wolf for larger games
        $roles[] = 'seer';
        if ($total >= 4) $roles[] = 'doctor';

        while (count($roles) < $total) {
            $roles[] = 'villager';
        }
        shuffle($roles);

        foreach ($players as $idx => $p_id) {
            $pdo->prepare("UPDATE players SET role = ?, is_alive = 1 WHERE id = ?")->execute([$roles[$idx], $p_id]);
        }

        $pdo->prepare("UPDATE games SET status = 'night', round = 1, winner = NULL WHERE id = ?")->execute([$player['game_id']]);
        $pdo->prepare("INSERT INTO logs (game_id, message) VALUES (?, ?)")
            ->execute([$player['game_id'], "🌕 The game has begun! Night 1 falls. Night roles, perform your actions."]);

        echo json_encode(['success' => true]);
        break;

    case 'get_state':
        $token = $input['session_token'] ?? '';
        $player = get_player_by_token($pdo, $token);

        if (!$player) {
            echo json_encode(['success' => false, 'error' => 'Invalid session']);
            exit;
        }

        $game_id = $player['game_id'];

        // Get Game Details
        $stmt = $pdo->prepare("SELECT * FROM games WHERE id = ?");
        $stmt->execute([$game_id]);
        $game = $stmt->fetch();

        // Check if Night phase auto-resolves
        if ($game['status'] === 'night') {
            $stmt = $pdo->prepare("SELECT role FROM players WHERE game_id = ? AND is_alive = 1");
            $stmt->execute([$game_id]);
            $alive_roles = $stmt->fetchAll(PDO::FETCH_COLUMN);

            $stmt = $pdo->prepare("SELECT action_type FROM actions WHERE game_id = ? AND round = ? AND phase = 'night'");
            $stmt->execute([$game_id, $game['round']]);
            $done_actions = $stmt->fetchAll(PDO::FETCH_COLUMN);

            $need_wolf = in_array('werewolf', $alive_roles) && !in_array('kill', $done_actions);
            $need_doc = in_array('doctor', $alive_roles) && !in_array('heal', $done_actions);
            $need_seer = in_array('seer', $alive_roles) && !in_array('check', $done_actions);

            if (!$need_wolf && !$need_doc && !$need_seer) {
                resolve_night($pdo, $game_id, $game['round']);
                $stmt->execute([$game_id]);
                $game = $stmt->fetch(); // refresh
            }
        }

        // Check if Day Vote auto-resolves
        if ($game['status'] === 'day_vote') {
            $stmt = $pdo->prepare("SELECT COUNT(*) FROM players WHERE game_id = ? AND is_alive = 1");
            $stmt->execute([$game_id]);
            $alive_cnt = (int)$stmt->fetchColumn();

            $stmt = $pdo->prepare("SELECT COUNT(DISTINCT actor_id) FROM actions WHERE game_id = ? AND round = ? AND phase = 'day_vote'");
            $stmt->execute([$game_id, $game['round']]);
            $voted_cnt = (int)$stmt->fetchColumn();

            if ($voted_cnt >= $alive_cnt && $alive_cnt > 0) {
                resolve_day_vote($pdo, $game_id, $game['round']);
                $stmt = $pdo->prepare("SELECT * FROM games WHERE id = ?");
                $stmt->execute([$game_id]);
                $game = $stmt->fetch(); // refresh
            }
        }

        // Fetch Players List (Mask sensitive role data)
        $stmt = $pdo->prepare("SELECT id, name, is_alive, is_host, role FROM players WHERE game_id = ?");
        $stmt->execute([$game_id]);
        $players_raw = $stmt->fetchAll();

        $players = [];
        foreach ($players_raw as $p) {
            $show_role = ($game['status'] === 'ended') 
                         || ($p['id'] == $player['id']) 
                         || ($player['role'] === 'werewolf' && $p['role'] === 'werewolf');
            
            $players[] = [
                'id' => $p['id'],
                'name' => $p['name'],
                'is_alive' => (bool)$p['is_alive'],
                'is_host' => (bool)$p['is_host'],
                'role' => $show_role ? $p['role'] : null
            ];
        }

        // Fetch Logs
        $stmt = $pdo->prepare("SELECT message, created_at FROM logs WHERE game_id = ? ORDER BY id DESC LIMIT 20");
        $stmt->execute([$game_id]);
        $logs = $stmt->fetchAll();

        // Fetch Messages
        $stmt = $pdo->prepare("SELECT player_name, message, is_werewolf_chat, created_at FROM messages WHERE game_id = ? ORDER BY id ASC");
        $stmt->execute([$game_id]);
        $raw_msgs = $stmt->fetchAll();

        $messages = [];
        foreach ($raw_msgs as $m) {
            if (!$m['is_werewolf_chat'] || $player['role'] === 'werewolf') {
                $messages[] = $m;
            }
        }

        // Fetch Current Action for Player
        $stmt = $pdo->prepare("SELECT target_id, action_type FROM actions WHERE game_id = ? AND round = ? AND phase = ? AND actor_id = ?");
        $stmt->execute([$game_id, $game['round'], $game['status'], $player['id']]);
        $my_action = $stmt->fetch();

        // If Seer action in this round, fetch target role
        $seer_result = null;
        if ($player['role'] === 'seer') {
            $stmt = $pdo->prepare("SELECT a.target_id, p.name, p.role FROM actions a JOIN players p ON a.target_id = p.id WHERE a.game_id = ? AND a.actor_id = ? AND a.action_type = 'check' ORDER BY a.id DESC LIMIT 1");
            $stmt->execute([$game_id, $player['id']]);
            $seer_result = $stmt->fetch();
        }

        echo json_encode([
            'success' => true,
            'game' => [
                'code' => $game['code'],
                'status' => $game['status'],
                'round' => (int)$game['round'],
                'winner' => $game['winner']
            ],
            'me' => [
                'id' => (int)$player['id'],
                'name' => $player['name'],
                'role' => $player['role'],
                'is_alive' => (bool)$player['is_alive'],
                'is_host' => (bool)$player['is_host']
            ],
            'players' => $players,
            'logs' => $logs,
            'messages' => $messages,
            'my_action' => $my_action,
            'seer_result' => $seer_result
        ]);
        break;

    case 'perform_action':
        $token = $input['session_token'] ?? '';
        $player = get_player_by_token($pdo, $token);
        $target_id = (int)($input['target_id'] ?? 0);

        if (!$player || !$player['is_alive']) {
            echo json_encode(['success' => false, 'error' => 'Dead or invalid player cannot act.']);
            exit;
        }

        $game_id = $player['game_id'];
        $phase = $player['game_status'];
        $round = $player['game_round'];

        if ($phase === 'night') {
            $action_type = null;
            if ($player['role'] === 'werewolf') $action_type = 'kill';
            if ($player['role'] === 'doctor') $action_type = 'heal';
            if ($player['role'] === 'seer') $action_type = 'check';

            if (!$action_type) {
                echo json_encode(['success' => false, 'error' => 'Villagers do not have night actions.']);
                exit;
            }

            // Remove previous action for this round if any
            $pdo->prepare("DELETE FROM actions WHERE game_id = ? AND round = ? AND phase = 'night' AND actor_id = ?")
                ->execute([$game_id, $round, $player['id']]);

            $pdo->prepare("INSERT INTO actions (game_id, round, phase, actor_id, action_type, target_id) VALUES (?, ?, 'night', ?, ?, ?)")
                ->execute([$game_id, $round, $player['id'], $action_type, $target_id]);

            echo json_encode(['success' => true]);

        } else if ($phase === 'day_vote') {
            $pdo->prepare("DELETE FROM actions WHERE game_id = ? AND round = ? AND phase = 'day_vote' AND actor_id = ?")
                ->execute([$game_id, $round, $player['id']]);

            $pdo->prepare("INSERT INTO actions (game_id, round, phase, actor_id, action_type, target_id) VALUES (?, ?, 'day_vote', ?, 'vote', ?)")
                ->execute([$game_id, $round, $player['id'], $target_id]);

            echo json_encode(['success' => true]);

        } else {
            echo json_encode(['success' => false, 'error' => 'Cannot act in current phase.']);
        }
        break;

    case 'force_advance':
        $player = get_player_by_token($pdo, $input['session_token'] ?? '');
        if (!$player || !$player['is_host']) {
            echo json_encode(['success' => false, 'error' => 'Only host can force advance.']);
            exit;
        }

        if ($player['game_status'] === 'night') {
            resolve_night($pdo, $player['game_id'], $player['game_round']);
        } else if ($player['game_status'] === 'day_vote') {
            resolve_day_vote($pdo, $player['game_id'], $player['game_round']);
        }
        echo json_encode(['success' => true]);
        break;

    case 'send_chat':
        $token = $input['session_token'] ?? '';
        $message = trim($input['message'] ?? '');
        $player = get_player_by_token($pdo, $token);

        if (!$player || empty($message)) {
            echo json_encode(['success' => false, 'error' => 'Invalid request']);
            exit;
        }

        $is_wolf_chat = ($player['game_status'] === 'night' && $player['role'] === 'werewolf') ? 1 : 0;

        $pdo->prepare("INSERT INTO messages (game_id, player_name, message, is_werewolf_chat) VALUES (?, ?, ?, ?)")
            ->execute([$player['game_id'], $player['name'], $message, $is_wolf_chat]);

        echo json_encode(['success' => true]);
        break;

    default:
        echo json_encode(['success' => false, 'error' => 'Invalid action']);
        break;
}
