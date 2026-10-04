<?php
/* werewolf / lib/actions-auth.php — passwordless email-code sign in.
   Guests never call these; nothing here is required to play.

   Two endpoints:
     request_code  {email}              -> mails a 6-digit code
     verify_code   {email, code, ...}   -> creates the account if new, signs in
   Register and login are the same flow on purpose. */

function handleRequestCode(PDO $pdo) {
    $email = authNormEmail($_POST['email'] ?? '');
    if (!authValidEmail($email)) {
        echo json_encode(["status" => "error", "message" => "Enter a valid email address."]);
        return;
    }
    $wait = authSendAllowed($pdo, $email, authClientIp());
    if ($wait > 0) {
        echo json_encode(["status" => "error", "cooldown" => $wait,
                          "message" => "Please wait {$wait}s before requesting another code."]);
        return;
    }
    if ($wait < 0) {
        echo json_encode(["status" => "error",
                          "message" => "Too many codes requested for this address. Try again in an hour."]);
        return;
    }

    $err = '';
    if (!authIssueLoginCode($pdo, $email, $err)) {
        // Operational failure (SMTP). Tell them, rather than leaving them waiting.
        echo json_encode(["status" => "error",
                          "message" => "We could not send the email just now. Please try again in a minute."]);
        return;
    }
    echo json_encode([
        "status"   => "success",
        "message"  => "Code sent to $email.",
        "cooldown" => CODE_RESEND_COOLDOWN,
        "expires"  => CODE_TTL
    ]);
}

function handleVerifyCode(PDO $pdo) {
    $email = authNormEmail($_POST['email'] ?? '');
    $code  = preg_replace('/\D/', '', (string)($_POST['code'] ?? ''));
    if (!authValidEmail($email) || strlen($code) !== 6) {
        echo json_encode(["status" => "error", "message" => "Enter the 6-digit code from the email."]);
        return;
    }

    $err = '';
    $res = authVerifyLoginCode($pdo, $email, $code, $err);
    if (!$res) {
        echo json_encode(["status" => "error", "message" => $err]);
        return;
    }

    $u = authUserPublic($res['user']);
    // Signing in mid-match hands the seat over and adopts the account name.
    $linked = authLinkSeat($pdo, $u['id'],
        strtoupper(trim($_POST['room_code'] ?? '')),
        trim($_POST['player_token'] ?? ''),
        $u['name']);

    echo json_encode([
        "status"      => "success",
        "message"     => $res['is_new'] ? "Account created — your matches now count." : "Signed in.",
        "user"        => $u,
        "is_new"      => $res['is_new'],
        "seat_linked" => $linked
    ]);
}

function handleLogout(PDO $pdo) {
    authLogout($pdo);
    echo json_encode(["status" => "success", "message" => "Signed out.", "user" => null]);
}

function handleMe(PDO $pdo) {
    echo json_encode(["status" => "success", "user" => authUserPublic(authUser($pdo))]);
}

// Top accounts by rank — one indexed read, cheap enough to poll.
function handleLeaderboard(PDO $pdo) {
    $limit = min(50, max(3, (int)($_POST['limit'] ?? 10)));
    $rows = $pdo->query("SELECT email, display_name, games, wins, rating
                           FROM users WHERE status = 1 AND games > 0
                          ORDER BY rating DESC, wins DESC LIMIT $limit")->fetchAll();
    $out = [];
    foreach ($rows as $r) {
        $games  = (int)$r['games'];
        $wins   = (int)$r['wins'];
        $rating = (int)$r['rating'];
        $name = $r['display_name'];
        if ($name === null || $name === '') {
            $local = strstr((string)$r['email'], '@', true);
            $name = $local === false ? 'Player' : $local;
        }
        $out[] = [
            'name'     => $name,
            'games'    => $games,
            'wins'     => $wins,
            'rating'   => $rating,
            'tier'     => authTier($rating),
            'win_rate' => $games > 0 ? round($wins * 100 / $games, 1) : 0.0,
        ];
    }
    echo json_encode(["status" => "success", "leaders" => $out]);
}
