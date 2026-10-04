<?php
/* werewolf / backend.php - thin dispatcher.
   Implementation lives in lib/; this file only wires it together and routes
   the request.  See lib/bootstrap.php for config + schema. */
require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/roles.php';
require_once __DIR__ . '/lib/bots.php';
require_once __DIR__ . '/lib/presence.php';
require_once __DIR__ . '/lib/game.php';
require_once __DIR__ . '/lib/actions-room.php';
require_once __DIR__ . '/lib/actions-play.php';
require_once __DIR__ . '/lib/actions-voice.php';

$action = $_POST['action'] ?? $_GET['action'] ?? '';

try {
switch ($action) {

    case 'create_room': handleCreateRoom($pdo); break;
    case 'matchmake': handleMatchmake($pdo); break;
    case 'join_room': handleJoinRoom($pdo); break;
    case 'leave_room': handleLeaveRoom($pdo); break;
    case 'start_game': handleStartGame($pdo); break;
    case 'send_message': handleSendMessage($pdo); break;
    case 'poll_game': handlePollGame($pdo); break;
    case 'poll_lobby': handlePollGame($pdo); break;
    case 'night_action': handleNightAction($pdo); break;
    case 'doctor_action': handleDoctorAction($pdo); break;
    case 'voice': handleVoice($pdo); break;
    case 'day_vote': handleDayVote($pdo); break;

    default:
        echo json_encode(["status" => "error", "message" => "Invalid API action."]);
                break;

}
} catch (Throwable $e) {
    // Surface the real error instead of a silent 500 (helps production
    // debugging; clients still get a JSON error they can display).
    http_response_code(500);
    echo json_encode([
        "status" => "error",
        "message" => "Server error: " . $e->getMessage(),
        "cutscene" => "scene_error"
    ]);
}
