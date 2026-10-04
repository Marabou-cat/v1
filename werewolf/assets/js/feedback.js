/* werewolf / feedback — instant acknowledgement for taps.
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= CLICK FEEDBACK ================= */

/* Every action endpoint pays a durable InnoDB write (~270ms fsync) before it can
   answer, plus a network round-trip. If the UI waits for that, every tap feels
   dead. So: acknowledge the tap IMMEDIATELY, then let the next poll reconcile
   with the server's truth. */

/* A non-blocking toast. alert() freezes the poll loop and looks awful on a
   phone, so nothing in the hot path should ever call it. */
function flashInfo(msg, isError) {
    if (!msg) return;
    let el = document.getElementById('toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        document.body.appendChild(el);
    }
    el.innerText = String(msg);
    el.className = 'toast show' + (isError ? ' toast-err' : '');
    clearTimeout(flashInfo._t);
    flashInfo._t = setTimeout(function () { el.className = 'toast'; }, 2800);
}

/* Lock a roster of choice-buttons onto one pick, right now. */
function lockChoice(scope, chosenBtn) {
    if (!scope) return;
    const btns = scope.querySelectorAll('.btn-action');
    Array.prototype.forEach.call(btns, function (b) {
        b.disabled = true;
        b.classList.add('choice-locked');
        if (b === chosenBtn) {
            b.classList.remove('choice-locked');
            b.classList.add('choice-picked');
            b.innerHTML = '<i data-lucide="check" size="16"></i> Chosen';
        }
    });
    if (window.lucide) lucide.createIcons();
}

/* Highlight the card that was just acted on (feels like the tap "landed"). */
function markCardActed(btn) {
    const card = btn && btn.closest ? btn.closest('.player-item') : null;
    if (!card) return;
    card.classList.remove('just-acted');
    void card.offsetWidth;          // restart the animation
    card.classList.add('just-acted');
}

/* Global tactile press state for every button/tap target, so even the buttons
   that do nothing but navigate feel like physical controls. */
document.addEventListener('pointerdown', function (e) {
    const t = e.target.closest ? e.target.closest('button, .avatar-pick, .nav-btn') : null;
    if (!t || t.disabled) return;
    t.classList.add('is-pressed');
    setTimeout(function () { t.classList.remove('is-pressed'); }, 170);
}, { passive: true });
