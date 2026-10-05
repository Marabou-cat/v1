/* werewolf / chat — message render + send + trim
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= CHAT ================= */
        async function sendChatMessage() {
            const input = document.getElementById('chat-input');
            const text = input.value.trim();
            if (!text) return;

            const res = await fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ action: 'send_message', room_code: state.roomCode, token: state.token, message: text })
            });
            const data = await res.json();
            if (data.status === 'success') {
                input.value = '';
                // My own line shows in the collapsed bar immediately.
                if (typeof noteChatActivity === 'function') noteChatActivity(text, state.nickname, true);
                input.focus();
            } else {
                alert(data.message);
            }
        }

        // Keep the chat DOM bounded. The message list is the one place that
        // accumulates without limit (bot chatter + system lines over a long
        // game), so cap the node count and drop the oldest bubbles.
        const CHAT_MAX_NODES = 80;
        function trimChat(el) {
            if (!el) return;
            while (el.children.length > CHAT_MAX_NODES) el.removeChild(el.firstChild);
        }

        function appendSystemMessage(text) {
            const chatMsgs = document.getElementById('chat-messages');
            // insertAdjacentHTML: appending via innerHTML+= would rebuild the
            // whole container and replay the entrance animation on every
            // existing message
            chatMsgs.insertAdjacentHTML('beforeend', chatBubbleHtml('System', text, false, true));
            if (window.lucide) lucide.createIcons();
            trimChat(chatMsgs);
            chatMsgs.scrollTop = chatMsgs.scrollHeight;
        }

        

/* ================= THE CHAT LOG IS SOMETHING YOU OPEN =================
   Collapsed, the whole chat is ONE small bar, so the board keeps its space.
   Opened, it takes the screen and turns into a proper player chat box.
   Nothing here touches the server: messages already arrive on the poll. */

function chatIsOpen() { return document.body.classList.contains('chat-open'); }

function openChatLog() {
    document.body.classList.add('chat-open');
    const c = document.getElementById('chat-close-btn');
    if (c) c.hidden = false;
    chatMarkRead();
    const m = document.getElementById('chat-messages');
    if (m) m.scrollTop = m.scrollHeight;
    if (window.lucide) lucide.createIcons();
}

function closeChatLog() {
    document.body.classList.remove('chat-open');
    const c = document.getElementById('chat-close-btn');
    if (c) c.hidden = true;
    stopTyping();
}

/* "打字时改为玩家发送聊天框" — the composer exists only while you are writing. */
function startTyping() {
    openChatLog();
    const co = document.getElementById('chat-composer');
    if (co) co.hidden = false;
    const av = document.getElementById('chat-me-avatar');
    if (av && !av.innerHTML && typeof myCharacter === 'function' && typeof avatarHtml === 'function') {
        av.innerHTML = avatarHtml(myCharacter(), 26);
    }
    if (window.lucide) lucide.createIcons();
    const inp = document.getElementById('chat-input');
    if (inp) setTimeout(function () { inp.focus(); }, 40);
}

function stopTyping() {
    const co = document.getElementById('chat-composer');
    if (co) co.hidden = true;
    const inp = document.getElementById('chat-input');
    if (inp) inp.value = '';
}

function chatMarkRead() {
    state.chatUnread = 0;
    const b = document.getElementById('chat-unread');
    if (b) { b.hidden = true; b.innerText = '0'; }
}

/* One-line preview so the collapsed bar still tells you what is being said. */
function chatPreview(text, who) {
    const el = document.getElementById('chat-last-line');
    if (!el) return;
    const t = String(text || '').replace(/\s+/g, ' ').slice(0, 44);
    el.innerText = (who ? who + ': ' : '') + t;
}

/* Every incoming message: always update the preview, badge only while collapsed. */
function noteChatActivity(text, who, mine) {
    chatPreview(text, who);
    if (mine) return;
    if (!chatIsOpen()) {
        state.chatUnread = (state.chatUnread || 0) + 1;
        const b = document.getElementById('chat-unread');
        if (b) { b.hidden = false; b.innerText = String(state.chatUnread); }
    }
}

/* ================= ONE FRAME PER THING SAID =================
   "每次说话生成一个聊天框" — every message gets its own bubble with the speaker's
   face and name, so the log reads as a conversation instead of a wall of lines. */

function chatAvatarFor(name) {
    const map = state.rosterAvatars || {};
    const id = map[name];
    if (id && typeof avatarHtml === 'function') return avatarHtml(id, 26);
    return '<span class="avatar" style="width:26px;height:26px"></span>';
}

function chatBubbleHtml(name, text, mine, system) {
    const cls = 'chat-message' + (system ? ' sys' : '') + (mine ? ' mine' : '');
    const av = system
        ? '<span class="cm-av"><i data-lucide="info" size="18" style="color:#38bdf8"></i></span>'
        : '<span class="cm-av">' + chatAvatarFor(name) + '</span>';
    return '<div class="' + cls + '">'
        + av
        + '<div class="cm-body"><span class="sender">' + esc(name) + '</span>'
        + '<span class="cm-text">' + text + '</span></div>'
        + '</div>';
}

/* ================= CLOSING THE LOG MUST ALWAYS WORK =================
   Three ways out: the X, Escape, or a click on the backdrop. Without the backdrop
   click the only way out was the small X, which read as "the chat won't close". */
document.addEventListener('click', function (e) {
    if (!chatIsOpen()) return;
    const c = document.getElementById('chat-container');
    if (c && !c.contains(e.target)) closeChatLog();
});
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && chatIsOpen()) closeChatLog();
});
