// Reserved Usernames — lock names so nobody can register or switch to them.
// Backed by public.reserved_usernames (RLS: read = any authed user, write =
// admins only) + a BEFORE trigger on users.username that hard-blocks
// non-admins from taking a locked name (migration 20260722000000).
(() => {
    let rows = [];

    registerRoute('usernames', {
        title: 'Usernames', icon: '🔒', order: 8,
        async render(el) {
            el.innerHTML = `
                <h2 class="page">Reserved Usernames</h2>
                <p class="pagesub">Locked names nobody can take — signups and username changes to these are blocked. Admin accounts are exempt, so you can still claim a name you've locked.</p>
                <div class="toolbar" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
                    <input type="text" id="ruName" placeholder="username to lock (e.g. kidheat)" style="min-width:220px;">
                    <input type="text" id="ruNote" placeholder="note — why it's locked (optional)" style="min-width:260px;">
                    <button class="btn gold" onclick="ru_add()">🔒 Lock name</button>
                </div>
                <div id="ruList" class="spin">Loading…</div>`;
            const nameInput = document.getElementById('ruName');
            if (nameInput) nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.ru_add(); });
            await load();
        },
    });

    async function load() {
        const box = document.getElementById('ruList');
        if (box) { box.className = 'spin'; box.textContent = 'Loading…'; }
        const { data, error } = await supabaseClient
            .from('reserved_usernames')
            .select('username, note, created_at, created_by')
            .order('created_at', { ascending: false });
        if (error) {
            if (box) { box.className = 'empty'; box.textContent = 'Failed to load: ' + error.message; }
            return;
        }
        rows = data || [];
        renderList();
    }

    function renderList() {
        const box = document.getElementById('ruList');
        if (!box) return;
        box.className = '';
        if (rows.length === 0) {
            box.innerHTML = '<div class="empty">No reserved usernames yet. Lock one above.</div>';
            return;
        }
        box.innerHTML = `
            <p class="pagesub" style="margin:6px 0 10px;">${rows.length} name${rows.length === 1 ? '' : 's'} locked</p>
            <table class="tbl">
                <thead><tr><th>Username</th><th>Note</th><th>Locked</th><th></th></tr></thead>
                <tbody>
                    ${rows.map(r => `
                        <tr>
                            <td style="font-weight:600;">@${esc(r.username)}</td>
                            <td>${esc(r.note || '—')}</td>
                            <td>${new Date(r.created_at).toLocaleDateString()}</td>
                            <td style="text-align:right;"><button class="btn sm" onclick="ru_remove('${esc(r.username)}')">Unlock</button></td>
                        </tr>`).join('')}
                </tbody>
            </table>`;
    }

    window.ru_add = async function () {
        const nameEl = document.getElementById('ruName');
        const noteEl = document.getElementById('ruNote');
        const username = (nameEl?.value || '').trim().toLowerCase().replace(/^@/, '');
        const note = (noteEl?.value || '').trim() || null;

        if (!username) { adminToast('Enter a username to lock', 'error'); return; }
        if (!/^[a-z0-9._-]{2,30}$/.test(username)) {
            adminToast('Usernames are 2–30 chars: letters, numbers, dots, underscores, dashes', 'error', 5000);
            return;
        }

        const { data: sessionData } = await supabaseClient.auth.getUser();
        const { error } = await supabaseClient
            .from('reserved_usernames')
            .insert({ username, note, created_by: sessionData?.user?.id || null });
        if (error) {
            adminToast(error.code === '23505' ? `@${username} is already locked` : 'Error: ' + error.message, 'error', 5000);
            return;
        }

        await logAdminAction('username_reserved', null, { username, note }, `Locked username @${username}`);
        adminToast(`🔒 @${username} locked`, 'success');
        if (nameEl) nameEl.value = '';
        if (noteEl) noteEl.value = '';
        await load();
    };

    window.ru_remove = async function (username) {
        if (!confirm(`Unlock @${username}? Anyone will be able to take it again.`)) return;
        const { error } = await supabaseClient
            .from('reserved_usernames')
            .delete()
            .eq('username', username);
        if (error) { adminToast('Error: ' + error.message, 'error', 5000); return; }
        await logAdminAction('username_released', null, { username }, `Unlocked username @${username}`);
        adminToast(`@${username} unlocked`, 'success');
        rows = rows.filter(r => r.username !== username);
        renderList();
    };
})();
