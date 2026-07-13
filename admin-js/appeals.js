// Appeals — ban appeals live in profile_reports with report_type='appeal'.
// All Supabase calls ported verbatim from admin-legacy.html (loadAppeals,
// approveAppeal, denyAppeal, markAppealReviewed, updateAppealStatus).
(() => {
    const PAGE_SIZE = 100;
    let appealsLimit = PAGE_SIZE;
    let allAppeals = [];
    let statusFilter = 'unresolved'; // Default to showing unresolved appeals (legacy default)
    let searchQuery = '';

    const CHIPS = [
        ['unresolved', 'Unresolved'],
        ['resolved', 'Resolved'],
        ['all', 'All'],
    ];

    registerRoute('appeals', {
        title: 'Appeals', icon: '⚖️', order: 3, badgeKey: 'appeals',
        async render(el) {
            el.innerHTML = `
                <h2 class="page">Appeals</h2>
                <p class="pagesub">Ban appeals submitted by users. Approve to unban, or deny with notes.</p>
                <div class="toolbar">
                    <div id="apChips" style="display:flex; gap:6px; flex-wrap:wrap;"></div>
                    <input type="search" id="apSearch" placeholder="Filter by username or email…" oninput="ap_search(this.value)" style="min-width:240px;">
                </div>
                <div id="apList" class="spin">Loading…</div>`;
            document.getElementById('apSearch').value = searchQuery;
            renderChips();
            await load();
        },
    });

    function renderChips() {
        const box = document.getElementById('apChips');
        if (!box) return;
        box.innerHTML = CHIPS.map(([val, label]) => `
            <button class="btn sm ${statusFilter === val ? 'gold' : ''}" onclick="ap_setFilter('${val}')">${label}</button>`).join('');
    }

    // ── Data loading — query ported byte-for-byte from legacy loadAppeals ──
    async function load() {
        const box = document.getElementById('apList');
        if (box) { box.className = 'spin'; box.textContent = 'Loading…'; }
        const { data: appeals } = await supabaseClient
            .from('profile_reports')
            .select(`
                id,
                reported_user_id,
                reported_by,
                reason,
                details,
                status,
                reviewed_by,
                reviewed_at,
                created_at,
                report_type,
                reported_user:users!profile_reports_reported_user_id_fkey(id, username, avatar_url, is_banned)
            `)
            .eq('report_type', 'appeal')
            .order('created_at', { ascending: false })
            .limit(appealsLimit);

        allAppeals = appeals || [];
        // email is REVOKE'd from authenticated, so it's no longer in the
        // embed above — fetch it via the admin RPC and attach so the
        // render + email filter keep working.
        const emap = await fetchEmailMap(allAppeals.map(a => a.reported_user_id));
        allAppeals.forEach(a => { if (a.reported_user) a.reported_user.email = emap[a.reported_user_id] || null; });
        renderList();
    }

    function filtered() {
        let list = allAppeals.filter(appeal => {
            if (statusFilter === 'unresolved') {
                return appeal.status === 'pending';
            } else if (statusFilter === 'resolved') {
                return appeal.status === 'reviewed' || appeal.status === 'dismissed';
            }
            return true; // 'all'
        });
        const q = searchQuery.toLowerCase().trim();
        if (q) {
            list = list.filter(appeal =>
                appeal.reported_user?.username?.toLowerCase().includes(q) ||
                appeal.reported_user?.email?.toLowerCase().includes(q)
            );
        }
        return list;
    }

    function statusPill(status) {
        const cls = status === 'pending' ? 'warn' : status === 'reviewed' ? 'ok' : 'muted';
        return `<span class="pill ${cls}">${esc(status)}</span>`;
    }

    function renderList() {
        const box = document.getElementById('apList');
        if (!box) return;
        renderChips();
        const list = filtered();
        if (!list.length) {
            box.className = 'empty';
            box.innerHTML = `No appeals found.
                <div style="margin-top:14px;"><button class="btn sm" onclick="ap_loadMore()">Load older appeals (currently ${appealsLimit} max)</button></div>`;
            return;
        }
        box.className = '';
        box.innerHTML = `
            <div class="tblwrap">
                <table class="tbl">
                    <thead><tr><th>User</th><th>Email</th><th>Appeal</th><th>Submitted</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead>
                    <tbody>
                        ${list.map(appeal => {
                            // Appeal text lives in details (format: "BAN APPEAL (Code: 12345)\n\nUser's reason")
                            const appealText = appeal.details || appeal.reason || 'No reason provided';
                            return `
                            <tr>
                                <td>
                                    <div class="userchip">
                                        ${avatarHtml(appeal.reported_user?.avatar_url, appeal.reported_user?.username)}
                                        <div>
                                            <span class="nm" onclick="openUser('${jsEsc(appeal.reported_user_id)}')">@${esc(appeal.reported_user?.username || 'Unknown')}</span>
                                            <div class="sub">${appeal.reported_user?.is_banned ? '<span class="pill danger">BANNED</span>' : '<span class="pill ok">ACTIVE</span>'}</div>
                                        </div>
                                    </div>
                                </td>
                                <td>${esc(appeal.reported_user?.email || 'N/A')}</td>
                                <td style="max-width:300px; white-space:pre-wrap; word-wrap:break-word;">${esc(appealText)}</td>
                                <td title="${esc(fmtDate(appeal.created_at))}">${timeAgo(appeal.created_at)}</td>
                                <td>${statusPill(appeal.status)}</td>
                                <td style="text-align:right; white-space:nowrap;">
                                    ${appeal.status === 'pending' && appeal.reported_user?.is_banned ? `
                                        <button class="btn sm ok" onclick="ap_approve('${jsEsc(appeal.id)}', '${jsEsc(appeal.reported_user_id)}', '${jsEsc(appeal.reported_user?.username)}')">Approve &amp; unban</button>
                                        <button class="btn sm danger" onclick="ap_deny('${jsEsc(appeal.id)}', '${jsEsc(appeal.reported_user?.username)}')">Deny</button>
                                    ` : appeal.status === 'pending' && !appeal.reported_user?.is_banned ? `
                                        <button class="btn sm" onclick="ap_markReviewed('${jsEsc(appeal.id)}')">Mark reviewed</button>
                                        <span style="color:var(--muted); font-size:11px;">(already unbanned)</span>
                                    ` : ''}
                                    <select onchange="ap_setStatus('${jsEsc(appeal.id)}', this.value)"
                                        style="padding:6px 10px; border-radius:7px; border:1px solid var(--border-strong); font-size:12px; cursor:pointer; background:var(--well); color:var(--cream); font-family:inherit;">
                                        <option value="${esc(appeal.status)}" selected>${esc(appeal.status)}</option>
                                        ${appeal.status !== 'pending' ? '<option value="pending">pending</option>' : ''}
                                        ${appeal.status !== 'reviewed' ? '<option value="reviewed">reviewed</option>' : ''}
                                        ${appeal.status !== 'dismissed' ? '<option value="dismissed">dismissed</option>' : ''}
                                    </select>
                                </td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
            <div style="text-align:center; margin-top:16px;">
                <button class="btn sm" onclick="ap_loadMore()">Load older appeals (currently ${appealsLimit} max)</button>
            </div>`;
    }

    // Update the appeal in memory + re-render (no refetch), then refresh badges.
    function patchAppeal(appealId, patch) {
        const appeal = allAppeals.find(a => String(a.id) === String(appealId));
        if (appeal) Object.assign(appeal, patch);
        renderList();
        cache.bust('badges');
        refreshBadges();
    }

    // ── Toolbar handlers ──
    window.ap_setFilter = function(filter) { statusFilter = filter; renderList(); };
    window.ap_search = function(q) { searchQuery = q; renderList(); };
    window.ap_loadMore = async function() {
        appealsLimit *= 2;
        await load();
    };

    // ── Approve (ported approveAppeal) ──
    window.ap_approve = async function(appealId, userId, username) {
        const notes = await adminPrompt({
            title: 'Approve appeal',
            message: `Notes for approving appeal for @${username}:`,
            placeholder: 'Why is this appeal being approved?',
            multiline: true
        });
        if (!notes) return;

        // Unban the user and clear ban reason
        const { error: unbanError } = await supabaseClient
            .from('users')
            .update({
                is_banned: false,
                ban_reason: null
            })
            .eq('id', userId);

        if (unbanError) {
            adminToast('Error unbanning user: ' + unbanError.message, 'error', 5000);
            return;
        }

        // Mark appeal as reviewed
        const { error: appealError } = await supabaseClient
            .from('profile_reports')
            .update({ status: 'reviewed', reviewed_by: currentAdminId, reviewed_at: new Date().toISOString() })
            .eq('id', appealId);

        if (appealError) {
            adminToast('Error updating appeal: ' + appealError.message, 'error', 5000);
            return;
        }

        // Log the action
        await logAdminAction('unban', userId, { appeal_approved: true }, `Appeal approved: ${notes}`);

        adminToast(`Appeal approved — @${username} has been unbanned.`, 'success');
        // The user is unbanned now — reflect that on every appeal row they own.
        allAppeals.forEach(a => {
            if (a.reported_user_id === userId && a.reported_user) a.reported_user.is_banned = false;
        });
        patchAppeal(appealId, { status: 'reviewed', reviewed_by: currentAdminId, reviewed_at: new Date().toISOString() });
    };

    // ── Deny (ported denyAppeal) ──
    window.ap_deny = async function(appealId, username) {
        const notes = await adminPrompt({
            title: 'Deny appeal',
            message: `Notes for denying appeal for @${username}:`,
            placeholder: 'Why is this appeal being denied?',
            multiline: true,
            dangerLevel: 'warning'
        });
        if (!notes) return;

        const { error } = await supabaseClient
            .from('profile_reports')
            .update({ status: 'dismissed', reviewed_by: currentAdminId, reviewed_at: new Date().toISOString() })
            .eq('id', appealId);

        if (error) {
            adminToast('Error: ' + error.message, 'error', 5000);
            return;
        }

        adminToast(`Appeal denied for @${username}`, 'success');
        patchAppeal(appealId, { status: 'dismissed', reviewed_by: currentAdminId, reviewed_at: new Date().toISOString() });
    };

    // ── Mark reviewed (ported markAppealReviewed — for already-unbanned users) ──
    window.ap_markReviewed = async function(appealId) {
        const { error } = await supabaseClient
            .from('profile_reports')
            .update({ status: 'reviewed', reviewed_by: currentAdminId, reviewed_at: new Date().toISOString() })
            .eq('id', appealId);

        if (error) {
            adminToast('Error: ' + error.message, 'error', 5000);
            return;
        }

        adminToast('Appeal marked as reviewed', 'success');
        patchAppeal(appealId, { status: 'reviewed', reviewed_by: currentAdminId, reviewed_at: new Date().toISOString() });
    };

    // ── Raw status change (ported updateAppealStatus) ──
    window.ap_setStatus = async function(appealId, status) {
        const { error } = await supabaseClient
            .from('profile_reports')
            .update({
                status: status,
                reviewed_by: currentAdminId,
                reviewed_at: new Date().toISOString()
            })
            .eq('id', appealId);

        if (error) {
            adminToast('Error: ' + error.message, 'error', 5000);
            renderList();
            return;
        }

        adminToast(`Appeal status updated to: ${status}`, 'success');
        patchAppeal(appealId, { status: status, reviewed_by: currentAdminId, reviewed_at: new Date().toISOString() });
    };
})();
