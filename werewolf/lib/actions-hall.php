<?php
/* werewolf / lib/actions-hall.php — the Hall.
   The home screen is a hall: before anyone joins a room they stand here, so the
   place is not an empty form. Deliberately tiny and ephemeral:

     * one row per visitor, carrying ONLY a nickname, an avatar id and a heartbeat
     * rows older than HALL_TTL are swept on the next beat, so the hall empties
       itself when people close the tab (no cron, no cleanup job)
     * carries nothing sensitive and exposes nothing about rooms in progress

   The beat is a menu-time call, never part of the in-game poll loop, so its writes
   stay off the latency-critical path. Both statements share ONE transaction so the
   beat costs a single fsync rather than two. */

function handleHallBeat(PDO $pdo) {
    $token = trim($_POST['token'] ?? '');
    if (!preg_match('/^[A-Za-z0-9_-]{8,64}$/', $token)) {
        $token = bin2hex(random_bytes(12));
    }

    $nick = trim($_POST['nickname'] ?? '');
    $nick = function_exists('mb_substr') ? mb_substr($nick, 0, 24) : substr($nick, 0, 24);
    $nick = trim(strip_tags($nick));
    if ($nick === '') $nick = 'Wanderer';

    // Only ids the avatar table knows may be worn; otherwise deal a fresh one.
    $av = authValidAvatar($_POST['avatar'] ?? '');
    if ($av === null) $av = AUTH_AVATARS[array_rand(AUTH_AVATARS)];

    $now = time();
    $pdo->beginTransaction();
    try {
        $pdo->prepare("INSERT INTO hall_presence (token, nickname, avatar, last_seen) VALUES (?, ?, ?, ?)
                       ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), avatar = VALUES(avatar), last_seen = VALUES(last_seen)")
            ->execute([$token, $nick, $av, $now]);
        // Sweep the departed. Indexed, and only ever touches stale rows.
        $pdo->prepare("DELETE FROM hall_presence WHERE last_seen < ?")->execute([$now - HALL_TTL]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }

    $st = $pdo->prepare("SELECT token, nickname, avatar FROM hall_presence
                         WHERE last_seen >= ? ORDER BY last_seen DESC LIMIT " . HALL_MAX);
    $st->execute([$now - HALL_TTL]);
    $rows = $st->fetchAll();

    $others = [];
    foreach ($rows as $r) {
        if ($r['token'] === $token) continue;          // I am not "in the hall" to myself
        $others[] = ['nickname' => $r['nickname'], 'avatar' => $r['avatar']];
    }

    echo json_encode([
        "status" => "success",
        "token"  => $token,
        "avatar" => $av,
        "hall"   => $others,
        "count"  => count($rows),
    ]);
}
