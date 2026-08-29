// Database of Pet Species with Base Stats, Max Stats, and Move Pools
const PETS = {
    flaragon: {
        id: "flaragon",
        name: "Flaragon",
        type: "Fire",
        spawn_routes: [2],
        img: "petpng/flaragon.png",
        baseStats: { hp: 20, attack: 10, defense: 10, spAttack: 16, spDefense: 12, speed: 15 },
        maxStats:  { hp: 210, attack: 110, defense: 120, spAttack: 190, spDefense: 140, speed: 175 },
        moves: [
            { name: "Scratch", damage: 35, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Ember", damage: 50, powerCost: 5, damageType: "special", levelToLearn: 1 },
            { name: "Flame Dash", damage: 70, powerCost: 10, damageType: "physical", levelToLearn: 5 },
            { name: "Inferno Blast", damage: 95, powerCost: 20, damageType: "special", levelToLearn: 10 }
        ]
    },
    bubbitty: {
        id: "bubbitty",
        name: "Bubbitty",
        type: "Water",
        spawn_routes: [1, 2],
        img: "petpng/bubbitty.png",
        baseStats: { hp: 22, attack: 10, defense: 14, spAttack: 12, spDefense: 16, speed: 10 },
        maxStats:  { hp: 230, attack: 130, defense: 170, spAttack: 150, spDefense: 195, speed: 120 },
        moves: [
            { name: "Tackle", damage: 35, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Water Gun", damage: 45, powerCost: 5, damageType: "special", levelToLearn: 1 },
            { name: "Bubble Beam", damage: 70, powerCost: 12, damageType: "special", levelToLearn: 5 },
            { name: "Hydro Pump", damage: 100, powerCost: 22, damageType: "special", levelToLearn: 10 }
        ]
    },
    sproupup: {
        id: "sproupup",
        name: "Sproupup",
        type: "Grass",
        spawn_routes: [1],
        img: "petpng/sproupup.png",
        baseStats: { hp: 25, attack: 16, defense: 13, spAttack: 8, spDefense: 10, speed: 12 },
        maxStats:  { hp: 260, attack: 185, defense: 155, spAttack: 100, spDefense: 130, speed: 145 },
        moves: [
            { name: "Tackle", damage: 35, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Vine Whip", damage: 45, powerCost: 5, damageType: "physical", levelToLearn: 1 },
            { name: "Razor Leaf", damage: 75, powerCost: 14, damageType: "physical", levelToLearn: 5 },
            { name: "Solar Beam", damage: 105, powerCost: 25, damageType: "special", levelToLearn: 10 }
        ]
    },
    sparkwing: {
        id: "sparkwing",
        name: "Sparkwing",
        type: "Electric",
        spawn_routes: [2],
        img: "petpng/sparkwing.png",
        baseStats: { hp: 18, attack: 13, defense: 8, spAttack: 17, spDefense: 9, speed: 18 },
        maxStats:  { hp: 195, attack: 150, defense: 105, spAttack: 205, spDefense: 115, speed: 210 },
        moves: [
            { name: "Quick Peck", damage: 35, powerCost: 0, damageType: "physical", levelToLearn: 1 },
            { name: "Thundershock", damage: 50, powerCost: 6, damageType: "special", levelToLearn: 1 },
            { name: "Spark Wing", damage: 70, powerCost: 12, damageType: "physical", levelToLearn: 5 },
            { name: "Thunderbolt", damage: 95, powerCost: 20, damageType: "special", levelToLearn: 10 }
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
