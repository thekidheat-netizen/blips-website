// Dashboard — lands on "what needs my attention" instead of a wall of tabs.
registerRoute('dashboard', {
    title: 'Dashboard', icon: '⌂', order: 0,
    async render(el) {
        el.innerHTML = `
            <h2 class="page">Dashboard</h2>
            <p class="pagesub">What needs your attention right now.</p>
            <div class="stats" id="dashStats"><div class="spin"></div></div>
            <div class="grid" style="grid-template-columns: 1fr 1fr; margin-top: 18px;" id="dashCols">
                <div class="card"><div class="sect"><h4>Needs attention</h4><div id="dashQueue" class="spin"></div></div></div>
                <div class="card"><div class="sect"><h4>Recent admin activity</h4><div id="dashLog" class="spin"></div></div></div>
            </div>`;

        // Stats + queue + log all load in parallel.
        const [counts, statRes, logRes] = await Promise.all([
            cache.get('badges', fetchPendingCounts, 15000),
            cache.get('dash:stats', async () => {
                const [u, b, ban, del] = await Promise.all([
                    sb.from('users').select('id', { count: 'exact', head: true }),
                    sb.from('blips').select('*', { count: 'exact', head: true }),
                    sb.from('users').select('id', { count: 'exact', head: true }).eq('is_banned', true),
                    sb.from('users').select('id', { count: 'exact', head: true }).not('deleted_at', 'is', null),
                ]);
                return { users: u.count || 0, blips: b.count || 0, banned: ban.count || 0, deleted: del.count || 0 };
            }, 60000),
            sb.from('admin_logs')
                .select('*, admin:users!admin_logs_admin_id_fkey(username)')
                .order('created_at', { ascending: false }).limit(12),
        ]);

        // Resolve target usernames in one batch (public columns only — the
        // same two-step pattern legacy used; no FK hint exists for target).
        const logsRaw = logRes.data || [];
        const targetIds = [...new Set(logsRaw.map(l => l.target_user_id).filter(Boolean))];
        let targetMap = {};
        if (targetIds.length) {
            const { data: tu } = await sb.from('users').select('id, username').in('id', targetIds);
            targetMap = Object.fromEntries((tu || []).map(u => [u.id, u.username]));
        }
        logsRaw.forEach(l => { l.target = l.target_user_id ? { username: targetMap[l.target_user_id] } : null; });

        const s = statRes;
        document.getElementById('dashStats').innerHTML = `
            <div class="stat"><h4>Users</h4><div class="num">${s.users}</div></div>
            <div class="stat"><h4>Blips</h4><div class="num">${s.blips}</div></div>
            <div class="stat ${counts.reports ? 'hot' : ''}"><h4>Pending reports</h4><div class="num">${counts.reports}</div></div>
            <div class="stat ${counts.appeals ? 'hot' : ''}"><h4>Appeals</h4><div class="num">${counts.appeals}</div></div>
            <div class="stat ${counts.verifications ? 'hot' : ''}"><h4>Verifications</h4><div class="num">${counts.verifications}</div></div>
            <div class="stat"><h4>Banned</h4><div class="num">${s.banned}</div></div>
            <div class="stat"><h4>Deleted users</h4><div class="num">${s.deleted}</div></div>`;

        // Needs-attention queue: one row per non-zero pending bucket.
        const q = [];
        if (counts.reports) q.push({ n: counts.reports, label: 'pending report' + (counts.reports > 1 ? 's' : ''), href: '#/reports', cls: 'danger' });
        if (counts.appeals) q.push({ n: counts.appeals, label: 'ban appeal' + (counts.appeals > 1 ? 's' : ''), href: '#/appeals', cls: 'warn' });
        if (counts.verifications) q.push({ n: counts.verifications, label: 'verification request' + (counts.verifications > 1 ? 's' : ''), href: '#/verifications', cls: 'gold' });
        document.getElementById('dashQueue').className = '';
        document.getElementById('dashQueue').innerHTML = q.length
            ? q.map(x => `
                <a href="${x.href}" style="display:flex; align-items:center; gap:12px; padding:12px; border:1px solid var(--border); border-radius:10px; margin-bottom:8px;">
                    <span class="pill ${x.cls}">${x.n}</span>
                    <span style="color:var(--cream); font-weight:700;">${x.label}</span>
                    <span style="margin-left:auto; color:var(--muted);">Review →</span>
                </a>`).join('')
            : '<div class="empty" style="padding:24px;">All clear — nothing pending. 🎉</div>';

        // Recent admin activity feed.
        const logs = logsRaw;
        document.getElementById('dashLog').className = '';
        document.getElementById('dashLog').innerHTML = logs.length
            ? logs.map(l => `
                <div style="display:flex; gap:10px; padding:9px 0; border-bottom:1px solid var(--border); font-size:13px;">
                    <span class="pill muted">${esc(l.action_type)}</span>
                    <span style="color:var(--text); flex:1;">
                        @${esc(l.admin?.username || '?')}${l.target?.username ? ` → <span class="userchip-inline" style="color:var(--gold); cursor:pointer;" onclick="openUser('${jsEsc(l.target_user_id)}')">@${esc(l.target.username)}</span>` : ''}
                        ${l.notes ? `<div style="color:var(--muted); font-size:12px; margin-top:2px;">${esc(l.notes)}</div>` : ''}
                    </span>
                    <span style="color:var(--muted); white-space:nowrap;">${timeAgo(l.created_at)}</span>
                </div>`).join('')
            : '<div class="empty" style="padding:24px;">No admin actions logged yet.</div>';
    },
});
