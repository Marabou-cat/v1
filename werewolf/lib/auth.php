<?php
/* werewolf / lib/auth.php — accounts, sessions, rank.

   Accounts are optional: guests keep playing exactly as before, they just never
   accumulate a win rate or a rank. Sign-in is PASSWORDLESS — there is no
   password column in use anywhere; the credential is a 6-digit code emailed to
   the address (lib/auth-mail.php).

   Design notes specific to this box:
   - Sessions are DB-backed opaque tokens, NOT PHP native sessions. The poll
     long-polls (>1s) and file sessions lock, so native sessions would serialise
     a player's own requests.
   - Every DB write here costs ~270ms (InnoDB redo fsync on this NAS), so each
     user-facing operation is wrapped in ONE transaction = ONE commit. */

const AUTH_COOKIE = 'wolf_auth';

function authCookieName() { return AUTH_COOKIE; }

function authHashToken($token) { return hash('sha256', $token); }

function authClientIp() {
    return substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45);
}

function authSessionToken() {
    return (string)($_COOKIE[AUTH_COOKIE] ?? '');
}

// Cookie flags: HttpOnly (JS can't read it), Secure whenever we're on HTTPS,
// SameSite=Lax so cross-site POSTs can't ride the session.
function authSetCookie($token) {
    $secure = (!empty($_SERVER['HTTPS']) && strtolower($_SERVER['HTTPS']) !== 'off')
           || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    if (PHP_VERSION_ID >= 70300) {
        setcookie(AUTH_COOKIE, $token, [
            'expires'  => time() + AUTH_SESSION_TTL,
            'path'     => '/',
            'secure'   => $secure,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    } else {
        setcookie(AUTH_COOKIE, $token, time() + AUTH_SESSION_TTL, '/', '', $secure, true);
    }
}

function authClearCookie() {
    $secure = (!empty($_SERVER['HTTPS']) && strtolower($_SERVER['HTTPS']) !== 'off');
    setcookie(AUTH_COOKIE, '', time() - 3600, '/', '', $secure, true);
}

// Resolve the signed-in user for this request (null for guests). Memoised so the
// poll and the action handlers never hit the DB twice.
function authUser(PDO $pdo) {
    static $cached = false;
    static $user = null;
    if ($cached) return $user;
    $cached = true;

    $tok = authSessionToken();
    if ($tok === '') return $user = null;
    try {
        $s = $pdo->prepare("SELECT u.*, s.id AS session_id, s.expires_at
                              FROM auth_sessions s JOIN users u ON u.id = s.user_id
                             WHERE s.token_hash = ? AND s.revoked_at = 0 AND s.expires_at > ?
                             LIMIT 1");
        $s->execute([authHashToken($tok), time()]);
        $row = $s->fetch();
        $user = ($row && (int)$row['status'] === 1) ? $row : null;
    } catch (Exception $e) {
        $user = null;
    }
    return $user;
}

function authTier($rating) {
    if ($rating >= 1750) return 'Master';
    if ($rating >= 1600) return 'Diamond';
    if ($rating >= 1450) return 'Platinum';
    if ($rating >= 1300) return 'Gold';
    if ($rating >= 1150) return 'Silver';
    return 'Bronze';
}

// Level curve: level n starts at 50*n*(n-1) cumulative XP, so the gap grows by
// 100 XP per level — L2 @100, L3 @300, L4 @600, L5 @1000, L6 @1500 …
function authXpForLevel($level) {
    $l = max(1, (int)$level);
    return 50 * $l * ($l - 1);
}

// XP is the only thing stored; the level is ALWAYS derived, so they can't drift.
function authLevelForXp($xp) {
    $xp = max(0, (int)$xp);
    $level = (int)floor((1 + sqrt(1 + 0.08 * $xp)) / 2);   // inverse of the curve
    return max(1, $level);
}

function authLevelProgress($xp) {
    $xp = max(0, (int)$xp);
    $level = authLevelForXp($xp);
    $cur = authXpForLevel($level);
    $next = authXpForLevel($level + 1);
    $span = max(1, $next - $cur);
    $into = $xp - $cur;
    return [
        'xp'          => $xp,
        'level'       => $level,
        'xp_into'     => $into,
        'xp_need'     => $next - $cur,
        'xp_progress' => round($into / $span, 4),
    ];
}

// --- Avatars ---------------------------------------------------------------
function authValidAvatar($id) {
    $id = strtolower(trim((string)$id));
    return in_array($id, AUTH_AVATARS, true) ? $id : null;
}

// Every account always has *an* avatar, even before the player picks one.
function authDefaultAvatar($userId) {
    $n = count(AUTH_AVATARS);
    return AUTH_AVATARS[abs((int)$userId) % $n];
}

function authAvatarFor($u) {
    $a = authValidAvatar($u['avatar'] ?? '');
    return $a !== null ? $a : authDefaultAvatar((int)$u['id']);
}

function authAvatarOfUser(PDO $pdo, $userId) {
    try {
        $q = $pdo->prepare("SELECT avatar FROM users WHERE id = ?");
        $q->execute([(int)$userId]);
        $v = authValidAvatar((string)$q->fetchColumn());
    } catch (Exception $e) {
        $v = null;
    }
    return $v !== null ? $v : authDefaultAvatar((int)$userId);
}

// What a NEW seat wears: the account's pick, or a throwaway random one for a
// guest (guests persist nothing, so it is per-seat).
function seatAvatar(PDO $pdo) {
    $u = authUser($pdo);
    return $u ? authAvatarFor($u) : AUTH_AVATARS[array_rand(AUTH_AVATARS)];
}

// The shape the client sees. Never leaks anything secret.
function authUserPublic($u) {
    if (!$u) return null;
    $games  = (int)$u['games'];
    $wins   = (int)$u['wins'];
    $rating = (int)$u['rating'];

    // In-game handle: the account nickname wins, then the account display name,
    // then the email local part.
    $nick = trim((string)($u['nickname'] ?? ''));
    $name = $nick;
    if ($name === '') $name = trim((string)($u['display_name'] ?? ''));
    if ($name === '') {
        $local = strstr((string)($u['email'] ?? ''), '@', true);
        $name = $local === false ? 'Player' : $local;
    }

    return [
        'id'       => (int)$u['id'],
        'name'     => $name,
        'nickname' => $nick !== '' ? $nick : null,
        'avatar'   => authAvatarFor($u),
        'email'    => $u['email'] ?? null,
        'games'    => $games,
        'wins'     => $wins,
        'losses'   => max(0, $games - $wins),
        'rating'   => $rating,
        'peak'     => (int)$u['peak_rating'],
        'tier'     => authTier($rating),
        'win_rate' => $games > 0 ? round($wins * 100 / $games, 1) : 0.0,
    ] + authLevelProgress((int)($u['xp'] ?? 0));
}

function authIssueSession(PDO $pdo, $userId) {
    $token = bin2hex(random_bytes(32));
    $now = time();
    $pdo->prepare("INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)")
        ->execute([$userId, authHashToken($token), $now, $now + AUTH_SESSION_TTL, authClientIp()]);
    // Housekeeping in the same commit: drop this user's expired/revoked rows.
    $pdo->prepare("DELETE FROM auth_sessions WHERE user_id = ? AND (expires_at < ? OR revoked_at > 0)")
        ->execute([$userId, $now]);
    return $token;
}

function authLogout(PDO $pdo) {
    $tok = authSessionToken();
    if ($tok !== '') {
        try {
            $pdo->prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?")
                ->execute([time(), authHashToken($tok)]);
        } catch (Exception $e) {}
    }
    authClearCookie();
}

// A guest who signs in mid-game keeps their seat: attach the account to the
// player row they're already holding, and adopt the account name so the roster
// shows who they really are.
function authLinkSeat(PDO $pdo, $userId, $roomCode, $playerToken, $name = '') {
    if (!$userId || $roomCode === '' || $playerToken === '') return false;
    try {
        $s = $pdo->prepare("UPDATE players SET user_id = ?, nickname = IF(? = '', nickname, ?), avatar = ?
                             WHERE room_code = ? AND session_token = ? AND is_bot = 0 AND user_id IS NULL");
        $s->execute([$userId, $name, $name, authAvatarOfUser($pdo, $userId), $roomCode, $playerToken]);
        return $s->rowCount() > 0;
    } catch (Exception $e) {
        return false;
    }
}

// Award a finished match. Everything (ratings + per-seat deltas) happens in ONE
// transaction, which means ONE fsync (~270ms) instead of one per player.
function authAwardGame(PDO $pdo, $roomCode, $winner) {
    try {
        $s = $pdo->prepare("SELECT p.id AS player_id, p.user_id, p.role, p.is_alive, u.rating
                              FROM players p JOIN users u ON u.id = p.user_id
                             WHERE p.room_code = ? AND p.user_id IS NOT NULL AND p.is_bot = 0");
        $s->execute([$roomCode]);
        $rows = $s->fetchAll();
        if (!$rows) return 0;

        $isWin = function ($role) use ($winner) {
            $wolf = ($role === 'Werewolf');
            return ($winner === 'werewolves') ? $wolf : !$wolf;
        };

        $sumWin = 0; $sumLose = 0; $nWin = 0; $nLose = 0;
        foreach ($rows as $r) {
            if ($isWin($r['role'])) { $sumWin += (int)$r['rating']; $nWin++; }
            else { $sumLose += (int)$r['rating']; $nLose++; }
        }
        $avgWin  = $nWin  ? $sumWin / $nWin   : AUTH_RATING_START;
        $avgLose = $nLose ? $sumLose / $nLose : AUTH_RATING_START;

        $pdo->beginTransaction();
        foreach ($rows as $r) {
            $won = $isWin($r['role']);
            $my  = (int)$r['rating'];
            $opp = $won ? $avgLose : $avgWin;
            $expected = 1 / (1 + pow(10, ($opp - $my) / 400));
            $delta = (int)round(AUTH_K * (($won ? 1 : 0) - $expected));
            $new = max(100, $my + $delta);

            // XP: everyone who finishes earns; winning and surviving pay extra.
            // Guests have no account row here, so they simply earn nothing.
            $xpGain = AUTH_XP_PLAY + ($won ? AUTH_XP_WIN : 0)
                    + ((int)$r['is_alive'] === 1 ? AUTH_XP_SURVIVE : 0);

            $pdo->prepare("UPDATE users SET games = games + 1, wins = wins + ?, rating = ?,
                                  peak_rating = GREATEST(peak_rating, ?), xp = xp + ? WHERE id = ?")
                ->execute([$won ? 1 : 0, $new, $new, $xpGain, (int)$r['user_id']]);
            $pdo->prepare("UPDATE players SET rating_delta = ?, user_won = ?, xp_delta = ? WHERE id = ?")
                ->execute([$delta, $won ? 1 : 0, $xpGain, (int)$r['player_id']]);
        }
        $pdo->commit();
        return count($rows);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        return 0;
    }
}
