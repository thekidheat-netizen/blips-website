// Blips — find a user's blips (search users + per-user blip counts, ported
// from legacy searchUsersForBlips) and inspect/delete a single blip by ID
// (ported from legacy openBlipDetail / deleteBlipFromDetail, rendered in the
// shared drawer). User search runs server-side via admin_search_users (the
// legacy version only filtered rows already loaded on the Users tab).
(function () {
    'use strict';

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    registerRoute('blips', {
        title: 'Blips', icon: '🎬', order: 5,
        async render(el) {
            el.innerHTML = `
                <h2 class="page">Blips</h2>
                <p class="pagesub">Search a user to see their blip counts, or paste a blip UUID to open it directly.</p>
                <div class="toolbar">
                    <input type="search" id="bSearch" placeholder="Search username, email, ID — or paste a blip UUID…"
                           style="flex:1; min-width:280px;" oninput="b_searchDebounced()">
                    <button class="btn" onclick="b_clearSearch()">Clear</button>
                </div>
                <div id="bResults" class="empty">Enter a username, email, or ID to search</div>`;
        },
    });

    let searchTimer = null;
    window.b_searchDebounced = function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(searchUsersForBlips, 300);
    };

    window.b_clearSearch = function () {
        const inp = document.getElementById('bSearch');
        if (inp) inp.value = '';
        const box = document.getElementById('bResults');
        if (box) { box.className = 'empty'; box.innerHTML = 'Enter a username, email, or ID to search'; }
    };

    async function searchUsersForBlips() {
        const box = document.getElementById('bResults');
        if (!box) return;
        const query = (document.getElementById('bSearch')?.value || '').trim();

        if (!query) {
            box.className = 'empty';
            box.innerHTML = 'Enter a username, email, or ID to search';
            return;
        }

        box.className = 'spin';
        box.innerHTML = 'Searching…';

        // If the query is a UUID it might be a blip ID — look that up in
        // parallel with the user search (same lookup legacy global search
        // used) so admins can jump straight to a blip.
        const isUUID = UUID_RE.test(query);
        const [userRes, blipRes] = await Promise.all([
            sb.rpc('admin_search_users', { p_query: query }),
            isUUID
                ? sb.from('blips').select('id, user_id, video_url, thumbnail_url, created_at, users(username)').eq('id', query).maybeSingle()
                : Promise.resolve({ data: null }),
        ]);

        if (userRes.error) {
            box.className = 'empty';
            box.innerHTML = 'Search failed: ' + esc(userRes.error.message);
            return;
        }

        const filtered = userRes.data || [];
        const blipHit = blipRes.data;

        if (filtered.length === 0 && !blipHit) {
            box.className = 'empty';
            box.innerHTML = 'No users found matching your search' + (isUUID ? ' (and no blip with that ID)' : '');
            return;
        }

        // Get blip counts for each user — kept as the same parallel burst
        // as legacy (one count query per matched user).
        const usersWithBlipCounts = await Promise.all(
            filtered.map(async (user) => {
                const { count } = await sb
                    .from('blips')
                    .select('*', { count: 'exact', head: true })
                    .eq('user_id', user.id);
                return { ...user, blip_count: count || 0 };
            })
        );

        const blipSection = blipHit ? `
            <div class="card" style="margin-bottom:16px;">
                <div class="sect" style="margin-bottom:0;"><h4>Blip match</h4>
                    <div style="display:flex; gap:12px; align-items:center;">
                        ${blipHit.thumbnail_url
                            ? `<img class="thumb" style="width:56px; height:56px;" src="${esc(blipHit.thumbnail_url)}" onclick="ui.player('${jsEsc(blipHit.video_url)}')">`
                            : `<div class="thumb ph" style="width:56px; height:56px;" onclick="ui.player('${jsEsc(blipHit.video_url)}')">📹</div>`}
                        <div style="flex:1; min-width:0;">
                            <div style="color:var(--cream); font-weight:700;">By
                                <span class="userchip" style="display:inline;"><span class="nm" onclick="openUser('${jsEsc(blipHit.user_id)}')">@${esc(blipHit.users?.username || 'Unknown')}</span></span>
                            </div>
                            <div style="color:var(--muted); font-size:12px;">${esc(fmtDate(blipHit.created_at))} · <span style="font-family:monospace;">${esc(blipHit.id)}</span></div>
                        </div>
                        <button class="btn sm gold" onclick="b_openBlip('${jsEsc(blipHit.id)}')">Open</button>
                    </div>
                </div>
            </div>` : '';

        const usersSection = usersWithBlipCounts.length ? `
            <div class="tblwrap">
                <table class="tbl">
                    <thead><tr><th>User</th><th>Blips</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
                    <tbody>
                        ${usersWithBlipCounts.map(user => `
                            <tr>
                                <td>
                                    <span class="userchip">
                                        ${avatarHtml(user.avatar_url, user.username)}
                                        <span>
                                            <span class="nm" onclick="openUser('${jsEsc(user.id)}')">@${esc(user.username || '—')}</span>
                                            ${user.is_admin ? ' <span class="pill info">ADMIN</span>' : ''}
                                            <div class="sub">${esc(user.email || '')}</div>
                                        </span>
                                    </span>
                                </td>
                                <td><strong style="color:var(--gold-soft);">${user.blip_count}</strong> blip${user.blip_count !== 1 ? 's' : ''}</td>
                                <td>${user.deleted_at
                                    ? '<span class="pill muted">DELETED</span>'
                                    : (user.is_banned ? '<span class="pill danger">BANNED</span>' : '<span class="pill ok">ACTIVE</span>')}</td>
                                <td style="text-align:right;">
                                    <button class="btn sm" onclick="openUser('${jsEsc(user.id)}')">View profile &amp; blips</button>
                                </td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>` : '';

        box.className = '';
        box.innerHTML = `
            ${blipSection}
            <h3 style="margin-bottom:12px; color:var(--muted); font-size:13px;">Search results (${filtered.length} user${filtered.length !== 1 ? 's' : ''} found)</h3>
            ${usersSection || '<div class="empty">No users matched — but see the blip above.</div>'}`;
    }

    // ── Blip detail (ported from legacy openBlipDetail) ───────────────
    async function openBlipDetail(blipId) {
        // Fetch full blip details
        const { data: blip, error } = await sb
            .from('blips')
            .select('*, users(id, username, avatar_url)')
            .eq('id', blipId)
            .single();

        if (error || !blip) {
            ui.toast('Error loading blip: ' + (error?.message || 'Blip not found'), 'error', 5000);
            return;
        }

        const html = `
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
                ${avatarHtml(blip.users?.avatar_url, blip.users?.username, 44)}
                <div>
                    <span class="userchip"><span class="nm" onclick="openUser('${jsEsc(blip.user_id)}')">@${esc(blip.users?.username || 'Unknown')}</span></span>
                    <div style="color:var(--muted); font-size:12px; margin-top:2px;">Posted on ${esc(fmtDate(blip.created_at))}</div>
                </div>
            </div>

            <video controls style="width:100%; border-radius:10px; margin-bottom:16px; max-height:400px; background:var(--well);">
                <source src="${esc(blip.video_url)}" type="video/mp4">
                Your browser does not support the video tag.
            </video>

            <div class="sect">
                <h4>Details</h4>
                <div class="kv">
                    <div class="k">Title</div><div class="v">${esc(blip.title || 'No title')}</div>
                    <div class="k">Description</div><div class="v">${esc(blip.description || 'No description')}</div>
                    <div class="k">Location</div><div class="v">${blip.latitude && blip.longitude
                        ? `📍 ${blip.latitude.toFixed(6)}, ${blip.longitude.toFixed(6)} · <a href="https://www.google.com/maps?q=${blip.latitude},${blip.longitude}" target="_blank" rel="noopener" style="color:var(--info);">View on Google Maps</a>`
                        : 'No location data'}</div>
                    <div class="k">Views</div><div class="v">👁️ ${blip.views_count || 0} views</div>
                    <div class="k">Visibility</div><div class="v">${blip.is_public ? '🌍 Public' : '🔒 Private'}</div>
                    <div class="k">ID</div><div class="v" style="font-family:monospace; font-size:12px;">${esc(blip.id)}</div>
                    ${blip.soft_deleted_at ? `<div class="k">Soft-deleted</div><div class="v"><span class="pill muted">DELETED</span> ${esc(fmtDate(blip.soft_deleted_at))}</div>` : ''}
                </div>
            </div>

            <div class="actionrow" style="justify-content:flex-end;">
                <button class="btn" onclick="openUser('${jsEsc(blip.user_id)}')">View user profile</button>
                <button class="btn danger" onclick="b_deleteBlip('${jsEsc(blip.id)}', '@${jsEsc(blip.users?.username || 'Unknown')}')">Delete blip</button>
            </div>`;

        ui.drawer({ title: 'Blip detail', html });
    }
    window.b_openBlip = openBlipDetail;

    // ── Delete (ported from legacy deleteBlipFromDetail) ──────────────
    window.b_deleteBlip = async function (blipId, username) {
        const ok = await ui.confirm({
            title: `Delete blip by ${username}`,
            message: `This permanently removes the blip and all its likes, comments, views, recipients, and replies.\n\nBlip ID: ${blipId}\n\nThis CANNOT be undone.`,
            dangerLevel: 'destructive',
            confirmLabel: 'Delete blip',
        });
        if (!ok) return;

        // Use the admin_delete_blip SECURITY DEFINER RPC instead of a
        // direct .delete(). The RPC verifies the caller is an admin
        // server-side, cleans up dependent rows (likes, comments, views,
        // recipients, replies) in the right order, and won't be blocked
        // by RLS the way a raw delete can be.
        const { error } = await sb
            .rpc('admin_delete_blip', { p_blip_id: blipId });

        if (error) {
            ui.toast('Delete failed: ' + error.message, 'error');
            return;
        }

        await logAdminAction('delete_blip', null, { blip_id: blipId }, `Deleted blip by ${username}`);
        ui.toast('Blip deleted', 'success');
        ui.closeDrawer();
        cache.bust('users');
    };
})();
