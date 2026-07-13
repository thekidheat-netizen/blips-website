// Users — list (keyset-paginated via admin_list_users), server-side search
// (admin_search_users — the legacy per-tab search only filtered loaded rows),
// and the full user drawer with every moderation action ported from legacy.
// All Supabase calls are byte-for-byte from admin-legacy.html; the users
// table has PII columns REVOKE'd, which is why the RPCs exist — never swap
// an RPC for a direct select.
(function () {
    'use strict';

    const PAGE_SIZE = 100;
    const state = {
        rows: [],          // paginated rows (admin_list_users)
        searchRows: [],    // server-side search results (admin_search_users)
        cursor: null,      // keyset cursor: created_at of the last row
        exhausted: false,
        loading: false,
        filter: 'all',     // all | banned | verified | deleted
        search: '',
    };

    // ── Route ─────────────────────────────────────────────────────────
    registerRoute('users', {
        title: 'Users', icon: '👤', order: 1,
        async render(el, params) {
            el.innerHTML = `
                <h2 class="page">Users</h2>
                <p class="pagesub">Search runs server-side across all users. Click a username to open the full profile drawer.</p>
                <div class="toolbar">
                    <input type="search" id="uSearch" placeholder="Search username, email, old username, or ID…"
                           style="flex:1; min-width:260px;" oninput="u_searchDebounced()">
                    <select id="uFilter" onchange="u_setFilter(this.value)">
                        <option value="all">All users</option>
                        <option value="banned">Banned</option>
                        <option value="verified">Verified</option>
                        <option value="deleted">Deleted</option>
                    </select>
                </div>
                <div id="uTable" class="spin">Loading…</div>`;
            document.getElementById('uFilter').value = state.filter;
            if (state.search) document.getElementById('uSearch').value = state.search;
            if (state.search) await runSearch();
            else await loadUsers(true);
            if (params && params[0]) openUserDrawer(params[0]);
        },
    });

    // ── List loading (ported from legacy loadUsers — keyset pagination) ──
    async function loadUsers(reset = true) {
        const box = document.getElementById('uTable');
        if (!box) return;
        if (state.loading) return;
        state.loading = true;

        if (reset) {
            state.cursor = null;
            state.exhausted = false;
            state.rows = [];
            box.className = 'spin';
            box.innerHTML = 'Loading…';
        }

        // Use the admin_list_users RPC instead of a direct select('*').
        // The PII column revokes (phone/push_token/location) make a
        // select('*') fail for the authenticated admin role; this
        // SECURITY DEFINER RPC (is_admin gated) returns the full row
        // incl the PII the dashboard needs. p_before is the created_at
        // cursor for keyset pagination.
        let users, error;
        try {
            const loader = async () => {
                const r = await sb.rpc('admin_list_users', {
                    p_limit: PAGE_SIZE,
                    p_before: state.cursor,
                });
                if (r.error) throw r.error;
                return r.data || [];
            };
            // Only the first page goes through the cache (later pages depend
            // on the moving cursor). Any action calls cache.bust('users').
            users = state.cursor === null
                ? await cache.get('users:firstpage', loader, 30000)
                : await loader();
        } catch (e) {
            error = e;
        }
        state.loading = false;

        if (error) {
            console.error('Error loading users:', error);
            ui.toast('Failed to load users: ' + error.message, 'error');
            return;
        }

        state.rows = state.rows.concat(users || []);
        if (!users || users.length < PAGE_SIZE) {
            state.exhausted = true;
        } else {
            state.cursor = users[users.length - 1].created_at;
        }

        displayUsers();
    }

    window.u_loadMore = async function () {
        await loadUsers(false);
    };

    // ── Server-side search (ported from legacy globalSearch's RPC use;
    //    replaces the legacy per-tab search that only filtered loaded rows).
    //    The RPC matches username / email / deleted_username / id. ──
    let searchTimer = null;
    window.u_searchDebounced = function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(runSearch, 300);
    };

    async function runSearch() {
        const box = document.getElementById('uTable');
        if (!box) return;
        state.search = (document.getElementById('uSearch')?.value || '').trim();
        if (!state.search) {
            state.searchRows = [];
            if (state.rows.length) displayUsers();
            else await loadUsers(true);
            return;
        }
        box.className = 'spin';
        box.innerHTML = 'Searching…';
        const { data, error } = await sb.rpc('admin_search_users', { p_query: state.search });
        if (error) {
            box.className = 'empty';
            box.innerHTML = 'Search failed: ' + esc(error.message);
            return;
        }
        state.searchRows = data || [];
        displayUsers();
    }

    window.u_setFilter = function (filter) {
        state.filter = filter;
        displayUsers();
    };

    // Ported from legacy applyUserFilter. "Banned only" = banned but NOT
    // soft-deleted, since soft-deletes also flip is_banned on — keeps the
    // two workflows separate. (Legacy 'active' option replaced by 'verified'.)
    function applyUserFilter(users) {
        switch (state.filter) {
            case 'banned':
                return users.filter(u => u.is_banned && !u.deleted_at);
            case 'verified':
                return users.filter(u => u.is_verified && !u.deleted_at);
            case 'deleted':
                return users.filter(u => !!u.deleted_at);
            case 'all':
            default:
                return users;
        }
    }

    function statusPills(u) {
        const pills = [];
        if (u.deleted_at) pills.push(`<span class="pill muted" title="Soft-deleted ${esc(fmtDate(u.deleted_at))}">DELETED</span>`);
        if (u.is_banned) pills.push('<span class="pill danger">BANNED</span>');
        if (u.is_verified) pills.push('<span class="pill gold">VERIFIED</span>');
        if (u.is_admin) pills.push('<span class="pill info">ADMIN</span>');
        if (!pills.length) pills.push('<span class="pill ok">ACTIVE</span>');
        return pills.join(' ');
    }

    function displayUsers() {
        const box = document.getElementById('uTable');
        if (!box) return;
        const source = state.search ? state.searchRows : state.rows;
        const users = applyUserFilter(source);

        if (!users || users.length === 0) {
            box.className = 'empty';
            box.innerHTML = 'No users found';
            return;
        }

        box.className = '';
        const rowsHtml = users.map(u => `
            <tr${u.deleted_at ? ' style="opacity:0.7;"' : ''}>
                <td>
                    <span class="userchip">
                        ${avatarHtml(u.avatar_url, u.username)}
                        <span>
                            <span class="nm" onclick="openUser('${jsEsc(u.id)}')">@${esc(u.username || '—')}</span>
                            ${u.deleted_at && u.deleted_username ? `<div class="sub">was @${esc(u.deleted_username)}</div>` : ''}
                        </span>
                    </span>
                </td>
                <td>${esc(u.display_name || '—')}</td>
                <td title="${esc(fmtDate(u.created_at))}">${timeAgo(u.created_at)}</td>
                <td>${u.blip_count ?? u.blips_count ?? '—'}</td>
                <td>${statusPills(u)}</td>
                <td style="text-align:right;">
                    <button class="btn sm" onclick="openUser('${jsEsc(u.id)}')">View</button>
                </td>
            </tr>`).join('');

        // "Load more" only when no search/filter is narrowing the view
        // (same rule as legacy — load-more is confusing mid-search).
        const showLoadMore = !state.exhausted && !state.search && state.filter === 'all';
        const footer = showLoadMore
            ? `<div style="text-align:center; margin-top:16px;">
                   <button class="btn" onclick="u_loadMore()">Load more (${state.rows.length} loaded)</button>
               </div>`
            : (!state.search && state.exhausted
                ? `<div style="text-align:center; margin-top:12px; color:var(--muted); font-size:12px;">${state.rows.length} users loaded · end of list</div>`
                : '');

        box.innerHTML = `
            <div class="tblwrap">
                <table class="tbl">
                    <thead><tr><th>User</th><th>Display name</th><th>Joined</th><th>Blips</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>${footer}`;
    }

    // ── Shared post-action refresh: drawer in place + bust cache; the list
    //    only reloads when it is actually visible. NO location.reload. ──
    function refreshAfterAction(userId, { reopenDrawer = true } = {}) {
        cache.bust('users');
        if (!reopenDrawer) ui.closeDrawer();
        else if (userId && document.getElementById('drawerBody')) openUserDrawer(userId);
        if (document.getElementById('uTable')) {
            if (state.search) runSearch();
            else loadUsers(true);
        }
    }

    // ── Action-history labels (ported verbatim) ───────────────────────
    function formatActionType(actionType) {
        const types = {
            'ban': '🚫 User Banned',
            'unban': '✅ User Unbanned',
            'delete_user': '🗑️ User Deleted',
            'delete_blip': '🗑️ Blip Deleted',
            'delete_video_reply': '🗑️ Video Reply Deleted',
            'delete_all_blips': '🗑️ All Blips Deleted',
            'username_change': '✏️ Username Changed',
            'display_name_change': '✏️ Display Name Changed',
            'email_change': '✉️ Email Changed',
            'password_reset': '🔑 Password Reset',
            'edit_user': '✏️ User Edited',
            'verification_approved': '✓ Verification Approved',
            'verification_rejected': '✗ Verification Rejected',
            'verification_removed': '✗ Verification Removed',
            'restore_user': '♻️ User Restored',
            'purge_user': '🔥 User Permanently Purged',
            'soft_delete_announcement': '🗑️ Announcement Removed',
            'warn_user': '⚠️ Warning Issued',
            'admin_delete_comment': '🗑️ Comment Deleted',
            'remove_warning': '↩️ Warning Removed',
        };
        return types[actionType] || actionType;
    }

    // ── User drawer (ported from legacy openUserDetail; the parallel
    //    Promise.all burst is kept intact) ──────────────────────────────
    async function openUserDrawer(userId) {
        ui.drawer({ title: 'Loading…', html: '<div class="spin">Loading user…</div>', wide: true });

        // Get user data via the admin_get_user RPC. A direct select('*')
        // fails for the authenticated admin role (PII columns
        // phone/push_token/location are REVOKE'd); this SECURITY DEFINER
        // RPC (is_admin gated) returns the full row. RPC returns SETOF →
        // an array, so take [0].
        const { data: userRows } = await sb.rpc('admin_get_user', {
            p_user_id: userId,
        });
        const user = Array.isArray(userRows) ? userRows[0] : userRows;

        if (!user) {
            ui.drawer({ title: 'User not found', html: '<div class="empty">Could not load this user.</div>', wide: true });
            return;
        }

        // Everything below is independent of everything else (only
        // videoRepliesReceived needs the blip IDs) — one parallel burst,
        // exactly as legacy did.
        const [
            { count: followersCount },
            { count: followingCount },
            { data: userBlips },
            { data: videoReplies },
            { data: adminLogs },
            { count: warningCount },
            { data: userWarnings },
            authMeta,
            emailMap,
        ] = await Promise.all([
            sb.from('followers').select('*', { count: 'exact', head: true }).eq('following_id', userId),
            sb.from('followers').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
            // Admin session is exempt from hide-soft-deleted RLS, so this
            // includes soft-deleted blips — split into live/deleted below.
            sb.from('blips').select('*').eq('user_id', userId)
                .order('created_at', { ascending: false }).limit(500),
            sb.from('video_replies').select(`
                    *,
                    replier:users!video_replies_replied_by_fkey(id, username, avatar_url),
                    original_blip:blips!video_replies_blip_id_fkey(id, thumbnail_url, user_id, users(username))
                `).eq('replied_by', userId).order('created_at', { ascending: false }),
            sb.from('admin_logs').select('*, admin:users!admin_logs_admin_id_fkey(username)')
                .eq('target_user_id', userId).order('created_at', { ascending: false }).limit(20),
            sb.from('user_warnings').select('id', { count: 'exact', head: true }).eq('user_id', userId),
            sb.from('user_warnings').select('id, category, title, reason, created_at, expires_at')
                .eq('user_id', userId).order('created_at', { ascending: false }).limit(20),
            // Auth metadata via admin-only RPC (migration 20260516000014).
            // Falls back to null silently if the RPC isn't available yet.
            sb.rpc('admin_get_user_auth_meta', { p_user_id: userId })
                .then(({ data }) => data || null)
                .catch((e) => { console.warn('admin_get_user_auth_meta unavailable:', e); return null; }),
            // Email fallback (email column is REVOKE'd from authenticated).
            fetchEmailMap([userId]),
        ]);

        const liveBlips = (userBlips || []).filter(b => !b.soft_deleted_at);
        const deletedBlips = (userBlips || []).filter(b => b.soft_deleted_at);

        // Video replies received (replies to their blips) — needs the
        // blip IDs from above, so it stays a second phase.
        const userBlipIds = userBlips?.map(b => b.id) || [];
        const { data: videoRepliesReceived } = userBlipIds.length > 0
            ? await sb
                .from('video_replies')
                .select(`
                    *,
                    replier:users!video_replies_replied_by_fkey(id, username, avatar_url),
                    original_blip:blips!video_replies_blip_id_fkey(id, thumbnail_url, user_id, users(username))
                `)
                .in('blip_id', userBlipIds)
                .order('created_at', { ascending: false })
            : { data: [] };

        const email = user.email || emailMap[userId] || null;
        const uname = user.username || '—';
        const jsU = jsEsc(user.username || '');
        const jsId = jsEsc(userId);

        // ── Sections ──
        const identity = `
            <div style="display:flex; gap:16px; align-items:center; margin-bottom:18px;">
                ${avatarHtml(user.avatar_url, user.username, 64)}
                <div style="min-width:0;">
                    <div style="font-size:19px; font-weight:900; color:var(--cream);">${esc(user.display_name || user.username || '—')}</div>
                    <div style="color:var(--muted);">@${esc(uname)}${user.deleted_at && user.deleted_username ? ` · was @${esc(user.deleted_username)}` : ''}</div>
                    ${user.bio ? `<div style="color:var(--text); font-size:13px; margin-top:4px;">${esc(user.bio)}</div>` : ''}
                    <div style="margin-top:8px;">${statusPills(user)}</div>
                </div>
            </div>
            ${user.deleted_at ? `
                <div style="margin-bottom:16px; padding:10px 14px; border-radius:8px; background:rgba(158,158,158,0.12); border:1px solid rgba(158,158,158,0.35); color:var(--text); font-size:13px;">
                    <strong>🗑️ Soft-deleted account</strong> — deleted ${esc(fmtDate(user.deleted_at))}.
                    Content stays in the DB for moderation but is hidden from the app.
                </div>` : ''}`;

        const account = `
            <div class="sect">
                <h4>Account</h4>
                <div class="kv">
                    <div class="k">ID</div><div class="v" style="font-family:monospace; font-size:12px;">${esc(userId)}</div>
                    <div class="k">Email</div><div class="v">${esc(email || 'no email')}
                        ${authMeta?.email_confirmed_at ? '<span class="pill ok" style="margin-left:6px;">confirmed</span>' : '<span class="pill warn" style="margin-left:6px;">unconfirmed</span>'}</div>
                    <div class="k">Phone</div><div class="v">${user.phone_number
                        ? `${esc(user.phone_number)} ${user.phone_verified ? '<span class="pill ok">verified</span>' : '<span class="pill warn">not verified</span>'}`
                        : '—'}</div>
                    <div class="k">Provider</div><div class="v">${esc(authMeta?.provider || 'email')}</div>
                    <div class="k">Last sign-in</div><div class="v" title="${esc(fmtDate(authMeta?.last_sign_in_at))}">${timeAgo(authMeta?.last_sign_in_at)}</div>
                    <div class="k">Last seen</div><div class="v" title="${esc(fmtDate(user.last_location_update))}">${timeAgo(user.last_location_update)}</div>
                    <div class="k">Joined</div><div class="v">${esc(fmtDate(user.created_at))} (${timeAgo(user.created_at)})</div>
                    <div class="k">Followers</div><div class="v">${followersCount || 0} followers · ${followingCount || 0} following</div>
                    <div class="k">Blips</div><div class="v">${liveBlips.length} live · ${deletedBlips.length} recently deleted</div>
                    ${user.last_known_lat && user.last_known_lon ? `
                    <div class="k">Location</div><div class="v"><a href="https://www.google.com/maps?q=${user.last_known_lat},${user.last_known_lon}" target="_blank" rel="noopener" style="color:var(--info);">📍 ${user.last_known_lat.toFixed(4)}, ${user.last_known_lon.toFixed(4)}</a></div>` : ''}
                </div>
            </div>`;

        const warnOptions = WARNING_TEMPLATES.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('');
        const warnings = `
            <div class="sect">
                <h4>⚠️ Warnings (${warningCount || 0})
                    ${!user.deleted_at ? `<button class="btn sm warn" style="margin-left:10px;" onclick="u_warnToggle()">Warn user</button>` : ''}</h4>
                <div id="uWarnBox" style="display:none; background:var(--well); border:1px solid var(--border-strong); border-radius:10px; padding:14px; margin-bottom:12px;">
                    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
                        <select id="uWarnTpl" onchange="u_warnPreview()" style="flex:1; min-width:180px; padding:9px; background:var(--panel); border:1px solid var(--border-strong); border-radius:8px; color:var(--cream); font-family:inherit;">${warnOptions}</select>
                    </div>
                    <textarea id="uWarnReason" rows="2" placeholder="Reason (fills {reason} in the template)" oninput="u_warnPreview()"
                        style="width:100%; padding:9px; background:var(--panel); border:1px solid var(--border-strong); border-radius:8px; color:var(--cream); font-family:inherit; resize:vertical;"></textarea>
                    <div style="margin:10px 0; padding:10px; border:1px dashed var(--border-strong); border-radius:8px;">
                        <div id="uWarnPrevTitle" style="color:var(--gold-soft); font-weight:900; font-size:13px;"></div>
                        <div id="uWarnPrevBody" style="color:var(--text); font-size:12.5px; margin-top:4px;"></div>
                    </div>
                    <div class="actionrow" style="justify-content:flex-end;">
                        <button class="btn sm" onclick="u_warnToggle()">Cancel</button>
                        <button class="btn sm warn" onclick="u_warnSubmit('${jsId}')">Send warning</button>
                    </div>
                </div>
                ${userWarnings && userWarnings.length > 0 ? userWarnings.map(w => {
                    const showing = new Date(w.expires_at).getTime() > Date.now();
                    return `
                    <div style="border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin-bottom:8px;">
                        <div style="display:flex; gap:10px; align-items:center;">
                            <span style="color:var(--cream); font-weight:700; flex:1;">${esc(w.title)}
                                ${showing ? '<span class="pill warn" title="Currently shown in their notifications">SHOWING</span>' : ''}</span>
                            <span style="color:var(--muted); font-size:12px;">${esc(fmtDate(w.created_at))}</span>
                        </div>
                        ${w.reason ? `<div style="color:var(--text); font-size:12.5px; margin-top:4px;">Reason: ${esc(w.reason)}</div>` : ''}
                        <button class="btn sm" style="margin-top:8px;" onclick="u_removeWarning('${jsEsc(w.id)}', '${jsId}')">↩️ Remove warning</button>
                    </div>`;
                }).join('') : '<div style="color:var(--muted); font-size:13px;">No warnings issued</div>'}
            </div>`;

        const actions = `
            <div class="sect">
                <h4>Moderation</h4>
                <div class="actionrow">
                    ${user.deleted_at ? `
                        <button class="btn ok" onclick="u_restore('${jsId}', '${jsEsc(user.deleted_username || user.username)}')">♻️ Restore account</button>
                        <button class="btn danger" onclick="u_purge('${jsId}', '${jsEsc(user.deleted_username || user.username)}')" title="Permanently destroy all of this user's data (CSAM / GDPR only)">🔥 Purge forever</button>
                    ` : `
                        ${!user.is_banned
                            ? `<button class="btn warn" onclick="u_ban('${jsId}', '${jsU}')">Ban</button>`
                            : `<button class="btn ok" onclick="u_unban('${jsId}', '${jsU}')">Unban</button>`}
                        <button class="btn warn" onclick="u_warnToggle()">⚠️ Warn</button>
                        ${!user.is_verified
                            ? `<button class="btn gold" onclick="u_verify('${jsId}', '${jsU}')">✓ Verify</button>`
                            : `<button class="btn" onclick="u_unverify('${jsId}', '${jsU}')">Remove verification</button>`}
                        <button class="btn" onclick="u_changeUsername('${jsId}', '${jsU}')">Change username</button>
                        <button class="btn" onclick="u_changeDisplayName('${jsId}', '${jsEsc(user.display_name || '')}')">Change display name</button>
                        <button class="btn" onclick="u_changeEmail('${jsId}', '${jsEsc(email || '')}', '${jsU}')">Change email</button>
                        <button class="btn" onclick="u_resetPassword('${jsId}', '${jsU}', '${jsEsc(email || '')}')">Reset password</button>
                        ${user.phone_number ? `<button class="btn warn" onclick="u_clearPhone('${jsId}', '${jsU}')">Remove phone</button>` : ''}
                        <button class="btn warn" onclick="u_deleteAllBlips('${jsId}', '${jsU}')">Delete all blips</button>
                        <button class="btn danger" onclick="u_softDelete('${jsId}', '${jsU}')">Soft delete account</button>
                    `}
                </div>
            </div>`;

        const blipsGrid = `
            <div class="sect">
                <h4>Live blips (${liveBlips.length})</h4>
                ${liveBlips.length > 0 ? `
                    <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(110px, 1fr)); gap:12px;">
                        ${liveBlips.map(blip => `
                            <div>
                                ${blip.thumbnail_url
                                    ? `<img class="thumb" style="width:100%; height:110px;" src="${esc(blip.thumbnail_url)}" onclick="ui.player('${jsEsc(blip.video_url)}')" title="${esc(blip.title || blip.description || '')}">`
                                    : `<div class="thumb ph" style="width:100%; height:110px;" onclick="ui.player('${jsEsc(blip.video_url)}')">📹</div>`}
                                <div style="display:flex; align-items:center; gap:6px; margin-top:4px; font-size:11.5px; color:var(--muted);">
                                    <span style="flex:1;" title="${esc(fmtDate(blip.created_at))} · 👁 ${blip.views_count || 0} views · ID ${esc(blip.id)}">👁 ${blip.views_count || 0} · ${timeAgo(blip.created_at)}</span>
                                    <button class="btn sm danger" onclick="u_deleteBlip('${jsEsc(blip.id)}', '@${jsU}', '${jsId}')">✕</button>
                                </div>
                                ${blip.visibility && blip.visibility !== 'public' ? `<span class="pill info">${esc(blip.visibility.toUpperCase())}</span>` : ''}
                                ${blip.is_scheduled ? '<span class="pill warn" title="Scheduled blip">⏰</span>' : ''}
                                ${blip.is_personalized ? '<span class="pill gold" title="Personalized / direct">🎯</span>' : ''}
                            </div>`).join('')}
                    </div>` : '<div style="color:var(--muted); font-size:13px;">No blips yet</div>'}
            </div>`;

        const deletedSection = `
            <div class="sect">
                <h4>🗑️ Recently deleted (${deletedBlips.length})</h4>
                ${deletedBlips.length > 0 ? deletedBlips.map(blip => `
                    <div style="display:flex; gap:12px; align-items:center; border:1px solid var(--border); border-radius:10px; padding:10px; margin-bottom:8px;">
                        ${blip.thumbnail_url
                            ? `<img class="thumb" style="width:56px; height:56px; filter:grayscale(0.4);" src="${esc(blip.thumbnail_url)}" onclick="ui.player('${jsEsc(blip.video_url)}')">`
                            : `<div class="thumb ph" style="width:56px; height:56px;" onclick="ui.player('${jsEsc(blip.video_url)}')">📹</div>`}
                        <div style="flex:1; min-width:0; font-size:12.5px; color:var(--text);">
                            ${(blip.title || blip.description) ? `<div style="color:var(--cream); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(blip.title || blip.description)}</div>` : ''}
                            <div>Deleted ${timeAgo(blip.soft_deleted_at)} · <span class="pill ${new Date(blip.purge_after || blip.delete_at) - Date.now() < 86400000 ? 'danger' : 'muted'}">purges ${esc(formatUntil(blip.purge_after || blip.delete_at))}</span></div>
                        </div>
                        <div style="white-space:nowrap;">
                            <button class="btn sm ok" onclick="u_restoreBlip('${jsEsc(blip.id)}', '${jsId}')">Restore</button>
                            <button class="btn sm danger" onclick="u_purgeBlip('${jsEsc(blip.id)}', '${jsId}')">Purge</button>
                        </div>
                    </div>`).join('') : '<div style="color:var(--muted); font-size:13px;">Nothing recently deleted</div>'}
            </div>`;

        const replyRow = (reply, dir) => `
            <div style="display:flex; gap:12px; align-items:center; border:1px solid var(--border); border-radius:10px; padding:10px; margin-bottom:8px;">
                ${reply.thumbnail_url
                    ? `<img class="thumb" style="width:56px; height:56px;" src="${esc(reply.thumbnail_url)}" onclick="ui.player('${jsEsc(reply.video_url)}')">`
                    : `<div class="thumb ph" style="width:56px; height:56px;" onclick="ui.player('${jsEsc(reply.video_url)}')">📹</div>`}
                <div style="flex:1; min-width:0; font-size:12.5px; color:var(--text);">
                    <div>${dir === 'sent' ? 'Sent' : 'From'}
                        <span class="userchip" style="display:inline;"><span class="nm" onclick="openUser('${jsEsc(reply.replier?.id || '')}')">@${esc(reply.replier?.username || 'Unknown')}</span></span>
                        · reply to blip by
                        <span class="userchip" style="display:inline;"><span class="nm" onclick="openUser('${jsEsc(reply.original_blip?.user_id || '')}')">@${esc(reply.original_blip?.users?.username || 'Unknown')}</span></span>
                    </div>
                    <div style="color:var(--muted);" title="Reply ID ${esc(reply.id)}">${esc(fmtDate(reply.created_at))}</div>
                </div>
                <button class="btn sm danger" onclick="u_deleteReply('${jsEsc(reply.id)}', '@${jsEsc(reply.replier?.username || 'Unknown')}', '${jsId}')">Delete</button>
            </div>`;

        const repliesSent = `
            <div class="sect">
                <h4>Video replies sent (${videoReplies?.length || 0})</h4>
                ${videoReplies && videoReplies.length > 0
                    ? videoReplies.map(r => replyRow(r, 'sent')).join('')
                    : '<div style="color:var(--muted); font-size:13px;">No video replies sent</div>'}
            </div>`;

        const repliesReceived = `
            <div class="sect">
                <h4>Video replies received (${videoRepliesReceived?.length || 0})</h4>
                ${videoRepliesReceived && videoRepliesReceived.length > 0
                    ? videoRepliesReceived.map(r => replyRow(r, 'received')).join('')
                    : '<div style="color:var(--muted); font-size:13px;">No video replies received</div>'}
            </div>`;

        const history = `
            <div class="sect">
                <h4>Admin action history</h4>
                ${adminLogs && adminLogs.length > 0 ? adminLogs.map(log => `
                    <div style="border-left:2px solid var(--border-strong); padding:6px 0 6px 12px; margin-left:4px;">
                        <div style="display:flex; gap:10px;">
                            <span style="color:var(--cream); font-weight:700; flex:1;">${formatActionType(esc(log.action_type))}</span>
                            <span style="color:var(--muted); font-size:12px;">${esc(fmtDate(log.created_at))}</span>
                        </div>
                        <div style="color:var(--text); font-size:12.5px;">
                            By @${esc(log.admin?.username || 'Unknown Admin')}
                            ${log.notes ? `<br>Notes: ${esc(log.notes)}` : ''}
                            ${log.action_details ? `<br>Details: ${esc(JSON.stringify(log.action_details))}` : ''}
                        </div>
                    </div>`).join('') : '<div style="color:var(--muted); font-size:13px;">No admin actions recorded</div>'}
            </div>`;

        ui.drawer({
            title: '@' + esc(uname),
            wide: true,
            html: identity + account + warnings + actions + blipsGrid + deletedSection + repliesSent + repliesReceived + history,
        });
    }

    // ── Warn flow (templates ported verbatim from legacy) ─────────────
    // Templates the user sees; {reason} is filled with the admin's input.
    // The "repeated warnings → review/ban" escalation line is added by the
    // app's notification banner (with the live count), so it's not repeated
    // in every template body.
    const WARNING_TEMPLATES = [
        { key: 'comment_removed', label: 'Comment removed', title: 'Your comment was removed',
          body: 'Your comment was removed because: {reason}. Please remember to be thoughtful and respectful — Blips is a community for everyone.' },
        { key: 'harassment', label: 'Bullying / harassment', title: 'Warning: harassment',
          body: 'We received a report of bullying or harassment: {reason}. This is not allowed on Blips. Please treat others with respect.' },
        { key: 'nudity', label: 'Nudity / graphic content', title: 'Warning: inappropriate content',
          body: 'Content you posted was removed for nudity or graphic material: {reason}. Please keep Blips appropriate for everyone.' },
        { key: 'spam', label: 'Spam', title: 'Warning: spam',
          body: 'Your activity was flagged as spam: {reason}. Please do not post repetitive or misleading content.' },
        { key: 'general', label: 'General conduct', title: 'Community guidelines warning',
          body: 'An admin has issued a warning about your activity: {reason}. Please review our community guidelines and be respectful.' },
    ];

    function renderWarnBody(tpl, reason) {
        const r = (reason || '').trim() || '(no reason provided)';
        return tpl.body.replace('{reason}', r);
    }

    window.u_warnToggle = function () {
        const box = document.getElementById('uWarnBox');
        if (!box) return;
        const opening = box.style.display === 'none';
        box.style.display = opening ? 'block' : 'none';
        if (opening) {
            const sel = document.getElementById('uWarnTpl');
            if (sel) sel.value = '0';
            const reason = document.getElementById('uWarnReason');
            if (reason) reason.value = '';
            window.u_warnPreview();
            box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    };

    window.u_warnPreview = function () {
        const idx = parseInt(document.getElementById('uWarnTpl')?.value || '0', 10);
        const tpl = WARNING_TEMPLATES[idx] || WARNING_TEMPLATES[0];
        const t = document.getElementById('uWarnPrevTitle');
        const b = document.getElementById('uWarnPrevBody');
        if (t) t.textContent = tpl.title;
        if (b) b.textContent = renderWarnBody(tpl, document.getElementById('uWarnReason')?.value);
    };

    window.u_warnSubmit = async function (userId) {
        const idx = parseInt(document.getElementById('uWarnTpl')?.value || '0', 10);
        const tpl = WARNING_TEMPLATES[idx] || WARNING_TEMPLATES[0];
        const reason = (document.getElementById('uWarnReason')?.value || '').trim();
        const body = renderWarnBody(tpl, reason);

        const { data, error } = await sb.rpc('admin_warn_user', {
            p_user_id: userId,
            p_category: tpl.key,
            p_title: tpl.title,
            p_body: body,
            p_reason: reason || null,
        });
        if (error) {
            ui.toast('Warning failed: ' + error.message, 'error', 6000);
            return;
        }
        // Log to admin_logs so it shows in this user's Admin Action History.
        await logAdminAction('warn_user', userId, { category: tpl.key, reason: reason || null }, body);
        const count = data && data.warning_count;
        ui.toast(`Warning sent${count ? ` (warning #${count})` : ''}`, 'success');
        refreshAfterAction(userId);
    };

    window.u_removeWarning = async function (warningId, userId) {
        const ok = await ui.confirm({
            title: 'Remove warning',
            message: 'This deletes the warning from the user\'s record and removes it from their notifications. Use this if the warning was given in error.',
            confirmLabel: 'Remove warning',
        });
        if (!ok) return;
        const { error } = await sb.rpc('admin_remove_warning', { p_warning_id: warningId });
        if (error) {
            ui.toast('Remove failed: ' + error.message, 'error');
            return;
        }
        await logAdminAction('remove_warning', userId, { warning_id: warningId }, 'Removed a warning (issued in error)');
        ui.toast('Warning removed', 'success');
        refreshAfterAction(userId);
    };

    // ── Ban / unban (RPC writes admin_logs atomically; refuses to ban
    //    another admin — all server-side) ───────────────────────────────
    window.u_ban = async function (userId, username) {
        const reason = await ui.prompt({
            title: `Ban @${username}`,
            message: 'Why are you banning this user?\n\nThis reason will be visible to them when they try to sign in.',
            placeholder: 'e.g. Repeated harassment after warning',
            multiline: true,
        });
        if (!reason) return;

        const { error } = await sb.rpc('admin_ban_user', {
            p_user_id: userId,
            p_reason: reason,
        });

        if (error) {
            ui.toast('Ban failed: ' + error.message, 'error');
            return;
        }

        ui.toast(`@${username} banned`, 'success');
        refreshAfterAction(userId);
    };

    window.u_unban = async function (userId, username) {
        const notes = await ui.prompt({
            title: `Unban @${username}`,
            message: 'Reason for lifting the ban (kept in audit log):',
            placeholder: 'e.g. False positive — appeal granted',
            multiline: true,
        });
        if (!notes) return;

        const { error } = await sb.rpc('admin_unban_user', {
            p_user_id: userId,
            p_notes: notes,
        });

        if (error) {
            ui.toast('Unban failed: ' + error.message, 'error');
            return;
        }

        ui.toast(`@${username} unbanned`, 'success');
        refreshAfterAction(userId);
    };

    // ── Clear phone: clears public.users + auth phone + phone identity so
    //    the number is freed for another account (admin_clear_user_phone) ──
    window.u_clearPhone = async function (userId, username) {
        const ok = await ui.confirm({
            title: `Remove phone from @${username}`,
            message: `This unlinks the phone number from this account — clears it from the profile AND removes phone login — so the number is freed up to be added to a different account.

Their email / Apple login is untouched, and you can always re-add a number later.`,
            confirmLabel: 'Remove phone',
        });
        if (!ok) return;

        const { error } = await sb.rpc('admin_clear_user_phone', { p_user_id: userId });
        if (error) {
            ui.toast('Remove phone failed: ' + error.message, 'error');
            return;
        }
        ui.toast(`Phone removed from @${username}`, 'success');
        refreshAfterAction(userId);
    };

    // ── Soft delete / restore / purge ─────────────────────────────────
    window.u_softDelete = async function (userId, username) {
        const ok = await ui.confirm({
            title: `Delete @${username}`,
            message: `Soft-delete this account.

Their content stays in the DB for moderation review, but they cannot sign back in and the app hides them everywhere. You can restore them later from the "Deleted" filter on the Users tab.

For a permanent purge (CSAM / GDPR), soft-delete first then use the Purge button on their profile.`,
            dangerLevel: 'destructive',
            confirmLabel: 'Soft-delete account',
        });
        if (!ok) return;

        const notes = await ui.prompt({
            title: 'Reason for deletion (audit log)',
            placeholder: 'e.g. Repeated TOS violations after warning',
            multiline: true,
        });
        if (!notes) return;

        // Use delete_user_completely RPC (soft-delete since migration 20260422000001)
        const { data, error } = await sb
            .rpc('delete_user_completely', { user_id_to_delete: userId });

        if (error) {
            ui.toast('Delete failed: ' + error.message, 'error');
            return;
        }
        if (!data) {
            ui.toast('Failed to delete user — check database logs', 'error');
            return;
        }

        await logAdminAction('delete_user', userId, null, notes);
        ui.toast(`@${username} soft-deleted. Restore via Users → Deleted filter.`, 'success', 5000);
        refreshAfterAction(userId);
    };

    // Restore a soft-deleted account via admin_restore_user RPC.
    // The RPC handles the username-collision case server-side and returns
    // {restored_username, collision} so we can show the right message.
    window.u_restore = async function (userId, originalUsername) {
        const ok = await ui.confirm({
            title: `Restore @${originalUsername}`,
            message: `This will:
• Clear the deleted_at flag
• Lift the ban
• Try to put their original username back (if it's not been claimed)

The user will be able to sign in again.`,
            confirmLabel: 'Restore account',
        });
        if (!ok) return;

        const notes = await ui.prompt({
            title: 'Reason for restoration',
            message: 'Why are you restoring this account? (audit log)',
            placeholder: 'e.g. User contacted support — accidental deletion',
            multiline: true,
        });
        if (!notes) return;

        const { data, error } = await sb.rpc('admin_restore_user', {
            p_user_id: userId,
            p_notes: notes,
        });

        if (error) {
            ui.toast('Restore failed: ' + error.message, 'error');
            return;
        }

        const result = data || {};
        if (result.collision) {
            ui.toast(`Account restored. Username @${originalUsername} was taken — kept the anonymized name; rename them manually if needed.`, 'info', 6000);
        } else {
            ui.toast(`@${result.restored_username || originalUsername} restored.`, 'success');
        }
        refreshAfterAction(userId);
    };

    // Permanently destroy a soft-deleted user (CSAM, GDPR right-to-be-forgotten).
    // Two-step gate: must be soft-deleted first (RPC enforces this server-side),
    // and the admin has to type the username to confirm — protects vs misclick.
    window.u_purge = async function (userId, username) {
        const ok = await ui.confirm({
            title: `⚠️ Permanently destroy @${username}`,
            message: `This will HARD DELETE the user and ALL their data:
• Blips, comments, likes, views
• Video replies (sent + received)
• Messages, conversations
• Followers, friend requests, blocks
• The user row itself

This CANNOT be undone. There is no restore from this.

Use this only when:
  - Legal compliance demands it (CSAM, GDPR purge request)
  - Or you've confirmed this is a malicious account that must leave no trace`,
            dangerLevel: 'destructive',
            confirmLabel: 'I understand, purge it',
            requireType: username,
        });
        if (!ok) return;

        const notes = await ui.prompt({
            title: 'Reason for purge (legal hold record)',
            message: 'Why is this purge required? Be specific — this is your audit defense.',
            placeholder: 'e.g. GDPR request received via support@blipsdigital.com on 2026-04-22',
            multiline: true,
        });
        if (!notes) return;

        const { error } = await sb.rpc('admin_purge_user', {
            p_user_id: userId,
            p_notes: notes,
        });

        if (error) {
            ui.toast('Purge failed: ' + error.message, 'error');
            return;
        }

        ui.toast(`@${username} permanently destroyed.`, 'success', 5000);
        refreshAfterAction(null, { reopenDrawer: false });
    };

    // ── Identity edits ────────────────────────────────────────────────
    window.u_changeUsername = async function (userId, currentUsername) {
        const newUsername = await ui.prompt({
            title: `Change username for @${currentUsername}`,
            message: 'Enter the new username (3+ chars, must be unique):',
            initial: currentUsername,
            placeholder: 'newusername',
        });
        if (!newUsername || newUsername === currentUsername) return;

        const { error } = await sb.rpc('admin_change_username', {
            p_user_id: userId,
            p_new_username: newUsername,
            p_notes: `Changed @${currentUsername} → @${newUsername}`,
        });

        if (error) {
            ui.toast('Username change failed: ' + error.message, 'error');
            return;
        }

        ui.toast(`Username changed to @${newUsername}`, 'success');
        refreshAfterAction(userId);
    };

    window.u_changeDisplayName = async function (userId, currentDisplayName) {
        const newDisplayName = await ui.prompt({
            title: 'Change display name',
            message: `Current: "${currentDisplayName || '(none)'}"`,
            initial: currentDisplayName || '',
            placeholder: 'Display name (shown in app)',
            required: false,
        });
        if (newDisplayName === null || newDisplayName === currentDisplayName) return;

        // Display name is plain text shown in-app, no need for an RPC.
        // Direct .update() is fine since RLS prevents non-admins from
        // updating other users' rows; we re-checked is_admin on dashboard load.
        const { error } = await sb
            .from('users')
            .update({ display_name: newDisplayName })
            .eq('id', userId);

        if (error) {
            ui.toast('Update failed: ' + error.message, 'error');
            return;
        }

        await logAdminAction('display_name_change', userId, { from: currentDisplayName, to: newDisplayName }, `Changed display name`);
        ui.toast(`Display name updated`, 'success');
        refreshAfterAction(userId);
    };

    window.u_changeEmail = async function (userId, currentEmail, username) {
        const newEmail = await ui.prompt({
            title: `Change email for @${username}`,
            message: `Current: ${currentEmail || '(none)'}\n\nUpdates the login email and the profile together (server-side). The user can sign in with the new email immediately.`,
            initial: currentEmail || '',
            placeholder: 'newemail@example.com',
        });
        if (!newEmail || newEmail === currentEmail) return;

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(newEmail)) {
            ui.toast('Invalid email format', 'error');
            return;
        }

        try {
            // Server-side atomic change via the admin-change-email Edge
            // Function. The GoTrue admin API (which actually changes the
            // login email) requires the service role, which the browser
            // doesn't have — the old browser-side auth.admin call silently
            // failed. The function updates auth.users + public.users
            // together and rolls auth back if the profile update fails.
            const { data, error } = await sb.functions.invoke('admin-change-email', {
                body: { target_user_id: userId, new_email: newEmail },
            });

            if (error) {
                let msg = error.message;
                try { const b = await error.context.json(); if (b?.error) msg = b.error; } catch (_) {}
                ui.toast('Email change failed: ' + msg, 'error', 6000);
                return;
            }

            await logAdminAction('email_change', userId, { from: currentEmail, to: newEmail }, `Changed email`);
            ui.toast(`Email changed to ${newEmail}`, 'success');
            refreshAfterAction(userId);
        } catch (error) {
            ui.toast('Email change error: ' + error.message, 'error');
            console.error('Email change error:', error);
        }
    };

    window.u_resetPassword = async function (userId, username, emailFromCard) {
        // Resolve the email. The card may not have it, so fall back to
        // the admin_get_user_emails RPC (email is REVOKE'd from
        // authenticated, so a direct .select('email') would fail).
        let email = emailFromCard;
        if (!email) {
            const emap = await fetchEmailMap([userId]);
            email = emap[userId];
        }
        if (!email) {
            ui.toast(`Can't reset @${username}: no email on file.`, 'error', 5000);
            return;
        }

        const notes = await ui.prompt({
            title: `Reset password for @${username}`,
            message: `This will send a password reset link to:\n${email}\n\nThe link lands on https://blipsdigital.com/reset-password and lets them choose a new password.\n\nLog the reason for support reference:`,
            placeholder: 'e.g. User contacted support unable to log in',
            multiline: true,
        });
        if (!notes) return;

        // Actually trigger the reset email. As of 2026-05-19 Supabase
        // SMTP is wired through Resend → reliable delivery, no 4/hour
        // built-in-SMTP rate limit.
        const { error } = await sb.auth.resetPasswordForEmail(email, {
            redirectTo: 'https://blipsdigital.com/reset-password',
        });

        if (error) {
            // Common cases: rate limit, invalid email, SMTP misconfigured.
            // Surface the raw message so the admin can act on it.
            ui.toast(`Reset failed for @${username}: ${error.message}`, 'error', 8000);
            // Still log the attempt so the audit trail captures the failure.
            await logAdminAction('password_reset_failed', userId, { email, error: error.message }, notes);
            return;
        }

        await logAdminAction('password_reset', userId, { email }, notes);
        ui.toast(`Reset link sent to ${email}`, 'success', 5000);
    };

    // ── Blip bulk delete (chunked parallel version ported verbatim) ───
    window.u_deleteAllBlips = async function (userId, username) {
        // Show count first so admin sees what they're about to nuke
        const { count } = await sb
            .from('blips')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId);

        const ok = await ui.confirm({
            title: `Delete ALL blips by @${username}`,
            message: `This will permanently delete ${count || 0} blip${count === 1 ? '' : 's'} and all their likes/comments/views/replies/recipients.\n\nThis CANNOT be undone.`,
            dangerLevel: 'destructive',
            confirmLabel: `Delete ${count || 0} blips`,
            requireType: count > 5 ? 'DELETE ALL' : null,
        });
        if (!ok) return;

        // Fetch the user's blip IDs, then call admin_delete_blip per row.
        // We can't bulk-delete via the RPC (it takes a single ID), but
        // looping is fine — admin operations are infrequent and per-blip
        // cleanup of likes/comments/views is what we want.
        const { data: rows, error: fetchErr } = await sb
            .from('blips')
            .select('id')
            .eq('user_id', userId);

        if (fetchErr) {
            ui.toast('Error fetching blips: ' + fetchErr.message, 'error', 5000);
            return;
        }

        const blipIds = (rows || []).map(r => r.id);
        let failures = 0;
        // Parallel chunks of 10 (was one serial RPC per blip — 300 blips
        // meant 300 sequential round-trips with the UI frozen silent).
        for (let i = 0; i < blipIds.length; i += 10) {
            const chunk = blipIds.slice(i, i + 10);
            const results = await Promise.all(chunk.map(blipId =>
                sb.rpc('admin_delete_blip', { p_blip_id: blipId })
                    .then(({ error }) => ({ blipId, error }))
            ));
            for (const { blipId, error } of results) {
                if (error) { console.error('Failed to delete blip', blipId, error); failures++; }
            }
            if (blipIds.length > 20) {
                ui.toast(`Deleting… ${Math.min(i + 10, blipIds.length)}/${blipIds.length}`, 'info', 900);
            }
        }

        await logAdminAction('delete_all_blips', userId, { count: blipIds.length, failures }, `Deleted ${blipIds.length - failures}/${blipIds.length} blips by @${username}`);
        if (failures > 0) {
            ui.toast(`Deleted ${blipIds.length - failures}/${blipIds.length}. ${failures} failed — check console.`, 'error', 6000);
        } else {
            ui.toast(`All ${blipIds.length} blips by @${username} deleted`, 'success');
        }
        refreshAfterAction(userId);
    };

    // ── Verify / unverify (admin_set_verified) ────────────────────────
    window.u_verify = async function (userId, username) {
        const notes = await ui.prompt({
            title: `Verify @${username}`,
            message: 'Why are you manually verifying this user? (audit log)',
            placeholder: 'e.g. Confirmed identity via email + ID document',
            multiline: true,
        });
        if (!notes) return;

        const { error } = await sb.rpc('admin_set_verified', {
            p_user_id: userId,
            p_verified: true,
            p_notes: notes,
        });

        if (error) {
            ui.toast('Verify failed: ' + error.message, 'error');
            return;
        }

        ui.toast(`@${username} verified ✓`, 'success');
        refreshAfterAction(userId);
    };

    window.u_unverify = async function (userId, username) {
        const notes = await ui.prompt({
            title: `Remove verification from @${username}`,
            message: 'Why are you removing verification? (audit log)',
            multiline: true,
        });
        if (!notes) return;

        const { error } = await sb.rpc('admin_set_verified', {
            p_user_id: userId,
            p_verified: false,
            p_notes: notes,
        });

        if (error) {
            ui.toast('Unverify failed: ' + error.message, 'error');
            return;
        }

        ui.toast(`Verification removed from @${username}`, 'success');
        refreshAfterAction(userId);
    };

    // ── Single blip / video-reply deletes from the drawer ─────────────
    window.u_deleteBlip = async function (blipId, username, userId) {
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
        refreshAfterAction(userId);
    };

    window.u_deleteReply = async function (videoReplyId, username, userId) {
        const ok = await ui.confirm({
            title: `Delete video reply by ${username}`,
            message: `This permanently removes the video reply.\n\nThis CANNOT be undone.`,
            dangerLevel: 'destructive',
            confirmLabel: 'Delete reply',
        });
        if (!ok) return;

        // Use admin_delete_video_reply RPC (server-side admin check + atomic log)
        const { error } = await sb.rpc('admin_delete_video_reply', {
            p_reply_id: videoReplyId,
        });

        if (error) {
            ui.toast('Delete failed: ' + error.message, 'error');
            return;
        }

        ui.toast('Video reply deleted', 'success');
        refreshAfterAction(userId);
    };

    // ── Per-blip restore / purge inside the drawer's Recently Deleted
    //    list (same RPCs the Recently Deleted tab uses) ─────────────────
    window.u_restoreBlip = async function (blipId, userId) {
        const ok = await ui.confirm({ title: 'Restore blip?', message: 'The blip becomes visible in the app again.', dangerLevel: 'warning', confirmLabel: 'Restore' });
        if (!ok) return;
        const { data, error } = await sb.rpc('admin_restore_blip', { p_blip_id: blipId });
        if (error) { ui.toast('Restore failed: ' + error.message, 'error', 5000); return; }
        ui.toast(data ? 'Blip restored' : 'Nothing changed — it may already be purged.', data ? 'success' : 'info');
        refreshAfterAction(userId);
    };

    window.u_purgeBlip = async function (blipId, userId) {
        const ok = await ui.confirm({ title: 'Purge tonight?', message: 'The blip and its video file are permanently destroyed on tonight\'s purge run. This cannot be undone after it runs.', dangerLevel: 'destructive', confirmLabel: 'Purge tonight' });
        if (!ok) return;
        const { data, error } = await sb.rpc('admin_purge_blip_now', { p_blip_id: blipId });
        if (error) { ui.toast('Purge scheduling failed: ' + error.message, 'error', 5000); return; }
        ui.toast(data ? 'Scheduled for tonight\'s purge' : 'Nothing changed — it may already be purged.', data ? 'success' : 'info');
        refreshAfterAction(userId);
    };

    // The shell's openUser() delegates here.
    window.__openUser = openUserDrawer;
})();
