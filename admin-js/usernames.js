// Reserved Usernames — lock names so nobody can register or switch to them,
// search the locked list, and ASSIGN a locked name to a specific account.
// Backed by public.reserved_usernames (RLS: read = any authed user, write =
// admins only) + a BEFORE trigger on users.username that hard-blocks
// non-admins from taking a locked name (migration 20260722000000). Assigning
// works because the acting admin is exempt from the trigger.
(() => {
    let rows = [];
    let filter = '';

    registerRoute('usernames', {
        title: 'Usernames', icon: '🔒', order: 8,
        async render(el) {
            el.innerHTML = `
                <h2 class="page">Reserved Usernames</h2>
                <p class="pagesub">Locked names nobody can take — signups and username changes to these are blocked. Admin accounts are exempt. Use Assign to hand a locked name to a specific account.</p>
                <div class="toolbar" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
                    <input type="text" id="ruName" placeholder="username to lock (e.g. kidheat)" style="min-width:200px;">
                    <input type="text" id="ruNote" placeholder="note — why it's locked (optional)" style="min-width:230px;">
                    <button class="btn gold" onclick="ru_add()">🔒 Lock name</button>
                    <span style="flex:1"></span>
                    <input type="search" id="ruSearch" placeholder="Search locked names…" style="min-width:200px;">
                </div>
                <div id="ruList" class="spin">Loading…</div>`;
            const nameInput = document.getElementById('ruName');
            if (nameInput) nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.ru_add(); });
            const searchInput = document.getElementById('ruSearch');
            if (searchInput) searchInput.addEventListener('input', (e) => {
                filter = (e.target.value || '').trim().toLowerCase();
                renderList();
            });
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

    function visibleRows() {
        if (!filter) return rows;
        return rows.filter(r =>
            r.username.includes(filter) || (r.note || '').toLowerCase().includes(filter));
    }

    function renderList() {
        const box = document.getElementById('ruList');
        if (!box) return;
        box.className = '';
        const list = visibleRows();
        if (rows.length === 0) {
            box.innerHTML = '<div class="empty">No reserved usernames yet. Lock one above.</div>';
            return;
        }
        if (list.length === 0) {
            box.innerHTML = `<div class="empty">No locked names match “${esc(filter)}”.</div>`;
            return;
        }
        box.innerHTML = `
            <p class="pagesub" style="margin:6px 0 10px;">${list.length}${filter ? ` of ${rows.length}` : ''} name${list.length === 1 ? '' : 's'} locked</p>
            <table class="tbl">
                <thead><tr><th>Username</th><th>Note</th><th>Locked</th><th style="text-align:right;">Actions</th></tr></thead>
                <tbody>
                    ${list.map(r => `
                        <tr>
                            <td style="font-weight:600;">@${esc(r.username)}</td>
                            <td>${esc(r.note || '—')}</td>
                            <td>${new Date(r.created_at).toLocaleDateString()}</td>
                            <td style="text-align:right; white-space:nowrap;">
                                <button class="btn sm gold" onclick="ru_assignOpen('${esc(r.username)}')">Assign</button>
                                <button class="btn sm" onclick="ru_remove('${esc(r.username)}')">Unlock</button>
                            </td>
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

    // ── Assign a locked name to an account ──────────────────────────────
    window.ru_assignOpen = function (lockedName) {
        ui.drawer({
            title: `Assign @${lockedName}`,
            html: `
                <p class="pagesub" style="margin-bottom:10px;">Pick the account that gets <b>@${esc(lockedName)}</b>. Their current username is released; the name stays locked so nobody else can grab it if they ever change away.</p>
                <input type="search" id="ruaSearch" placeholder="Search by username or display name…" style="width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--border); background:var(--well); color:var(--cream); font-family:inherit;">
                <div id="ruaResults" style="margin-top:10px;"></div>`,
            onMount() {
                const input = document.getElementById('ruaSearch');
                let t = null;
                input.addEventListener('input', () => {
                    clearTimeout(t);
                    t = setTimeout(() => ruaSearch(lockedName, input.value), 250);
                });
                input.focus();
            },
        });
    };

    async function ruaSearch(lockedName, q) {
        const box = document.getElementById('ruaResults');
        if (!box) return;
        const query = (q || '').trim().toLowerCase().replace(/^@/, '');
        if (query.length < 2) { box.innerHTML = '<div class="empty">Type at least 2 characters…</div>'; return; }
        box.innerHTML = '<div class="spin">Searching…</div>';
        const { data, error } = await supabaseClient
            .from('users')
            .select('id, username, display_name, avatar_url, is_verified')
            .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
            .is('deleted_at', null)
            .limit(12);
        if (error) { box.innerHTML = `<div class="empty">Search failed: ${esc(error.message)}</div>`; return; }
        if (!data || data.length === 0) { box.innerHTML = '<div class="empty">No accounts found.</div>'; return; }
        box.innerHTML = data.map(u => `
            <div style="display:flex; align-items:center; gap:10px; padding:9px 6px; border-bottom:1px solid var(--border); cursor:pointer;"
                 onclick="ru_assignTo('${esc(lockedName)}', '${u.id}', '${esc(u.username)}')">
                ${u.avatar_url
                    ? `<img src="${esc(u.avatar_url)}" style="width:34px; height:34px; border-radius:50%; object-fit:cover;">`
                    : `<div style="width:34px; height:34px; border-radius:50%; background:var(--card); display:flex; align-items:center; justify-content:center;">${esc((u.username || '?')[0].toUpperCase())}</div>`}
                <div style="flex:1; min-width:0;">
                    <div style="font-weight:600;">@${esc(u.username)}${u.is_verified ? ' ✔︎' : ''}</div>
                    <div class="pagesub" style="margin:0; font-size:12px;">${esc(u.display_name || '')}</div>
                </div>
                <button class="btn sm gold">Assign</button>
            </div>`).join('');
    }

    window.ru_assignTo = async function (lockedName, userId, currentUsername) {
        if (!confirm(`Give @${lockedName} to @${currentUsername}? Their current name @${currentUsername} becomes available.`)) return;

        const { error } = await supabaseClient
            .from('users')
            .update({ username: lockedName, username_changed_at: new Date().toISOString() })
            .eq('id', userId);
        if (error) {
            adminToast(error.code === '23505'
                ? `@${lockedName} is currently HELD by another account — find them in Users first`
                : 'Error: ' + error.message, 'error', 6000);
            return;
        }

        // Record the assignment on the reservation (name stays locked).
        const existing = rows.find(r => r.username === lockedName);
        const stamped = `assigned to @${currentUsername} → now holds it (${new Date().toLocaleDateString()})`;
        const newNote = existing?.note ? `${existing.note} · ${stamped}` : stamped;
        await supabaseClient.from('reserved_usernames').update({ note: newNote }).eq('username', lockedName);

        await logAdminAction('username_assigned', userId, { username: lockedName, previous_username: currentUsername }, `Assigned locked username @${lockedName} to user ${userId} (was @${currentUsername})`);
        adminToast(`✅ @${lockedName} assigned — account is now @${lockedName}`, 'success');
        ui.closeDrawer();
        await load();
    };
})();
