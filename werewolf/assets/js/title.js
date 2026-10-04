/* werewolf / title — title screen blood drips
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= TITLE BLOOD DRIPS ================= */
        function initTitleDrips() {
            const holder = document.getElementById('title-drips');
            if (!holder) return;
            // Respect reduced-motion: no drips, no creep
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

            function rand(min, max) { return min + Math.random() * (max - min); }

            // Static set of drips with randomised position / length / timing.
            const COUNT = 9;
            let prevLeft = -99;
            for (let i = 0; i < COUNT; i++) {
                const d = document.createElement('span');
                d.className = 'drip';
                // position: 4% .. 96% (avoid dead-edges), keep some spacing
                let left = rand(4, 96);
                let guard = 0;
                while (i > 0 && Math.abs(left - prevLeft) < 7 && guard++ < 20) left = rand(4, 96);
                prevLeft = left;
                d.style.left = left + '%';
                d.style.setProperty('--dur', rand(2.6, 4.6).toFixed(2) + 's');
                d.style.setProperty('--delay', rand(0, 3.2).toFixed(2) + 's');
                const w = rand(5, 9);
                d.style.width = w + 'px';
                d.style.borderRadius = '0 0 ' + w + 'px ' + w + 'px';
                d.style.filter = `brightness(${rand(0.85, 1.12).toFixed(2)})`;
                holder.appendChild(d);
            }
        }

        
