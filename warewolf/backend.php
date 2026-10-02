<?php
header('Content-Type: application/json');

// --- DATABASE CONNECTION SETUP ---
$configPath = __DIR__ . '/../config.ini';

if (!file_exists($configPath)) {
    echo json_encode(['status' => 'error', 'message' => 'Configuration file config.ini not found.']);
    exit;
}

$configLines = file($configPath, FILE_IGNORE_NEW_LINES);
$dbUser = isset($configLines[0]) ? trim($configLines[0]) : '';
$dbPass = isset($configLines[1]) ? trim($configLines[1]) : '';
$dbName = 'werewolf_db';
$dbHost = 'localhost';

try {
    $pdo = new PDO("mysql:host={$dbHost};dbname={$dbName};charset=utf8mb4", $dbUser, $dbPass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
    ]);
} catch (PDOException $e) {
    echo json_encode(['status' => 'error', 'message' => 'Database connection failed: ' . $e->getMessage()]);
    exit;
}

// --- HELPER FUNCTIONS ---
function sendJson(array $data): void {
    echo json_encode($data);
    exit;
}

function sendError(string $message): void {
    sendJson(['status' => 'error', 'message' => $message]);
}

function generateRoomCode(PDO $pdo, int $length = 5): string {
    $characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do {
        $code = '';
        for ($i = 0; $i < $length; $i++) {
            $code .= $characters[random_int(0, strlen($characters) - 1)];
        }
        $stmt = $pdo->prepare('SELECT id FROM rooms WHERE room_code = ?');
        $stmt->execute([$code]);
    } while ($stmt->fetch());

    return $code;
}

function generateToken(): string {
    return bin2hex(random_bytes(16));
}

// --- ROUTER ---
$action = $_POST['action'] ?? '';
$nickname = isset($_POST['nickname']) ? trim(strip_tags($_POST['nickname'])) : 'Brawler';
if (empty($nickname)) {
    $nickname = 'Brawler';
}

switch ($action) {
    case 'find_online_game':
        handleFindOnlineGame($pdo, $nickname);
        break;

    case 'create_room':
        $maxPlayers = isset($_POST['max_players']) ? (int)$_POST['max_players'] : 6;
        $isPublic = isset($_POST['is_public']) ? (int)$_POST['is_public'] : 0;
        handleCreateRoom($pdo, $nickname, $maxPlayers, $isPublic);
        break;

    case 'join_room':
        $roomCode = isset($_POST['room_code']) ? strtoupper(trim($_POST['room_code'])) : '';
        handleJoinRoom($pdo, $nickname, $roomCode);
        break;

    case 'start_game':
        $roomCode = isset($_POST['room_code']) ? strtoupper(trim($_POST['room_code'])) : '';
        $token = $_POST['token'] ?? '';
        handleStartGame($pdo, $roomCode, $token);
        break;

    case 'poll_lobby':
        $roomCode = isset($_POST['room_code']) ? strtoupper(trim($_POST['room_code'])) : '';
        $token = $_POST['token'] ?? '';
        handlePollLobby($pdo, $roomCode, $token);
        break;

    default:
        sendError('Invalid request action.');
}

// --- CONTROLLER ACTIONS ---

