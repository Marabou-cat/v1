<?php
/* werewolf / lib/actions-voice.php - action handlers: voice
   Each was formerly a `case` body in backend.php's switch; each
   receives $pdo and echoes its own JSON response. */

function handleVoice(PDO $pdo) {
// Toggle voice-room presence and relay WebRTC signalling to peers.
        $roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');

        $stmt = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND session_token = ?");
        $stmt->execute([$roomCode, $token]);
        $me = $stmt->fetch();

        if (!$me) {
            echo json_encode(["status" => "error", "message" => "Invalid session."]);
            exit;
        }

        if (isset($_POST['on'])) {
            $on = (int)$_POST['on'] ? 1 : 0;
            $pdo->prepare("UPDATE players SET voice_on = ? WHERE id = ?")->execute([$on, (int)$me['id']]);
            if (!$on) {
                // Left the voice room: drop anything queued for/from us.
                $pdo->prepare("DELETE FROM voice_signals WHERE room_code = ? AND (from_id = ? OR to_id = ?)")
                    ->execute([$roomCode, (int)$me['id'], (int)$me['id']]);
            }
        }

        $kind = trim($_POST['kind'] ?? '');
        $toId = (int)($_POST['to_id'] ?? 0);
        if ($kind !== '' && $toId > 0) {
            $payload = (string)($_POST['payload'] ?? '');
            if (strlen($payload) > 20000) {
                echo json_encode(["status" => "error", "message" => "Signal too large."]);
                exit;
            }
            $pdo->prepare("INSERT INTO voice_signals (room_code, from_id, to_id, kind, payload) VALUES (?, ?, ?, ?, ?)")
                ->execute([$roomCode, (int)$me['id'], $toId, substr($kind, 0, 12), $payload]);
        }

        echo json_encode(["status" => "success"]);
}
