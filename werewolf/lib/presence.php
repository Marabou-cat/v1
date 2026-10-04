<?php
/* werewolf / lib/presence.php - touchPresence, reapStaleRooms, maybeReap
   Included by backend.php into its scope (shares $pdo and constants).
   Split out of the old monolithic backend.php. */

function touchPresence(PDO $pdo, $roomCode, $token = '') {
    if ($roomCode === '') return;
    $now = time();
    try {
        // Only write when the stored heartbeat is actually stale (>3s old).  The
        // guard turns the common case into a read-only no-op instead of a row
        // write on every poll, so a busy room stops churning the redo log — and
        // the columns stay accurate to within 3s, far tighter than the reaper's
        // 150s timeout needs.
        $pdo->prepare("UPDATE rooms SET last_activity = ? WHERE room_code = ? AND last_activity < ?")
            ->execute([$now, $roomCode, $now - 3]);
        if ($token !== '') {
            $pdo->prepare("UPDATE players SET last_seen = ? WHERE room_code = ? AND session_token = ? AND last_seen < ?")
                ->execute([$now, $roomCode, $token, $now - 3]);
        }
    } catch (Exception $e) {}
}

// Cheap "did anything the players can SEE change?" fingerprint, used by the
// poll's long-poll wait.  Deliberately EXCLUDES the heartbeat columns
// (last_seen / last_activity): they change on every presence touch, so
// including them would make the signature flap forever and turn the wait loop
// into a busy loop that never parks.
function wolfStateSig(PDO $pdo, $roomCode) {
    $s = $pdo->prepare("SELECT r.status, r.night_step, r.started_at, r.phase_started_at,
              r.last_event, r.pending_victim, r.mm_deadline,
              (SELECT COUNT(*) FROM players WHERE room_code = r.room_code),
              (SELECT COUNT(*) FROM players WHERE room_code = r.room_code AND is_alive = 1),
              (SELECT COUNT(*) FROM players WHERE room_code = r.room_code AND asleep = 1),
              (SELECT COUNT(*) FROM players WHERE room_code = r.room_code AND target_id IS NOT NULL),
              (SELECT COUNT(*) FROM players WHERE room_code = r.room_code AND vote_id IS NOT NULL),
              (SELECT COUNT(*) FROM players WHERE room_code = r.room_code AND check_target IS NOT NULL),
              (SELECT COUNT(*) FROM players WHERE room_code = r.room_code AND poison_target IS NOT NULL),
              (SELECT COUNT(*) FROM players WHERE room_code = r.room_code AND doctor_choice IS NOT NULL),
              (SELECT COUNT(*) FROM players WHERE room_code = r.room_code AND voice_on = 1),
              (SELECT COALESCE(MAX(id), 0) FROM messages WHERE room_code = r.room_code)
            FROM rooms r WHERE r.room_code = ? LIMIT 1");
    $s->execute([$roomCode]);
    $row = $s->fetch(PDO::FETCH_NUM);
    return $row ? md5(implode('|', $row)) : '';
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