function handleFindOnlineGame(PDO $pdo, string $nickname): void {
    // Search for an open public lobby
    $stmt = $pdo->query("
        SELECT r.id, r.room_code, r.max_players, COUNT(p.id) AS player_count
        FROM rooms r
        LEFT JOIN players p ON r.id = p.room_id
        WHERE r.status = 'waiting' AND r.is_public = 1
        GROUP BY r.id
        HAVING player_count < r.max_players
        ORDER BY r.created_at ASC
        LIMIT 1
    ");
    $openRoom = $stmt->fetch();

    if ($openRoom) {
        // Join existing public room
        $token = generateToken();
        $stmtJoin = $pdo->prepare('INSERT INTO players (room_id, nickname, token, is_host) VALUES (?, ?, ?, 0)');
        $stmtJoin->execute([$openRoom['id'], $nickname, $token]);

        sendJson([
            'status' => 'success',
            'room_code' => $openRoom['room_code'],
            'token' => $token,
            'cutscene' => 'scene_match_found'
        ]);
    } else {
        // Create new public room if none is available
        handleCreateRoom($pdo, $nickname, 6, 1);
    }
}

function handleCreateRoom(PDO $pdo, string $nickname, int $maxPlayers, int $isPublic): void {
    $maxPlayers = max(4, min(10, $maxPlayers));
    $roomCode = generateRoomCode($pdo);
    $token = generateToken();

    $stmtRoom = $pdo->prepare('INSERT INTO rooms (room_code, max_players, is_public, status) VALUES (?, ?, ?, "waiting")');
    $stmtRoom->execute([$roomCode, $maxPlayers, $isPublic]);
    $roomId = $pdo->lastInsertId();

    $stmtPlayer = $pdo->prepare('INSERT INTO players (room_id, nickname, token, is_host) VALUES (?, ?, ?, 1)');
    $stmtPlayer->execute([$roomId, $nickname, $token]);

    sendJson([
        'status' => 'success',
        'room_code' => $roomCode,
        'token' => $token,
        'cutscene' => 'scene_room_created'
    ]);
}

function handleJoinRoom(PDO $pdo, string $nickname, string $roomCode): void {
    if (empty($roomCode)) {
        sendError('Room code is required.');
    }

    $stmt = $pdo->prepare('SELECT id, max_players, status FROM rooms WHERE room_code = ?');
    $stmt->execute([$roomCode]);
    $room = $stmt->fetch();

    if (!$room) {
        sendError('Room not found.');
    }

    if ($room['status'] !== 'waiting') {
        sendError('Game in this room has already started.');
    }

    $stmtCount = $pdo->prepare('SELECT COUNT(*) FROM players WHERE room_id = ?');
    $stmtCount->execute([$room['id']]);
    $currentCount = (int)$stmtCount->fetchColumn();

    if ($currentCount >= (int)$room['max_players']) {
        sendError('Room is full.');
    }

    $token = generateToken();
    $stmtInsert = $pdo->prepare('INSERT INTO players (room_id, nickname, token, is_host) VALUES (?, ?, ?, 0)');
    $stmtInsert->execute([$room['id'], $nickname, $token]);

    sendJson([
        'status' => 'success',
        'room_code' => $roomCode,
        'token' => $token,
        'cutscene' => 'scene_joining_room'
    ]);
}

function handleStartGame(PDO $pdo, string $roomCode, string $token): void {
    if (empty($roomCode) || empty($token)) {
        sendError('Missing credentials to start game.');
    }

    $stmt = $pdo->prepare('
        SELECT p.id AS player_id, p.is_host, r.id AS room_id, r.status
        FROM players p
        JOIN rooms r ON p.room_id = r.id
        WHERE r.room_code = ? AND p.token = ?
    ');
    $stmt->execute([$roomCode, $token]);
    $player = $stmt->fetch();

    if (!$player) {
        sendError('Session authorization failed.');
    }

    if (!$player['is_host']) {
        sendError('Only the lobby host can start the brawl.');
    }

    $stmtAll = $pdo->prepare('SELECT id FROM players WHERE room_id = ?');
    $stmtAll->execute([$player['room_id']]);
    $allPlayers = $stmtAll->fetchAll();
    $count = count($allPlayers);

    if ($count < 4) {
        sendError('Minimum 4 players required to start the game.');
    }

    // Role assignment logic
    $roles = [];
    if ($count <= 5) {
        $roles = ['Werewolf', 'Seer'];
    } elseif ($count <= 8) {
        $roles = ['Werewolf', 'Werewolf', 'Seer', 'Doctor'];
    } else {
        $roles = ['Werewolf', 'Werewolf', 'Werewolf', 'Seer', 'Doctor'];
    }

    while (count($roles) < $count) {
        $roles[] = 'Villager';
    }

    shuffle($roles);

    $stmtUpdateRole = $pdo->prepare('UPDATE players SET role = ? WHERE id = ?');
    foreach ($allPlayers as $index => $p) {
        $stmtUpdateRole->execute([$roles[$index], $p['id']]);
    }

    $stmtRoomStart = $pdo->prepare('UPDATE rooms SET status = "night" WHERE id = ?');
    $stmtRoomStart->execute([$player['room_id']]);

    sendJson([
        'status' => 'success',
        'cutscene' => 'scene_night_falls'
    ]);
}

function handlePollLobby(PDO $pdo, string $roomCode, string $token): void {
    if (empty($roomCode) || empty($token)) {
        sendError('Missing session identifiers.');
    }

    $stmtSelf = $pdo->prepare('
        SELECT p.id, p.is_host, p.role, r.id AS room_id, r.max_players, r.status AS room_status
        FROM players p
        JOIN rooms r ON p.room_id = r.id
        WHERE r.room_code = ? AND p.token = ?
    ');
    $stmtSelf->execute([$roomCode, $token]);
    $me = $stmtSelf->fetch();

    if (!$me) {
        sendError('Room or player session expired.');
    }

    $stmtPlayers = $pdo->prepare('SELECT nickname FROM players WHERE room_id = ? ORDER BY id ASC');
    $stmtPlayers->execute([$me['room_id']]);
    $playerList = $stmtPlayers->fetchAll(PDO::FETCH_COLUMN);

    sendJson([
        'status' => 'success',
        'current_count' => count($playerList),
        'max_players' => (int)$me['max_players'],
        'players' => $playerList,
        'is_host' => (bool)$me['is_host'],
        'room_status' => $me['room_status'],
        'my_role' => $me['role']
    ]);
}
