// Rebalanced version of pets.js with adjusted base HP, lowered move power, and integrated stat-scaling[cite: 2]
const TYPE_CHART = {
    fire:     { fire: 0.67, water: 0.67, grass: 1.5,  electric: 1.0, combat: 1.0, basic: 1.0, bug: 1.5 },
    water:    { fire: 1.5,  water: 0.67, grass: 0.67, electric: 1.0, combat: 1.0, basic: 1.0, bug: 1.0 },
    grass:    { fire: 0.67, water: 1.5,  grass: 0.67, electric: 1.0, combat: 1.0, basic: 1.0, bug: 0.67 },
    electric: { fire: 1.0,  water: 1.5,  grass: 0.67, electric: 0.67, combat: 1.0, basic: 1.0, bug: 1.0 },
    combat:   { fire: 1.0,  water: 1.0,  grass: 1.0,  electric: 1.0, combat: 0.67, basic: 1.5, bug: 1.5 },
    basic:    { fire: 1.0,  water: 1.0,  grass: 1.0,  electric: 1.0, combat: 1.0, basic: 1.0, bug: 1.0 },
    bug:     { fire: 0.67,  water: 1.0,  grass: 1.5, electric: 1.0, combat: 1.0, basic: 1.0, bug: 1.0 }
};

// Helper function to calculate type effectiveness across multi-type pets (max 2 types)
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

// Database of Pet Species with Rebalanced Base HP and Move Powers
const PETS = {
    flaragon: {
        id: "flaragon",
        name: "Flaragon",
        type: ["fire"],
        spawn_routes: [],
        img: "petpng/flaragon.png",
        baseStats: { hp: 100, attack: 10, defense: 10, spAttack: 16, spDefense: 12, speed: 15 },
        maxStats:  { hp: 500, attack: 110, defense: 120, spAttack: 190, spDefense: 140, speed: 175 },
        moves: [
            { name: "Scratch", type: "basic", damage: 10, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Ember", type: "fire", damage: 25, powerCost: 5, damageType: "special", levelToLearn: 1 },
            { name: "Flame Dash", type: "fire", damage: 45, powerCost: 10, damageType: "physical", levelToLearn: 5 },
            { name: "Inferno Blast", type: "fire", damage: 70, powerCost: 20, damageType: "special", levelToLearn: 10 }
        ]
    },
    bubbitty: {
        id: "bubbitty",
        name: "Bubbitty",
        type: ["water"],
        spawn_routes: [],
        img: "petpng/bubbitty.png",
        baseStats: { hp: 110, attack: 10, defense: 14, spAttack: 12, spDefense: 16, speed: 10 },
        maxStats:  { hp: 540, attack: 130, defense: 170, spAttack: 150, spDefense: 195, speed: 240 },
        moves: [
            { name: "Tackle", type: "basic", damage: 15, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Water Gun", type: "water", damage: 25, powerCost: 5, damageType: "special", levelToLearn: 1 },
            { name: "Bubble Beam", type: "water", damage: 45, powerCost: 12, damageType: "special", levelToLearn: 5 },
            { name: "Hydro Pump", type: "water", damage: 75, powerCost: 22, damageType: "special", levelToLearn: 10 }
        ]
    },
    sproupup: {
        id: "sproupup",
        name: "Sproupup",
        type: ["grass"],
        spawn_routes: [],
        img: "petpng/sproupup.png",
        baseStats: { hp: 120, attack: 16, defense: 13, spAttack: 8, spDefense: 10, speed: 12 },
        maxStats:  { hp: 600, attack: 185, defense: 155, spAttack: 100, spDefense: 130, speed: 145 },
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
        type: ["electric"],
        spawn_routes: [1, 2],
        img: "petpng/sparkwing.png",
        baseStats: { hp: 95, attack: 13, defense: 8, spAttack: 17, spDefense: 9, speed: 18 },
        maxStats:  { hp: 450, attack: 150, defense: 105, spAttack: 205, spDefense: 115, speed: 210 },
        moves: [
            { name: "Quick Peck", type: "basic", damage: 15, powerCost: 0, damageType: "physical", levelToLearn: 1 },
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
        baseStats: { hp: 120, attack: 17, defense: 25, spAttack: 17, spDefense: 25, speed: 10 },
        maxStats:  { hp: 650, attack: 150, defense: 180, spAttack: 150, spDefense: 180, speed: 120 },
        moves: [
            { name: "Stick Impact", type: "basic", damage: 12, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Burn Out", type: "fire", damage: 50, powerCost: 40, damageType: "special", levelToLearn: 1 },
            { name: "Heavy Slam", type: "basic", damage: 65, powerCost: 70, damageType: "physical", levelToLearn: 5 },
            { name: "Flamethrower", type: "fire", damage: 65, powerCost: 70, damageType: "special", levelToLearn: 10 }
        ]
    },
    samupillar: {
        id: "samupillar",
        name: "Samupillar",
        type: ["combat","bug"],
        spawn_routes: [1, 2],
        img: "petpng/samupillar.png",
        baseStats: { hp: 80, attack: 15, defense: 12, spAttack: 12, spDefense: 5, speed: 5 },
        maxStats:  { hp: 350, attack: 125, defense: 120, spAttack: 95, spDefense: 60, speed: 100 },
        moves: [
            { name: "Sticky Webs", type: "bug", damage: 12, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Power Punch", type: "combat", damage: 50, powerCost: 40, damageType: "physical", levelToLearn: 1 },
            { name: "Fighting Aura", type: "combat", damage: 60, powerCost: 60, damageType: "physical", levelToLearn: 5 },
            { name: "Bug Bite", type: "bug", damage: 45, powerCost: 40, damageType: "physical", levelToLearn: 10 }
        ]
    }
};

/**
 * Dynamic Stat Calculation Formula:
 * Stat = BaseStat + Math.floor((MaxStat - BaseStat) * ((Level - 1) / 99))
 */
function getCalculatedPet(petData) {
    if (!petData || !petData.id) return null;

    const species = PETS[petData.id.toLowerCase()];
    if (!species) return null;

    const level = petData.lvl || 1;
    const calc = (base, max) => Math.floor(base + (max - base) * ((level - 1) / 99));

    const maxHp = calc(species.baseStats.hp, species.maxStats.hp);
    const unlockedMoves = species.moves.export ? species.moves.filter(m => level >= m.levelToLearn) : species.moves.filter(m => level >= m.levelToLearn);

    let activeMoves = petData.activeMoves;
    if (!activeMoves || activeMoves.length === 0) {
        activeMoves = unlockedMoves.slice(0, 4).map(m => m.name);
    }

    return {
        id: species.id,
        name: species.name,
        type: species.type,
        img: species.img,
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

/**
 * Stat-Scaling Damage Function:
 * Scales raw move damage based on the attacker's offensive stat vs. the defender's defensive stat.
 */
function calculateDamage(attacker, defender, move) {
    const isPhysical = move.damageType === "physical";
    const atk = isPhysical ? attacker.attack : attacker.spAttack;
    const def = isPhysical ? defender.defense : defender.spDefense;

    // Scale damage using stat ratio and a balancing divisor
    let damage = (move.damage * (atk / def)) / 1.5;

    // Factor in type multipliers
    const effectiveness = getTypeEffectiveness(move.type, defender.type);
    damage *= effectiveness;

    // Ensure a minimum of 1 damage is always dealt on a hit
    return Math.max(1, Math.floor(damage));
}
