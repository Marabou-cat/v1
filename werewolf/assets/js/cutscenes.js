/* werewolf / cutscenes — scene overlays
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= CUTSCENES ================= */
        function triggerCutscene(sceneKey, callback) {
            const overlay = document.getElementById('cutscene-overlay');
            const iconContainer = document.getElementById('cutscene-icon');
            const text = document.getElementById('cutscene-text');
            const sub = document.getElementById('cutscene-sub');

            const scenes = {
                'scene_room_created': { icon: 'castle', title: 'Fortress Created', sub: 'Assembling players...' },
                'scene_door_open': { icon: 'door-open', title: 'Entering Arena', sub: 'Joining squad room...' },
                'scene_night_falls': { icon: 'moon', title: 'Blood Moon Rises', sub: 'Battle phase beginning...' },
                'scene_error': { icon: 'zap', title: 'Action Failed', sub: 'An error occurred' }
            };

            const scene = scenes[sceneKey] || { icon: 'help-circle', title: 'Processing...', sub: '' };
            iconContainer.innerHTML = `<i data-lucide="${scene.icon}" size="84"></i>`;
            text.innerText = scene.title;
            sub.innerText = scene.sub;
            lucide.createIcons();

            overlay.classList.remove('fade-out');
            overlay.style.display = 'flex';
            setTimeout(() => {
                overlay.classList.add('fade-out');
                setTimeout(() => {
                    overlay.style.display = 'none';
                    overlay.classList.remove('fade-out');
                    if (callback) callback();
                }, 320);
            }, 1700);
        }

        
