// Reports — unified moderation queue across blip / announcement / profile /
// video-reply / comment reports. All Supabase queries + RPCs ported verbatim
// from admin-legacy.html (loadReports, attachReporters, updateReportStatus,
// deleteBlipFromReport, deleteAnnouncementFromReport,
// deleteVideoReplyFromReport, deleteCommentFromReport, openReportDetail).
(() => {
    // Cap how many of each report type we fetch per load. "Load older reports"
    // bumps this. Without a limit the dashboard freezes when total reports
    // pass a few thousand. PAGE_SIZE per table = up to PAGE_SIZE*5 displayed.
    const PAGE_SIZE = 100;
    let reportsLimit = PAGE_SIZE;
    let allReports = [];
    let statusFilter = 'pending'; // Default to showing pending reports (legacy default)
    let typeFilter = 'all';
    let searchQuery = '';

    // Translucent type tints — same colors as the legacy badges.
    const TYPE_TINT = {
        blip:         { bg: 'rgba(194,144,47,0.18)', fg: '#C2902F' },
        announcement: { bg: 'rgba(255,152,0,0.18)',  fg: '#FF9800' },
        video_reply:  { bg: 'rgba(255,140,0,0.18)',  fg: '#FF8C00' },
        comment:      { bg: 'rgba(27,158,119,0.18)', fg: '#1B9E77' },
        profile:      { bg: 'rgba(74,144,226,0.18)', fg: '#4A90E2' },
    };
    const STATUSES = ['pending', 'investigating', 'reviewed', 'dismissed', 'actioned'];
    const CHIPS = [
        ['all', 'All'],
        ['pending', 'Pending'],
        ['reviewed', 'Reviewed'],
        ['resolved', 'Resolved'],
        ['dismissed', 'Dismissed'],
    ];

    registerRoute('reports', {
        title: 'Reports', icon: '🚩', order: 2, badgeKey: 'reports',
        async render(el) {
            el.innerHTML = `
                <h2 class="page">Reports</h2>
                <p class="pagesub">User reports across blips, announcements, profiles, video replies, and comments.</p>
                <div class="toolbar">
                    <div id="rChips" style="display:flex; gap:6px; flex-wrap:wrap;"></div>
                    <select id="rType" onchange="r_setType(this.value)">
                        <option value="all">All types</option>
                        <option value="blip">Blip</option>
                        <option value="announcement">Announcement</option>
                        <option value="profile">Profile</option>
                        <option value="video_reply">Video reply</option>
                        <option value="comment">Comment</option>
                    </select>
                    <input type="search" id="rSearch" placeholder="Filter by username…" oninput="r_search(this.value)" style="min-width:220px;">
                </div>
                <div id="rList" class="spin">Loading…</div>`;
            document.getElementById('rType').value = typeFilter;
            document.getElementById('rSearch').value = searchQuery;
            renderChips();
            await load();
        },
    });

    function renderChips() {
        const box = document.getElementById('rChips');
        if (!box) return;
        box.innerHTML = CHIPS.map(([val, label]) => `
            <button class="btn sm ${statusFilter === val ? 'gold' : ''}" onclick="r_setFilter('${val}')">${label}</button>`).join('');
    }

    // ── Data loading — queries ported byte-for-byte from legacy loadReports ──
    async function fetchReports() {
        // The five report-table queries are independent — fire them in
        // parallel (previously sequential; this tab reloads on every
        // status change and realtime event, so it was the slowest page).
        const [
            { data: blipReports },
            { data: announcementReports },
            { data: profileReports },
            { data: videoReplyReports, error: videoReplyError },
            { data: commentReports, error: commentReportError },
        ] = await Promise.all([
            supabaseClient
                .from('blip_reports')
                .select(`
                    *,
                    blips(id, video_url, thumbnail_url, user_id, title, description, latitude, longitude, views_count, created_at, is_public),
                    users!blip_reports_reported_by_fkey(username),
                    blip_owner:users!blip_reports_blip_owner_id_fkey(id, username)
                `)
                .order('created_at', { ascending: false })
                .limit(reportsLimit),
            supabaseClient
                .from('announcement_reports')
                .select(`
                    *,
                    announcements(id, video_url, thumbnail_url, user_id, created_at, views_count, latitude, longitude, deleted_at, deleted_by, announcement_owner:users!announcements_user_id_fkey(id, username)),
                    reporter:users!announcement_reports_reporter_id_fkey(username)
                `)
                .order('created_at', { ascending: false })
                .limit(reportsLimit),
            supabaseClient
                .from('profile_reports')
                .select(`
                    *,
                    reported_user:users!profile_reports_reported_user_id_fkey(id, username, avatar_url),
                    reporter:users!profile_reports_reported_by_fkey(username)
                `)
                .neq('report_type', 'appeal') // Exclude appeals from reports
                .order('created_at', { ascending: false })
                .limit(reportsLimit),
            supabaseClient
                .from('video_reply_reports')
                .select(`
                    *,
                    video_reply:video_replies(
                        id, video_url, thumbnail_url, replied_by, blip_id,
                        location_lat, location_lon, created_at,
                        replier:users!video_replies_replied_by_fkey(id, username),
                        blip:blips(
                            id, user_id, title,
                            blip_owner:users!blips_user_id_fkey(id, username)
                        )
                    )
                `)
                .order('created_at', { ascending: false })
                .limit(reportsLimit),
            supabaseClient
                .from('blip_comment_reports')
                .select(`
                    *,
                    comment:blip_comments(
                        id, content, user_id, blip_id, created_at,
                        commenter:users!blip_comments_user_id_fkey(id, username)
                    )
                `)
                .order('created_at', { ascending: false })
                .limit(reportsLimit),
        ]);

        if (videoReplyError) console.error('Error loading video reply reports:', videoReplyError);
        if (commentReportError) console.error('Error loading comment reports:', commentReportError);

        // Reporter usernames for video-reply + comment reports aren't
        // joinable (reported_by -> auth.users, no public FK) — fetch both
        // username maps in one parallel pass.
        const attachReporters = async (reports) => {
            if (!reports || reports.length === 0) return;
            const reporterIds = [...new Set(reports.map(r => r.reported_by))];
            const { data: reporters } = await supabaseClient
                .from('users')
                .select('id, username')
                .in('id', reporterIds);
            if (reporters) {
                const reporterMap = Object.fromEntries(reporters.map(u => [u.id, u]));
                reports.forEach(report => {
                    report.reporter = reporterMap[report.reported_by];
                });
            }
        };
        await Promise.all([attachReporters(videoReplyReports), attachReporters(commentReports)]);

        return [
            ...(blipReports || []).map(r => ({ ...r, reportType: 'blip' })),
            ...(announcementReports || []).map(r => ({ ...r, reportType: 'announcement' })),
            ...(profileReports || []).map(r => ({ ...r, reportType: 'profile' })),
            ...(videoReplyReports || []).map(r => ({ ...r, reportType: 'video_reply' })),
            ...(commentReports || []).map(r => ({ ...r, reportType: 'comment' }))
        ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    async function load() {
        const box = document.getElementById('rList');
        if (box) { box.className = 'spin'; box.textContent = 'Loading…'; }
        allReports = await cache.get('reports:' + reportsLimit, fetchReports, 30000);
        renderList();
    }

    // ── Per-row identity helpers (same extraction logic as legacy displayReports) ──
    function rowUsers(report) {
        if (report.reportType === 'blip') {
            return {
                reportedByUser: report.users?.username,
                reportedUser: report.blip_owner?.username,
                reportedUserId: report.blip_owner_id,
                reporterId: report.reported_by,
            };
        } else if (report.reportType === 'announcement') {
            return {
                reportedByUser: report.reporter?.username,
                reportedUser: report.announcements?.announcement_owner?.username,
                reportedUserId: report.announcements?.user_id,
                // announcement_reports keys the reporter as reporter_id (legacy
                // list used reported_by here, which is undefined on this table).
                reporterId: report.reporter_id,
            };
        } else if (report.reportType === 'video_reply') {
            return {
                reportedByUser: report.reporter?.username,
                reportedUser: report.video_reply?.replier?.username,
                reportedUserId: report.video_reply?.replied_by,
                reporterId: report.reported_by,
            };
        } else if (report.reportType === 'comment') {
            return {
                reportedByUser: report.reporter?.username,
                reportedUser: report.comment?.commenter?.username,
                reportedUserId: report.comment?.user_id,
                reporterId: report.reported_by,
            };
        }
        return {
            reportedByUser: report.reporter?.username,
            reportedUser: report.reported_user?.username,
            reportedUserId: report.reported_user_id,
            reporterId: report.reported_by,
        };
    }

    function filtered() {
        let list = allReports.filter(report => {
            if (statusFilter === 'pending') {
                // "Pending" = still needs attention. 'investigating' is an
                // open case (it also suspends the blip purge timer), so it
                // belongs in the active queue (legacy behavior).
                return report.status === 'pending' || report.status === 'investigating';
            } else if (statusFilter === 'reviewed') {
                return report.status === 'reviewed';
            } else if (statusFilter === 'resolved') {
                return report.status === 'actioned' || report.status === 'resolved';
            } else if (statusFilter === 'dismissed') {
                return report.status === 'dismissed';
            }
            return true; // 'all'
        });
        if (typeFilter !== 'all') list = list.filter(r => r.reportType === typeFilter);
        const q = searchQuery.toLowerCase().trim();
        if (q) {
            list = list.filter(report => {
                const { reportedByUser, reportedUser } = rowUsers(report);
                return (reportedByUser || '').toLowerCase().includes(q) ||
                       (reportedUser || '').toLowerCase().includes(q);
            });
        }
        return list;
    }

    function statusPill(status) {
        const cls = (status === 'pending' || status === 'investigating') ? 'warn' : 'ok';
        return `<span class="pill ${cls}">${esc(status)}</span>`;
    }
    function typePill(type) {
        const t = TYPE_TINT[type] || TYPE_TINT.profile;
        return `<span class="pill" style="background:${t.bg}; color:${t.fg};">${esc(type.toUpperCase().replace('_', ' '))}</span>`;
    }
    function statusSelect(report, handler) {
        return `
            <select onclick="event.stopPropagation()" onchange="${handler}('${jsEsc(report.id)}', this.value, '${jsEsc(report.reportType)}')"
                style="padding:6px 10px; border-radius:7px; border:1px solid var(--border-strong); font-size:12px; cursor:pointer; background:var(--well); color:var(--cream); font-family:inherit;">
                <option value="${esc(report.status)}" selected>${esc(report.status)}</option>
                ${STATUSES.filter(s => s !== report.status).map(s => `<option value="${s}">${s}</option>`).join('')}
            </select>`;
    }

    function renderList() {
        const box = document.getElementById('rList');
        if (!box) return;
        renderChips();
        const list = filtered();
        if (!list.length) {
            box.className = 'empty';
            box.innerHTML = `No reports found.
                <div style="margin-top:14px;"><button class="btn sm" onclick="r_loadMore()">Load older reports (currently up to ${reportsLimit} per category)</button></div>`;
            return;
        }
        box.className = '';
        box.innerHTML = `
            <div class="tblwrap">
                <table class="tbl">
                    <thead><tr><th>Type</th><th>Reported user</th><th>Reporter</th><th>Reason</th><th>When</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead>
                    <tbody>
                        ${list.map(report => {
                            const { reportedByUser, reportedUser, reportedUserId, reporterId } = rowUsers(report);
                            return `
                            <tr onclick="r_openDetail('${jsEsc(report.id)}', '${jsEsc(report.reportType)}')" style="cursor:pointer;">
                                <td>${typePill(report.reportType)}</td>
                                <td><span class="userchip"><span class="nm" onclick="event.stopPropagation(); openUser('${jsEsc(reportedUserId)}')">@${esc(reportedUser || 'Unknown')}</span></span></td>
                                <td><span class="userchip"><span class="nm" onclick="event.stopPropagation(); openUser('${jsEsc(reporterId)}')">@${esc(reportedByUser || 'Unknown')}</span></span></td>
                                <td style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(report.details || 'No additional details')}">${esc(report.reason || '—')}</td>
                                <td title="${esc(fmtDate(report.created_at))}">${timeAgo(report.created_at)}</td>
                                <td>${statusPill(report.status)}</td>
                                <td style="text-align:right; white-space:nowrap;">
                                    <button class="btn sm" onclick="event.stopPropagation(); r_openDetail('${jsEsc(report.id)}', '${jsEsc(report.reportType)}')">View</button>
                                    ${statusSelect(report, 'r_setStatus')}
                                </td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
            <div style="text-align:center; margin-top:16px;">
                <button class="btn sm" onclick="r_loadMore()">Load older reports (currently up to ${reportsLimit} per category)</button>
                <div style="margin-top:8px; font-size:11px; color:var(--muted);">Showing ${list.length} reports</div>
            </div>`;
    }

    // ── Toolbar handlers ──
    window.r_setFilter = function(filter) { statusFilter = filter; renderList(); };
    window.r_setType = function(type) { typeFilter = type; renderList(); };
    window.r_search = function(q) { searchQuery = q; renderList(); };

    // Doubles the per-table cap and reloads. Keeps things simple — for a
    // moderation queue the most recent reports are what matters; rare to
    // need to scroll back through thousands.
    window.r_loadMore = async function() {
        reportsLimit *= 2;
        adminToast(`Loading up to ${reportsLimit} per category…`, 'info', 1500);
        await load();
    };

    // ── Status change (ported updateReportStatus) — update in memory, no full reload ──
    window.r_setStatus = async function(reportId, status, reportType) {
        let tableName;
        if (reportType === 'blip') {
            tableName = 'blip_reports';
        } else if (reportType === 'announcement') {
            tableName = 'announcement_reports';
        } else if (reportType === 'video_reply') {
            tableName = 'video_reply_reports';
        } else if (reportType === 'comment') {
            tableName = 'blip_comment_reports';
        } else {
            tableName = 'profile_reports';
        }

        const { error } = await supabaseClient
            .from(tableName)
            .update({
                status: status,
                reviewed_by: currentAdminId,
                reviewed_at: new Date().toISOString()
            })
            .eq('id', reportId);

        if (error) {
            adminToast('Error: ' + error.message, 'error', 5000);
            renderList(); // reset any optimistic dropdown state
            return;
        }

        adminToast(`Report status updated to: ${status}`, 'success');
        const report = allReports.find(r => String(r.id) === String(reportId) && r.reportType === reportType);
        if (report) {
            report.status = status;
            report.reviewed_by = currentAdminId;
            report.reviewed_at = new Date().toISOString();
        }
        renderList();
        cache.bust('reports');
        cache.bust('badges');
        refreshBadges();
    };

    // Detail-drawer variant: change status, then close the drawer (legacy
    // updateReportStatusFromDetail behavior).
    window.r_setStatusFromDetail = async function(reportId, status, reportType) {
        await window.r_setStatus(reportId, status, reportType);
        ui.closeDrawer();
    };

    // ── Report detail drawer (ported openReportDetail, five type branches) ──
    function mediaThumb(videoUrl, thumbUrl) {
        const play = videoUrl ? `onclick="ui.player('${jsEsc(videoUrl)}')"` : '';
        return thumbUrl
            ? `<img class="thumb" style="width:120px; height:120px;" src="${esc(thumbUrl)}" ${play}>`
            : `<div class="thumb ph" style="width:120px; height:120px;" ${play}>📹</div>`;
    }
    function mapsLink(lat, lng) {
        return (lat && lng)
            ? `📍 ${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)} · <a href="https://www.google.com/maps?q=${Number(lat)},${Number(lng)}" target="_blank" rel="noopener">Google Maps</a>`
            : 'No location data';
    }
    function userLink(id, username) {
        return `<span class="userchip" style="display:inline-flex;"><span class="nm" onclick="openUser('${jsEsc(id)}')">@${esc(username || 'Unknown')}</span></span>`;
    }
    function detailsBlock(text) {
        return `<div style="white-space:pre-wrap; background:var(--well); color:var(--cream); padding:10px; border-radius:8px; margin-top:6px;">${esc(text || 'No additional details provided')}</div>`;
    }
    function statusButtons(report) {
        const accent = { reviewed: 'ok', dismissed: '', actioned: 'gold', investigating: 'warn', pending: '' };
        return STATUSES.filter(s => s !== report.status).map(s => `
            <button class="btn sm ${accent[s] || ''}" onclick="r_setStatusFromDetail('${jsEsc(report.id)}', '${s}', '${jsEsc(report.reportType)}')">Mark ${s}</button>`).join('');
    }
    function reportInfoSect(report, reporterId, reporterName, detailsText) {
        return `
            <div class="sect">
                <h4>Report information</h4>
                <div class="kv">
                    <div class="k">Category</div><div class="v">${esc(report.reason || '—')}</div>
                    <div class="k">Status</div><div class="v">${statusPill(report.status)}</div>
                    <div class="k">Reported by</div><div class="v">${userLink(reporterId, reporterName)}</div>
                    <div class="k">Reported on</div><div class="v">${esc(fmtDate(report.created_at))}</div>
                </div>
                <div style="margin-top:10px;"><span style="color:var(--muted); font-size:12.5px;">Additional details</span>${detailsBlock(detailsText)}</div>
            </div>`;
    }

    window.r_openDetail = function(reportId, reportType) {
        const report = allReports.find(r => String(r.id) === String(reportId) && r.reportType === reportType);
        if (!report) {
            adminToast('Report not found', 'error', 5000);
            return;
        }

        let title = '';
        let html = '';

        if (reportType === 'blip') {
            const blip = report.blips;
            const reporter = report.users;
            const owner = report.blip_owner;
            title = 'Blip report';
            html = `
                ${reportInfoSect(report, report.reported_by, reporter?.username, report.details)}
                <div class="sect">
                    <h4>Reported blip</h4>
                    ${blip ? `
                        <div style="display:flex; gap:16px; align-items:flex-start;">
                            ${mediaThumb(blip.video_url, blip.thumbnail_url)}
                            <div class="kv" style="flex:1;">
                                <div class="k">Owner</div><div class="v">${owner?.username ? userLink(report.blip_owner_id, owner.username) : '—'}</div>
                                <div class="k">Title</div><div class="v">${esc(blip.title || 'No title')}</div>
                                <div class="k">Description</div><div class="v">${esc(blip.description || 'No description')}</div>
                                <div class="k">Location</div><div class="v">${mapsLink(blip.latitude, blip.longitude)}</div>
                                <div class="k">Views</div><div class="v">👁️ ${blip.views_count || 0} views</div>
                                <div class="k">Visibility</div><div class="v">${blip.is_public ? '🌍 Public' : '🔒 Private'}</div>
                                <div class="k">Uploaded</div><div class="v">${esc(fmtDate(blip.created_at))}</div>
                            </div>
                        </div>` : '<div class="empty" style="padding:18px;">Blip has been deleted</div>'}
                </div>
                <div class="sect">
                    <h4>Actions</h4>
                    <div class="actionrow">${statusButtons(report)}</div>
                    ${blip ? `<div class="actionrow" style="margin-top:8px;">
                        <button class="btn sm danger" onclick="r_deleteBlip('${jsEsc(blip.id)}', '@${jsEsc(owner?.username || 'Unknown')}', '${jsEsc(report.id)}')">Delete blip</button>
                    </div>` : ''}
                </div>`;
        } else if (reportType === 'announcement') {
            const announcement = report.announcements;
            const reporter = report.reporter;
            const owner = announcement?.announcement_owner;
            title = 'Announcement report';
            html = `
                ${reportInfoSect(report, report.reporter_id, reporter?.username, report.description || report.details)}
                <div class="sect">
                    <h4>Reported announcement</h4>
                    ${announcement ? `
                        ${announcement.deleted_at ? `
                            <div class="card" style="border-color:var(--danger); margin-bottom:12px;">
                                <div style="color:var(--danger); font-weight:900; margin-bottom:6px;">🗑️ REMOVED FROM APP</div>
                                <div style="color:var(--muted); font-size:13px;">Hidden from users on ${esc(fmtDate(announcement.deleted_at))}. Still in your dashboard for investigation and record-keeping.</div>
                            </div>` : ''}
                        <div style="display:flex; gap:16px; align-items:flex-start;">
                            ${mediaThumb(announcement.video_url, announcement.thumbnail_url)}
                            <div class="kv" style="flex:1;">
                                <div class="k">Owner</div><div class="v">${owner?.username ? userLink(announcement.user_id, owner.username) : '—'}</div>
                                <div class="k">Location</div><div class="v">${mapsLink(announcement.latitude, announcement.longitude)}</div>
                                <div class="k">Views</div><div class="v">👁️ ${announcement.views_count || 0} views</div>
                                <div class="k">Posted</div><div class="v">${esc(fmtDate(announcement.created_at))}</div>
                            </div>
                        </div>` : '<div class="empty" style="padding:18px;">Announcement record not found</div>'}
                </div>
                <div class="sect">
                    <h4>Actions</h4>
                    <div class="actionrow">${statusButtons(report)}</div>
                    ${announcement ? `<div class="actionrow" style="margin-top:8px;">
                        ${!announcement.deleted_at
                            ? `<button class="btn sm danger" onclick="r_deleteAnnouncement('${jsEsc(announcement.id)}', '@${jsEsc(owner?.username || 'Unknown')}', '${jsEsc(report.id)}')">Remove from app</button>`
                            : `<button class="btn sm" disabled>Already removed</button>`}
                    </div>` : ''}
                </div>`;
        } else if (reportType === 'video_reply') {
            const videoReply = report.video_reply;
            const reporter = report.reporter;
            const sender = videoReply?.replier;
            const recipient = videoReply?.blip?.blip_owner;
            const originalBlip = videoReply?.blip;
            title = 'Video reply report';
            html = `
                ${reportInfoSect(report, report.reported_by, reporter?.username, report.details)}
                <div class="sect">
                    <h4>Reported video reply</h4>
                    ${videoReply ? `
                        <div style="display:flex; gap:16px; align-items:flex-start;">
                            ${mediaThumb(videoReply.video_url, videoReply.thumbnail_url)}
                            <div class="kv" style="flex:1;">
                                <div class="k">Sent by</div><div class="v">${userLink(videoReply.replied_by, sender?.username)}</div>
                                <div class="k">Sent to</div><div class="v">${userLink(originalBlip?.user_id, recipient?.username)}</div>
                                <div class="k">Reply to blip by</div><div class="v">${userLink(originalBlip?.user_id, originalBlip?.blip_owner?.username)}${originalBlip?.id ? ` <span style="color:var(--muted); font-size:12px;">(Blip ID: ${esc(originalBlip.id)})</span>` : ''}</div>
                                <div class="k">Location</div><div class="v">${mapsLink(videoReply.location_lat, videoReply.location_lon)}</div>
                                <div class="k">Sent</div><div class="v">${esc(fmtDate(videoReply.created_at))}</div>
                            </div>
                        </div>` : '<div class="empty" style="padding:18px;">Video reply has been deleted</div>'}
                </div>
                <div class="sect">
                    <h4>Actions</h4>
                    <div class="actionrow">${statusButtons(report)}</div>
                    ${videoReply ? `<div class="actionrow" style="margin-top:8px;">
                        <button class="btn sm danger" onclick="r_deleteVideoReply('${jsEsc(videoReply.id)}', '@${jsEsc(sender?.username || 'Unknown')}', '${jsEsc(report.id)}')">Delete video reply</button>
                    </div>` : ''}
                </div>`;
        } else if (reportType === 'comment') {
            const comment = report.comment;
            const commenter = comment?.commenter;
            const reporter = report.reporter;
            title = 'Comment report';
            html = `
                ${reportInfoSect(report, report.reported_by, reporter?.username, report.details)}
                <div class="sect">
                    <h4>Reported comment</h4>
                    <div style="font-style:italic; background:var(--well); color:var(--cream); padding:12px; border-radius:8px; white-space:pre-wrap;">“${esc(comment?.content || '(comment unavailable — may have been deleted)')}”</div>
                    <div style="margin-top:10px;">By ${userLink(comment?.user_id || '', commenter?.username)}</div>
                </div>
                <div class="sect">
                    <h4>Actions</h4>
                    <div class="actionrow">${statusButtons(report)}</div>
                    ${comment?.id ? `<div class="actionrow" style="margin-top:8px;">
                        <button class="btn sm danger" onclick="r_deleteComment('${jsEsc(comment.id)}', '@${jsEsc(commenter?.username || 'Unknown')}', '${jsEsc(report.id)}', '${jsEsc(comment?.user_id || '')}', '${jsEsc(report.reason || '')}')">Delete comment</button>
                    </div>` : ''}
                </div>`;
        } else {
            // Profile report
            const reportedUser = report.reported_user;
            const reporter = report.reporter;
            title = 'Profile report';
            html = `
                ${reportInfoSect(report, report.reported_by, reporter?.username, report.details)}
                <div class="sect">
                    <h4>Reported user</h4>
                    <div class="userchip">
                        ${avatarHtml(reportedUser?.avatar_url, reportedUser?.username, 48)}
                        <span class="nm" onclick="openUser('${jsEsc(report.reported_user_id)}')">@${esc(reportedUser?.username || 'Unknown')}</span>
                    </div>
                </div>
                <div class="sect">
                    <h4>Actions</h4>
                    <div class="actionrow">${statusButtons(report)}</div>
                </div>`;
        }

        ui.drawer({ title: `${title} ${statusPill(report.status)}`, html });
    };

    // Shared post-delete refresh: content changed, so refetch the queue.
    async function afterContentDelete() {
        ui.closeDrawer();
        cache.bust('reports');
        cache.bust('badges');
        await load();
        refreshBadges();
    }

    // ── Content deletes (RPCs ported verbatim from legacy) ──
    window.r_deleteBlip = async function(blipId, username, reportId) {
        const ok = await adminConfirm({
            title: `Delete reported blip by ${username}`,
            message: `Permanently delete this blip and all its likes/comments/views/recipients.\n\nBlip ID: ${blipId}\nReport ID: ${reportId}`,
            dangerLevel: 'destructive',
            confirmLabel: 'Delete blip',
        });
        if (!ok) return;

        // Use admin_delete_blip RPC (handles dependent-row cleanup +
        // server-side admin check) instead of a direct .delete().
        const { error } = await supabaseClient
            .rpc('admin_delete_blip', { p_blip_id: blipId });

        if (error) {
            adminToast('Delete failed: ' + error.message, 'error');
            return;
        }

        await logAdminAction('delete_blip', null, { blip_id: blipId, report_id: reportId }, `Deleted reported blip by ${username}`);
        adminToast('Blip deleted', 'success');
        await afterContentDelete();
    };

    window.r_deleteAnnouncement = async function(announcementId, username, reportId) {
        const ok = await adminConfirm({
            title: `Remove announcement by ${username}`,
            message: `This hides the announcement from the app but keeps it in the DB for moderation records.\n\nAnnouncement ID: ${announcementId}\nReport ID: ${reportId}`,
            dangerLevel: 'warning',
            confirmLabel: 'Hide announcement',
        });
        if (!ok) return;

        // Use the soft_delete_announcement SECURITY DEFINER RPC instead of
        // a direct .update. The RPC verifies the caller is an admin
        // server-side and sets deleted_at/deleted_by atomically.
        const { error } = await supabaseClient
            .rpc('soft_delete_announcement', { announcement_id: announcementId });

        if (error) {
            adminToast('Remove failed: ' + error.message, 'error');
            return;
        }

        await logAdminAction('soft_delete_announcement', null, { announcement_id: announcementId, report_id: reportId }, `Soft-deleted announcement by ${username} (hidden from app, kept for records)`);
        adminToast('Announcement hidden from app (still visible to admins)', 'success', 4500);
        await afterContentDelete();
    };

    window.r_deleteVideoReply = async function(videoReplyId, username, reportId) {
        const ok = await adminConfirm({
            title: `Delete video reply by ${username}`,
            message: `This permanently removes the video reply.\n\nReport ID: ${reportId}\n\nThis CANNOT be undone.`,
            dangerLevel: 'destructive',
            confirmLabel: 'Delete reply',
        });
        if (!ok) return;

        // Use admin_delete_video_reply RPC (server-side admin check + atomic log)
        const { error } = await supabaseClient.rpc('admin_delete_video_reply', {
            p_reply_id: videoReplyId,
        });

        if (error) {
            adminToast('Delete failed: ' + error.message, 'error');
            return;
        }

        adminToast('Video reply deleted', 'success');
        await afterContentDelete();
    };

    window.r_deleteComment = async function(commentId, username, reportId, authorUserId, reason) {
        const ok = await adminConfirm({
            title: `Delete comment by ${username}`,
            message: `This permanently removes the comment (and any replies to it).\n\nComment ID: ${commentId}\nReport ID: ${reportId}\n\nThis CANNOT be undone.`,
            dangerLevel: 'destructive',
            confirmLabel: 'Delete comment',
        });
        if (!ok) return;

        // admin_delete_comment: SECURITY DEFINER, verifies is_admin
        // server-side, bypasses RLS. The delete CASCADEs to replies, likes,
        // and the comment's own report rows.
        const { error } = await supabaseClient.rpc('admin_delete_comment', {
            p_comment_id: commentId,
        });

        if (error) {
            adminToast('Delete failed: ' + error.message, 'error');
            return;
        }

        // Log against the COMMENT AUTHOR (not null) + the report reason, so it
        // shows in that user's Admin Action History with the "why".
        await logAdminAction(
            'admin_delete_comment',
            authorUserId || null,
            { comment_id: commentId, report_id: reportId, reason: reason || null },
            `Deleted reported comment by ${username}${reason ? ' — ' + reason : ''}`,
        );
        adminToast('Comment deleted', 'success');
        await afterContentDelete();
    };
})();
