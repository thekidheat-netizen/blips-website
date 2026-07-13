// Recently Deleted — soft-deleted blips across ALL users: restore, purge
// tonight, or extend retention 7 days. RPCs ported verbatim from legacy
// (admin_list_soft_deleted_blips / admin_restore_blip /
// admin_purge_blip_now / admin_extend_blip_retention).
registerRoute('deleted', {
    title: 'Recently Deleted', icon: '🗑', order: 6,
    async render(el) {
        el.innerHTML = `
            <h2 class="page">Recently Deleted</h2>
            <p class="pagesub">Soft-deleted blips still inside their retention window. Restore them, purge tonight, or extend by 7 days.</p>
            <div id="delList" class="spin">Loading…</div>`;
        await window.__loadDeleted();
    },
});

window.__loadDeleted = async function() {
    const box = document.getElementById('delList');
    if (!box) return;
    const { data, error } = await sb.rpc('admin_list_soft_deleted_blips');
    if (error) {
        box.className = 'empty';
        box.innerHTML = `Couldn't load deleted blips: ${esc(error.message)}<br>
            <span style="font-size:12px">If this mentions a missing function, migration 20260703000000 hasn't been applied yet.</span>`;
        return;
    }
    if (!data || !data.length) {
        box.className = 'empty';
        box.textContent = 'Nothing in the trash — no soft-deleted blips right now.';
        return;
    }
    box.className = 'tblwrap';
    box.innerHTML = `
        <table class="tbl">
            <thead><tr><th></th><th>Owner</th><th>Title</th><th>Deleted</th><th>Purges</th><th style="text-align:right">Actions</th></tr></thead>
            <tbody>
                ${data.map(b => `
                    <tr>
                        <td>${b.thumbnail_url
                            ? `<img class="thumb" style="width:52px;height:52px;" src="${esc(b.thumbnail_url)}" onclick="ui.player('${jsEsc(b.video_url)}')">`
                            : `<div class="thumb ph" style="width:52px;height:52px;" onclick="ui.player('${jsEsc(b.video_url)}')">📹</div>`}</td>
                        <td><span class="userchip"><span class="nm" onclick="openUser('${jsEsc(b.user_id)}')">@${esc(b.username || '?')}</span></span></td>
                        <td style="max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(b.title || '—')}</td>
                        <td title="${esc(fmtDate(b.soft_deleted_at))}">${timeAgo(b.soft_deleted_at)}</td>
                        <td><span class="pill ${new Date(b.delete_at) - Date.now() < 86400000 ? 'danger' : 'muted'}">${formatUntil(b.delete_at)}</span></td>
                        <td style="text-align:right; white-space:nowrap;">
                            <button class="btn sm ok" onclick="window.__restoreDeleted('${jsEsc(b.id)}')">Restore</button>
                            <button class="btn sm" onclick="window.__extendDeleted('${jsEsc(b.id)}')">+7 days</button>
                            <button class="btn sm danger" onclick="window.__purgeDeleted('${jsEsc(b.id)}')">Purge tonight</button>
                        </td>
                    </tr>`).join('')}
            </tbody>
        </table>`;
};

window.__restoreDeleted = async function(blipId) {
    const ok = await ui.confirm({ title: 'Restore blip?', message: 'The blip becomes visible in the app again.', dangerLevel: 'warning', confirmLabel: 'Restore' });
    if (!ok) return;
    const { data, error } = await sb.rpc('admin_restore_blip', { p_blip_id: blipId });
    if (error) { ui.toast('Restore failed: ' + error.message, 'error', 5000); return; }
    ui.toast(data ? 'Blip restored' : 'Nothing changed — it may already be purged.', data ? 'success' : 'info');
    window.__loadDeleted();
};
window.__purgeDeleted = async function(blipId) {
    const ok = await ui.confirm({ title: 'Purge tonight?', message: 'The blip and its video file are permanently destroyed on tonight\'s purge run. This cannot be undone after it runs.', dangerLevel: 'destructive', confirmLabel: 'Purge tonight' });
    if (!ok) return;
    const { data, error } = await sb.rpc('admin_purge_blip_now', { p_blip_id: blipId });
    if (error) { ui.toast('Purge scheduling failed: ' + error.message, 'error', 5000); return; }
    ui.toast(data ? 'Scheduled for tonight\'s purge' : 'Nothing changed — it may already be purged.', data ? 'success' : 'info');
    window.__loadDeleted();
};
window.__extendDeleted = async function(blipId) {
    const { data, error } = await sb.rpc('admin_extend_blip_retention', { p_blip_id: blipId, p_days: 7 });
    if (error) { ui.toast('Extend failed: ' + error.message, 'error', 5000); return; }
    ui.toast(data ? 'Retention extended 7 days' : 'Nothing changed — it may already be purged.', data ? 'success' : 'info');
    window.__loadDeleted();
};
