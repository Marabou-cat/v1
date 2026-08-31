// npc.js - Battle NPCs definition
const npc = [
    {
        id: "pelle",
        name: "Rival Pelle",
        route: 1,
        x: 14,
        y: 8,
        color: "#3498db",
        team: [
            { id: "sproupup", lvl: 5 }
        ],
        rewards: { coins: 1000 },
        defeated: false
    },
    {
        id: "challenger_mia",
        name: "Challenger Mia",
        route: 1,
        x: 22,
        y: 15,
        color: "#9b59b6",
        team: [
            { id: "samupillar", lvl: 5 },
            { id: "coalapling", lvl: 4 }
        ],
        rewards: { coins: 500 },
        defeated: false
    },
    {
        id: "expert_leo",
        name: "Route Expert Leo",
        route: 2,
        x: 14,
        y: 16,
        color: "#e67e22",
        team: [
            { id: "flaragon", lvl: 6 },
            { id: "sproupup", lvl: 6 }
        ],
        rewards: { coins: 300 },
        defeated: false
    }
];
