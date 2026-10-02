<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

// -------------------------------------------------------------
// 1. Database Connection via ../config.ini
// -------------------------------------------------------------
$configPath = __DIR__ . 'config.ini';

if (!file_exists($configPath)) {
    echo json_encode(['status' => 'error', 'message' => 'Config file not found at ../config.ini']);
    exit;
}

$lines = file($configPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$dbUser = isset($lines[0]) ? trim($lines[0]) : 'root';
$dbPass = isset($lines[1]) ? trim($lines[1]) : '';
$dbHost = 'localhost';
$dbName = 'werewolf_db';

try {
    $pdo = new PDO("mysql:host=$dbHost;dbname=$dbName;charset=utf8mb4", $dbUser, $dbPass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
    ]);
} catch (PDOException $e) {
    echo json_encode(['status' => 'error', 'message' => 'Database connection failed: ' . $e->getMessage()]);
    exit;
}

// Read JSON input or POST data
$rawInput = file_get_contents('php_input');
$input = json_decode($rawInput, true) ?? $_POST;
$action = $input['action'] ?? $_GET['action'] ?? '';

// Helper to send standard responses
function respond($status, $data = [], $message = '') {
    echo json_encode(array_merge(['status' => $status, 'message' => $message], $data));
    exit;
}

// Helper: Generate 6-digit random numeric room code
function generateRoomCode($pdo) {
    do {
        $code = str_pad(mt_rand(100000, 999999), 6, '0', STR_PAD_LEFT);
        $stmt = $pdo->prepare("SELECT id FROM rooms WHERE code = ?");
        $stmt->execute([$code]);
    } while ($stmt->fetch());
    return $code;
}

// -------------------------------------------------------------
// 2. API Endpoints
// -------------------------------------------------------------

