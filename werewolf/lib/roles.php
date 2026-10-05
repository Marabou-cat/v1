<?php
/* werewolf / lib/roles.php - calculateRoles
   Included by backend.php into its scope (shares $pdo and constants).
   Split out of the old monolithic backend.php. */

function calculateRoles($playerCount, $mode = 'classic') {
    if ($playerCount < 4) return null;
    $werewolves = 1 + (int)floor(($playerCount - 4) / 3);
    // Chaos Night: nights only WOUND (34 a bite), so a single wolf can no longer
    // remove a player a night. One extra wolf keeps the pressure comparable to
    // Classic's guaranteed kill — three focused wolves can still drop someone in
    // one night. Skipped at 4 players, where an extra wolf would be brutal.
    if ($mode === 'chaos' && $playerCount >= 5) $werewolves++;
    $specials = ($playerCount === 4) ? 0 : (int)floor(($playerCount - 3) / 2);
    $villagers = $playerCount - ($werewolves + $specials);

    $specialPool = ['Seer', 'Doctor', 'Witch', 'Hunter', 'Cupid'];
    $assignedSpecials = array_slice($specialPool, 0, $specials);

    return [
        "werewolves" => $werewolves,
        "specials" => $specials,
        "special_cards" => $assignedSpecials,
        "villagers" => $villagers
    ];
}

/* ================= MATCHMAKING + BOTS ================= */
const MATCH_WAIT_SECONDS = 2;

// Top-level (global) pool of bot nicknames. Helper functions below must pull
// it in with `global $BOT_NAMES;` — PHP functions do NOT see top-level vars
// automatically (referencing it without `global` yields null).
// Names are deliberately realistic / human-sounding (casual gamer handles),
// so AI fillers are indistinguishable from real players.
$BOT_NAMES = [
    'Mia Chen', 'Leo Park', 'Sofia', 'Jack', 'Emma', 'Lucas', 'Ava', 'Noah',
    'Mason', 'Isabella', 'Ethan', 'Olivia', 'Liam', 'Sophia', 'Mateo', 'Aria',
    'Kai', 'Nina', 'Diego', 'Chloe', 'Ryan', 'Ella', 'Max', 'Lena',
    'Theo', 'Ivy', 'Owen', 'Ruby', 'Felix', 'Hana', 'Marco', 'Priya',
    'Dylan', 'Grace', 'Oscar', 'Lily', 'Victor', 'Maya', 'Andre', 'Tara',
    'Sam', 'Nora', 'Cole', 'Iris', 'Ezra', 'Dana', 'Rex', 'Bella',
    'Nico', 'Faye', 'Gus', 'Ivy Rose', 'Jude', 'Kira', 'Luca', 'Mila'
];

// Add a single AI player to a lobby room. Returns the bot row or null.
