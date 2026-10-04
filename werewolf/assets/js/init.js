/* werewolf / init — boot
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= INIT ================= */
        initTitleDrips();
        initAmbient();
        initNickname();
        initSettings();
        initAuth();
        lucide.createIcons();

        /* The menu is the DEFAULT visible section (the others ship `hidden`), so on a
           cold load no showScreen() ever runs — and the hall, which is driven by that
           hook, would sit empty until the player wandered to another screen and back.
           Start it here, after the nickname is prefilled. */
        if (typeof startHall === 'function') startHall();
    
