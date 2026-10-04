<?php
/* werewolf / lib/presence.php - touchPresence, reapStaleRooms, maybeReap
   Included by backend.php into its scope (shares $pdo and constants).
   Split out of the old monolithic backend.php. */

function touchPresence(PDO $pdo, $roomCode, $token = '') {
    if ($roomCode === '') return;
    $now = time();
    try {
        $pdo->prepare("UPDATE rooms SET last_activity = ? WHERE room_code = ?")->execute([$now, $roomCode]);
        if ($token !== '') {
            $pdo->prepare("UPDATE players SET last_seen = ? WHERE room_code = ? AND session_token = ?")->execute([$now, $roomCode, $token]);
        }
    } catch (Exception $e) {}
}

// Sweep away dead weight. Without this the rooms table grows forever AND
// matchmaking keeps pairing new players with long-abandoned "ghost" lobbies
// (they look populated, but every seat belongs to someone who closed the tab),
// which is what made "Find Match" look broken and kept offering non-existent
// rooms. Cheap enough to run on a short throttle from the poll path.
function reapStaleRooms(PDO $pdo) {
    $now = time();
    try {
        // 1) Ghost humans sitting in a lobby (stopped polling).
        $pdo->prepare("DELETE p FROM players p JOIN rooms r ON r.room_code = p.room_code
                        WHERE p.is_bot = 0 AND r.status = 'lobby' AND p.last_seen < ?")
            ->execute([$now - PLAYER_TIMEOUT]);

        // 2) End lobbies that no longer hold a single human.
        $pdo->prepare("UPDATE rooms SET status = 'ended', last_event = 'This lobby was abandoned.', last_activity = ?
                        WHERE status = 'lobby'
                          AND room_code NOT IN (SELECT room_code FROM (SELECT DISTINCT room_code FROM players WHERE is_bot = 0) h)")
            ->execute([$now]);

        // 3) Force-end live games every human has walked away from.
        $pdo->prepare("UPDATE rooms SET status = 'ended', last_event = 'This game was abandoned by its players.', last_activity = ?
                        WHERE status IN ('night','day') AND last_activity < ?")
            ->execute([$now, $now - GAME_TIMEOUT]);

        // 4) Delete long-finished rooms + any orphaned player rows.
        $pdo->prepare("DELETE FROM rooms WHERE status = 'ended' AND last_activity < ?")->execute([$now - ENDED_TTL]);
        $pdo->prepare("DELETE FROM players WHERE room_code NOT IN (SELECT room_code FROM rooms)")->execute();
    } catch (Exception $e) {}
}

// Run the reaper at most once every 20s (the poll path fires every ~1.5s).
function maybeReap(PDO $pdo) {
    $marker = sys_get_temp_dir() . '/wolf_last_reap';
    $last = @filemtime($marker) ?: 0;
    if (time() - $last < 20) return;
    @touch($marker);
    reapStaleRooms($pdo);
}

// Deal cards and flip a full room into the night phase (shared by manual
// start and the matchmaker auto-start).
//
// The claim AND the whole deal run in ONE transaction. The claim's UPDATE
// takes a row lock on the rooms row, so a concurrent poll that loses the
// claim BLOCKS until the winner's deal has committed — which guarantees the
// loser can never read a pre-deal "all unassigned" snapshot and falsely
// declare a winner (the old 0-werewolf race).
