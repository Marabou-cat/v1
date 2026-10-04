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
            chatMsgs.insertAdjacentHTML('beforeend', `<div class="chat-message no-anim" style="border-left-color: #38bdf8;"><span class="sender" style="color: #38bdf8;">System:</span> ${text}</div>`);
            trimChat(chatMsgs);
            chatMsgs.scrollTop = chatMsgs.scrollHeight;
        }

        
