<?php
header('Content-Type: text/plain');
$lines = file(__DIR__ . '/../config.ini', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$u = trim($lines[0] ?? ''); $p = trim($lines[1] ?? '');
$pdo = new PDO("mysql:host=127.0.0.1;dbname=werewolf_db;charset=utf8mb4", $u, $p, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);

echo "=== TABLES ===\n";
foreach ($pdo->query("SHOW TABLES")->fetchAll(PDO::FETCH_COLUMN) as $t) echo "  $t\n";

echo "=== MESSAGES COLUMNS (if table exists) ===\n";
try {
  $cols = $pdo->query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='werewolf_db' AND TABLE_NAME='messages'")->fetchAll(PDO::FETCH_COLUMN);
  echo ($cols ? implode(',', $cols) : "NO TABLE / no columns") . "\n";
} catch (Exception $e) { echo "  err ".$e->getMessage()."\n"; }

// Simulate a matchmake room + player
$rc = 'DBG' . substr(strtoupper(bin2hex(random_bytes(2))),0,3);
$tok = bin2hex(random_bytes(16));
$pdo->prepare("INSERT INTO rooms (room_code, host_token, max_players, status, is_match, mm_deadline) VALUES (?,?,?,'lobby',1,?)")->execute([$rc,$tok,6,time()+30]);
$pdo->prepare("INSERT INTO players (room_code, session_token, nickname, is_alive) VALUES (?,?,?,1)")->execute([$rc,$tok,'DbgPlayer']);
echo "\n=== Replicate poll_game queries against $rc ===\n";

$steps = [
  "room"        => "SELECT * FROM rooms WHERE room_code = ?",
  "count"       => "SELECT COUNT(*) AS c FROM players WHERE room_code = ?",
  "players"     => "SELECT id, nickname, session_token, role, is_alive, target_id, vote_id, is_bot FROM players WHERE room_code = ? ORDER BY id ASC",
  "messages"    => "SELECT sender_name, message, created_at FROM messages WHERE room_code = ? ORDER BY id ASC LIMIT 50",
];
foreach ($steps as $name => $sql) {
  try {
    $s = $pdo->prepare($sql); $s->execute([$rc]);
    $r = $s->fetchAll();
    echo "  OK  $name (" . count($r) . " rows)\n";
  } catch (Exception $e) {
    echo "  FAIL $name :: " . $e->getMessage() . "\n";
  }
}

// Cleanup test room + its players/messages
$pdo->prepare("DELETE FROM players WHERE room_code = ?")->execute([$rc]);
$pdo->prepare("DELETE FROM messages WHERE room_code = ?")->execute([$rc]);
$pdo->prepare("DELETE FROM rooms WHERE room_code = ?")->execute([$rc]);
echo "\n=== cleaned up $rc ===\n";

// Also list any leftover E2E/match rooms still in lobby so we can see test residue
echo "=== current matchmade lobby rooms (test residue) ===\n";
try {
  $s = $pdo->query("SELECT room_code, max_players, status, mm_deadline FROM rooms WHERE is_match = 1 ORDER BY created_at");
  foreach ($s->fetchAll() as $r) echo "  {$r['room_code']} max={$r['max_players']} status={$r['status']} deadline={$r['mm_deadline']}\n";
} catch (Exception $e) { echo "  err ".$e->getMessage()."\n"; }
echo "=== all rooms ===\n";
try {
  $s = $pdo->query("SELECT room_code, max_players, status, is_match, created_at FROM rooms ORDER BY created_at DESC LIMIT 20");
  foreach ($s->fetchAll() as $r) echo "  {$r['room_code']} max={$r['max_players']} status={$r['status']} is_match={$r['is_match']} {$r['created_at']}\n";
} catch (Exception $e) { echo "  err ".$e->getMessage()."\n"; }
