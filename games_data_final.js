// games_data.js  —— Game list for the site portal (only the three self-made games)
// format: path|display name|icon path (absolute paths start with / and openGame uses them directly)
const RAW_GAMES = [
    "/smash/|Super Brawl|/logos/smash-logo.png?v=1",
    "/exams_games/TheAviator/|The Aviator|/exams_games/icon_aviator.svg?v=2",
    "/exams_games/MineWorld/|MineWorld|/exams_games/icon_mineworld.svg?v=2",
    "/dungeon/|灰烬遗迹|/exams_games/icon_dungeon.svg?v=1",
    "/blockwild/|荒石遗境 Ruinwild|/exams_games/icon_blockwild.svg?v=1"
];

// Convert the compact strings into the final object array needed by your portal
const GAMES = RAW_GAMES.map(str => {
    const parts = str.split('|');
    return { 
        f: parts[0] ? parts[0].trim() : "", 
        name: parts[1] ? parts[1].trim() : "", 
        icon: parts.length > 2 ? parts[2].trim() : "" 
    };
});