switch ($action) {

    // --- CREATE ROOM ---
    case 'create_room':
        $playerId = $input['player_id'] ?? '';
        $username = $input['username'] ?? 'Player';
        $avatar   = $input['avatar']   ?? 'shelly';

        if (!$playerId) respond('error', [], 'Missing player_id');

        $code = generateRoomCode($pdo);

        // Create Room
        $stmt = $pdo->prepare("INSERT INTO rooms (code, host_id, status, phase) VALUES (?, ?, 'waiting', 'lobby')");
        $stmt->execute([$code, $playerId]);

        // Add Host as Player
        $stmt = $pdo->prepare("INSERT INTO players (room_code, player_id, username, avatar, is_host, is_ready) VALUES (?, ?, ?, ?, 1, 1)");
        $stmt->execute([$code, $playerId, $username, $avatar]);

        // Add Welcome Chat System Message
        $stmt = $pdo->prepare("INSERT INTO messages (room_code, sender, text, is_system) VALUES (?, 'SYSTEM', ?, 1)");
        $stmt->execute([$code, "Room $code created. Welcome!"]);

        respond('success', ['room_code' => $code]);
        break;

    // --- JOIN ROOM ---
    case 'join_room':
        $code     = $input['room_code'] ?? '';
        $playerId = $input['player_id'] ?? '';
        $username = $input['username']  ?? 'Player';
        $avatar   = $input['avatar']    ?? 'shelly';

        if (!$code || !$playerId) respond('error', [], 'Missing room code or player ID');

        // Check room
        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE code = ?");
        $stmt->execute([$code]);
        $room = $stmt->fetch();

        if (!$room) respond('error', [], 'Room not found!');
        if ($room['status'] !== 'waiting') respond('error', [], 'Game has already started');

        // Check player count
        $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM players WHERE room_code = ?");
        $stmt->execute([$code]);
        $pCount = $stmt->fetch()['count'];

        if ($pCount >= $room['max_players']) respond('error', [], 'Room is full!');

        // Add or update player
        $stmt = $pdo->prepare("INSERT INTO players (room_code, player_id, username, avatar) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=?, avatar=?");
        $stmt->execute([$code, $playerId, $username, $avatar, $username, $avatar]);

        // System message
        $stmt = $pdo->prepare("INSERT INTO messages (room_code, sender, text, is_system) VALUES (?, 'SYSTEM', ?, 1)");
        $stmt->execute([$code, "$username joined the room"]);

        respond('success', ['room_code' => $code]);
        break;

    // --- QUICK MATCH / FIND GAME ---
    case 'find_game':
        $playerId = $input['player_id'] ?? '';
        $username = $input['username']  ?? 'Player';
        $avatar   = $input['avatar']    ?? 'shelly';

        // Find open room
        $stmt = $pdo->prepare("SELECT r.code FROM rooms r JOIN players p ON r.code = p.room_code WHERE r.status = 'waiting' GROUP BY r.code HAVING COUNT(p.id) < 10 LIMIT 1");
        $stmt->execute();
        $room = $stmt->fetch();

        if ($room) {
            $code = $room['code'];
            $stmt = $pdo->prepare("INSERT INTO players (room_code, player_id, username, avatar) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=?, avatar=?");
            $stmt->execute([$code, $playerId, $username, $avatar, $username, $avatar]);
            respond('success', ['room_code' => $code]);
        } else {
            // Auto-create room if none available
            $code = generateRoomCode($pdo);
            $stmt = $pdo->prepare("INSERT INTO rooms (code, host_id) VALUES (?, ?)");
            $stmt->execute([$code, $playerId]);

            $stmt = $pdo->prepare("INSERT INTO players (room_code, player_id, username, avatar, is_host, is_ready) VALUES (?, ?, ?, ?, 1, 1)");
            $stmt->execute([$code, $playerId, $username, $avatar]);

            respond('success', ['room_code' => $code]);
        }
        break;

    // --- POLL / GET ROOM STATE ---
    case 'get_room':
        $code     = $input['room_code'] ?? '';
        $playerId = $input['player_id'] ?? '';

        if (!$code) respond('error', [], 'Missing room code');

        // Fetch room info
        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE code = ?");
        $stmt->execute([$code]);
        $room = $stmt->fetch();

        if (!$room) respond('error', [], 'Room not found');

        // Fetch players
        $stmt = $pdo->prepare("SELECT player_id, username, avatar, role, is_alive, is_ready, is_host FROM players WHERE room_code = ? ORDER BY id ASC");
        $stmt->execute([$code]);
        $players = $stmt->fetchAll();

        // Fetch recent messages
        $stmt = $pdo->prepare("SELECT sender, text, is_system, created_at FROM messages WHERE room_code = ? ORDER BY id ASC LIMIT 50");
        $stmt->execute([$code]);
        $messages = $stmt->fetchAll();

        respond('success', [
            'room'     => $room,
            'players'  => $players,
            'messages' => $messages
        ]);
        break;

    // --- TOGGLE READY ---
    case 'toggle_ready':
        $code     = $input['room_code'] ?? '';
        $playerId = $input['player_id'] ?? '';

        $stmt = $pdo->prepare("UPDATE players SET is_ready = NOT is_ready WHERE room_code = ? AND player_id = ?");
        $stmt->execute([$code, $playerId]);

        respond('success');
        break;

    // --- SEND CHAT MESSAGE ---
    case 'send_chat':
        $code     = $input['room_code'] ?? '';
        $username = $input['username']  ?? 'Player';
        $text     = trim($input['text'] ?? '');

        if ($text !== '') {
            $stmt = $pdo->prepare("INSERT INTO messages (room_code, sender, text) VALUES (?, ?, ?)");
            $stmt->execute([$code, $username, $text]);
        }

        respond('success');
        break;

    // --- START GAME (HOST) ---
    case 'start_game':
        $code     = $input['room_code'] ?? '';
        $playerId = $input['player_id'] ?? '';

        // Verify Host
        $stmt = $pdo->prepare("SELECT host_id, werewolf_count, has_seer, has_doctor FROM rooms WHERE code = ?");
        $stmt->execute([$code]);
        $room = $stmt->fetch();

        if (!$room || $room['host_id'] !== $playerId) {
            respond('error', [], 'Only the host can start the game');
        }

        // Get players
        $stmt = $pdo->prepare("SELECT player_id FROM players WHERE room_code = ?");
        $stmt->execute([$code]);
        $pList = $stmt->fetchAll(PDO::FETCH_COLUMN);

        if (count($pList) < 3) {
            respond('error', [], 'Need at least 3 players to start');
        }

        // Shuffle and Assign Roles
        shuffle($pList);
        $wolves  = $room['werewolf_count'];
        $hasSeer = $room['has_seer'];
        $hasDoc  = $room['has_doctor'];

        foreach ($pList as $idx => $pid) {
            $role = 'Villager';
            if ($idx < $wolves) {
                $role = 'Werewolf';
            } elseif ($hasSeer && $idx == $wolves) {
                $role = 'Seer';
            } elseif ($hasDoc && $idx == ($wolves + ($hasSeer ? 1 : 0))) {
                $role = 'Doctor';
            }

            $upd = $pdo->prepare("UPDATE players SET role = ?, is_alive = 1 WHERE room_code = ? AND player_id = ?");
            $upd->execute([$role, $code, $pid]);
        }

        // Update Room Status
        $stmt = $pdo->prepare("UPDATE rooms SET status = 'playing', phase = 'NIGHT' WHERE code = ?");
        $stmt->execute([$code]);

        // Add System Announcement
        $stmt = $pdo->prepare("INSERT INTO messages (room_code, sender, text, is_system) VALUES (?, 'SYSTEM', 'Night 1 has fallen. Use your abilities wisely!', 1)");
        $stmt->execute([$code]);

        respond('success');
        break;

    // --- SUBMIT GAME ACTION (NIGHT KILL / INSPECT / PROTECT / VOTE) ---
    case 'submit_action':
        $code       = $input['room_code']   ?? '';
        $actorId    = $input['player_id']   ?? '';
        $targetId   = $input['target_id']   ?? '';
        $actionType = $input['action_type'] ?? ''; // 'kill', 'inspect', 'protect', 'vote'
        $phase      = $input['phase']       ?? 'NIGHT';

        if (!$code || !$actorId || !$targetId) respond('error', [], 'Missing action params');

        $stmt = $pdo->prepare("INSERT INTO actions (room_code, actor_id, target_id, action_type, phase) VALUES (?, ?, ?, ?, ?)");
        $stmt->execute([$code, $actorId, $targetId, $actionType, $phase]);

        respond('success');
        break;

    default:
        respond('error', [], 'Invalid action');
        break;
}
