// quests.js
let activeQuestIndex = 0;

const quests = [
    {
        id: 'q1',
        type: 'catch_pet',
        target: 'samupillar', // Make sure this matches the pet's ID
        description: 'Catch a wild Samupillar in the tall grass get a new friend! Make the enemy on low hp first to higher the catch rate!',
        rewardCoins: 250
    },
    {
        id: 'q2',
        type: 'defeat_npc',
        target: 'Rival Pelle', // Make sure this matches the NPC's exact name
        description: 'There is a boy challenging you! What? How to even battle with these creatures? Defeat the boy in a Ultramon Battle.',
        rewardCoins: 250
    },
    {
        id: 'q3',
        type: 'catch_pet',
        target: 'bubbitty',
        description: 'Catch a wild Bubbitty',
        rewardCoins: 150
    }
];

function getActiveQuest() {
    if (activeQuestIndex < quests.length) {
        return quests[activeQuestIndex];
    }
    return null; // All quests completed
}

function updateQuestUI() {
    const objectiveText = document.getElementById('questObjective');
    if (!objectiveText) return;

    const quest = getActiveQuest();
    if (!quest) {
        objectiveText.innerText = "All quests completed!";
        return;
    }
    objectiveText.innerText = quest.description;
}

function checkQuestProgress(actionType, actionTarget) {
    const quest = getActiveQuest();
    if (!quest) return;

    // Check if the action matches the current quest requirement
    if (quest.type === actionType && quest.target.toLowerCase() === actionTarget.toLowerCase()) {
        
        // Give rewards
        coins += quest.rewardCoins || 0;
        
        // Notify player
        setTimeout(() => {
            alert(`🎉 Quest Complete: ${quest.description}!\nReward: ${quest.rewardCoins} coins!`);
            if (typeof updateUI === 'function') updateUI(); 
            if (typeof saveGameData === 'function') saveGameData(true);
        }, 500);

        // Advance to next quest
        activeQuestIndex++;
        updateQuestUI();
    }
}
