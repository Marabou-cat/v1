<?php
header('Content-Type: text/plain');
$lines = file(__DIR__ . '/../config.ini', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$u = trim($lines[0] ?? ''); $p = trim($lines[1] ?? '');
$pdo = new PDO("mysql:host=127.0.0.1;dbname=werewolf_db;charset=utf8mb4", $u, $p, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
echo "SERVER=" . trim($pdo->query("SELECT VERSION()")->fetchColumn()) . "\n";
echo "ENGINE=" . trim($pdo->query("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA='werewolf_db' AND TABLE_NAME='rooms'")->fetchColumn()) . "\n";

$tests = [
 "players.is_bot"   => "ALTER TABLE players ADD COLUMN IF NOT EXISTS is_bot TINYINT DEFAULT 0",
 "rooms.is_match"   => "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_match TINYINT DEFAULT 0",
 "rooms.mm_deadline"=> "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS mm_deadline INT DEFAULT NULL",
];
foreach ($tests as $label => $sql) {
  try { $pdo->exec($sql); echo "DDL_OK   $label\n"; }
  catch (Exception $e) { echo "DDL_FAIL $label :: " . $e->getMessage() . "\n"; }
}
$rcols = $pdo->query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='werewolf_db' AND TABLE_NAME='rooms'")->fetchAll(PDO::FETCH_COLUMN);
echo "ROOMS_COLS=" . implode(',', $rcols) . "\n";
$pcols = $pdo->query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='werewolf_db' AND TABLE_NAME='players'")->fetchAll(PDO::FETCH_COLUMN);
echo "PLAYERS_COLS=" . implode(',', $pcols) . "\n";
// now the exact failing query
try {
  $s = $pdo->prepare("SELECT * FROM rooms WHERE is_match = 1 AND status = 'lobby' AND max_players = ? ORDER BY id ASC");
  $s->execute([6]);
  echo "SELECT_OK rows=" . count($s->fetchAll()) . "\n";
} catch (Exception $e) { echo "SELECT_FAIL :: " . $e->getMessage() . "\n"; }
