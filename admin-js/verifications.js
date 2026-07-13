// Verifications — blue-check applications. All Supabase calls ported verbatim
// from admin-legacy.html (loadVerifications, resolveVerificationImageUrl,
// openVerificationDetail, approveVerification, rejectVerification).
(() => {
    const PAGE_SIZE = 100;
    let verificationsLimit = PAGE_SIZE;
    let allVerifications = [];
    let statusFilter = 'pending'; // Default to showing pending verifications (legacy default)

    const CHIPS = [
        ['pending', 'Pending'],
        ['approved', 'Approved'],
        ['rejected', 'Rejected'],
        ['all', 'All'],
    ];

    registerRoute('verifications', {
        title: 'Verifications', icon: '✔︎', order: 4, badgeKey: 'verifications',
        async render(el) {
            el.innerHTML = `
                <h2 class="page">Verifications</h2>
                <p class="pagesub">Blue-checkmark applications: review identity documents and social links.</p>
                <div class="toolbar"><div id="vChips" style="display:flex; gap:6px; flex-wrap:wrap;"></div></div>
                <div id="vList" class="spin">Loading…</div>`;
            renderChips();
            await load();
        },
    });

    function renderChips() {
        const box = document.getElementById('vChips');
        if (!box) return;
        box.innerHTML = CHIPS.map(([val, label]) => `
            <button class="btn sm ${statusFilter === val ? 'gold' : ''}" onclick="v_setFilter('${val}')">${label}</button>`).join('');
    }

    // ── Data loading — query ported byte-for-byte from legacy loadVerifications ──
    async function load() {
        const box = document.getElementById('vList');
        if (box) { box.className = 'spin'; box.textContent = 'Loading…'; }
        const { data: verifications, error } = await supabaseClient
            .from('verification_applications')
            .select(`
                *,
                user:users!verification_applications_user_id_fkey(id, username, avatar_url, display_name, is_verified)
            `)
            .order('created_at', { ascending: false })
            .limit(verificationsLimit);

        if (error) {
            console.error('Error loading verifications:', error);
            adminToast('Error loading verifications: ' + error.message, 'error');
            if (box) { box.className = 'empty'; box.textContent = 'Couldn’t load verifications: ' + error.message; }
            return;
        }

        allVerifications = verifications || [];
        // email REVOKE'd from authenticated → fetch via admin RPC + attach
        // so the verification rows + detail still show the applicant email.
        const emap = await fetchEmailMap(allVerifications.map(v => v.user?.id));
        allVerifications.forEach(v => { if (v.user) v.user.email = emap[v.user.id] || null; });
        renderList();
    }

    function filtered() {
        return allVerifications.filter(verification => {
            if (statusFilter === 'all') return true;
            return verification.status === statusFilter;
        });
    }

    function statusPill(status) {
        const cls = status === 'pending' ? 'warn' : status === 'approved' ? 'ok' : 'danger';
        return `<span class="pill ${cls}">${esc(status)}</span>`;
    }

    function renderList() {
        const box = document.getElementById('vList');
        if (!box) return;
        renderChips();
        const list = filtered();
        if (!list.length) {
            box.className = 'empty';
            box.innerHTML = `No verification requests found.
                <div style="margin-top:14px;"><button class="btn sm" onclick="v_loadMore()">Load older verifications (currently ${verificationsLimit} max)</button></div>`;
            return;
        }
        box.className = '';
        box.innerHTML = `
            <div class="tblwrap">
                <table class="tbl">
                    <thead><tr><th>User</th><th>Email</th><th>Real name</th><th>Status</th><th>Submitted</th><th style="text-align:right">Actions</th></tr></thead>
                    <tbody>
                        ${list.map(verification => `
                            <tr onclick="v_openDetail('${jsEsc(verification.id)}')" style="cursor:pointer;">
                                <td>
                                    <div class="userchip">
                                        ${avatarHtml(verification.user?.avatar_url, verification.user?.username)}
                                        <div>
                                            <span class="nm" onclick="event.stopPropagation(); openUser('${jsEsc(verification.user_id)}')">@${esc(verification.user?.username || 'Unknown')}</span>
                                            ${verification.user?.is_verified ? '<div class="sub"><span class="pill info">✓ VERIFIED</span></div>' : ''}
                                        </div>
                                    </div>
                                </td>
                                <td>${esc(verification.user?.email || 'N/A')}</td>
                                <td style="max-width:200px; white-space:pre-wrap; word-wrap:break-word;">${esc(verification.real_name || 'No name provided')}</td>
                                <td>${statusPill(verification.status)}</td>
                                <td title="${esc(fmtDate(verification.created_at))}">${timeAgo(verification.created_at)}</td>
                                <td style="text-align:right; white-space:nowrap;">
                                    <button class="btn sm" onclick="event.stopPropagation(); v_openDetail('${jsEsc(verification.id)}')">View</button>
                                    ${verification.status === 'pending' ? `
                                        <button class="btn sm ok" onclick="event.stopPropagation(); v_approve('${jsEsc(verification.id)}', '${jsEsc(verification.user_id)}', '${jsEsc(verification.user?.username)}')">Approve</button>
                                        <button class="btn sm danger" onclick="event.stopPropagation(); v_reject('${jsEsc(verification.id)}', '${jsEsc(verification.user?.username)}')">Reject</button>
                                    ` : ''}
                                </td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>
            <div style="text-align:center; margin-top:16px;">
                <button class="btn sm" onclick="v_loadMore()">Load older verifications (currently ${verificationsLimit} max)</button>
            </div>`;
    }

    // ── Toolbar handlers ──
    window.v_setFilter = function(filter) { statusFilter = filter; renderList(); };
    window.v_loadMore = async function() {
        verificationsLimit *= 2;
        await load();
    };

    // Resolve a stored verification ID image to a renderable URL.
    // - Legacy rows: id_front_url / id_back_url is a full https:// URL
    //   from when files were in the public `blip-videos` bucket. Returned
    //   unchanged.
    // - New rows: stored as a path inside the private `verification-ids`
    //   bucket. Sign with a 1-hour TTL so even if the admin leaves the
    //   drawer open, the link stops working soon. Re-signed each open.
    async function resolveVerificationImageUrl(stored) {
        if (!stored) return null;
        if (/^https?:\/\//i.test(stored)) return stored; // legacy
        const { data, error } = await supabaseClient.storage
            .from('verification-ids')
            .createSignedUrl(stored, 3600);
        if (error) {
            console.error('[verification] Failed to sign URL for', stored, error);
            return null;
        }
        return data?.signedUrl || null;
    }

    // ── Detail drawer (ported openVerificationDetail) ──
    window.v_openDetail = async function(verificationId) {
        const verification = allVerifications.find(v => String(v.id) === String(verificationId));
        if (!verification) return;

        // Resolve both image URLs in parallel BEFORE we render. Without
        // this the <img src> would be a bare path string and render broken.
        const [resolvedFrontUrl, resolvedBackUrl] = await Promise.all([
            resolveVerificationImageUrl(verification.id_front_url),
            resolveVerificationImageUrl(verification.id_back_url),
        ]);

        const html = `
            <div class="sect">
                <div class="userchip" style="gap:14px;">
                    ${avatarHtml(verification.user?.avatar_url, verification.user?.username, 56)}
                    <div>
                        <div style="color:var(--cream); font-weight:900; font-size:16px;">${esc(verification.user?.display_name || verification.user?.username || 'N/A')}</div>
                        <span class="nm" onclick="openUser('${jsEsc(verification.user_id)}')">@${esc(verification.user?.username || 'N/A')}</span>
                        <div class="sub">${esc(verification.user?.email || 'No email')}</div>
                    </div>
                </div>
            </div>

            <div class="sect">
                <h4>Application details</h4>
                <div class="kv">
                    <div class="k">Status</div><div class="v">${statusPill(verification.status)}</div>
                    <div class="k">Real name</div><div class="v" style="white-space:pre-wrap;">${esc(verification.real_name || 'No name provided')}</div>
                    <div class="k">Submitted</div><div class="v">${esc(fmtDate(verification.created_at))}</div>
                    ${verification.reviewed_at ? `<div class="k">Reviewed</div><div class="v">${esc(fmtDate(verification.reviewed_at))}</div>` : ''}
                    ${verification.rejection_reason ? `<div class="k" style="color:var(--danger);">Rejection reason</div><div class="v" style="white-space:pre-wrap;">${esc(verification.rejection_reason)}</div>` : ''}
                </div>
            </div>

            <div class="sect">
                <h4>Social links</h4>
                ${verification.social_links && verification.social_links.length > 0 ?
                    verification.social_links.map(link => `
                        <div style="margin-bottom:8px;">
                            <strong style="color:var(--cream);">${esc(link.platform)}:</strong>
                            <a href="${esc(link.url)}" target="_blank" rel="noopener">${esc(link.url)}</a>
                            ${link.follower_count ? ` <span style="color:var(--muted);">(${Number(link.follower_count).toLocaleString()} followers)</span>` : ''}
                        </div>`).join('')
                    : '<div style="color:var(--muted);">No social links provided</div>'}
            </div>

            <div class="sect">
                <h4>ID photos <span style="font-size:11px; color:var(--muted); font-weight:normal; text-transform:none;">(signed URLs valid 1h)</span></h4>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:16px;">
                    ${resolvedFrontUrl ? `
                        <div>
                            <strong style="display:block; margin-bottom:8px; color:var(--cream);">ID front</strong>
                            <a href="${esc(resolvedFrontUrl)}" target="_blank" rel="noopener">
                                <img src="${esc(resolvedFrontUrl)}" style="width:100%; border-radius:8px; border:1px solid var(--border-strong);">
                            </a>
                        </div>
                    ` : (verification.id_front_url ? '<div style="color:var(--danger);">ID front: failed to load (sign error or missing file)</div>' : '')}
                    ${resolvedBackUrl ? `
                        <div>
                            <strong style="display:block; margin-bottom:8px; color:var(--cream);">ID back</strong>
                            <a href="${esc(resolvedBackUrl)}" target="_blank" rel="noopener">
                                <img src="${esc(resolvedBackUrl)}" style="width:100%; border-radius:8px; border:1px solid var(--border-strong);">
                            </a>
                        </div>
                    ` : (verification.id_back_url ? '<div style="color:var(--danger);">ID back: failed to load (sign error or missing file)</div>' : '')}
                    ${!verification.id_front_url && !verification.id_back_url ? '<div style="color:var(--muted);">No ID photos provided</div>' : ''}
                </div>
            </div>

            <div class="sect">
                <h4>Actions</h4>
                <div class="actionrow">
                    <button class="btn sm" onclick="openUser('${jsEsc(verification.user_id)}')">View user profile</button>
                    ${verification.status === 'pending' ? `
                        <button class="btn sm ok" onclick="v_approve('${jsEsc(verification.id)}', '${jsEsc(verification.user_id)}', '${jsEsc(verification.user?.username)}')">Approve</button>
                        <button class="btn sm danger" onclick="v_reject('${jsEsc(verification.id)}', '${jsEsc(verification.user?.username)}')">Reject</button>
                    ` : ''}
                </div>
            </div>`;

        ui.drawer({ title: `Verification ${statusPill(verification.status)}`, html });
    };

    // Update a verification in memory + re-render (no refetch), then badges.
    function patchVerification(verificationId, patch) {
        const verification = allVerifications.find(v => String(v.id) === String(verificationId));
        if (verification) Object.assign(verification, patch);
        renderList();
        cache.bust('badges');
        refreshBadges();
    }

    // ── Approve (ported approveVerification — direct users update, as legacy) ──
    window.v_approve = async function(verificationId, userId, username) {
        const ok = await adminConfirm({
            title: 'Approve verification',
            message: `Approve verification for @${username}? They will receive a blue checkmark.`,
            dangerLevel: 'neutral',
            confirmLabel: 'Approve'
        });
        if (!ok) return;

        // Update user to verified
        const { error: userError } = await supabaseClient
            .from('users')
            .update({ is_verified: true })
            .eq('id', userId);

        if (userError) {
            adminToast('Error verifying user: ' + userError.message, 'error', 5000);
            return;
        }

        // Update application status
        const { error: appError } = await supabaseClient
            .from('verification_applications')
            .update({
                status: 'approved',
                reviewed_by: currentAdminId,
                reviewed_at: new Date().toISOString()
            })
            .eq('id', verificationId);

        if (appError) {
            adminToast('Error updating application: ' + appError.message, 'error', 5000);
            return;
        }

        // Log the action
        await logAdminAction('verification_approved', userId, { verification_id: verificationId }, `Approved verification for @${username}`);

        adminToast(`@${username} has been verified!`, 'success');
        ui.closeDrawer();
        // Reflect verified state on every application row from this user.
        allVerifications.forEach(v => {
            if (v.user_id === userId && v.user) v.user.is_verified = true;
        });
        patchVerification(verificationId, { status: 'approved', reviewed_by: currentAdminId, reviewed_at: new Date().toISOString() });
    };

    // ── Reject (ported rejectVerification) ──
    window.v_reject = async function(verificationId, username) {
        const reason = await adminPrompt({
            title: 'Reject verification',
            message: `Why are you rejecting verification for @${username}?\n\nThis reason will be shown to the user.`,
            placeholder: 'Rejection reason (visible to the user)',
            multiline: true,
            dangerLevel: 'warning'
        });
        if (!reason) return;

        const verification = allVerifications.find(v => String(v.id) === String(verificationId));

        const { error } = await supabaseClient
            .from('verification_applications')
            .update({
                status: 'rejected',
                rejection_reason: reason,
                reviewed_by: currentAdminId,
                reviewed_at: new Date().toISOString()
            })
            .eq('id', verificationId);

        if (error) {
            adminToast('Error: ' + error.message, 'error', 5000);
            return;
        }

        await logAdminAction('verification_rejected', verification.user_id, { verification_id: verificationId, reason }, `Rejected verification for @${username}: ${reason}`);

        adminToast(`Verification rejected for @${username}`, 'success');
        ui.closeDrawer();
        patchVerification(verificationId, { status: 'rejected', rejection_reason: reason, reviewed_by: currentAdminId, reviewed_at: new Date().toISOString() });
    };
})();
