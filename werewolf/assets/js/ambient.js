/* werewolf / ambient — background particles
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= AMBIENT PARTICLES ================= */
        function initAmbient() {
            const starsEl = document.getElementById('stars');
            let starsHtml = '';
            for (let i = 0; i < 110; i++) {
                const size = (Math.random() * 2 + 1).toFixed(1);
                const x = (Math.random() * 100).toFixed(2);
                const y = (Math.random() * 100).toFixed(2);
                const tw = (Math.random() * 4 + 2).toFixed(1);
                const delay = (Math.random() * 5).toFixed(1);
                starsHtml += `<div class="star" style="width:${size}px;height:${size}px;left:${x}%;top:${y}%;--tw:${tw}s;animation-delay:${delay}s;"></div>`;
            }
            starsEl.innerHTML = starsHtml;

            const embersEl = document.getElementById('embers');
            let embersHtml = '';
            for (let i = 0; i < 24; i++) {
                const size = (Math.random() * 4 + 3).toFixed(1);
                const x = (Math.random() * 100).toFixed(2);
                const dur = (Math.random() * 10 + 9).toFixed(1);
                const delay = (Math.random() * 14).toFixed(1);
                const drift = (Math.random() * 120 - 60).toFixed(0);
                const op = (Math.random() * 0.4 + 0.35).toFixed(2);
                embersHtml += `<div class="ember" style="width:${size}px;height:${size}px;left:${x}%;--er:${dur}s;animation-delay:${delay}s;--ex:${drift}px;--eo:${op};"></div>`;
            }
            embersEl.innerHTML = embersHtml;
        }

        
