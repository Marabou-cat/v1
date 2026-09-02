const TYPE_CHART = {
    fire:     { fire: 0.67, water: 0.67, grass: 1.5,  electric: 1.0, combat: 1.0, basic: 1.0, bug: 1.5, dragon: 0.67, air: 1.0, metal: 1.5, stone: 0.67 },
    water:    { fire: 1.5,  water: 0.67, grass: 0.67, electric: 1.0, combat: 1.0, basic: 1.0, bug: 1.0, dragon: 0.67, air: 1.0, metal: 1.0, stone: 1.5 },
    grass:    { fire: 0.67, water: 1.5,  grass: 0.67, electric: 1.0, combat: 1.0, basic: 1.0, bug: 0.67, dragon: 0.67, air: 0.67, metal: 0.67, stone: 1.5 },
    electric: { fire: 1.0,  water: 1.5,  grass: 0.67, electric: 0.67, combat: 1.0, basic: 1.0, bug: 1.0, dragon: 0.67, air: 1.5, metal: 1.0, stone: 1.0 },
    combat:   { fire: 1.0,  water: 1.0,  grass: 1.0,  electric: 1.0, combat: 0.67, basic: 1.5, bug: 1.5, dragon: 0.67, air: 0.67, metal: 1.5, stone: 1.5 },
    basic:    { fire: 1.0,  water: 1.0,  grass: 1.0,  electric: 1.0, combat: 1.0, basic: 1.0, bug: 1.0, dragon: 1.0, air: 1.0, metal: 0.67, stone: 1.0 },
    bug:      { fire: 0.67, water: 1.0,  grass: 1.5,  electric: 1.0, combat: 1.0, basic: 1.0, bug: 1.0, dragon: 1.0, air: 0.67, metal: 0.67, stone: 0.67 },
    dragon:   { fire: 1.0,  water: 1.0,  grass: 1.0,  electric: 1.0, combat: 1.0, basic: 1.0, bug: 1.0, dragon: 1.5, air: 1.0, metal: 0.67, stone: 1.0 },
    air:      { fire: 1.0,  water: 1.0,  grass: 1.5,  electric: 0.67, combat: 1.5, basic: 1.0, bug: 1.5, dragon: 1.0, air: 1.0, metal: 0.67, stone: 0.67 },
    metal:    { fire: 0.67, water: 1.0,  grass: 1.0,  electric: 1.0, combat: 0.67, basic: 1.0, bug: 1.5, dragon: 1.0, air: 1.0, metal: 0.67, stone: 0.67 },
    stone:    { fire: 1.5,  water: 0.67, grass: 0.67, electric: 1.0, combat: 0.67, basic: 1.0, bug: 1.5, dragon: 1.0, air: 1.5, metal: 0.67, stone: 1.0 }
};

const TYPE_COLORS = {
    fire:     "#ff6b35",
    water:    "#00b4d8",
    grass:    "#2ecc71",
    electric: "#f1c40f",
    combat:   "#d35400",
    basic:    "#ffffff",
    bug:      "#27ae60",
    dragon:   "#9b59b6",
    air:      "#d5ffff",
    metal:    "#c0c0c0",
    stone:    "#95a5a6"
};

let isActionLocked = false; // Prevents spamming and input abuse during animations

function getTypeEffectiveness(moveType, defenderTypes) {
    let multiplier = 1.0;
    if (!TYPE_CHART[moveType]) return multiplier;

    defenderTypes.forEach(defType => {
        if (TYPE_CHART[moveType][defType] !== undefined) {
            multiplier *= TYPE_CHART[moveType][defType];
        }
    });
    return multiplier;
}

