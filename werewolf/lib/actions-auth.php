<?php
/* werewolf / lib/actions-auth.php — register / login / logout / me / leaderboard.
   Guests never call these; nothing here is required to play. */

function handleRegister(PDO $pdo) {
    $username = trim($_POST['username'] ?? '');
    $password = (string)($_POST['password'] ?? '');

    [$ok, $res] = authRegister($pdo, $username, $password);
    if (!$ok) {
        echo json_encode(["status" => "error", "message" => $res]);
        return;
    }
    // A guest who signs up mid-game keeps the seat they were already holding,
    // so the match they're in still counts for them.
    $linked = authLinkSeat($pdo, $res['id'], strtoupper(trim($_POST['room_code'] ?? '')), trim($_POST['player_token'] ?? ''));

    // Read the row back rather than using authUser(): the cookie was only just
    // set in this response, so $_COOKIE is not populated yet.
    $s = $pdo->prepare("SELECT * FROM users WHERE id = ?");
    $s->execute([$res['id']]);
    echo json_encode([
        "status"      => "success",
        "message"     => "Account created — your matches now count.",
        "user"        => authUserPublic($s->fetch()),
        "seat_linked" => $linked
    ]);
}

function handleLogin(PDO $pdo) {
    $username = trim($_POST['username'] ?? '');
    $password = (string)($_POST['password'] ?? '');

    [$ok, $res] = authLogin($pdo, $username, $password);
    if (!$ok) {
        echo json_encode(["status" => "error", "message" => $res]);
        return;
    }
    $linked = authLinkSeat($pdo, $res['id'], strtoupper(trim($_POST['room_code'] ?? '')), trim($_POST['player_token'] ?? ''));

    $s = $pdo->prepare("SELECT * FROM users WHERE id = ?");
    $s->execute([$res['id']]);
    echo json_encode([
        "status"      => "success",
        "message"     => "Signed in.",
        "user"        => authUserPublic($s->fetch()),
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
    $rows = $pdo->query("SELECT username, display_name, games, wins, rating
                           FROM users WHERE status = 1 AND games > 0
                          ORDER BY rating DESC, wins DESC LIMIT $limit")->fetchAll();
    $out = [];
    foreach ($rows as $r) {
        $games = (int)$r['games'];
        $wins  = (int)$r['wins'];
        $rating = (int)$r['rating'];
        $out[] = [
            'name'     => ($r['display_name'] !== null && $r['display_name'] !== '') ? $r['display_name'] : $r['username'],
            'games'    => $games,
            'wins'     => $wins,
            'rating'   => $rating,
            'tier'     => authTier($rating),
            'win_rate' => $games > 0 ? round($wins * 100 / $games, 1) : 0.0,
        ];
    }
    echo json_encode(["status" => "success", "leaders" => $out]);
}
