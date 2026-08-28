// Database of Pet Species with Base Stats (Lv. 1) and Max Stats (Lv. 100)
const PETS = {
    flaragon: {
        id: "flaragon",
        name: "Flaragon",
        type: "Fire",
        baseStats: { hp: 20, attack: 10, defense: 10, spAttack: 16, spDefense: 12, speed: 15 },
        maxStats:  { hp: 210, attack: 110, defense: 120, spAttack: 190, spDefense: 140, speed: 175 }
    },
    bubbitty: {
        id: "bubbity",
        name: "Bubbitty",
        type: "Water",
        baseStats: { hp: 22, attack: 10, defense: 14, spAttack: 12, spDefense: 16, speed: 10 },
        maxStats:  { hp: 230, attack: 130, defense: 170, spAttack: 150, spDefense: 195, speed: 120 }
    },
    sproupup: {
        id: "sproupup",
        name: "Sproupup",
        type: "Grass",
        baseStats: { hp: 25, attack: 16, defense: 13, spAttack: 8, spDefense: 10, speed: 12 },
        maxStats:  { hp: 260, attack: 185, defense: 155, spAttack: 100, spDefense: 130, speed: 145 }
    },
    sparkwing: {
        id: "sparkwing",
        name: "Sparkwing",
        type: "Electric",
        baseStats: { hp: 18, attack: 13, defense: 8, spAttack: 17, spDefense: 9, speed: 18 },
        maxStats:  { hp: 195, attack: 150, defense: 105, spAttack: 205, spDefense: 115, speed: 210 }
    }
};

/**
 * Dynamic Stat Calculation Formula:
 * Stat = BaseStat + Math.floor((MaxStat - BaseStat) * ((Level - 1) / 99))
 */
function getCalculatedPet(petData) {
    const species = PETS[petData.id];
    if (!species) return null;

    const level = petData.lvl || 1;
    const calc = (base, max) => Math.floor(base + (max - base) * ((level - 1) / 99));

    const maxHp = calc(species.baseStats.hp, species.maxStats.hp);

    return {
        id: species.id,
        name: species.name,
        type: species.type,
        level: level,
        maxHp: maxHp,
        currentHp: petData.hp !== undefined ? Math.min(petData.hp, maxHp) : maxHp,
        attack: calc(species.baseStats.attack, species.maxStats.attack),
        defense: calc(species.baseStats.defense, species.maxStats.defense),
        spAttack: calc(species.baseStats.spAttack, species.maxStats.spAttack),
        spDefense: calc(species.baseStats.spDefense, species.maxStats.spDefense),
        speed: calc(species.baseStats.speed, species.maxStats.speed)
    };
}