const PETS = {
    flaragon: {
        id: "flaragon",
        name: "Flaragon",
        type: ["fire"],
        spawn_routes: [],
        img: "petpng/flaragon.png",
        catchRate: 45,
        evolvingLevel: 16,
        evolutionId: "pyrodon",
        size: 1.0,
        baseStats: { hp: 100, attack: 10, defense: 10, spAttack: 16, spDefense: 12, speed: 15 },
        maxStats:  { hp: 500, attack: 110, defense: 120, spAttack: 190, spDefense: 140, speed: 175 },
        moves: [
            { name: "Scratch", type: "basic", damage: 10, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Ember", type: "fire", damage: 25, powerCost: 5, damageType: "special", levelToLearn: 1 },
            { name: "Flame Dash", type: "fire", damage: 45, powerCost: 10, damageType: "physical", levelToLearn: 5 },
            { name: "Inferno Blast", type: "fire", damage: 70, powerCost: 20, damageType: "special", levelToLearn: 10 }
        ]
    },
    pyrodon: {
        id: "pyrodon",
        name: "Pyrodon",
        type: ["fire"],
        spawn_routes: [],
        img: "petpng/pyrodon.png",
        catchRate: 25,
        evolvingLevel: 20,
        evolutionId: "",
        size: 1.5,
        baseStats: { hp: 160, attack: 15, defense: 16, spAttack: 24, spDefense: 18, speed: 22 },
        maxStats:  { hp: 750, attack: 150, defense: 160, spAttack: 240, spDefense: 180, speed: 220 },
        moves: [
            { name: "Scratch", type: "basic", damage: 10, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Ember", type: "fire", damage: 25, powerCost: 5, damageType: "special", levelToLearn: 1 },
            { name: "Flame Dash", type: "fire", damage: 45, powerCost: 10, damageType: "physical", levelToLearn: 5 },
            { name: "Inferno Blast", type: "fire", damage: 70, powerCost: 20, damageType: "special", levelToLearn: 10 },
            { name: "Burn Out", type: "fire", damage: 200, powerCost: 100, damageType: "special", levelToLearn: 1 }
        ]
    },
    malime: {
        id: "malime",
        name: "Malime",
        type: ["fire"],
        spawn_routes: [4],
        img: "petpng/malime.png",
        catchRate: 45,
        evolvingLevel: 16,
        evolutionId: "magmud",
        size: 1.0,
        baseStats: { hp: 105, attack: 12, defense: 14, spAttack: 15, spDefense: 13, speed: 14 },
        maxStats:  { hp: 520, attack: 120, defense: 140, spAttack: 180, spDefense: 150, speed: 160 },
        moves: [
            { name: "Scratch", type: "basic", damage: 10, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Ember", type: "fire", damage: 25, powerCost: 5, damageType: "special", levelToLearn: 1 },
            { name: "Rock Throw", type: "stone", damage: 40, powerCost: 10, damageType: "physical", levelToLearn: 5 },
            { name: "Flame Dash", type: "fire", damage: 45, powerCost: 10, damageType: "physical", levelToLearn: 10 }
        ]
    },
    magmud: {
        id: "magmud",
        name: "Magmud",
        type: ["fire", "stone"],
        spawn_routes: [],
        img: "petpng/magmud.png",
        catchRate: 25,
        evolvingLevel: 0,
        evolutionId: "",
        size: 1.6,
        baseStats: { hp: 165, attack: 18, defense: 22, spAttack: 22, spDefense: 20, speed: 18 },
        maxStats:  { hp: 780, attack: 160, defense: 200, spAttack: 220, spDefense: 190, speed: 190 },
        moves: [
            { name: "Scratch", type: "basic", damage: 10, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Ember", type: "fire", damage: 25, powerCost: 5, damageType: "special", levelToLearn: 1 },
            { name: "Rock Throw", type: "stone", damage: 40, powerCost: 10, damageType: "physical", levelToLearn: 5 },
            { name: "Flame Dash", type: "fire", damage: 45, powerCost: 10, damageType: "physical", levelToLearn: 10 },
            { name: "Stone Edge", type: "stone", damage: 90, powerCost: 50, damageType: "physical", levelToLearn: 16 }
        ]
    },
    bubbitty: {
        id: "bubbitty",
        name: "Bubbitty",
        type: ["water"],
        spawn_routes: [],
        img: "petpng/bubbitty.png",
        catchRate: 45,
        evolvingLevel: 16,
        evolutionId: "tideleel",
        size: 0.8,
        baseStats: { hp: 110, attack: 10, defense: 14, spAttack: 12, spDefense: 16, speed: 10 },
        maxStats:  { hp: 540, attack: 130, defense: 170, spAttack: 150, spDefense: 195, speed: 240 },
        moves: [
            { name: "Tackle", type: "basic", damage: 15, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Water Gun", type: "water", damage: 25, powerCost: 5, damageType: "special", levelToLearn: 1 },
            { name: "Bubble Beam", type: "water", damage: 45, powerCost: 12, damageType: "special", levelToLearn: 5 },
            { name: "Hydro Pump", type: "water", damage: 75, powerCost: 22, damageType: "special", levelToLearn: 16 }
        ]
    },
    charmpaw: {
        id: "charmpaw",
        name: "Charmpaw",
        type: ["water"],
        spawn_routes: [],
        img: "petpng/bubbitty.png",
        catchRate: 25,
        evolvingLevel: 0,
        evolutionId: "",
        size: 1.3,
        baseStats: { hp: 170, attack: 14, defense: 20, spAttack: 18, spDefense: 22, speed: 15 },
        maxStats:  { hp: 780, attack: 160, defense: 210, spAttack: 190, spDefense: 240, speed: 280 },
        moves: [
            { name: "Tackle", type: "basic", damage: 15, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Water Gun", type: "water", damage: 25, powerCost: 5, damageType: "special", levelToLearn: 1 },
            { name: "Bubble Beam", type: "water", damage: 45, powerCost: 12, damageType: "special", levelToLearn: 5 },
            { name: "Hydro Pump", type: "water", damage: 75, powerCost: 22, damageType: "special", levelToLearn: 10 },
            { name: "Charm", type: "basic", damage: 90, powerCost: 55, damageType: "special", levelToLearn: 16 }
        ]
    },
    sproupup: {
        id: "sproupup",
        name: "Sproupup",
        type: ["grass"],
        spawn_routes: [],
        img: "petpng/sproupu.png",
        catchRate: 45,
        evolvingLevel: 5,
        evolutionId: "floraplnt",
        size: 0.9,
        baseStats: { hp: 120, attack: 16, defense: 13, spAttack: 8, spDefense: 10, speed: 12 },
        maxStats:  { hp: 600, attack: 185, defense: 155, spAttack: 100, spDefense: 130, speed: 145 },
        moves: [
            { name: "Tackle", type: "basic", damage: 15, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Vine Whip", type: "grass", damage: 25, powerCost: 5, damageType: "physical", levelToLearn: 1 },
            { name: "Razor Leaf", type: "grass", damage: 50, powerCost: 14, damageType: "physical", levelToLearn: 5 },
            { name: "Solar Beam", type: "grass", damage: 75, powerCost: 25, damageType: "special", levelToLearn: 10 }
        ]
    },
    floraplnt: {
        id: "floraplnt",
        name: "Floraplnt",
        type: ["grass"],
        spawn_routes: [],
        img: "petpng/sproupu.png",
        catchRate: 25,
        evolvingLevel: 0,
        evolutionId: "",
        size: 1.4,
        baseStats: { hp: 180, attack: 22, defense: 18, spAttack: 12, spDefense: 15, speed: 16 },
        maxStats:  { hp: 820, attack: 230, defense: 190, spAttack: 130, spDefense: 170, speed: 180 },
        moves: [
            { name: "Tackle", type: "basic", damage: 15, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Vine Whip", type: "grass", damage: 25, powerCost: 5, damageType: "physical", levelToLearn: 1 },
            { name: "Razor Leaf", type: "grass", damage: 50, powerCost: 14, damageType: "physical", levelToLearn: 5 },
            { name: "Solar Beam", type: "grass", damage: 75, powerCost: 25, damageType: "special", levelToLearn: 10 }
        ]
    },
    sparkwing: {
        id: "sparkwing",
        name: "Sparkwing",
        type: ["electric", "air"],
        spawn_routes: [1, 2],
        img: "petpng/sparkwing.png",
        catchRate: 40,
        evolvingLevel: 8,
        evolutionId: "",
        size: 0.85,
        baseStats: { hp: 95, attack: 13, defense: 8, spAttack: 17, spDefense: 9, speed: 18 },
        maxStats:  { hp: 450, attack: 150, defense: 105, spAttack: 205, spDefense: 115, speed: 210 },
        moves: [
            { name: "Quick Peck", type: "air", damage: 15, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Thundershock", type: "electric", damage: 25, powerCost: 6, damageType: "special", levelToLearn: 1 },
            { name: "Spark Wing", type: "electric", damage: 45, powerCost: 12, damageType: "physical", levelToLearn: 5 },
            { name: "Thunderbolt", type: "electric", damage: 70, powerCost: 20, damageType: "special", levelToLearn: 10 }
        ]
    },
    coalapling: {
        id: "coalapling",
        name: "Coalapling",
        type: ["grass", "fire"],
        spawn_routes: [1, 2],
        img: "petpng/coalapling.png",
        catchRate: 35,
        evolvingLevel: 10,
        evolutionId: "",
        size: 1.5,
        baseStats: { hp: 120, attack: 17, defense: 25, spAttack: 17, spDefense: 25, speed: 10 },
        maxStats:  { hp: 650, attack: 150, defense: 180, spAttack: 150, spDefense: 180, speed: 120 },
        moves: [
            { name: "Stick Impact", type: "grass", damage: 15, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Burn Out", type: "fire", damage: 50, powerCost: 40, damageType: "special", levelToLearn: 1 },
            { name: "Heavy Slam", type: "basic", damage: 65, powerCost: 70, damageType: "physical", levelToLearn: 5 },
            { name: "Flamethrower", type: "fire", damage: 65, powerCost: 70, damageType: "special", levelToLearn: 10 },
            { name: "Vine Whip", type: "fire", damage: 80, powerCost: 75, damageType: "physical", levelToLearn: 16 }
        ]
    },
    samupillar: {
        id: "samupillar",
        name: "Samupillar",
        type: ["combat", "bug"],
        spawn_routes: [1, 2],
        img: "petpng/samupillar.png",
        catchRate: 45,
        evolvingLevel: 7,
        evolutionId: "samupod",
        size: 0.7,
        baseStats: { hp: 80, attack: 15, defense: 12, spAttack: 12, spDefense: 5, speed: 5 },
        maxStats:  { hp: 350, attack: 125, defense: 120, spAttack: 95, spDefense: 60, speed: 100 },
        moves: [
            { name: "Sticky Webs", type: "bug", damage: 12, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Power Punch", type: "combat", damage: 50, powerCost: 40, damageType: "physical", levelToLearn: 1 },
            { name: "Fighting Aura", type: "combat", damage: 60, powerCost: 60, damageType: "physical", levelToLearn: 5 },
            { name: "Bug Bite", type: "bug", damage: 45, powerCost: 40, damageType: "physical", levelToLearn: 10 }
        ]
    },
    dragorm: {
        id: "dragorm",
        name: "Dragorm",
        type: ["dragon", "bug"],
        spawn_routes: [2],
        img: "petpng/dragorm.png",
        catchRate: 45,
        evolvingLevel: 12,
        evolutionId: "",
        size: 1.6,
        baseStats: { hp: 90, attack: 19, defense: 30, spAttack: 5, spDefense: 15, speed: 15 },
        maxStats:  { hp: 450, attack: 125, defense: 250, spAttack: 95, spDefense: 70, speed: 150 },
        moves: [
            { name: "Sticky Webs", type: "bug", damage: 12, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Dragons Breath", type: "dragon", damage: 50, powerCost: 40, damageType: "special", levelToLearn: 1 },
            { name: "Dragon Webs", type: "dragon", damage: 200, powerCost: 100, damageType: "physical", levelToLearn: 15 },
            { name: "Bug Bite", type: "bug", damage: 45, powerCost: 40, damageType: "physical", levelToLearn: 10 }
        ]
    },
    hydrini: {
        id: "hydrini",
        name: "Hydrini",
        type: ["dragon"],
        spawn_routes: [2, 3],
        img: "petpng/hydrini.png",
        catchRate: 45,
        evolvingLevel: 20,
        evolutionId: "",
        size: 1.0,
        baseStats: { hp: 90, attack: 19, defense: 30, spAttack: 25, spDefense: 30, speed: 30 },
        maxStats:  { hp: 450, attack: 125, defense: 120, spAttack: 145, spDefense: 120, speed: 220 },
        moves: [
            { name: "Tackle", type: "basic", damage: 15, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Dragons Breath", type: "dragon", damage: 50, powerCost: 40, damageType: "special", levelToLearn: 1 },
            { name: "Dragon Orb", type: "dragon", damage: 75, powerCost: 55, damageType: "special", levelToLearn: 15 },
            { name: "Magical Burst", type: "basic", damage: 75, powerCost: 55, damageType: "special", levelToLearn: 20 }
        ]
    },
    shocket: {
        id: "shocket",
        name: "Shocket",
        type: ["water"],
        spawn_routes: [3],
        img: "petpng/shark.png",
        catchRate: 45,
        evolvingLevel: 20,
        evolutionId: "trishock",
        size: 1.0,
        baseStats: { hp: 100, attack: 25, defense: 30, spAttack: 25, spDefense: 15, speed: 30 },
        maxStats:  { hp: 500, attack: 130, defense: 150, spAttack: 145, spDefense: 75, speed: 250 },
        moves: [
            { name: "Tackle", type: "basic", damage: 15, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Flame Burst", type: "fire", damage: 50, powerCost: 40, damageType: "special", levelToLearn: 1 },
            { name: "Water Blade", type: "water", damage: 50, powerCost: 40, damageType: "special", levelToLearn: 15 },
            { name: "Self Destruct", type: "basic", damage: 150, powerCost: 100, damageType: "physical", levelToLearn: 20 }
        ]
    },
    trishock: {
        id: "trishock",
        name: "Trishock",
        type: ["water"],
        spawn_routes: [],
        img: "petpng/trishock.png",
        catchRate: 45,
        evolvingLevel: 20,
        evolutionId: "",
        size: 1.5,
        baseStats: { hp: 150, attack: 35, defense: 45, spAttack: 35, spDefense: 20, speed: 45 },
        maxStats:  { hp: 800, attack: 200, defense: 190, spAttack: 210, spDefense: 90, speed: 320 },
        moves: [
            { name: "Tackle", type: "basic", damage: 15, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Flame Burst", type: "fire", damage: 50, powerCost: 40, damageType: "special", levelToLearn: 1 },
            { name: "Water Blade", type: "water", damage: 50, powerCost: 40, damageType: "special", levelToLearn: 15 },
            { name: "Self Destruct", type: "basic", damage: 150, powerCost: 100, damageType: "physical", levelToLearn: 20 },
            { name: "Silver Gleam", type: "metal", damage: 65, powerCost: 35, damageType: "special", levelToLearn: 20 }
        ]
    },
    samupod: {
        id: "samupod",
        name: "Samupod",
        type: ["bug", "combat"],
        spawn_routes: [3],
        img: "petpng/samupod.png",
        catchRate: 45,
        evolvingLevel: 16,
        evolutionId: "bladee",
        size: 0.8,
        baseStats: { hp: 100, attack: 15, defense: 45, spAttack: 15, spDefense: 45, speed: 5 },
        maxStats:  { hp: 500, attack: 120, defense: 190, spAttack: 120, spDefense: 190, speed: 80 },
        moves: [
            { name: "Tackle", type: "basic", damage: 15, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Web", type: "bug", damage: 15, powerCost: 0, damageType: "special", levelToLearn: 1 },
            { name: "Charged Tackle", type: "combat", damage: 70, powerCost: 45, damageType: "physical", levelToLearn: 5 },
            { name: "Self Destruct", type: "basic", damage: 150, powerCost: 100, damageType: "physical", levelToLearn: 10 },
            { name: "Shining Eye", type: "metal", damage: 65, powerCost: 35, damageType: "special", levelToLearn: 15 }
        ]
    },
    bladee: {
        id: "bladee",
        name: "Bladee",
        type: ["bug", "combat"],
        spawn_routes: [],
        img: "petpng/bladee.png",
        catchRate: 45,
        evolvingLevel: 20,
        evolutionId: "",
        size: 1.5,
        baseStats: { hp: 150, attack: 25, defense: 35, spAttack: 15, spDefense: 20, speed: 35 },
        maxStats:  { hp: 600, attack: 190, defense: 180, spAttack: 120, spDefense: 130, speed: 270 },
        moves: [
            { name: "Tackle", type: "basic", damage: 15, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Blade Slash", type: "combat", damage: 75, powerCost: 40, damageType: "physical", levelToLearn: 1 },
            { name: "Water Blade", type: "water", damage: 75, powerCost: 40, damageType: "special", levelToLearn: 15 },
            { name: "Heavy Tackle", type: "basic", damage: 110, powerCost: 80, damageType: "physical", levelToLearn: 20 },
            { name: "Thunder Slash", type: "electric", damage: 75, powerCost: 40, damageType: "special", levelToLearn: 20 }
        ]
    }
};

function getCalculatedPet(petData) {
    if (!petData || !petData.id) return null;

    const species = PETS[petData.id.toLowerCase()];
    if (!species) return null;

    const level = petData.lvl || 1;
    const calc = (base, max) => Math.floor(base + (max - base) * ((level - 1) / 99));

    const maxHp = calc(species.baseStats.hp, species.maxStats.hp);
    const unlockedMoves = species.moves.filter(m => level >= m.levelToLearn);

    let activeMoves = petData.activeMoves;
    if (!activeMoves || activeMoves.length === 0) {
        activeMoves = unlockedMoves.slice(0, 4).map(m => m.name);
    }

    return {
        id: species.id,
        name: species.name,
        type: species.type,
        img: species.img,
        size: species.size || 1.0,
        level: level,
        maxHp: maxHp,
        currentHp: petData.hp !== undefined ? Math.min(petData.hp, maxHp) : maxHp,
        attack: calc(species.baseStats.attack, species.maxStats.attack),
        defense: calc(species.baseStats.defense, species.maxStats.defense),
        spAttack: calc(species.baseStats.spAttack, species.maxStats.spAttack),
        spDefense: calc(species.baseStats.spDefense, species.maxStats.spDefense),
        speed: calc(species.baseStats.speed, species.maxStats.speed),
        moves: species.moves,
        unlockedMoves: unlockedMoves,
        activeMoves: activeMoves
    };
}

function calculateDamage(attacker, defender, move) {
    const isPhysical = move.damageType === "physical";
    const atk = isPhysical ? attacker.attack : attacker.spAttack;
    const def = isPhysical ? defender.defense : defender.spDefense;

    let damage = (move.damage * (atk / def)) / 1.5;
    const effectiveness = getTypeEffectiveness(move.type, defender.type);
    damage *= effectiveness;

    return Math.max(1, Math.floor(damage));
}

function calculateCatchRate(petInstance, ballMultiplier = 1) {
    const species = PETS[petInstance.id.toLowerCase()];
    if (!species) return 0;

    const baseRate = species.catchRate || 45;
    const hpRatio = Math.max(0.01, Math.min(1.0, petInstance.currentHp / petInstance.maxHp));
    const healthMultiplier = 1 + ((1 - hpRatio) / 0.99);

    return Math.floor(baseRate * healthMultiplier * ballMultiplier);
}
