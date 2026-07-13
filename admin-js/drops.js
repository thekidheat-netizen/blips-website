// ═══════════════════════════════════════════════════════════════════════
// Drops (Blip Coins) — UX facelift of the ported legacy admin-drops section.
//
// Three sub-views (was six):
//   New Drop  — 4-step wizard (Where / What / Who / Launch) replacing the
//               separate Single & Bulk forms. Wizard state lives in module
//               scope, so switching sub-tabs never loses work.
//   Manage    — unified Browse + Batches + Map: stat tiles, filter chips,
//               batch-grouped collapsible list ⇄ map view of the same
//               filtered set. Coin detail opens in ui.drawer.
//   Insights  — the audit dashboard (stats row, top claimants, code lookup).
//
// EVERY write path is byte-for-byte from the legacy port:
//   storage uploads  blip-videos / admin-drops/${Date.now()}.${ext} and
//                    admin-drops/${Date.now()}_bulk.${ext}
//   edge fns         create-admin-drop (hardcoded URL, headers, body keys),
//                    ${SUPABASE_URL}/functions/v1/notify-drop-batch
//   RPCs             bulk_insert_admin_drops_at_points (11 params),
//                    admin_bulk_delete_admin_drops, admin_list_drop_batches,
//                    admin_delete_drops_batch
//   UPDATEs          is_active toggle, video_duration_seconds backfills
//   reads            audit dashboard, coin detail (+users/ledger/emails),
//                    viewer audit, recipients — all identical.
// Only intentional read deviation: the unified Manage fetch needs
// bulk_batch_id to group by batch, so it reuses the EXACT column list from
// the ported batch-detail SELECT combined with the ported map-view's
// order('created_at' desc) + limit(2000). "Deactivate all" on a batch loops
// the ported per-coin toggle UPDATE (no new call shapes).
//
// Legacy dead code remains skipped (retired #adminDropsList table cluster:
// loadAdminDrops/groupAdminDrops/renderAdminDropsList/group modal/
// updateDropMarkersOnMap/toggleDropActive/deleteAdminDrop/toggleViewerDetails).
// ═══════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    // ───────── module state ─────────
    let _sub = 'new'; // 'new' | 'manage' | 'insights' — survives re-renders

    // Wizard state — module scope so tab switches / route re-renders keep it.
    // Numeric fields stored as strings (parsed at use) to mirror how legacy
    // read raw input .value strings.
    const wiz = {
        step: 1,
        mode: 'single',          // 'single' | 'area'
        // WHERE
        location: null,          // {lat,lng} single mode
        locationLabel: '',
        center: null,            // {lat,lng} area mode
        centerLabel: '',
        spreadKm: '10',
        count: '50',
        // WHAT
        file: null,              // File object (persists in memory)
        fileUrl: null,           // object URL for inline preview
        videoDurationSeconds: null,
        durationNote: '',
        currency: 'CREDITS',
        value: '100',            // single-mode value
        valueMin: '50',
        valueMax: '500',
        geofence: '30',
        title: '',
        description: '',
        iconType: 'coin',        // single mode only (bulk RPC hardcodes 'coin')
        viewLimit: '1',          // blank = unlimited (single mode)
        // WHO & WHEN
        expiresPreset: 'never',
        expiresAt: '',           // datetime-local string
        notifMessage: '',
        notifRadius: '5',
        // launch
        launching: false,
        result: null,            // set after successful launch → success screen
    };

    // Wizard map objects (DOM-bound — reset on route re-render)
    let wizMap = null, wizMarker = null, wizCenterMarker = null, wizCircle = null;

    // Manage state
    const mng = {
        coins: [],
        batches: {},             // batch_id → admin_list_drop_batches row
        claimsToday: 0,
        status: 'all',           // all | active | fully_claimed | expired | inactive
        view: 'list',            // list | map
        closed: new Set(),       // collapsed group keys (groups default open)
        loading: false,
        everLoaded: false,
        pendingBatch: null,      // batch filter to apply after next load
    };
    let mngMap = null, mngMarkers = [], mngInfoWindow = null;
    let _mngSearchTimer = null;

    // Post-create stash for copy-all
    let _lastBulkCoinCodes = [];

    // Same key the shell's Maps JS <script> tag uses (legacy line 5358).
    const GOOGLE_API_KEY = 'AIzaSyA3ctp1Waczjq5VJZp-rO0I1eRa916I_8s';

    // Shared inline styles
    const INP  = 'width:100%; padding:11px; border:1px solid var(--border-strong); border-radius:8px; background:var(--well); color:var(--cream); font-size:14px; font-family:inherit;';
    const LBL  = 'display:block; margin-bottom:6px; color:var(--muted); font-size:12px;';
    const HINT = 'display:block; margin-top:4px; color:var(--muted); font-size:11px;';
    const H3   = 'margin:0 0 14px; color:var(--gold); font-size:15px; font-weight:900;';

    const DARK_MAP = [
        { elementType: 'geometry', stylers: [{ color: '#261E18' }] },
        { elementType: 'labels.text.stroke', stylers: [{ color: '#261E18' }] },
        { elementType: 'labels.text.fill', stylers: [{ color: '#9C8F80' }] },
        { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2C241D' }] },
        { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#1E1712' }] },
        { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    ];

    const STATUS_BADGE = {
        active:        { label: '● ACTIVE',  color: '#4CAF50', bg: 'rgba(76,175,80,0.15)' },
        inactive:      { label: 'INACTIVE',  color: '#A99C8D', bg: 'rgba(150,150,150,0.15)' },
        expired:       { label: 'EXPIRED',   color: '#FF9800', bg: 'rgba(255,152,0,0.12)' },
        fully_claimed: { label: '✓ CLAIMED', color: '#9C27B0', bg: 'rgba(156,39,176,0.15)' },
    };
    function statusBadgeHtml(status) {
        const b = STATUS_BADGE[status] || STATUS_BADGE.inactive;
        return `<span style="color:${b.color}; background:${b.bg}; font-weight:700; font-size:11px; padding:4px 10px; border-radius:12px; white-space:nowrap;">${b.label}</span>`;
    }

    // Live status precedence: inactive → expired → fully claimed → active.
    function computeCoinStatus(d) {
        if (!d.is_active) return 'inactive';
        if (d.expires_at && new Date(d.expires_at) < new Date()) return 'expired';
        if (d.view_limit != null && d.views_count != null && d.views_count >= d.view_limit) return 'fully_claimed';
        return 'active';
    }

    function fmtVal(amount, currency) {
        return currency === 'USD'
            ? `$${((amount || 0) / 100).toFixed(2)}`
            : `${(amount || 0).toLocaleString()} cr`;
    }

    const $id = (x) => document.getElementById(x);

    // ═════════ Route ═════════
    registerRoute('drops', {
        title: 'Drops', icon: '🪙', order: 7,
        render(el) {
            // DOM rebuilt — reset everything map/DOM-bound.
            wizMap = null; wizMarker = null; wizCenterMarker = null; wizCircle = null;
            mngMap = null; mngMarkers = []; mngInfoWindow = null;

            el.innerHTML = `
                <h2 class="page">🪙 Blip Coins</h2>
                <p class="pagesub">Drop geo-located coins. Users walk within the geofence and watch the full media to claim. Value is hidden on the map — they only see the tier color.</p>
                <div class="toolbar">
                    <button class="btn" data-dsub="new" onclick="d_setSubTab('new')">🚀 New Drop</button>
                    <button class="btn" data-dsub="manage" onclick="d_setSubTab('manage')">🗂 Manage</button>
                    <button class="btn" data-dsub="insights" onclick="d_setSubTab('insights')">📈 Insights</button>
                </div>
                <div id="d_pane_new" style="display:none;"></div>
                <div id="d_pane_manage" style="display:none;">${manageSkeletonHtml()}</div>
                <div id="d_pane_insights" style="display:none;">${insightsSkeletonHtml()}</div>`;
            renderWizard();
            window.d_setSubTab(_sub);
        },
    });

    // ═════════ Sub-tab switching ═════════
    // CRITICAL: a Google Map created while its container is display:none
    // renders gray. Panes are made visible FIRST, then maps init; re-showing
    // an existing map kicks google.maps.event.trigger(map,'resize').
    window.d_setSubTab = function (name) {
        _sub = name;
        for (const k of ['new', 'manage', 'insights']) {
            const pane = $id('d_pane_' + k);
            if (pane) pane.style.display = (k === name) ? 'block' : 'none';
        }
        document.querySelectorAll('[data-dsub]').forEach(b => b.classList.toggle('gold', b.dataset.dsub === name));

        if (name === 'new' && !wiz.result && wiz.step === 1) wizEnsureMap();
        if (name === 'manage') {
            window.d_manageLoad();          // always refresh on entry
            if (mng.view === 'map') mngEnsureMap();
        }
        if (name === 'insights') loadInsights();
    };
    // ═════════════════════════════════════════════════════════════════
    // NEW DROP — 4-step wizard
    // ═════════════════════════════════════════════════════════════════
    const WIZ_STEPS = [[1, 'Where'], [2, 'What'], [3, 'Who'], [4, 'Launch']];

    function renderWizard() {
        const pane = $id('d_pane_new');
        if (!pane) return;
        if (wiz.result) { pane.innerHTML = wizSuccessHtml(); return; }
        pane.innerHTML = `
            <div id="d_wizStepper"></div>
            <div id="d_wstep1">${wizStep1Html()}</div>
            <div id="d_wstep2" style="display:none;"></div>
            <div id="d_wstep3" style="display:none;"></div>
            <div id="d_wstep4" style="display:none;"></div>
            <div id="d_wizFooter" style="display:flex; justify-content:space-between; margin-top:16px;"></div>`;
        wizGoto(wiz.step, true);
    }

    function renderWizStepper() {
        const el = $id('d_wizStepper');
        if (!el) return;
        el.innerHTML = `
            <div class="card" style="display:flex; align-items:center; gap:8px; padding:12px 16px; margin-bottom:16px; flex-wrap:wrap;">
                ${WIZ_STEPS.map(([n, label], i) => {
                    const done = n < wiz.step, cur = n === wiz.step;
                    const circ = done
                        ? 'background:var(--gold); color:#1A1410; border:1px solid var(--gold);'
                        : cur
                            ? 'background:transparent; color:var(--gold); border:1px solid var(--gold);'
                            : 'background:transparent; color:var(--muted); border:1px solid var(--border-strong);';
                    return `
                        ${i > 0 ? `<span style="color:var(--border-strong); flex:1; border-top:1px solid var(--border-strong); min-width:12px;"></span>` : ''}
                        <span onclick="${done ? `d_wizGoto(${n})` : ''}" style="display:inline-flex; align-items:center; gap:8px; ${done ? 'cursor:pointer;' : ''}">
                            <span style="display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; border-radius:50%; font-size:12px; font-weight:900; ${circ}">${done ? '✓' : n}</span>
                            <span style="font-weight:${cur ? '900' : '700'}; color:${cur ? 'var(--cream)' : done ? 'var(--text)' : 'var(--muted)'}; font-size:13px;">${label}</span>
                        </span>`;
                }).join('')}
            </div>`;
    }

    function renderWizFooter() {
        const el = $id('d_wizFooter');
        if (!el) return;
        el.innerHTML = `
            <span>${wiz.step > 1 ? `<button class="btn" onclick="d_wizBack()">← Back</button>` : ''}</span>
            <span>${wiz.step < 4 ? `<button class="btn gold" onclick="d_wizNext()">Next →</button>` : ''}</span>`;
    }

    function wizGoto(n, skipRender) {
        wiz.step = n;
        renderWizStepper();
        for (let i = 1; i <= 4; i++) {
            const el = $id('d_wstep' + i);
            if (el) el.style.display = (i === n) ? 'block' : 'none';
        }
        // Steps 2–4 re-render from state on entry (mode-dependent fields,
        // fresh review). Step 1 keeps its DOM so the map survives.
        if (n === 2) $id('d_wstep2').innerHTML = wizStep2Html();
        if (n === 3) $id('d_wstep3').innerHTML = wizStep3Html();
        if (n === 4) $id('d_wstep4').innerHTML = wizStep4Html();
        if (n === 1 && !skipRender) wizEnsureMap();
        if (n === 1 && skipRender) wizEnsureMap();
        renderWizFooter();
    }
    window.d_wizGoto = function (n) { if (n < wiz.step) wizGoto(n); };
    window.d_wizBack = function () { if (wiz.step > 1) wizGoto(wiz.step - 1); };
    window.d_wizNext = function () {
        if (!wizValidateStep(wiz.step)) return;
        if (wiz.step < 4) wizGoto(wiz.step + 1);
    };

    function wizValidateStep(n) {
        if (n === 1) {
            if (wiz.mode === 'single') {
                if (!wiz.location) { adminToast('Click the map (or search an address) to set the drop spot', 'error'); return false; }
            } else {
                if (!wiz.center) { adminToast('Pick a city or click on the map first', 'error'); return false; }
                const count = parseInt(wiz.count);
                if (!(count >= 1 && count <= 500)) { adminToast('Count must be 1–500', 'error'); return false; }
            }
        }
        if (n === 2) {
            if (!wiz.title.trim()) { adminToast('Title is required', 'error'); return false; }
            const g = parseInt(wiz.geofence);
            if (!g || g < 1) { adminToast('Please enter a valid geofence radius', 'error'); return false; }
            if (wiz.mode === 'single') {
                const v = parseInt(wiz.value);
                if (!v || v < 0) { adminToast('Please enter a valid reward amount', 'error'); return false; }
            } else {
                const min = parseInt(wiz.valueMin), max = parseInt(wiz.valueMax);
                if (min < 0 || max < min || isNaN(min) || isNaN(max)) { adminToast('Invalid value range', 'error'); return false; }
                if (!wiz.file) { adminToast('Pick a media file — area drops share one video/image', 'error'); return false; }
            }
        }
        return true;
    }

    // ── Step 1: WHERE ──────────────────────────────────────────────────
    function wizStep1Html() {
        const single = wiz.mode === 'single';
        return `
            <div class="card">
                <h3 style="${H3}">📍 Where do the coins go?</h3>
                <div style="display:flex; gap:10px; margin-bottom:14px;">
                    <button class="btn ${single ? 'gold' : ''}" id="d_wizModeSingle" onclick="d_wizSetMode('single')" style="flex:1; padding:13px; justify-content:center;">🪙 Single spot</button>
                    <button class="btn ${!single ? 'gold' : ''}" id="d_wizModeArea" onclick="d_wizSetMode('area')" style="flex:1; padding:13px; justify-content:center;">🎯 Spread over an area</button>
                </div>
                <input type="text" id="d_wizSearch" placeholder="🔍 Search an address or city — or just click the map" style="${INP} margin-bottom:12px;">
                <div id="d_wizMap" style="width:100%; height:400px; border-radius:8px; margin-bottom:8px; background:var(--well);"></div>
                <div id="d_wizLocInfo" style="color:var(--muted); font-size:13px; padding:8px 0;">${wizLocInfoText()}</div>
                <div id="d_wizAreaControls" style="display:${single ? 'none' : 'block'}; border-top:1px solid var(--border); padding-top:14px; margin-top:6px;">
                    <div style="display:grid; grid-template-columns:2fr 1fr; gap:14px; align-items:end;">
                        <div>
                            <label style="${LBL}">Spread radius (km from center)</label>
                            <div style="display:flex; gap:10px; align-items:center;">
                                <input type="range" id="d_wizSpread" min="0.5" max="50" step="0.5" value="${esc(wiz.spreadKm)}" style="flex:1;" oninput="d_wizField('spreadKm', this.value)">
                                <span id="d_wizSpreadLabel" style="color:var(--gold); font-weight:bold; min-width:70px; text-align:right;">${esc(wiz.spreadKm)} km</span>
                            </div>
                        </div>
                        <div>
                            <label style="${LBL}">Number of coins (max 500)</label>
                            <input type="number" min="1" max="500" value="${esc(wiz.count)}" style="${INP}" oninput="d_wizField('count', this.value)">
                        </div>
                    </div>
                    <div id="d_wizAreaPreview" style="margin-top:12px; padding:12px; background:rgba(194,144,47,0.08); border:1px solid rgba(194,144,47,0.3); border-radius:8px; color:var(--text); font-size:13px;">${wizAreaPreviewText()}</div>
                    <small style="${HINT}">Coins are scattered at random points inside the circle, then each is snapped to the nearest road so none land in water or wilderness.</small>
                </div>
            </div>`;
    }

    function wizLocInfoText() {
        if (wiz.mode === 'single') {
            return wiz.location
                ? `<strong>Location set:</strong> ${wiz.location.lat.toFixed(6)}, ${wiz.location.lng.toFixed(6)}${wiz.locationLabel ? ` — ${esc(wiz.locationLabel)}` : ''}`
                : 'Click on the map to set the drop location';
        }
        return wiz.center
            ? `<strong style="color:var(--gold);">Center set:</strong> ${wiz.center.lat.toFixed(5)}, ${wiz.center.lng.toFixed(5)}${wiz.centerLabel ? ` — ${esc(wiz.centerLabel)}` : ''}`
            : 'Search a city or click on the map to set the center';
    }

    function wizAreaPreviewText() {
        const count = parseInt(wiz.count) || 0;
        const min = parseInt(wiz.valueMin) || 0;
        const max = parseInt(wiz.valueMax) || 0;
        if (count <= 0) return '<span style="color:var(--danger);">Set a coin count.</span>';
        const avg = (min + max) / 2;
        return `<strong style="color:var(--cream);">${count} coins</strong> scattered within <strong style="color:var(--gold);">${esc(wiz.spreadKm)} km</strong> of the center · est. total <strong style="color:var(--cream);">${fmtVal(Math.round(avg * count), wiz.currency)}</strong> <span style="color:var(--muted);">(per-coin values are set in the next step)</span>`;
    }

    window.d_wizSetMode = function (mode) {
        wiz.mode = mode;
        const single = mode === 'single';
        $id('d_wizModeSingle')?.classList.toggle('gold', single);
        $id('d_wizModeArea')?.classList.toggle('gold', !single);
        const area = $id('d_wizAreaControls');
        if (area) area.style.display = single ? 'none' : 'block';
        const info = $id('d_wizLocInfo');
        if (info) info.innerHTML = wizLocInfoText();
        // Show only the active mode's overlays.
        if (wizMarker) wizMarker.setMap(single && wiz.location ? wizMap : null);
        if (wizCenterMarker) wizCenterMarker.setMap(!single && wiz.center ? wizMap : null);
        if (wizCircle) wizCircle.setMap(!single && wiz.center ? wizMap : null);
    };

    function wizEnsureMap() {
        const mapEl = $id('d_wizMap');
        if (!mapEl || typeof google === 'undefined') return;
        if (wizMap) {
            const c = wizMap.getCenter();
            google.maps.event.trigger(wizMap, 'resize');
            if (c) wizMap.setCenter(c);
            return;
        }
        try {
            wizMap = new google.maps.Map(mapEl, {
                center: { lat: 34.0522, lng: -118.2437 }, // LA default
                zoom: 11,
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: true,
                styles: DARK_MAP,
            });

            const searchInput = $id('d_wizSearch');
            if (searchInput && google.maps.places) {
                const ac = new google.maps.places.Autocomplete(searchInput);
                ac.bindTo('bounds', wizMap);
                ac.addListener('place_changed', () => {
                    const place = ac.getPlace();
                    if (!place.geometry || !place.geometry.location) return;
                    wizMap.setCenter(place.geometry.location);
                    wizMap.setZoom(wiz.mode === 'single' ? 15 : 11);
                    const lat = place.geometry.location.lat();
                    const lng = place.geometry.location.lng();
                    const label = place.formatted_address || place.name;
                    if (wiz.mode === 'single') wizPlaceMarker(lat, lng, label);
                    else wizSetCenter(lat, lng, label);
                });
            }

            wizMap.addListener('click', (e) => {
                if (wiz.mode === 'single') wizPlaceMarker(e.latLng.lat(), e.latLng.lng());
                else wizSetCenter(e.latLng.lat(), e.latLng.lng());
            });

            // Restore overlays from state, else center on the admin.
            if (wiz.mode === 'single' && wiz.location) {
                wizPlaceMarker(wiz.location.lat, wiz.location.lng, wiz.locationLabel);
                wizMap.setCenter(wiz.location); wizMap.setZoom(14);
            } else if (wiz.mode === 'area' && wiz.center) {
                wizSetCenter(wiz.center.lat, wiz.center.lng, wiz.centerLabel);
                wizMap.setCenter(wiz.center);
            } else if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(
                    (position) => { wizMap.setCenter({ lat: position.coords.latitude, lng: position.coords.longitude }); },
                    (error) => { console.log('Geolocation error:', error); }
                );
            }
        } catch (error) {
            console.error('Error initializing map:', error);
            adminToast('Failed to initialize map. Please refresh the page.', 'error', 5000);
        }
    }

    function wizPlaceMarker(lat, lng, label) {
        wiz.location = { lat, lng };
        wiz.locationLabel = label || '';
        if (wizMarker) wizMarker.setMap(null);
        wizMarker = new google.maps.Marker({
            position: { lat, lng },
            map: wizMap,
            animation: google.maps.Animation.DROP,
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 10,
                fillColor: '#C2902F',
                fillOpacity: 1,
                strokeColor: '#FFA06B',
                strokeWeight: 3,
            },
        });
        const info = $id('d_wizLocInfo');
        if (info) info.innerHTML = wizLocInfoText();
    }

    function wizSetCenter(lat, lng, label) {
        wiz.center = { lat, lng };
        wiz.centerLabel = label || '';
        if (wizCenterMarker) wizCenterMarker.setMap(null);
        wizCenterMarker = new google.maps.Marker({
            position: { lat, lng },
            map: wizMap,
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 8,
                fillColor: '#C2902F',
                fillOpacity: 1,
                strokeColor: '#fff',
                strokeWeight: 2,
            },
        });
        wizDrawCircle();
        const info = $id('d_wizLocInfo');
        if (info) info.innerHTML = wizLocInfoText();
    }

    function wizDrawCircle() {
        if (!wiz.center || !wizMap) return;
        const km = parseFloat(wiz.spreadKm || '10');
        if (wizCircle) wizCircle.setMap(null);
        wizCircle = new google.maps.Circle({
            center: wiz.center,
            radius: km * 1000, // meters
            map: wizMap,
            fillColor: '#C2902F',
            fillOpacity: 0.10,
            strokeColor: '#C2902F',
            strokeOpacity: 0.7,
            strokeWeight: 2,
        });
    }

    // Generic field setter for wizard inputs + dependent hint refreshes.
    window.d_wizField = function (key, value) {
        wiz[key] = value;
        if (key === 'spreadKm') {
            const lbl = $id('d_wizSpreadLabel');
            if (lbl) lbl.textContent = `${value} km`;
            wizDrawCircle();
        }
        if (['spreadKm', 'count', 'valueMin', 'valueMax', 'currency'].includes(key)) {
            const prev = $id('d_wizAreaPreview');
            if (prev) prev.innerHTML = wizAreaPreviewText();
            const est = $id('d_wizEstimate');
            if (est) est.innerHTML = wizEstimateText();
        }
        if (['value', 'currency'].includes(key)) {
            const h = $id('d_wizValueHint');
            if (h) h.textContent = wizValueHintText();
        }
        if (key === 'expiresAt') {
            wiz.expiresPreset = value ? 'custom' : 'never';
            renderWizExpiryChips();
            renderWizExpiryHint();
        }
    };
    // ── Step 2: WHAT ───────────────────────────────────────────────────
    function wizValueHintText() {
        const amt = parseInt(wiz.value || '0');
        return wiz.currency === 'USD' ? `$${(amt / 100).toFixed(2)} (${amt} cents)` : `${amt} credits`;
    }

    // Ported updateBulkPreview wording, fed from wizard state.
    function wizEstimateText() {
        const count = parseInt(wiz.count || '0');
        const min   = parseInt(wiz.valueMin || '0');
        const max   = parseInt(wiz.valueMax || '0');
        const cur   = wiz.currency || 'CREDITS';
        if (count <= 0 || min < 0 || max < min) {
            return '<span style="color:var(--danger);">Set count and a valid min ≤ max range.</span>';
        }
        const avg = (min + max) / 2;
        const fmt = v => cur === 'USD' ? `$${(v / 100).toFixed(2)}` : `${Math.round(v).toLocaleString()} credits`;
        return `
            <strong style="color:var(--cream);">${count} coins</strong>, each worth between
            <strong style="color:var(--gold);">${fmt(min)}</strong> and
            <strong style="color:var(--gold);">${fmt(max)}</strong>.<br>
            Estimated total: <strong style="color:var(--cream);">${fmt(avg * count)}</strong>
            (range: ${fmt(min * count)} – ${fmt(max * count)}).`;
    }

    function wizMediaPreviewHtml() {
        if (!wiz.file) return `<div style="color:var(--muted); font-size:12px;">No file selected${wiz.mode === 'single' ? ' — single coins may skip media (instant-claim)' : ''}.</div>`;
        const isVideo = wiz.file.type && wiz.file.type.startsWith('video/');
        const media = wiz.fileUrl
            ? (isVideo
                ? `<video src="${esc(wiz.fileUrl)}" controls muted playsinline style="max-width:260px; max-height:180px; border-radius:8px; background:#000; display:block;"></video>`
                : `<img src="${esc(wiz.fileUrl)}" style="max-width:260px; max-height:180px; border-radius:8px; object-fit:cover; display:block;">`)
            : '';
        return `
            <div style="display:flex; gap:14px; align-items:flex-start; flex-wrap:wrap;">
                ${media}
                <div>
                    <div style="color:var(--cream); font-size:13px; font-weight:700;">${esc(wiz.file.name)}</div>
                    <div style="color:var(--muted); font-size:12px;">${(wiz.file.size / 1024 / 1024).toFixed(1)} MB · ${esc(wiz.file.type || 'unknown type')}</div>
                    ${wiz.durationNote ? `<div style="margin-top:6px; padding:6px 10px; background:rgba(194,144,47,0.08); border:1px solid rgba(194,144,47,0.25); border-radius:6px; color:var(--gold); font-size:12px;">${wiz.durationNote}</div>` : ''}
                </div>
            </div>`;
    }

    function wizStep2Html() {
        const single = wiz.mode === 'single';
        return `
            <div class="card">
                <h3 style="${H3}">🎬 What do they get?</h3>

                <div style="margin-bottom:16px;">
                    <label style="${LBL}">📹 Media ${single ? '(video preferred, optional)' : '(video preferred — every coin in the area shares it)'}</label>
                    <input type="file" id="d_wizMedia" accept="video/*,image/*" onchange="d_wizFile(this)" style="${INP} padding:10px; font-size:13px;">
                    <div id="d_wizMediaPreview" style="margin-top:10px;">${wizMediaPreviewHtml()}</div>
                </div>

                <div style="display:grid; grid-template-columns:${single ? '1fr 1fr 1fr' : '1fr 1fr 1fr 1fr'}; gap:14px; margin-bottom:16px;">
                    <div>
                        <label style="${LBL}">Currency</label>
                        <select style="${INP}" onchange="d_wizField('currency', this.value)">
                            <option value="CREDITS" ${wiz.currency === 'CREDITS' ? 'selected' : ''}>Credits (in-app)</option>
                            <option value="USD" ${wiz.currency === 'USD' ? 'selected' : ''}>USD (cents)</option>
                        </select>
                    </div>
                    ${single ? `
                    <div>
                        <label style="${LBL}">Value (per coin)</label>
                        <input type="number" min="1" value="${esc(wiz.value)}" style="${INP}" oninput="d_wizField('value', this.value)">
                        <small style="${HINT}" id="d_wizValueHint">${wizValueHintText()}</small>
                    </div>` : `
                    <div>
                        <label style="${LBL}">Min value (per coin)</label>
                        <input type="number" min="1" value="${esc(wiz.valueMin)}" style="${INP}" oninput="d_wizField('valueMin', this.value)">
                    </div>
                    <div>
                        <label style="${LBL}">Max value (per coin)</label>
                        <input type="number" min="1" value="${esc(wiz.valueMax)}" style="${INP}" oninput="d_wizField('valueMax', this.value)">
                    </div>`}
                    <div>
                        <label style="${LBL}">Geofence (meters)</label>
                        <input type="number" min="5" max="5000" value="${esc(wiz.geofence)}" style="${INP}" oninput="d_wizField('geofence', this.value)">
                        <small style="${HINT}">30m ≈ 100ft</small>
                    </div>
                </div>

                ${single ? '' : `<div id="d_wizEstimate" style="background:rgba(194,144,47,0.08); border:1px solid rgba(194,144,47,0.3); border-radius:8px; padding:14px; margin-bottom:16px; color:var(--text); font-size:13px; line-height:1.6;">${wizEstimateText()}</div>`}

                <div style="display:grid; grid-template-columns:${single ? '2fr 1fr 1fr' : '2fr 1fr'}; gap:14px; margin-bottom:16px;">
                    <div>
                        <label style="${LBL}">Title (shown after claim)</label>
                        <input type="text" placeholder="${single ? 'e.g. Welcome to Blipss LA' : 'e.g. LA Launch Drop'}" value="${esc(wiz.title)}" style="${INP}" oninput="d_wizField('title', this.value)">
                    </div>
                    ${single ? `
                    <div>
                        <label style="${LBL}">Icon style</label>
                        <select style="${INP}" onchange="d_wizField('iconType', this.value)">
                            ${['coin', 'star', 'gift', 'trophy'].map(v => `<option value="${v}" ${wiz.iconType === v ? 'selected' : ''}>${v.charAt(0).toUpperCase() + v.slice(1)}</option>`).join('')}
                        </select>
                    </div>` : ''}
                    <div>
                        <label style="${LBL}">Claim limit (per coin)</label>
                        <input type="number" min="1" value="${esc(wiz.viewLimit)}" placeholder="Blank = unlimited" style="${INP}" oninput="d_wizField('viewLimit', this.value)">
                        <small style="${HINT}">1 = first to claim wins${single ? ' · blank = unlimited' : ''}</small>
                    </div>
                </div>

                <div>
                    <label style="${LBL}">Description (optional)</label>
                    <textarea rows="2" placeholder="Optional context" style="${INP} resize:vertical;" oninput="d_wizField('description', this.value)">${esc(wiz.description)}</textarea>
                </div>
            </div>`;
    }

    // Media pick + auto duration extraction (ported probe logic → state).
    window.d_wizFile = function (input) {
        const file = input.files && input.files[0];
        if (wiz.fileUrl) { try { URL.revokeObjectURL(wiz.fileUrl); } catch (e) {} }
        wiz.file = file || null;
        wiz.fileUrl = null;
        wiz.videoDurationSeconds = null;
        wiz.durationNote = '';
        const refresh = () => { const p = $id('d_wizMediaPreview'); if (p) p.innerHTML = wizMediaPreviewHtml(); };
        if (!file) { refresh(); return; }
        wiz.fileUrl = URL.createObjectURL(file);

        // Images / non-video MIME types → no duration, instant-claim.
        if (!file.type || !file.type.startsWith('video/')) {
            wiz.durationNote = `📸 Image upload — instant-claim coin (no watch required).`;
            refresh();
            return;
        }

        wiz.durationNote = '⏳ Reading video duration…';
        refresh();
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.muted   = true;       // satisfy autoplay rules on some browsers
        probe.src     = wiz.fileUrl;

        probe.onloadedmetadata = () => {
            const seconds = probe.duration;
            if (!isFinite(seconds) || seconds <= 0) {
                wiz.durationNote = '⚠️ Could not read duration from this video file. Re-encode and try again.';
                refresh();
                return;
            }
            // Round up so the server's 90% threshold definitely fires
            // after the user actually watches to the end.
            const rounded = Math.max(1, Math.ceil(seconds));
            wiz.videoDurationSeconds = rounded;
            wiz.durationNote = `🎬 Detected: ${seconds.toFixed(1)}s — users must watch the full video to claim.`;
            console.log('[admin-coins] auto-detected video duration:', rounded, 's');
            refresh();
        };
        probe.onerror = () => {
            wiz.durationNote = '⚠️ Could not read this video. Make sure it\'s an H.264 MP4 / MOV that the browser can preview.';
            console.warn('[admin-coins] video metadata load failed');
            refresh();
        };
    };

    // ── Step 3: WHO & WHEN ─────────────────────────────────────────────
    const EXPIRY_PRESETS = [['1h', '+1h'], ['6h', '+6h'], ['24h', '+1 day'], ['7d', '+1 week'], ['30d', '+30 days'], ['never', 'Never']];

    function wizStep3Html() {
        return `
            <div class="card">
                <h3 style="${H3}">⏳ When does it expire?</h3>
                <div id="d_wizExpChips" style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px;">${wizExpiryChipsHtml()}</div>
                <input type="datetime-local" id="d_wizExpires" value="${esc(wiz.expiresAt)}" style="${INP} max-width:320px;" oninput="d_wizField('expiresAt', this.value)">
                <small id="d_wizExpHint" style="display:block; margin-top:6px; color:var(--muted); font-size:11px;">${wizExpiryHintText().text}</small>
            </div>

            <div class="card" style="margin-top:16px;">
                <h3 style="${H3}">📬 Who should hear about it? (optional)</h3>
                <p style="color:var(--muted); font-size:12.5px; margin-bottom:12px;">Leave the message empty to drop silently. With a message, users who have a recent location + push token within the radius get ${wiz.mode === 'area' ? 'ONE push for the whole batch' : 'a push notification'} — you'll see exactly who after launch.</p>
                <div style="margin-bottom:14px;">
                    <label style="${LBL}">Push notification message</label>
                    <textarea rows="2" placeholder="${wiz.mode === 'area' ? 'e.g. 💰 50 coins just dropped across LA — go find them!' : 'e.g. 💰 A new coin has dropped near you!'}" style="${INP} resize:vertical;" oninput="d_wizField('notifMessage', this.value)">${esc(wiz.notifMessage)}</textarea>
                </div>
                <div style="max-width:320px;">
                    <label style="${LBL}">Notification radius (miles)</label>
                    <input type="number" min="0.1" max="100" step="0.1" value="${esc(wiz.notifRadius)}" style="${INP}" oninput="d_wizField('notifRadius', this.value)">
                    <small style="${HINT}">Users with location data within this distance will get a push notification</small>
                </div>
            </div>`;
    }

    function wizExpiryChipsHtml() {
        return EXPIRY_PRESETS.map(([p, label]) =>
            `<button type="button" class="btn sm ${wiz.expiresPreset === p ? 'gold' : ''}" onclick="d_wizExpiryPreset('${p}')">${label}</button>`
        ).join('');
    }
    function renderWizExpiryChips() {
        const el = $id('d_wizExpChips');
        if (el) el.innerHTML = wizExpiryChipsHtml();
    }

    // Ported setExpiry math — writes wizard state instead of a form field.
    window.d_wizExpiryPreset = function (preset) {
        wiz.expiresPreset = preset;
        if (preset === 'never') {
            wiz.expiresAt = '';
        } else {
            const now = new Date();
            const deltaMs = {
                '1h':  60 * 60 * 1000,
                '6h':  6 * 60 * 60 * 1000,
                '24h': 24 * 60 * 60 * 1000,
                '7d':  7 * 24 * 60 * 60 * 1000,
                '30d': 30 * 24 * 60 * 60 * 1000,
            }[preset] || 0;
            const target = new Date(now.getTime() + deltaMs);
            // datetime-local needs YYYY-MM-DDTHH:mm in LOCAL time, no tz
            const pad = (n) => String(n).padStart(2, '0');
            wiz.expiresAt = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}`;
        }
        const inp = $id('d_wizExpires');
        if (inp) inp.value = wiz.expiresAt;
        renderWizExpiryChips();
        renderWizExpiryHint();
    };

    // Ported updateExpiryHint logic, from state.
    function wizExpiryHintText() {
        if (!wiz.expiresAt) return { text: 'Never expires (leave blank for indefinite).', color: 'var(--muted)' };
        const target = new Date(wiz.expiresAt);
        const diffMs = target - new Date();
        if (diffMs <= 0) return { text: '⚠️ This time is in the past — drop will be expired immediately.', color: 'var(--danger)' };
        const totalMin = Math.round(diffMs / (60 * 1000));
        const days = Math.floor(totalMin / (60 * 24));
        const hours = Math.floor((totalMin % (60 * 24)) / 60);
        const mins = totalMin % 60;
        let label;
        if (days > 0)       label = `${days} day${days === 1 ? '' : 's'}` + (hours > 0 ? `, ${hours}h` : '');
        else if (hours > 0) label = `${hours} hour${hours === 1 ? '' : 's'}` + (mins > 0 ? `, ${mins}m` : '');
        else                label = `${mins} minute${mins === 1 ? '' : 's'}`;
        return { text: `Expires in ${label} (${target.toLocaleString()})`, color: 'var(--muted)' };
    }
    function renderWizExpiryHint() {
        const h = $id('d_wizExpHint');
        if (!h) return;
        const { text, color } = wizExpiryHintText();
        h.textContent = text;
        h.style.color = color;
    }
    // ── Step 4: REVIEW & LAUNCH ────────────────────────────────────────
    function wizStep4Html() {
        const single = wiz.mode === 'single';
        const count = single ? 1 : (parseInt(wiz.count) || 0);
        const valueEach = single
            ? fmtVal(parseInt(wiz.value) || 0, wiz.currency)
            : `${fmtVal(parseInt(wiz.valueMin) || 0, wiz.currency)} – ${fmtVal(parseInt(wiz.valueMax) || 0, wiz.currency)}`;
        const total = single
            ? fmtVal(parseInt(wiz.value) || 0, wiz.currency)
            : `≈ ${fmtVal(Math.round(((parseInt(wiz.valueMin) || 0) + (parseInt(wiz.valueMax) || 0)) / 2 * count), wiz.currency)} (avg)`;
        const where = single
            ? (wiz.location ? `${wiz.location.lat.toFixed(5)}, ${wiz.location.lng.toFixed(5)}${wiz.locationLabel ? ` — ${esc(wiz.locationLabel)}` : ''}` : '—')
            : (wiz.center ? `${wiz.center.lat.toFixed(5)}, ${wiz.center.lng.toFixed(5)}${wiz.centerLabel ? ` — ${esc(wiz.centerLabel)}` : ''} · ${esc(wiz.spreadKm)} km spread, road-snapped` : '—');
        const media = wiz.file
            ? `${esc(wiz.file.name)}${wiz.videoDurationSeconds != null ? ` · ${wiz.videoDurationSeconds}s watch required` : ' · instant-claim'}`
            : 'none (instant-claim)';
        const expiry = wiz.expiresAt ? new Date(wiz.expiresAt).toLocaleString() : 'Never';
        const notify = wiz.notifMessage.trim()
            ? `“${esc(wiz.notifMessage.trim())}” · within ${esc(wiz.notifRadius)} mi (recipient list shown after launch)`
            : 'No push notification';
        const limit = single
            ? (wiz.viewLimit ? `${parseInt(wiz.viewLimit)} claim${parseInt(wiz.viewLimit) === 1 ? '' : 's'} per coin` : 'Unlimited')
            : `${parseInt(wiz.viewLimit || '1')} claim${parseInt(wiz.viewLimit || '1') === 1 ? '' : 's'} per coin`;
        const kv = (k, v) => `<div class="k">${k}</div><div class="v">${v}</div>`;
        return `
            <div class="card">
                <h3 style="${H3}">🚀 Review & launch</h3>
                <div class="kv" style="margin-bottom:18px;">
                    ${kv('Mode', single ? '🪙 Single coin' : `🎯 Area drop`)}
                    ${kv('Location', where)}
                    ${kv('Coins', String(count))}
                    ${kv('Value each', valueEach)}
                    ${kv('Total cost', total)}
                    ${kv('Geofence', `${esc(wiz.geofence)} m per coin`)}
                    ${kv('Claim limit', limit)}
                    ${kv('Expiry', esc(expiry))}
                    ${kv('Media', media)}
                    ${kv('Notification', notify)}
                    ${kv('Title', esc(wiz.title || '—'))}
                </div>
                <button id="d_wizLaunchBtn" class="btn gold" onclick="d_wizLaunch()" style="width:100%; padding:16px; font-size:16px; font-weight:900; justify-content:center;">
                    ${single ? '🪙 Launch — drop the coin' : `🎯 Launch — drop ${count} coins`}
                </button>
                <div id="d_wizProgress" style="display:none; margin-top:12px; padding:10px 12px; background:rgba(194,144,47,0.1); border-radius:6px; color:var(--gold); font-size:12.5px;"></div>
            </div>`;
    }

    function wizProgress(text) {
        const el = $id('d_wizProgress');
        if (!el) return el;
        if (text === null) { el.style.display = 'none'; return el; }
        el.style.display = 'block';
        el.textContent = text;
        return el;
    }

    window.d_wizLaunch = async function () {
        if (wiz.launching) return;
        if (!wizValidateStep(1) || !wizValidateStep(2)) return;
        wiz.launching = true;
        const btn = $id('d_wizLaunchBtn');
        if (btn) btn.disabled = true;
        try {
            if (wiz.mode === 'single') await wizLaunchSingle();
            else await wizLaunchArea();
        } finally {
            wiz.launching = false;
            const b = $id('d_wizLaunchBtn');
            if (b) b.disabled = false;
        }
    };

    // ── Launch: SINGLE (ported createAdminDrop — calls byte-for-byte) ──
    async function wizLaunchSingle() {
        try {
            const title = wiz.title.trim();
            const description = wiz.description.trim();
            // Drop type field was removed in the redesign — default to 'reward'
            const dropType = 'reward';
            const iconType = wiz.iconType;
            const rewardAmount = parseInt(wiz.value);
            const valueCurrency = wiz.currency || 'CREDITS';
            const radius = parseInt(wiz.geofence);
            const viewLimit = wiz.viewLimit;
            const expiresAt = wiz.expiresAt;
            const notificationMessage = wiz.notifMessage.trim();
            const notificationRadius = parseFloat(wiz.notifRadius);
            const videoDurationSeconds = wiz.videoDurationSeconds;
            const selectedDropLocation = wiz.location;

            if (!title) { adminToast('Please enter a title', 'error', 5000); return; }
            if (!selectedDropLocation) { adminToast('Please select a location on the map', 'error', 5000); return; }
            if (!rewardAmount || rewardAmount < 0) { adminToast('Please enter a valid reward amount', 'error', 5000); return; }
            if (!radius || radius < 1) { adminToast('Please enter a valid radius', 'error', 5000); return; }

            // Handle media upload if file selected
            const mediaFile = wiz.file;
            let mediaUrl = null;
            let mediaType = null;

            if (mediaFile) {
                wizProgress('Uploading media...');
                const fileExt = mediaFile.name.split('.').pop();
                const fileName = `admin-drops/${Date.now()}.${fileExt}`;
                mediaType = mediaFile.type.startsWith('video/') ? 'video' : 'image';

                const { error: uploadError } = await supabaseClient.storage
                    .from('blip-videos')
                    .upload(fileName, mediaFile);

                if (uploadError) {
                    wizProgress('Upload failed: ' + uploadError.message);
                    return;
                }

                const { data: { publicUrl } } = supabaseClient.storage
                    .from('blip-videos')
                    .getPublicUrl(fileName);

                mediaUrl = publicUrl;
                wizProgress('Media uploaded — creating the coin…');
            }

            // Prepare data
            const dropData = {
                title: title,
                description: description || null,
                latitude: selectedDropLocation.lat,
                longitude: selectedDropLocation.lng,
                drop_type: dropType,
                icon_type: iconType,
                reward_amount: rewardAmount,
                value_currency: valueCurrency,
                radius: radius,
                view_limit: viewLimit ? parseInt(viewLimit) : null,
                expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
                notification_message: notificationMessage || null,
                notification_radius_miles: notificationRadius,
                created_by: currentAdminId,
                is_active: true,
                views_count: 0,
                media_url: mediaUrl,
                media_type: mediaType,
                // Server-side watch validation kicks in when this is set.
                video_duration_seconds: videoDurationSeconds,
            };

            // Call Edge Function to create drop and send notifications
            const { data: { session } } = await supabaseClient.auth.getSession();
            const response = await fetch('https://obtsdsztblemlbvcrcdy.supabase.co/functions/v1/create-admin-drop', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`
                },
                body: JSON.stringify(dropData)
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Error creating drop:', errorData);
                wizProgress(null);
                adminToast('Failed to create drop: ' + (errorData.error || response.statusText), 'error', 5000);
                return;
            }

            const result = await response.json();
            console.log('[admin-coins] single drop created:', result);

            const notifCount = result.notificationsSent || 0;

            // The edge function returns the drop row, but to be safe (and to
            // pick up the DB-generated coin_code in case the edge function
            // doesn't surface it), do an explicit SELECT.
            let coinCode = result.drop?.coin_code || null;
            const dropId = result.drop?.id;
            if (dropId && !coinCode) {
                try {
                    const { data: fetched, error: fetchErr } = await supabaseClient
                        .from('admin_drops')
                        .select('coin_code')
                        .eq('id', dropId)
                        .single();
                    if (!fetchErr) coinCode = fetched?.coin_code || null;
                    else console.log('[admin-coins] coin_code fetch error', fetchErr);
                } catch (e) {
                    console.log('[admin-coins] coin_code fetch threw', e);
                }
            }

            // If admin set a video duration, apply it via UPDATE. The edge
            // function may not pass it through to the row, so we do this
            // unconditionally — keeps FE forward-compatible with the function.
            if (dropId && videoDurationSeconds != null && !isNaN(videoDurationSeconds)) {
                const { error: vidErr } = await supabaseClient
                    .from('admin_drops')
                    .update({ video_duration_seconds: videoDurationSeconds })
                    .eq('id', dropId);
                if (vidErr) {
                    console.log('[admin-coins] video duration backfill error', vidErr);
                    adminToast('Coin created but video duration could not be set: ' + vidErr.message, 'error', 6000);
                } else {
                    console.log('[admin-coins] applied video duration', videoDurationSeconds, 'to coin', dropId);
                }
            }

            wizProgress(null);
            adminToast('✅ Coin dropped successfully!', 'success');

            wiz.result = {
                kind: 'single',
                codes: coinCode ? [coinCode] : [],
                dropId,
                batchId: null,
                createdCount: 1,
                totalValue: rewardAmount,
                currency: valueCurrency,
                notifResult: { notificationsSent: notifCount, recipients: result.recipients || [] },
                notifMessage: notificationMessage,
                placedRandom: false,
            };
            _lastBulkCoinCodes = wiz.result.codes.slice();
            renderWizard();
            if (mng.everLoaded) window.d_manageLoad();
        } catch (error) {
            console.error('[admin-coins] error creating drop:', error);
            wizProgress(null);
            adminToast('Failed to create drop: ' + error.message, 'error', 5000);
        }
    }

    // ── Launch: AREA (ported createBulkAdminDrop — calls byte-for-byte) ─
    async function wizLaunchArea() {
        try {
            const bulkSelectedCenter = wiz.center;
            if (!bulkSelectedCenter) {
                adminToast('Pick a city or click on the map first', 'error');
                return;
            }

            const count    = parseInt(wiz.count);
            const valueMin = parseInt(wiz.valueMin);
            const valueMax = parseInt(wiz.valueMax);
            const currency = wiz.currency;
            const geofence = parseInt(wiz.geofence);
            const spreadKm = parseFloat(wiz.spreadKm);
            const title    = wiz.title.trim();
            const desc     = wiz.description.trim();
            const limit    = parseInt(wiz.viewLimit || '1');
            const expires  = wiz.expiresAt;
            const notif    = wiz.notifMessage.trim();
            const notifRad = parseFloat(wiz.notifRadius || '5');
            const videoDurationSeconds = wiz.videoDurationSeconds;

            if (!title) { adminToast('Title is required', 'error'); return; }
            if (count < 1 || count > 500) { adminToast('Count must be 1–500', 'error'); return; }
            if (valueMin < 0 || valueMax < valueMin) { adminToast('Invalid value range', 'error'); return; }

            const sumLabel = currency === 'USD'
                ? `$${((valueMin + valueMax) / 2 * count / 100).toFixed(2)} (avg)`
                : `${Math.round((valueMin + valueMax) / 2 * count).toLocaleString()} credits (avg)`;
            const ok = await adminConfirm({
                title: `Drop ${count} coins?`,
                message: `${count} coins will be scattered within ${spreadKm}km, then each will be snapped to the nearest road so they land on streets/sidewalks (not mountains or water). Each coin will be worth ${currency === 'USD' ? `$${(valueMin / 100).toFixed(2)}–$${(valueMax / 100).toFixed(2)}` : `${valueMin}–${valueMax} credits`}.\n\nEstimated total: ${sumLabel}\n\nThis CANNOT be undone in bulk.`,
                dangerLevel: 'warning',
                confirmLabel: `Drop ${count} coins`,
                requireType: count > 100 ? `DROP ${count}` : null,
            });
            if (!ok) return;

            const mediaFile = wiz.file;
            if (!mediaFile) { adminToast('Pick a media file', 'error'); return; }

            wizProgress('Uploading shared media…');

            const fileExt = mediaFile.name.split('.').pop();
            const fileName = `admin-drops/${Date.now()}_bulk.${fileExt}`;
            const { error: upErr } = await supabaseClient.storage.from('blip-videos').upload(fileName, mediaFile);
            if (upErr) { wizProgress('Upload failed: ' + upErr.message); return; }
            const { data: { publicUrl } } = supabaseClient.storage.from('blip-videos').getPublicUrl(fileName);

            // Generate random candidates and snap each to the NEAREST road.
            // Points far from any road (deep water, wilderness) won't snap —
            // we must NEVER place those, so oversample and keep snapping
            // fresh random points until we have `count` on-road points or
            // hit the round cap.
            wizProgress(`Snapping ${count} coins to nearest roads…`);
            const onRoad = [];
            let snapError = null;
            let placedRandom = false;
            const MAX_ROUNDS = 6;
            for (let round = 0; round < MAX_ROUNDS && onRoad.length < count; round++) {
                const need = count - onRoad.length;
                // oversample to absorb points with no nearby road
                const batchN = Math.min(500, Math.max(Math.ceil(need * 1.5), 10));
                const cands = [];
                for (let i = 0; i < batchN; i++) {
                    cands.push(randomPointInDisc(bulkSelectedCenter.lat, bulkSelectedCenter.lng, spreadKm * 1000));
                }
                const res = await snapPointsToNearestRoad(cands);
                if (res.errorMsg) { snapError = res.errorMsg; break; }
                for (const p of res.points) {
                    if (onRoad.length >= count) break;
                    onRoad.push(p);
                }
                wizProgress(`Snapping coins to roads… ${onRoad.length}/${count}`);
            }

            // Roads API genuinely failed (not enabled / quota / billing).
            // Do NOT silently place off-road — make the admin opt in.
            if (snapError) {
                const proceed = await adminConfirm({
                    title: 'Roads API failed',
                    message: `Could not snap coins to roads:\n\n${snapError}\n\nFix: enable the Roads API in Google Cloud Console for this API key, then try again.\n\nIf you continue, coins will be placed at RANDOM points and may land in water / on mountains / private property.`,
                    dangerLevel: 'destructive',
                    confirmLabel: 'Place at random anyway',
                });
                if (!proceed) { wizProgress(null); return; }
                placedRandom = true;
                while (onRoad.length < count) {
                    onRoad.push(randomPointInDisc(bulkSelectedCenter.lat, bulkSelectedCenter.lng, spreadKm * 1000));
                }
            }

            if (onRoad.length === 0) {
                wizProgress(null);
                adminToast('No roads found near that area — pick a denser spot or a larger spread.', 'error', 6000);
                return;
            }
            if (!placedRandom && onRoad.length < count) {
                adminToast(`Only ${onRoad.length}/${count} coins could be placed on roads near that area. Try a larger spread or a denser area for more.`, 'info', 6000);
            }

            // Assign each a random value in [min, max]
            const points = onRoad.map(p => ({
                lat: p.lat,
                lng: p.lng,
                value: valueMin === valueMax
                    ? valueMin
                    : Math.floor(Math.random() * (valueMax - valueMin + 1)) + valueMin,
            }));

            // Insert via the points-list RPC
            wizProgress('Saving coins…');
            const { data, error } = await supabaseClient.rpc('bulk_insert_admin_drops_at_points', {
                p_points: points,
                p_value_currency: currency,
                p_geofence_radius_m: geofence,
                p_title: title,
                p_description: desc || null,
                p_media_url: publicUrl,
                p_icon_type: 'coin',
                p_view_limit_per_coin: limit,
                p_expires_at: expires ? new Date(expires).toISOString() : null,
                p_notification_message: notif || null,
                p_notification_radius_miles: notifRad,
            });

            if (error) {
                wizProgress(null);
                console.log('[admin-coins] bulk drop RPC error', error);
                adminToast('Bulk drop failed: ' + error.message, 'error');
                return;
            }

            // If admin set a video duration, apply it to the newly-created
            // coins. Separate UPDATE (rather than a new RPC arg) so we don't
            // depend on the RPC signature having that param yet.
            if (videoDurationSeconds != null && !isNaN(videoDurationSeconds) && Array.isArray(data.coin_codes) && data.coin_codes.length > 0) {
                const { error: upErr2 } = await supabaseClient
                    .from('admin_drops')
                    .update({ video_duration_seconds: videoDurationSeconds })
                    .in('coin_code', data.coin_codes);
                if (upErr2) {
                    console.log('[admin-coins] video duration backfill error', upErr2);
                    adminToast('Coins created but video duration could not be set: ' + upErr2.message, 'error', 6000);
                } else {
                    console.log('[admin-coins] applied video duration', videoDurationSeconds, 'to', data.coin_codes.length, 'coins');
                }
            }

            adminToast(`✅ Dropped ${data.created_count} coins ${placedRandom ? '(RANDOM placement — Roads API was unavailable)' : '(snapped to roads)'}! Total: ${currency === 'USD' ? `$${(data.total_value / 100).toFixed(2)}` : `${data.total_value} credits`}`, 'success', 6500);

            // Fan out ONE push per nearby user for the whole batch. Only
            // notify when the admin actually entered a message.
            let bulkNotif = { notificationsSent: 0, recipients: [] };
            if (notif && data.batch_id) {
                try {
                    wizProgress('Sending notifications…');
                    const { data: { session } } = await supabaseClient.auth.getSession();
                    const nResp = await fetch(`${SUPABASE_URL}/functions/v1/notify-drop-batch`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
                        },
                        body: JSON.stringify({
                            batchId: data.batch_id,
                            latitude: bulkSelectedCenter.lat,
                            longitude: bulkSelectedCenter.lng,
                            notificationRadiusMiles: notifRad,
                            message: notif,
                            coinCount: data.created_count,
                        }),
                    });
                    const nJson = await nResp.json();
                    if (nResp.ok) {
                        bulkNotif = nJson;
                        adminToast(`📬 Notified ${bulkNotif.notificationsSent} ${bulkNotif.notificationsSent === 1 ? 'person' : 'people'} nearby`, 'info', 5000);
                    } else {
                        console.warn('[admin-coins] batch notify failed', nJson);
                        adminToast('Coins dropped, but notifications failed: ' + (nJson.error || nResp.statusText), 'error', 6000);
                    }
                } catch (e) {
                    console.warn('[admin-coins] batch notify threw', e);
                    adminToast('Coins dropped, but notifications failed (network).', 'error', 6000);
                }
            }
            wizProgress(null);

            wiz.result = {
                kind: 'bulk',
                codes: (data.coin_codes || []).slice(),
                dropId: null,
                batchId: data.batch_id || null,
                createdCount: data.created_count,
                totalValue: data.total_value,
                currency,
                notifResult: bulkNotif,
                notifMessage: notif,
                placedRandom,
            };
            _lastBulkCoinCodes = wiz.result.codes.slice();
            console.log('[admin-coins] bulk drop produced codes:', wiz.result.codes);
            renderWizard();
            if (mng.everLoaded) window.d_manageLoad();
        } catch (err) {
            console.error('Bulk drop error:', err);
            wizProgress(null);
            adminToast('Unexpected error: ' + err.message, 'error');
        }
    }

    // ── Success screen ──────────────────────────────────────────────────
    function wizSuccessHtml() {
        const r = wiz.result;
        const bulk = r.kind === 'bulk';
        const totalLabel = fmtVal(r.totalValue, r.currency);
        const codesHtml = r.codes.length
            ? `<div style="max-height:220px; overflow-y:auto; background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:10px; margin-top:10px;">
                   ${r.codes.map(c => `<div style="padding:4px 0; font-family:Menlo,Monaco,monospace; font-size:12px; color:var(--gold);">${esc(c)}</div>`).join('')}
               </div>`
            : `<div style="color:var(--muted); font-size:12px; margin-top:10px;">No coin codes were returned — open Manage to see the coins.</div>`;
        const notifSection = buildDropNotifSectionHtml(r.notifResult, r.notifMessage, bulk ? 'batch' : 'drop', bulk ? r.batchId : r.dropId);
        return `
            <div class="card" style="border-color:var(--gold);">
                <div style="text-align:center; padding:10px 0 16px;">
                    <div style="font-size:44px;">✅</div>
                    <h3 style="color:var(--cream); font-size:20px; margin-top:8px;">${bulk ? `${r.createdCount} coins dropped` : 'Coin dropped'}</h3>
                    <div style="color:var(--muted); margin-top:4px;">Total value on the map: <strong style="color:#FFD700;">${totalLabel}</strong>${r.placedRandom ? ' · <span style="color:var(--warn);">RANDOM placement (Roads API unavailable)</span>' : ''}</div>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
                    <strong style="color:var(--gold); font-size:14px;">${r.codes.length ? `${r.codes.length} coin code${r.codes.length === 1 ? '' : 's'} generated` : 'Coin codes'}</strong>
                    ${r.codes.length ? `<button class="btn sm" onclick="d_copyCoinCodesToClipboard()">📋 Copy all</button>` : ''}
                </div>
                ${r.batchId ? `<div style="font-family:Menlo,Monaco,monospace; font-size:11px; color:var(--muted); margin-top:8px;">batch: ${esc(r.batchId)}</div>` : ''}
                ${codesHtml}
                ${notifSection}
                <div class="actionrow" style="margin-top:18px;">
                    ${bulk && r.batchId ? `<button class="btn gold" onclick="d_gotoBatch('${jsEsc(r.batchId)}')">📦 Manage this batch →</button>` : ''}
                    ${!bulk && r.dropId ? `<button class="btn gold" onclick="d_openCoinDetail('${jsEsc(r.dropId)}')">📊 Open coin detail</button>` : ''}
                    <button class="btn" onclick="d_wizReset()">🪙 Drop another</button>
                </div>
            </div>`;
    }

    window.d_gotoBatch = function (batchId) {
        mng.pendingBatch = batchId;
        window.d_setSubTab('manage');
    };

    // Reset for the next drop, remembering last-used defaults (currency,
    // values, geofence, spread, count, notif radius, expiry preset, icon,
    // claim limit, mode).
    window.d_wizReset = function () {
        wiz.result = null;
        wiz.step = 1;
        wiz.location = null; wiz.locationLabel = '';
        wiz.center = null; wiz.centerLabel = '';
        wiz.title = ''; wiz.description = ''; wiz.notifMessage = '';
        if (wiz.fileUrl) { try { URL.revokeObjectURL(wiz.fileUrl); } catch (e) {} }
        wiz.file = null; wiz.fileUrl = null;
        wiz.videoDurationSeconds = null; wiz.durationNote = '';
        // Re-apply the remembered relative preset so "+24h" etc. is measured
        // from now; a custom absolute time doesn't carry over.
        if (wiz.expiresPreset === 'custom') { wiz.expiresPreset = 'never'; wiz.expiresAt = ''; }
        else window.d_wizExpiryPreset(wiz.expiresPreset);
        wizMap = null; wizMarker = null; wizCenterMarker = null; wizCircle = null;
        renderWizard();
    };

    window.d_copyCoinCodesToClipboard = function () {
        const codes = _lastBulkCoinCodes || [];
        if (codes.length === 0) { adminToast('Nothing to copy', 'error'); return; }
        navigator.clipboard.writeText(codes.join('\n'))
            .then(() => adminToast(`Copied ${codes.length} coin code${codes.length === 1 ? '' : 's'}`, 'success'))
            .catch(err => {
                console.warn('[admin-coins] clipboard copy failed', err);
                adminToast('Copy failed — see console', 'error');
            });
    };
    // ═════════ Road snapping (unchanged from the port) ═════════
    // Generate one random lat/lng inside a disc of radius (meters) around
    // (centerLat, centerLng). sqrt(random()) gives uniform distribution
    // by area (vs naive random() which clusters near the center).
    function randomPointInDisc(centerLat, centerLng, radiusM) {
        const distance = Math.sqrt(Math.random()) * radiusM;
        const bearing = Math.random() * 2 * Math.PI;
        const dLat = (distance * Math.cos(bearing)) / 111320;
        const dLng = (distance * Math.sin(bearing)) / (111320 * Math.cos(centerLat * Math.PI / 180));
        return { lat: centerLat + dLat, lng: centerLng + dLng };
    }

    // Snap scattered points to the NEAREST road via Google's Roads
    // "nearestRoads" API (snapToRoads silently drops off-road points — how
    // coins ended up in lakes). 100 points per request max, so we batch.
    // Returns { points, errorMsg } with ONLY on-road points.
    async function snapPointsToNearestRoad(points) {
        const out = [];
        let errorMsg = null;
        const BATCH = 100;
        for (let i = 0; i < points.length; i += BATCH) {
            const slice = points.slice(i, i + BATCH);
            const pointsParam = slice.map(p => `${p.lat},${p.lng}`).join('|');
            try {
                const resp = await fetch(
                    `https://roads.googleapis.com/v1/nearestRoads?points=${encodeURIComponent(pointsParam)}&key=${GOOGLE_API_KEY}`
                );
                const json = await resp.json();
                if (json.error) {
                    // Common causes: API not enabled, quota exceeded, billing not set up
                    const msg = `${json.error.code} ${json.error.message || json.error.status || 'unknown'}`;
                    console.warn('Roads API (nearestRoads) error:', json.error);
                    errorMsg = errorMsg || msg;
                    continue; // do NOT keep originals — they may be in water
                }
                // nearestRoads can return several snapped candidates for the
                // same originalIndex (e.g. near an intersection). Keep the
                // first per index.
                const snapped = json.snappedPoints || [];
                const seen = new Set();
                snapped.forEach(sp => {
                    const idx = sp.originalIndex ?? -1;
                    if (idx >= 0 && !seen.has(idx) && sp.location) {
                        seen.add(idx);
                        out.push({ lat: sp.location.latitude, lng: sp.location.longitude });
                    }
                });
            } catch (e) {
                console.warn('nearestRoads batch failed', e);
                errorMsg = errorMsg || (e?.message || 'network error');
            }
        }
        return { points: out, errorMsg };
    }

    // ═════════ Recipients ("who got notified") ═════════
    // notifResult = { notificationsSent, recipients: [{username, distance_miles}] }
    function buildDropNotifSectionHtml(notifResult, notifMessage, lookupKind, lookupId) {
        if (!notifMessage) {
            return `<div style="margin-top:12px; border-top:1px solid var(--border); padding-top:10px; color:var(--muted); font-size:12px;">📭 No push notification sent (the notification message field was left empty).</div>`;
        }
        const count = (notifResult && notifResult.notificationsSent) || 0;
        const recips = (notifResult && Array.isArray(notifResult.recipients)) ? notifResult.recipients.slice() : [];
        recips.sort((a, b) => (a.distance_miles || 0) - (b.distance_miles || 0));
        const listHtml = recips.length
            ? recips.map(r => `<div style="display:flex; justify-content:space-between; gap:10px; padding:4px 0; font-size:12px; color:var(--text); border-bottom:1px solid var(--border);"><span>@${esc(r.username || 'unknown')}</span><span style="color:var(--muted); white-space:nowrap;">${(r.distance_miles != null) ? Number(r.distance_miles).toFixed(1) + ' mi' : ''}</span></div>`).join('')
            : `<div style="color:var(--muted); font-size:12px;">No nearby users had a recent location + push token within range.</div>`;
        const lookupBtn = (lookupKind && lookupId)
            ? `<button class="btn sm" onclick="d_viewDropRecipients('${jsEsc(lookupKind)}','${jsEsc(lookupId)}')">👥 View recipients</button>`
            : '';
        return `
            <div style="margin-top:12px; border-top:1px solid var(--border); padding-top:10px;">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
                    <strong style="color:var(--gold); font-size:13px;">📬 Notified ${count} ${count === 1 ? 'person' : 'people'}</strong>
                    ${lookupBtn}
                </div>
                ${recips.length ? `<div style="max-height:160px; overflow-y:auto; background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:8px; margin-top:8px;">${listHtml}</div>` : `<div style="margin-top:6px;">${listHtml}</div>`}
            </div>`;
    }

    // Saved per-drop lookup: works long after the drop because the fan-out
    // logs every recipient to admin_drop_notifications. Query byte-for-byte.
    async function fetchRecipients(kind, id) {
        const col = kind === 'batch' ? 'batch_id' : 'drop_id';
        const { data, error } = await supabaseClient
            .from('admin_drop_notifications')
            .select('username, distance_miles, sent_at')
            .eq(col, id)
            .order('distance_miles', { ascending: true });
        if (error) throw error;
        return data || [];
    }

    function recipientsListHtml(recipients) {
        return (recipients || []).length
            ? recipients.map(r => `<div style="display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-bottom:1px solid var(--border); font-size:13px; color:var(--text);"><span>@${esc(r.username || 'unknown')}</span><span style="color:var(--muted); white-space:nowrap;">${(r.distance_miles != null) ? Number(r.distance_miles).toFixed(1) + ' mi' : ''}</span></div>`).join('')
            : `<div class="empty">No recipients were recorded for this drop.</div>`;
    }

    // Standalone drawer (from success screen / batch headers).
    window.d_viewDropRecipients = async function (kind, id) {
        try {
            const data = await fetchRecipients(kind, id);
            const n = data.length;
            ui.drawer({
                title: `👥 Notified ${n} ${n === 1 ? 'person' : 'people'}`,
                html: `<div class="card" style="max-height:70vh; overflow-y:auto;">${recipientsListHtml(data)}</div>`,
            });
        } catch (e) {
            console.warn('[admin-coins] viewDropRecipients failed', e);
            adminToast('Could not load recipients: ' + (e.message || 'see console'), 'error', 5000);
        }
    };

    // Inline loader used INSIDE the coin-detail drawer (doesn't replace it).
    window.d_loadRecipientsInline = async function (kind, id) {
        const box = $id('d_coinRecipients');
        if (!box) return;
        box.innerHTML = '<div class="spin">Loading recipients…</div>';
        try {
            const data = await fetchRecipients(kind, id);
            box.innerHTML = `
                <div style="max-height:240px; overflow-y:auto; background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:8px;">
                    ${recipientsListHtml(data)}
                </div>`;
        } catch (e) {
            box.innerHTML = `<div style="color:var(--danger); font-size:12px;">Could not load recipients: ${esc(e.message || '')}</div>`;
        }
    };

    // ═════════════════════════════════════════════════════════════════
    // MANAGE — unified Browse + Batches + Map
    // ═════════════════════════════════════════════════════════════════
    const MNG_CHIPS = [['all', 'All'], ['active', 'Active'], ['fully_claimed', 'Claimed'], ['expired', 'Expired'], ['inactive', 'Inactive']];

    function manageSkeletonHtml() {
        return `
            <div class="stats" id="d_mngTiles" style="margin-bottom:16px;">
                <div class="stat"><h4>Active coins</h4><div class="num">—</div></div>
                <div class="stat"><h4>Claims today</h4><div class="num">—</div></div>
                <div class="stat"><h4>Expiring ≤ 24h</h4><div class="num">—</div></div>
                <div class="stat"><h4>Live value</h4><div class="num">—</div></div>
            </div>
            <div class="toolbar">
                ${MNG_CHIPS.map(([v, label]) => `<button class="btn sm ${mng.status === v ? 'gold' : ''}" data-mchip="${v}" onclick="d_manageChip('${v}')">${label}</button>`).join('')}
                <select id="d_mngBatch" onchange="d_manageApply()" style="min-width:170px;">
                    <option value="all">All batches</option>
                    <option value="_single">Individual only</option>
                </select>
                <input type="search" id="d_mngSearch" placeholder="🔍 Code or title…" oninput="d_manageSearchDebounced()" style="min-width:190px;">
                <span style="flex:1;"></span>
                <button class="btn sm ${mng.view === 'list' ? 'gold' : ''}" data-mview="list" onclick="d_manageView('list')">📋 List</button>
                <button class="btn sm ${mng.view === 'map' ? 'gold' : ''}" data-mview="map" onclick="d_manageView('map')">🗺️ Map</button>
                <button class="btn sm" onclick="d_manageLoad()">🔄 Refresh</button>
            </div>
            <div id="d_mngCount" style="color:var(--muted); font-size:12px; margin-bottom:10px;"></div>
            <div id="d_mngList"><div class="spin">Loading coins…</div></div>
            <div id="d_mngMapWrap" style="display:${mng.view === 'map' ? 'block' : 'none'};">
                <div id="d_mngMap" style="width:100%; height:600px; border-radius:12px; overflow:hidden; border:1px solid var(--border); background:var(--panel);">
                    <div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--muted);">Loading map…</div>
                </div>
                <div style="display:flex; gap:18px; margin-top:14px; flex-wrap:wrap; color:var(--muted); font-size:12px;">
                    <div style="display:flex; align-items:center; gap:6px;"><span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:#4CAF50;"></span> Active</div>
                    <div style="display:flex; align-items:center; gap:6px;"><span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:#9E9E9E;"></span> Inactive</div>
                    <div style="display:flex; align-items:center; gap:6px;"><span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:#FF9800;"></span> Expired</div>
                    <div style="display:flex; align-items:center; gap:6px;"><span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:#9C27B0;"></span> Fully Claimed</div>
                </div>
            </div>`;
    }

    window.d_manageLoad = async function () {
        if (mng.loading) return;
        mng.loading = true;
        const listEl = $id('d_mngList');
        if (listEl && !mng.everLoaded) listEl.innerHTML = '<div class="spin">Loading coins…</div>';
        try {
            const oneDayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            // Coin fetch: ported batch-detail column list (has bulk_batch_id,
            // needed to group) + ported map-view order/limit.
            const [coinsRes, batchesRes, claimsRes] = await Promise.all([
                supabaseClient
                    .from('admin_drops')
                    .select('id, coin_code, title, reward_amount, value_currency, view_limit, views_count, is_active, expires_at, latitude, longitude, created_at, radius, video_duration_seconds, bulk_batch_id')
                    .order('created_at', { ascending: false })
                    .limit(2000),
                supabaseClient.rpc('admin_list_drop_batches'),
                // Claims today (24h window) — byte-for-byte from the audit.
                supabaseClient
                    .from('admin_drop_views')
                    .select('id', { count: 'exact', head: true })
                    .not('claimed_at', 'is', null)
                    .gt('claimed_at', oneDayAgoIso),
            ]);

            if (coinsRes.error) {
                console.log('[admin-coins] manage fetch error', coinsRes.error);
                if (listEl) listEl.innerHTML = `<div class="empty" style="color:var(--danger);">Failed to load coins: ${esc(coinsRes.error.message)}</div>`;
                return;
            }
            mng.coins = coinsRes.data || [];

            if (batchesRes.error) console.log('[admin-coins] batches RPC error', batchesRes.error);
            mng.batches = {};
            for (const b of (batchesRes.data || [])) mng.batches[b.batch_id] = b;

            if (claimsRes.error) console.log('[admin-coins] claimsToday error', claimsRes.error);
            mng.claimsToday = claimsRes.count || 0;

            mng.everLoaded = true;
            mngRefreshBatchOptions();
            mngRenderTiles();
            window.d_manageApply();
        } catch (err) {
            console.error('[admin-coins] manage load threw', err);
            adminToast('Unexpected error loading coins', 'error');
        } finally {
            mng.loading = false;
        }
    };

    function mngRefreshBatchOptions() {
        const sel = $id('d_mngBatch');
        if (!sel) return;
        const want = mng.pendingBatch || sel.value || 'all';
        mng.pendingBatch = null;
        // Batches present in the fetched coins, newest first (coins are desc).
        const seen = new Set();
        const ids = [];
        for (const c of mng.coins) {
            if (c.bulk_batch_id && !seen.has(c.bulk_batch_id)) { seen.add(c.bulk_batch_id); ids.push(c.bulk_batch_id); }
        }
        sel.innerHTML = `
            <option value="all">All batches</option>
            <option value="_single">Individual only</option>
            ${ids.map(id => {
                const m = mng.batches[id];
                const n = mng.coins.filter(c => c.bulk_batch_id === id).length;
                return `<option value="${esc(id)}">${esc(m?.title || '(untitled batch)')} (${n})</option>`;
            }).join('')}`;
        sel.value = [...sel.options].some(o => o.value === want) ? want : 'all';
    }

    function mngRenderTiles() {
        const el = $id('d_mngTiles');
        if (!el) return;
        const active = mng.coins.filter(c => computeCoinStatus(c) === 'active');
        const exp24 = active.filter(c => c.expires_at && (new Date(c.expires_at) - Date.now()) < 86400000).length;
        const usd = active.filter(c => c.value_currency === 'USD').reduce((s, c) => s + (c.reward_amount || 0), 0);
        const credits = active.filter(c => c.value_currency === 'CREDITS').reduce((s, c) => s + (c.reward_amount || 0), 0);
        const liveValue = [usd ? fmtVal(usd, 'USD') : null, credits ? fmtVal(credits, 'CREDITS') : null].filter(Boolean).join(' + ') || '0';
        const tile = (title, value, hot, sub) => `
            <div class="stat ${hot ? 'hot' : ''}"><h4>${title}</h4><div class="num" style="font-size:${String(value).length > 12 ? '18px' : '26px'};">${value}</div>${sub ? `<div style="color:var(--muted); font-size:11.5px; margin-top:4px;">${sub}</div>` : ''}</div>`;
        el.innerHTML =
            tile('Active coins', active.length.toLocaleString(), true, 'Claimable right now') +
            tile('Claims today', mng.claimsToday.toLocaleString(), false, 'Last 24 hours') +
            tile('Expiring ≤ 24h', exp24.toLocaleString(), exp24 > 0, exp24 > 0 ? 'Still active — act soon' : '') +
            tile('Live value', liveValue, false, 'Sum of active coins');
    }
    // ── Filters ──────────────────────────────────────────────────────
    window.d_manageChip = function (status) {
        mng.status = status;
        document.querySelectorAll('[data-mchip]').forEach(b => b.classList.toggle('gold', b.dataset.mchip === status));
        window.d_manageApply();
    };

    window.d_manageSearchDebounced = function () {
        clearTimeout(_mngSearchTimer);
        _mngSearchTimer = setTimeout(window.d_manageApply, 200);
    };

    function mngFiltered() {
        const q = ($id('d_mngSearch')?.value || '').trim().toLowerCase();
        const batch = $id('d_mngBatch')?.value || 'all';
        return mng.coins.filter(c => {
            if (q) {
                const hay = `${c.coin_code || ''} ${c.title || ''}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            if (batch === '_single') { if (c.bulk_batch_id) return false; }
            else if (batch !== 'all') { if (c.bulk_batch_id !== batch) return false; }
            if (mng.status !== 'all' && computeCoinStatus(c) !== mng.status) return false;
            return true;
        });
    }

    // Re-render the ACTIVE view (list or map) from the same filtered set.
    window.d_manageApply = function () {
        const filtered = mngFiltered();
        const countEl = $id('d_mngCount');
        if (countEl) countEl.textContent = `Showing ${filtered.length} of ${mng.coins.length} coins${mng.coins.length >= 2000 ? ' (capped at the 2000 most recent)' : ''}`;
        if (mng.view === 'map') mngRenderMarkers(filtered);
        else mngRenderList(filtered);
    };

    window.d_manageView = function (view) {
        mng.view = view;
        document.querySelectorAll('[data-mview]').forEach(b => b.classList.toggle('gold', b.dataset.mview === view));
        const listEl = $id('d_mngList');
        const mapWrap = $id('d_mngMapWrap');
        if (listEl) listEl.style.display = view === 'list' ? 'block' : 'none';
        if (mapWrap) mapWrap.style.display = view === 'map' ? 'block' : 'none';
        if (view === 'map') mngEnsureMap(); // container is visible NOW
        window.d_manageApply();
    };

    // ── List view: batch-grouped, collapsible ────────────────────────
    function mngRenderList(filtered) {
        const listEl = $id('d_mngList');
        if (!listEl) return;
        if (mng.view !== 'list') return;
        listEl.style.display = 'block';
        if (!filtered.length) {
            listEl.innerHTML = `<div class="empty">No coins match the current filters.<br><span style="font-size:12px;">Try the All chip or clear the search.</span></div>`;
            return;
        }
        // Group by batch (single drops under "Individual"), newest-first
        // insertion order since coins are already created_at desc.
        const order = [];
        const groups = new Map();
        for (const c of filtered) {
            const k = c.bulk_batch_id || '_single';
            if (!groups.has(k)) { groups.set(k, []); order.push(k); }
            groups.get(k).push(c);
        }
        listEl.innerHTML = order.map(k => mngGroupHtml(k, groups.get(k))).join('');
    }

    function mngGroupHtml(key, rows) {
        const isSingle = key === '_single';
        const meta = isSingle ? null : mng.batches[key];
        const open = !mng.closed.has(key);
        const activeN = rows.filter(c => computeCoinStatus(c) === 'active').length;
        const anyOn = rows.some(c => c.is_active);
        const totals = {};
        rows.forEach(c => { totals[c.value_currency] = (totals[c.value_currency] || 0) + (c.reward_amount || 0); });
        const totalLabel = Object.entries(totals).map(([cur, amt]) => fmtVal(amt, cur)).join(' + ') || '—';
        const title = isSingle ? '🪙 Individual coins' : `📦 ${esc(meta?.title || rows[0]?.title || '(untitled batch)')}`;
        const sub = isSingle
            ? `${rows.length} coin${rows.length === 1 ? '' : 's'} · ${activeN} active · ${totalLabel}`
            : `${rows.length} coin${rows.length === 1 ? '' : 's'} · ${activeN} active · ${totalLabel}${meta ? ` · ${timeAgo(meta.created_at)} by @${esc(meta.created_by_username || '?')}` : ''}`;
        const actions = isSingle ? '' : `
            <button class="btn sm" onclick="event.stopPropagation(); d_viewDropRecipients('batch','${jsEsc(key)}')">👥 Notified</button>
            <button class="btn sm ${anyOn ? 'warn' : 'ok'}" onclick="event.stopPropagation(); d_manageBatchToggleAll('${jsEsc(key)}', ${!anyOn})">${anyOn ? '⏸ Deactivate all' : '▶ Activate all'}</button>
            <button class="btn sm danger" onclick="event.stopPropagation(); d_deleteDropBatch('${jsEsc(key)}', ${rows.length})">🗑 Delete batch</button>`;
        return `
            <div class="card" style="padding:0; margin-bottom:12px; overflow:hidden;">
                <div onclick="d_manageToggleGroup('${jsEsc(key)}')" style="display:flex; align-items:center; gap:12px; padding:14px 18px; cursor:pointer; flex-wrap:wrap;">
                    <span style="color:var(--muted); font-size:11px; width:12px;">${open ? '▼' : '►'}</span>
                    <div style="flex:1; min-width:220px;">
                        <div style="color:var(--cream); font-weight:900; font-size:14.5px;">${title}</div>
                        <div style="color:var(--muted); font-size:12px; margin-top:2px;">${sub}</div>
                    </div>
                    <div class="actionrow">${actions}</div>
                </div>
                ${open ? `
                <div class="tblwrap" style="border:none; border-top:1px solid var(--border); border-radius:0;">
                    <table class="tbl">
                        <thead>
                            <tr><th>Coin</th><th>Location</th><th>Value</th><th>Status</th><th>Claims</th><th>Expires</th><th style="text-align:right;">Actions</th></tr>
                        </thead>
                        <tbody>${rows.map(mngRowHtml).join('')}</tbody>
                    </table>
                </div>` : ''}
            </div>`;
    }

    window.d_manageToggleGroup = function (key) {
        if (mng.closed.has(key)) mng.closed.delete(key);
        else mng.closed.add(key);
        mngRenderList(mngFiltered());
    };

    function mngRowHtml(c) {
        const status = computeCoinStatus(c);
        const expiry = c.expires_at
            ? (new Date(c.expires_at) < new Date() ? '<span class="pill warn">expired</span>' : `<span title="${esc(fmtDate(c.expires_at))}">${formatUntil(c.expires_at)}</span>`)
            : '—';
        return `
            <tr>
                <td>
                    <span style="font-family:Menlo,Monaco,monospace; font-size:12px; color:var(--gold); cursor:pointer;" title="Click to copy" onclick="d_copyCode('${jsEsc(c.coin_code || '')}')">${esc(c.coin_code || '—')}</span>
                    <div style="color:var(--muted); font-size:11.5px; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(c.title || '(untitled)')}</div>
                </td>
                <td style="font-size:12px; color:var(--muted); font-family:monospace; white-space:nowrap;">${c.latitude != null ? `${c.latitude.toFixed(4)}, ${c.longitude.toFixed(4)}` : '—'}</td>
                <td style="color:#FFD700; font-weight:700; white-space:nowrap;">${fmtVal(c.reward_amount, c.value_currency)}</td>
                <td>${statusBadgeHtml(status)}</td>
                <td>${c.views_count || 0}${c.view_limit ? ` / ${c.view_limit}` : ' / ∞'}</td>
                <td style="font-size:12px; color:var(--muted); white-space:nowrap;">${expiry}</td>
                <td style="text-align:right; white-space:nowrap;">
                    <button class="btn sm" onclick="d_openCoinDetail('${jsEsc(c.id)}')">Detail</button>
                    <button class="btn sm ${c.is_active ? 'warn' : 'ok'}" onclick="d_manageToggleCoin('${jsEsc(c.id)}', ${!c.is_active})">${c.is_active ? 'Deactivate' : 'Activate'}</button>
                    <button class="btn sm danger" onclick="d_manageDeleteCoin('${jsEsc(c.id)}', '${jsEsc(c.coin_code || c.id)}')">Delete</button>
                </td>
            </tr>`;
    }

    window.d_copyCode = function (code) {
        if (!code) { adminToast('This coin has no code', 'error'); return; }
        navigator.clipboard.writeText(code)
            .then(() => adminToast('Coin code copied', 'success'))
            .catch(() => adminToast('Copy failed — see console', 'error'));
    };

    // ── Per-coin actions (calls byte-for-byte) ───────────────────────
    window.d_manageToggleCoin = async function (coinId, makeActive) {
        const { error } = await supabaseClient
            .from('admin_drops')
            .update({ is_active: makeActive })
            .eq('id', coinId);
        if (error) {
            adminToast('Failed to update: ' + error.message, 'error');
            return;
        }
        adminToast(`Coin ${makeActive ? 'activated' : 'deactivated'}`, 'success');
        const row = mng.coins.find(c => c.id === coinId);
        if (row) row.is_active = makeActive;
        if (mngInfoWindow) mngInfoWindow.close();
        mngRenderTiles();
        window.d_manageApply();
    };

    window.d_manageDeleteCoin = async function (coinId, label) {
        const ok = await adminConfirm({
            title: 'Delete this coin?',
            message: `Permanently removes coin ${label} and its claim history.\n\nThis cannot be undone.`,
            dangerLevel: 'destructive',
            confirmLabel: 'Delete coin',
        });
        if (!ok) return;
        const { error } = await supabaseClient.rpc('admin_bulk_delete_admin_drops', { p_drop_ids: [coinId] });
        if (error) {
            adminToast('Delete failed: ' + error.message, 'error');
            return;
        }
        adminToast('Coin deleted', 'success');
        mng.coins = mng.coins.filter(c => c.id !== coinId);
        if (mngInfoWindow) mngInfoWindow.close();
        mngRenderTiles();
        window.d_manageApply();
    };

    // ── Batch actions ────────────────────────────────────────────────
    // "Deactivate/Activate all" loops the ported per-coin toggle UPDATE —
    // no new call shapes introduced.
    window.d_manageBatchToggleAll = async function (batchId, makeActive) {
        const targets = mng.coins.filter(c => (c.bulk_batch_id || '_single') === batchId && c.is_active !== makeActive);
        if (!targets.length) { adminToast('Nothing to change in this batch', 'info'); return; }
        if (!makeActive) {
            const ok = await adminConfirm({
                title: `Deactivate ${targets.length} coin${targets.length === 1 ? '' : 's'}?`,
                message: 'They disappear from the app map immediately. You can re-activate the batch at any time.',
                dangerLevel: 'warning',
                confirmLabel: `Deactivate ${targets.length}`,
            });
            if (!ok) return;
        }
        const results = await Promise.all(targets.map(c =>
            supabaseClient
                .from('admin_drops')
                .update({ is_active: makeActive })
                .eq('id', c.id)
        ));
        const failed = results.filter(r => r.error).length;
        targets.forEach((c, i) => { if (!results[i].error) c.is_active = makeActive; });
        if (failed) adminToast(`${targets.length - failed} updated, ${failed} failed`, 'error', 5000);
        else adminToast(`${targets.length} coin${targets.length === 1 ? '' : 's'} ${makeActive ? 'activated' : 'deactivated'}`, 'success');
        mngRenderTiles();
        window.d_manageApply();
    };

    window.d_deleteDropBatch = async function (batchId, coinCount) {
        const confirmed = await adminConfirm({
            title: 'Delete entire bulk drop?',
            message: `This will permanently delete ${coinCount} coin${coinCount === 1 ? '' : 's'} from this batch. Users who already claimed coins from it keep their rewards (ledger entries are untouched), but unclaimed coins disappear from the map immediately.\n\nThis cannot be undone.`,
            dangerLevel: 'destructive',
            confirmLabel: `Delete ${coinCount} coin${coinCount === 1 ? '' : 's'}`,
        });
        if (!confirmed) return;

        const { data, error } = await supabaseClient.rpc('admin_delete_drops_batch', { p_batch_id: batchId });
        if (error) {
            adminToast('Failed to delete batch: ' + error.message, 'error');
            return;
        }
        adminToast(`Deleted ${data?.deleted_count || 0} coins from batch.`, 'success');
        window.d_manageLoad();
    };

    // ── Map view (same filtered set) ─────────────────────────────────
    function mngEnsureMap() {
        const mapEl = $id('d_mngMap');
        if (!mapEl || typeof google === 'undefined') return;
        if (mngMap) {
            const c = mngMap.getCenter();
            google.maps.event.trigger(mngMap, 'resize');
            if (c) mngMap.setCenter(c);
            return;
        }
        mapEl.innerHTML = '';
        mngMap = new google.maps.Map(mapEl, {
            center: { lat: 39.5, lng: -98.35 }, // continental US until markers fit bounds
            zoom: 4,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: true,
            styles: DARK_MAP,
        });
        mngInfoWindow = new google.maps.InfoWindow();
    }

    function mngRenderMarkers(filtered) {
        if (mng.view !== 'map') return;
        mngEnsureMap();
        if (!mngMap) return;
        // Clear previous markers before re-adding (reuse the array).
        for (const m of mngMarkers) m.setMap(null);
        mngMarkers = [];
        if (mngInfoWindow) mngInfoWindow.close();

        const coins = filtered.filter(c =>
            c.latitude != null && c.longitude != null && !isNaN(c.latitude) && !isNaN(c.longitude)
        );
        if (!coins.length) return;

        const bounds = new google.maps.LatLngBounds();
        for (const coin of coins) {
            const status = computeCoinStatus(coin);
            const color = {
                active:        '#4CAF50',
                inactive:      '#9E9E9E',
                expired:       '#FF9800',
                fully_claimed: '#9C27B0',
            }[status] || '#9C8F80';

            const marker = new google.maps.Marker({
                position: { lat: coin.latitude, lng: coin.longitude },
                map: mngMap,
                title: coin.title || '(untitled)',
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 9,
                    fillColor: color,
                    fillOpacity: 0.95,
                    strokeColor: '#000',
                    strokeWeight: 2,
                },
            });
            marker.addListener('click', () => {
                mngInfoWindow.setContent(mngInfoWindowHtml(coin, status));
                mngInfoWindow.open(mngMap, marker);
            });
            mngMarkers.push(marker);
            bounds.extend({ lat: coin.latitude, lng: coin.longitude });
        }

        // Fit bounds with padding; skip fit-to-1 (extreme zoom).
        if (coins.length > 1) {
            mngMap.fitBounds(bounds, 60);
        } else {
            mngMap.setCenter({ lat: coins[0].latitude, lng: coins[0].longitude });
            mngMap.setZoom(15);
        }
    }

    // InfoWindow renders inside Google's white popover — dark text there.
    function mngInfoWindowHtml(coin, status) {
        const badge = STATUS_BADGE[status] || STATUS_BADGE.inactive;
        const claimsLabel = `${coin.views_count || 0}${coin.view_limit ? ` / ${coin.view_limit}` : ' / ∞'}`;
        return `
            <div style="font-family:-apple-system, BlinkMacSystemFont, sans-serif; min-width:240px; max-width:320px;">
                <div style="font-size:14px; font-weight:700; color:#1E1712; margin-bottom:4px;">${esc(coin.title || '(untitled)')}</div>
                <div style="font-size:11px; font-family:Menlo,Monaco,monospace; color:#9C8F80; margin-bottom:8px;">${esc(coin.coin_code || coin.id)}</div>
                <div style="display:grid; grid-template-columns:auto 1fr; gap:4px 10px; font-size:12px; color:#3d3226; margin-bottom:10px;">
                    <span style="color:#9C8F80;">Value:</span> <span style="font-weight:600; color:#B8860B;">${fmtVal(coin.reward_amount, coin.value_currency)}</span>
                    <span style="color:#9C8F80;">Status:</span> <span style="color:${badge.color}; font-weight:600;">${badge.label}</span>
                    <span style="color:#9C8F80;">Claims:</span> <span>${claimsLabel}</span>
                    <span style="color:#9C8F80;">Radius:</span> <span>${coin.radius || '?'} m</span>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button onclick="d_openCoinDetail('${jsEsc(coin.id)}')" style="padding:6px 12px; background:#C2902F; color:#F2E9DA; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">✏️ Detail</button>
                    <button onclick="d_manageToggleCoin('${jsEsc(coin.id)}', ${!coin.is_active})" style="padding:6px 12px; background:${coin.is_active ? '#FF9800' : '#4CAF50'}; color:#F2E9DA; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">${coin.is_active ? 'Deactivate' : 'Activate'}</button>
                    <button onclick="d_manageDeleteCoin('${jsEsc(coin.id)}', '${jsEsc(coin.coin_code || coin.id)}')" style="padding:6px 12px; background:#FF4757; color:#F2E9DA; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">🗑 Delete</button>
                </div>
            </div>`;
    }
    // ═════════════════════════════════════════════════════════════════
    // INSIGHTS — audit dashboard (queries byte-for-byte from the port)
    // ═════════════════════════════════════════════════════════════════
    function insightsSkeletonHtml() {
        return `
            <div class="card" style="margin-bottom:18px; display:flex; gap:10px; align-items:end;">
                <div style="flex:1;">
                    <label style="${LBL} text-transform:uppercase; letter-spacing:0.05em; font-size:11px;">Look up a coin by code</label>
                    <input type="text" id="d_insLookup" placeholder="COIN-XXXX-XXXX-XXXX" onkeydown="if(event.key==='Enter')d_lookupCoinByCode()" style="${INP} font-size:13px; font-family:Menlo,Monaco,monospace;">
                </div>
                <button class="btn gold" onclick="d_lookupCoinByCode()">Look up</button>
            </div>
            <div id="d_insBody"><div class="spin">Loading dashboard…</div></div>`;
    }

    async function loadInsights() {
        const pane = $id('d_insBody');
        if (!pane) return;
        pane.innerHTML = '<div class="spin">Loading dashboard…</div>';

        try {
            const nowIso = new Date().toISOString();
            const oneDayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

            // Active coins: is_active AND (expires_at IS NULL OR expires_at > NOW())
            //              AND (view_limit IS NULL OR views_count < view_limit).
            // PostgREST can't compare views_count < view_limit column-to-column,
            // so fetch active+non-expired rows and apply that check here.
            const { data: activeRows, error: actErr } = await supabaseClient
                .from('admin_drops')
                .select('id, reward_amount, value_currency, view_limit, views_count')
                .eq('is_active', true)
                .or(`expires_at.is.null,expires_at.gt.${nowIso}`);
            if (actErr) console.log('[admin-coins] dashboard active fetch error', actErr);

            const stillClaimable = (activeRows || []).filter(d =>
                d.view_limit == null || (d.views_count || 0) < d.view_limit
            );
            const totalActive = stillClaimable.length;
            const usdOnMap = stillClaimable
                .filter(d => d.value_currency === 'USD')
                .reduce((s, d) => s + (d.reward_amount || 0), 0);
            const creditsOnMap = stillClaimable
                .filter(d => d.value_currency === 'CREDITS')
                .reduce((s, d) => s + (d.reward_amount || 0), 0);

            // Claims today (24h window)
            const { count: claimsToday, error: ctErr } = await supabaseClient
                .from('admin_drop_views')
                .select('id', { count: 'exact', head: true })
                .not('claimed_at', 'is', null)
                .gt('claimed_at', oneDayAgoIso);
            if (ctErr) console.log('[admin-coins] dashboard claimsToday error', ctErr);

            // Claims all-time
            const { count: claimsAllTime, error: caErr } = await supabaseClient
                .from('admin_drop_views')
                .select('id', { count: 'exact', head: true })
                .not('claimed_at', 'is', null);
            if (caErr) console.log('[admin-coins] dashboard claimsAllTime error', caErr);

            // Top 5 claimants. Pull recent claims (cap 2000 to bound work),
            // group client-side, then join usernames.
            const { data: claimsRows, error: clErr } = await supabaseClient
                .from('admin_drop_views')
                .select('viewer_id')
                .not('claimed_at', 'is', null)
                .limit(2000);
            if (clErr) console.log('[admin-coins] dashboard claims fetch error', clErr);

            const claimCounts = {};
            (claimsRows || []).forEach(r => {
                if (!r.viewer_id) return;
                claimCounts[r.viewer_id] = (claimCounts[r.viewer_id] || 0) + 1;
            });
            const topIds = Object.entries(claimCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5);

            let topClaimants = [];
            if (topIds.length > 0) {
                const { data: users } = await supabaseClient
                    .from('users')
                    .select('id, username')
                    .in('id', topIds.map(([id]) => id));
                const usersById = new Map((users || []).map(u => [u.id, u]));
                topClaimants = topIds.map(([id, count]) => ({
                    id,
                    username: usersById.get(id)?.username || '(unknown)',
                    count,
                }));
            }

            const usdLabel = `$${(usdOnMap / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            const tile = (title, value, sub) => `
                <div class="stat"><h4>${esc(title)}</h4><div class="num">${value}</div>${sub ? `<div style="color:var(--muted); font-size:12px; margin-top:6px;">${sub}</div>` : ''}</div>`;
            const topHtml = topClaimants.length === 0
                ? '<div style="color:var(--muted); font-size:13px;">No claims yet.</div>'
                : topClaimants.map((c, i) => `
                    <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border);">
                        <div style="color:var(--cream);"><span style="color:var(--gold); font-weight:700; margin-right:8px;">#${i + 1}</span>${esc(c.username)}</div>
                        <div style="color:#FFD700; font-weight:700;">${c.count} claim${c.count === 1 ? '' : 's'}</div>
                    </div>`).join('');
            pane.innerHTML = `
                <div class="stats" style="margin-bottom:24px;">
                    ${tile('Total coins active', totalActive.toLocaleString(), 'Still claimable right now')}
                    ${tile('USD on the map', `<span style="color:#FFD700;">${usdLabel}</span>`, 'Sum of active USD coins')}
                    ${tile('Credits on the map', `<span style="color:#FFD700;">${creditsOnMap.toLocaleString()}</span>`, 'Sum of active CREDITS coins')}
                    ${tile('Claims today', (claimsToday || 0).toLocaleString(), 'Last 24 hours')}
                    ${tile('Claims all-time', (claimsAllTime || 0).toLocaleString(), 'Across every coin ever')}
                </div>
                <div class="card">
                    <h3 style="color:var(--gold); font-size:14px; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:12px;">🏆 Top 5 Claimants</h3>
                    ${topHtml}
                    <div style="color:var(--muted); font-size:11px; margin-top:12px;">Based on the most recent 2,000 claims.</div>
                </div>`;
        } catch (err) {
            console.error('[admin-coins] dashboard threw', err);
            pane.innerHTML = `<div class="empty" style="color:var(--danger);">Failed to load dashboard: ${esc(err.message || String(err))}</div>`;
        }
    }

    // Look up by coin_code (public identifier). Stored uppercase — normalize,
    // then fall back to case-insensitive ilike. Queries byte-for-byte.
    window.d_lookupCoinByCode = async function () {
        const raw = ($id('d_insLookup')?.value || '').trim();
        if (!raw) { adminToast('Enter a coin code first', 'error'); return; }
        const code = raw.toUpperCase();
        console.log('[admin-coins] lookup by code', code);
        let { data, error } = await supabaseClient
            .from('admin_drops')
            .select('id')
            .eq('coin_code', code)
            .maybeSingle();
        if (error) {
            console.log('[admin-coins] lookup error', error);
            adminToast('Lookup failed: ' + error.message, 'error');
            return;
        }
        if (!data) {
            const fallback = await supabaseClient
                .from('admin_drops')
                .select('id')
                .ilike('coin_code', raw)
                .maybeSingle();
            if (!fallback.error && fallback.data) data = fallback.data;
        }
        if (!data) {
            adminToast(`No coin with code "${raw}"`, 'error');
            return;
        }
        window.d_openCoinDetail(data.id);
    };

    // ═════════════════════════════════════════════════════════════════
    // COIN DETAIL — ui.drawer (queries byte-for-byte from the port)
    // ═════════════════════════════════════════════════════════════════
    window.d_openCoinDetail = function (coinId) {
        ui.drawer({
            title: '🪙 Coin detail',
            wide: true,
            html: '<div class="spin">Loading coin…</div>',
            onMount: (body) => loadCoinDetailInto(body, coinId),
        });
    };

    async function loadCoinDetailInto(body, coinId) {
        try {
            // Fetch coin + claim history in parallel.
            const [coinRes, claimsRes] = await Promise.all([
                supabaseClient
                    .from('admin_drops')
                    .select('*')
                    .eq('id', coinId)
                    .single(),
                supabaseClient
                    .from('admin_drop_views')
                    .select('id, viewer_id, claimed_at, watch_progress_pct, watch_started_at')
                    .eq('admin_drop_id', coinId)
                    .order('claimed_at', { ascending: false, nullsFirst: false }),
            ]);

            if (coinRes.error) {
                console.log('[admin-coins] coin detail fetch error', coinRes.error);
                body.innerHTML = `<div class="empty" style="color:var(--danger);">Failed to load coin: ${esc(coinRes.error.message)}</div>`;
                return;
            }
            const coin = coinRes.data;
            const claims = claimsRes.data || [];
            if (claimsRes.error) console.log('[admin-coins] claims fetch error', claimsRes.error);

            // Sidecar fetches: usernames + ledger txn codes
            const viewerIds = [...new Set(claims.map(c => c.viewer_id).filter(Boolean))];
            const claimIds = claims.map(c => c.id);

            const [usersRes, ledgerRes] = await Promise.all([
                viewerIds.length > 0
                    ? supabaseClient.from('users').select('id, username').in('id', viewerIds)
                    : Promise.resolve({ data: [], error: null }),
                claimIds.length > 0
                    ? supabaseClient.from('user_credit_ledger')
                        .select('source_id, transaction_code, amount, currency')
                        .eq('source', 'drop_claim')
                        .in('source_id', claimIds)
                    : Promise.resolve({ data: [], error: null }),
            ]);
            if (usersRes.error) console.log('[admin-coins] users fetch error', usersRes.error);
            if (ledgerRes.error) console.log('[admin-coins] ledger fetch error', ledgerRes.error);

            const usersById = new Map((usersRes.data || []).map(u => [u.id, u]));
            // email REVOKE'd from authenticated → fetch via admin RPC +
            // attach to each user so the claim list shows it.
            const coinEmap = await fetchEmailMap(viewerIds);
            usersById.forEach((u, id) => { u.email = coinEmap[id] || null; });
            const ledgerByClaimId = new Map((ledgerRes.data || []).map(l => [l.source_id, l]));

            body.innerHTML = coinDetailHtml(coin, claims, usersById, ledgerByClaimId);
            loadViewerAudit(coinId);
        } catch (err) {
            console.error('[admin-coins] coin detail threw', err);
            body.innerHTML = `<div class="empty" style="color:var(--danger);">Unexpected error: ${esc(err.message || String(err))}</div>`;
        }
    }

    function coinDetailHtml(coin, claims, usersById, ledgerByClaimId) {
        const status = computeCoinStatus(coin);
        const valueLabel = coin.value_currency === 'USD'
            ? `$${((coin.reward_amount || 0) / 100).toFixed(2)}`
            : `${(coin.reward_amount || 0).toLocaleString()} credits`;
        const claimsTotal = claims.filter(c => c.claimed_at).length;
        const claimsAttempted = claims.length;
        const claimsRowsHtml = claims.length === 0
            ? '<tr><td colspan="5" style="padding:24px; text-align:center; color:var(--muted);">No claim attempts yet.</td></tr>'
            : claims.map(c => {
                const u = usersById.get(c.viewer_id);
                const ledger = ledgerByClaimId.get(c.id);
                const claimedLabel = c.claimed_at
                    ? new Date(c.claimed_at).toLocaleString()
                    : '<span style="color:var(--muted);">— (incomplete)</span>';
                const progress = c.watch_progress_pct != null
                    ? `${Number(c.watch_progress_pct).toFixed(0)}%`
                    : '—';
                const txCell = ledger
                    ? `<span style="font-family:Menlo,Monaco,monospace; font-size:11px; color:var(--gold);">${esc(ledger.transaction_code)}</span>`
                    : '<span style="color:var(--muted);">—</span>';
                return `
                    <tr>
                        <td>
                            <span class="userchip"><span class="nm" onclick="openUser('${jsEsc(c.viewer_id || '')}')">${esc(u?.username || '(unknown)')}</span></span>
                            ${u?.email ? `<div style="color:var(--muted); font-size:11px;">${esc(u.email)}</div>` : ''}
                        </td>
                        <td style="color:var(--muted); font-size:12px;">${claimedLabel}</td>
                        <td style="color:var(--cream);">${progress}</td>
                        <td>${txCell}</td>
                        <td style="text-align:center;">
                            <button class="btn sm" onclick="d_reverseClaimTodo('${jsEsc(c.id)}')" title="Not yet implemented">Reverse (TODO)</button>
                        </td>
                    </tr>`;
            }).join('');

        const videoDurLine = coin.video_duration_seconds != null
            ? `<div style="color:var(--muted); font-size:12px;">⏱️ Video duration: <strong style="color:var(--cream);">${esc(coin.video_duration_seconds)}s</strong> (server-side watch validation enabled)</div>`
            : `<div style="color:var(--muted); font-size:12px;">⏱️ Video duration: <strong style="color:var(--cream);">not set</strong> (instant-claim coin)</div>`;

        return `
            <div class="sect">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:14px;">
                    <div>
                        <div style="font-family:Menlo,Monaco,monospace; font-size:18px; color:var(--gold); margin-bottom:6px; cursor:pointer;" title="Click to copy" onclick="d_copyCode('${jsEsc(coin.coin_code || '')}')">${esc(coin.coin_code || coin.id)}</div>
                        <h3 style="color:var(--cream); font-size:17px; margin-bottom:6px;">${esc(coin.title || '(untitled)')}</h3>
                        ${coin.description ? `<div style="color:var(--muted); font-size:13px; margin-bottom:10px;">${esc(coin.description)}</div>` : ''}
                        <div style="font-size:24px; color:#FFD700; font-weight:700; margin-bottom:8px;">${valueLabel}</div>
                        <div style="color:var(--muted); font-size:12px;">📍 ${coin.latitude?.toFixed(5)}, ${coin.longitude?.toFixed(5)} · geofence ${coin.radius}m</div>
                        ${videoDurLine}
                        ${coin.media_url ? `<div style="margin-top:8px;"><button class="btn sm" onclick="ui.player('${jsEsc(coin.media_url)}')">▶︎ Play media</button></div>` : ''}
                    </div>
                    <div style="text-align:right;">
                        <div style="margin-bottom:8px;">${statusBadgeHtml(status)}</div>
                        <div style="color:var(--muted); font-size:12px;">Created ${coin.created_at ? new Date(coin.created_at).toLocaleString() : '—'}</div>
                        ${coin.expires_at ? `<div style="color:var(--muted); font-size:12px;">Expires ${new Date(coin.expires_at).toLocaleString()}</div>` : '<div style="color:var(--muted); font-size:12px;">No expiry</div>'}
                        <div style="color:var(--muted); font-size:12px;">Claims: <strong style="color:var(--cream);">${coin.views_count || 0}</strong>${coin.view_limit ? ` / ${coin.view_limit}` : ' (unlimited)'}</div>
                    </div>
                </div>
            </div>

            <div class="sect">
                <h4>📬 Notified</h4>
                <button class="btn sm" onclick="d_loadRecipientsInline('drop','${jsEsc(coin.id)}')">👥 Who was notified</button>
                <div id="d_coinRecipients" style="margin-top:10px;"></div>
            </div>

            <div class="sect">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <h4 style="margin:0;">📜 Claim history</h4>
                    <div style="color:var(--muted); font-size:12px;">${claimsTotal} successful · ${claimsAttempted} attempted</div>
                </div>
                <div class="tblwrap">
                    <table class="tbl">
                        <thead>
                            <tr><th>Username</th><th>Claimed At</th><th>Watch %</th><th>Transaction Code</th><th style="text-align:center;">Action</th></tr>
                        </thead>
                        <tbody>${claimsRowsHtml}</tbody>
                    </table>
                </div>
            </div>

            <!-- Viewer log (claimed vs preview-only) — ported loadViewerData -->
            <div class="sect" id="d_coinViewerAudit"><div class="spin">Loading claim audit…</div></div>`;
    }

    // Placeholder — wire up to a real "reverse claim" RPC later (legacy TODO).
    window.d_reverseClaimTodo = function (claimId) {
        console.log('[admin-coins] reverseClaimTodo for claim', claimId);
        adminToast('Reverse-claim flow is not yet implemented.', 'info');
    };

    // Ported legacy loadViewerData: full viewer audit trail for one coin
    // (claimed vs preview-only, avatars, emails via admin RPC).
    async function loadViewerAudit(dropId) {
        const contentDiv = $id('d_coinViewerAudit');
        if (!contentDiv) return;
        try {
            const { data: views, error } = await supabaseClient
                .from('admin_drop_views')
                .select(`
                    viewer_id, viewed_at, claimed_at, watch_progress_pct,
                    viewer:users!admin_drop_views_viewer_id_fkey(id, username, avatar_url)
                `)
                .eq('admin_drop_id', dropId)
                .order('claimed_at', { ascending: false, nullsLast: true });

            if (error) {
                console.error('Error loading viewer data:', error);
                contentDiv.innerHTML = `<div class="empty" style="color:var(--danger);">Failed to load claim data: ${esc(error.message)}</div>`;
                return;
            }
            if (!views || views.length === 0) {
                contentDiv.innerHTML = `<h4>🧾 Claim audit</h4><div style="color:var(--muted); font-size:13px;">No claims yet — this coin hasn't been viewed by anyone.</div>`;
                return;
            }

            // email REVOKE'd from authenticated → fetch via admin RPC.
            const emap = await fetchEmailMap(views.map(v => v.viewer?.id || v.viewer_id));
            views.forEach(v => { if (v.viewer) v.viewer.email = emap[v.viewer.id] || null; });

            const claimedCount = views.filter(v => v.claimed_at).length;
            const previewCount = views.length - claimedCount;
            const rowsHtml = views.map((view, idx) => {
                const viewedDate = new Date(view.viewed_at);
                const claimedDate = view.claimed_at ? new Date(view.claimed_at) : null;
                const viewer = view.viewer || {};
                const isClaimed = !!view.claimed_at;
                const badge = isClaimed ? `<span class="pill ok">✓ CLAIMED</span>` : `<span class="pill muted">PREVIEW</span>`;
                const whenLabel = isClaimed
                    ? `${claimedDate.toLocaleString()}<div style="color:var(--muted); font-size:11px;">${getTimeAgo(claimedDate)}</div>`
                    : `${viewedDate.toLocaleString()}<div style="color:var(--muted); font-size:11px;">${getTimeAgo(viewedDate)}</div>`;
                return `
                    <tr>
                        <td style="color:var(--muted);">${idx + 1}</td>
                        <td>
                            <div class="userchip">
                                ${avatarHtml(viewer.avatar_url, viewer.username, 28)}
                                <span class="nm" onclick="openUser('${jsEsc(viewer.id || '')}')">@${esc(viewer.username || 'Unknown')}</span>
                            </div>
                        </td>
                        <td style="color:var(--muted); font-size:12px;">${esc(viewer.email || '—')}</td>
                        <td>${badge}</td>
                        <td style="color:${view.watch_progress_pct === 100 ? 'var(--ok)' : 'var(--warn)'}; font-weight:700;">${view.watch_progress_pct}%</td>
                        <td style="color:var(--muted); font-size:12px;">${whenLabel}</td>
                    </tr>`;
            }).join('');

            contentDiv.innerHTML = `
                <div style="margin-bottom:10px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                    <h4 style="margin:0;">🧾 Claim audit</h4>
                    <span class="pill ok">${claimedCount} CLAIMED</span>
                    <span class="pill muted">${previewCount} PREVIEW ONLY</span>
                </div>
                <div class="tblwrap">
                    <table class="tbl">
                        <thead><tr><th>#</th><th>User</th><th>Email</th><th>Status</th><th>Watched %</th><th>When</th></tr></thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>`;
        } catch (error) {
            console.error('Error loading viewer data:', error);
            contentDiv.innerHTML = `<div class="empty" style="color:var(--danger);">Failed to load viewer data: ${esc(error.message)}</div>`;
        }
    }

    // Legacy getTimeAgo — takes a Date (shared timeAgo takes ISO), finer wording.
    function getTimeAgo(date) {
        const now = new Date();
        const seconds = Math.floor((now - date) / 1000);
        if (seconds < 60) return 'just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days} day${days !== 1 ? 's' : ''} ago`;
        const weeks = Math.floor(days / 7);
        if (weeks < 4) return `${weeks} week${weeks !== 1 ? 's' : ''} ago`;
        const months = Math.floor(days / 30);
        if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;
        const years = Math.floor(days / 365);
        return `${years} year${years !== 1 ? 's' : ''} ago`;
    }
})();
