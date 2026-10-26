// games_data.js  —— Game list for the site portal (only the three self-made games)
// format: path|display name|icon path (absolute paths start with / and openGame uses them directly)
const RAW_GAMES = [
    "/smash/|Super Brawl|/exams_games/icon_smash.svg?v=2",
    "/exams_games/TheAviator/|The Aviator|/exams_games/icon_aviator.svg?v=2",
    "/exams_games/MineWorld/|MineWorld|/exams_games/icon_mineworld.svg?v=2"
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
