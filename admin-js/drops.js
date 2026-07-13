// ═══════════════════════════════════════════════════════════════════════
// Drops (Blip Coins) — ported from admin-legacy.html
//   HTML  ~lines 876–1313  (admin-drops tab + sub-tab panes)
//   JS    ~lines 5044–7972 (Admin Drops functions)
//
// Sub-views: Create Single | Create Bulk | Browse | Batches | Map | Audit.
// All supabase .from()/.rpc()/storage/edge-function calls are byte-for-byte
// from legacy (bucket blip-videos, prefix admin-drops/, create-admin-drop +
// notify-drop-batch edge functions, bulk_insert_admin_drops_at_points,
// admin_bulk_delete_admin_drops, admin_list_drop_batches,
// admin_delete_drops_batch RPCs).
//
// Skipped as dead code (legacy "Manage Drops" table was retired; its
// container #adminDropsList never exists in the DOM, and nothing reachable
// calls loadAdminDrops()): loadAdminDrops, groupAdminDrops,
// renderAdminDropsList, deleteGroupAll, openGroupDetail, closeGroupDetail,
// toggleSelectCoin, toggleSelectAllInGroup, deleteSelectedInGroup,
// deleteSingleFromGroup, updateDropMarkersOnMap, toggleDropActive,
// deleteAdminDrop, toggleViewerDetails, closeAdminDropsTab. Their live
// equivalents are the Browse/Batches/Map handlers below (toggle via
// admin_drops UPDATE, delete via admin_bulk_delete_admin_drops).
// loadViewerData's audit query IS ported — it renders inside the coin
// detail view (its legacy home, the expandable table row, was retired).
// ═══════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    // ───────── module state ─────────
    let _sub = 'single'; // active sub-view; survives route re-renders

    // Single-coin picker map
    let dropMap = null;
    let dropMarker = null;
    let selectedDropLocation = null;

    // Bulk-drop area picker map
    let bulkDropMap = null;
    let bulkCenterMarker = null;
    let bulkSpreadCircle = null;
    let bulkSelectedCenter = null;

    // Map view (all coins) — reuse the instance, keep marker refs to clear
    let _adminMapInstance = null;
    let _adminMapMarkers = [];
    let _adminMapInfoWindow = null;

    // Browse
    const BROWSE_PAGE_SIZE = 50;
    let _browseCoinsLoaded = false;
    let _browseCoinsAll = [];
    let _browseCoinsOffset = 0;
    let _browseCoinsExhausted = false;
    let _browseCoinsLoading = false;
    let _browseSearchTimer = null;

    // Batches
    let _dropBatchesCache = {};
    let _currentBatchDetail = null;
    let _dropBatchDetailRows = [];

    // Post-create callout stashes (legacy kept these on window)
    let _lastBulkCoinCodes = [];
    let _lastSingleCoinCode = '';

    // Same key the shell's Maps JS <script> tag uses (legacy line 5358).
    const GOOGLE_API_KEY = 'AIzaSyA3ctp1Waczjq5VJZp-rO0I1eRa916I_8s';

    // Shared inline styles for the ported forms
    const INP  = 'width:100%; padding:11px; border:1px solid var(--border-strong); border-radius:8px; background:var(--well); color:var(--cream); font-size:14px; font-family:inherit;';
    const LBL  = 'display:block; margin-bottom:6px; color:var(--muted); font-size:12px;';
    const HINT = 'display:block; margin-top:4px; color:var(--muted); font-size:11px;';
    const H3   = 'margin:22px 0 14px; color:var(--gold); font-size:16px;';
    const CALLOUT = 'display:none; margin-top:18px; padding:16px; background:rgba(194,144,47,0.08); border:1px solid var(--gold); border-radius:10px; color:var(--cream);';

    const SUBTABS = [
        ['single',  '🪙 Create Single'],
        ['bulk',    '🎯 Create Bulk'],
        ['browse',  '🔍 Browse'],
        ['batches', '📦 Batches'],
        ['map',     '🗺️ Map'],
        ['audit',   '📊 Audit'],
    ];

    const STATUS_BADGE = {
        active:        { label: '● ACTIVE',        color: '#4CAF50', bg: 'rgba(76,175,80,0.15)' },
        inactive:      { label: 'INACTIVE',        color: '#A99C8D', bg: 'rgba(150,150,150,0.15)' },
        expired:       { label: 'EXPIRED',         color: '#FF9800', bg: 'rgba(255,152,0,0.12)' },
        fully_claimed: { label: '✓ FULLY CLAIMED', color: '#9C27B0', bg: 'rgba(156,39,176,0.15)' },
    };
    function statusBadgeHtml(status) {
        const b = STATUS_BADGE[status] || STATUS_BADGE.inactive;
        return `<span style="color:${b.color}; background:${b.bg}; font-weight:700; font-size:11px; padding:4px 10px; border-radius:12px; white-space:nowrap;">${b.label}</span>`;
    }

    // ═════════ Route ═════════
    registerRoute('drops', {
        title: 'Drops', icon: '🪙', order: 7,
        render(el) {
            // The router rebuilt the DOM — every map instance / DOM-bound cache
            // now points at dead nodes. Reset them so panes re-init cleanly.
            dropMap = null; dropMarker = null; selectedDropLocation = null;
            bulkDropMap = null; bulkCenterMarker = null; bulkSpreadCircle = null; bulkSelectedCenter = null;
            _adminMapInstance = null; _adminMapMarkers = []; _adminMapInfoWindow = null;
            _browseCoinsLoaded = false; _browseCoinsAll = []; _browseCoinsOffset = 0;
            _browseCoinsExhausted = false; _browseCoinsLoading = false;
            _dropBatchesCache = {}; _currentBatchDetail = null; _dropBatchDetailRows = [];

            el.innerHTML = `
                <h2 class="page">🪙 Blip Coins</h2>
                <p class="pagesub">Drop geo-located coins. Users walk within the geofence and watch the full media to claim. Value is hidden on the map — they only see the tier color.</p>
                <div class="toolbar">
                    ${SUBTABS.map(([k, label]) => `<button class="btn" data-dsub="${k}" onclick="d_setSubTab('${k}')">${label}</button>`).join('')}
                </div>
                <div id="d_pane_single"  style="display:none;">${paneSingleHtml()}</div>
                <div id="d_pane_bulk"    style="display:none;">${paneBulkHtml()}</div>
                <div id="d_pane_browse"  style="display:none;">${paneBrowseHtml()}</div>
                <div id="d_pane_batches" style="display:none;">${paneBatchesHtml()}</div>
                <div id="d_pane_map"     style="display:none;">${paneMapHtml()}</div>
                <div id="d_pane_audit"   style="display:none;">${paneAuditHtml()}</div>`;
            window.d_setSubTab(_sub);
        },
    });

    // ═════════ Sub-tab switching ═════════
    // CRITICAL (learned in legacy): a Google Map created while its container
    // is display:none renders gray — legacy worked around it with a 100ms
    // setTimeout after tab switch. Here the pane is made visible FIRST, then
    // its map is initialized; when re-showing an existing map we kick
    // google.maps.event.trigger(map,'resize') and restore the center.
    window.d_setSubTab = function (name) {
        _sub = name;
        for (const [k] of SUBTABS) {
            const pane = document.getElementById('d_pane_' + k);
            if (pane) pane.style.display = (k === name) ? 'block' : 'none';
        }
        document.querySelectorAll('[data-dsub]').forEach(b => b.classList.toggle('gold', b.dataset.dsub === name));

        const hasG = typeof google !== 'undefined';
        if (name === 'single' && hasG) {
            if (!dropMap) initializeDropMap();
            else { const c = dropMap.getCenter(); google.maps.event.trigger(dropMap, 'resize'); if (c) dropMap.setCenter(c); }
        }
        if (name === 'bulk' && hasG) {
            if (!bulkDropMap) initBulkDropMap();
            else { const c = bulkDropMap.getCenter(); google.maps.event.trigger(bulkDropMap, 'resize'); if (c) bulkDropMap.setCenter(c); }
        }
        if (name === 'browse' && !_browseCoinsLoaded) {
            window.d_loadBrowseCoins(true);
        }
        if (name === 'batches') {
            // Always refresh on entry — admins likely click into Batches
            // because they JUST did a bulk drop and want to see it.
            window.d_loadDropBatches();
        }
        if (name === 'map') {
            if (hasG && _adminMapInstance) {
                const c = _adminMapInstance.getCenter();
                google.maps.event.trigger(_adminMapInstance, 'resize');
                if (c) _adminMapInstance.setCenter(c);
            }
            // Always refresh on entry so markers reflect current state.
            window.d_loadMapView();
        }
        if (name === 'audit') {
            // If we're not currently viewing a coin detail, refresh the dashboard.
            const detailPane = document.getElementById('auditCoinDetailPane');
            if (!detailPane || detailPane.style.display === 'none') {
                loadAuditDashboard();
            }
        }
    };

    // ═════════ Pane HTML ═════════
    function expiryButtonsHtml(form) {
        return ['1h', '6h', '24h', '7d', '30d', 'never'].map(p => {
            const label = { '1h': '+1h', '6h': '+6h', '24h': '+1 day', '7d': '+1 week', '30d': '+30 days', 'never': 'Never' }[p];
            return `<button type="button" class="btn sm" onclick="d_setExpiry('${form}','${p}')">${label}</button>`;
        }).join('');
    }

    function paneSingleHtml() {
        return `
            <div class="card" style="margin-bottom:30px;">
                <h3 style="${H3} margin-top:0;">📍 Step 1: Pick the spot</h3>
                <input type="text" id="addressSearch" placeholder="🔍 Search address or click on the map…" style="${INP} margin-bottom:12px;">
                <div id="dropMap" style="width:100%; height:400px; border-radius:8px; margin-bottom:8px; background:var(--well);"></div>
                <div id="dropLocationInfo" style="color:var(--muted); font-size:13px; padding:8px 0;">Click on the map to set drop location</div>

                <h3 style="${H3}">💵 Step 2: Set the value</h3>
                <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; margin-bottom:16px;">
                    <div>
                        <label style="${LBL}">Currency</label>
                        <select id="dropCurrency" style="${INP}" onchange="d_updateValueHint()">
                            <option value="CREDITS">Credits (in-app)</option>
                            <option value="USD">USD (cents)</option>
                        </select>
                    </div>
                    <div>
                        <label style="${LBL}">Value (per coin)</label>
                        <input type="number" id="dropRewardAmount" value="100" min="1" style="${INP}" oninput="d_updateValueHint()">
                        <small style="${HINT}" id="dropValueHint">100 credits</small>
                    </div>
                    <div>
                        <label style="${LBL}">Geofence (meters)</label>
                        <input type="number" id="dropRadius" value="30" min="5" max="5000" style="${INP}">
                        <small style="${HINT}">30m ≈ 100ft</small>
                    </div>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:16px;">
                    <div>
                        <label style="${LBL}">Claim limit (1 = first to claim wins)</label>
                        <input type="number" id="dropViewLimit" value="1" min="1" placeholder="Leave blank for unlimited" style="${INP}">
                        <small style="${HINT}">Default: only one user can claim each coin.</small>
                    </div>
                    <div>
                        <label style="${LBL}">Expires at</label>
                        <input type="datetime-local" id="dropExpiresAt" style="${INP}" oninput="d_updateExpiryHint('drop')">
                        <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">${expiryButtonsHtml('drop')}</div>
                        <small id="dropExpiryHint" style="display:block; margin-top:6px; color:var(--muted); font-size:11px;">Default: never expires.</small>
                    </div>
                </div>

                <h3 style="${H3}">🎬 Step 3: The video they have to watch</h3>
                <div style="display:grid; grid-template-columns:2fr 1fr; gap:14px; margin-bottom:16px;">
                    <div>
                        <label style="${LBL}">Title (shown after claim)</label>
                        <input type="text" id="dropTitle" placeholder="e.g. Welcome to Blipss LA" style="${INP}">
                    </div>
                    <div>
                        <label style="${LBL}">Icon style</label>
                        <select id="dropIconType" style="${INP}">
                            <option value="coin">Coin</option>
                            <option value="star">Star</option>
                            <option value="gift">Gift</option>
                            <option value="trophy">Trophy</option>
                        </select>
                    </div>
                </div>
                <div style="margin-bottom:16px;">
                    <label style="${LBL}">Description (optional)</label>
                    <textarea id="dropDescription" rows="2" placeholder="Optional context" style="${INP} resize:vertical;"></textarea>
                </div>
                <div style="margin-bottom:16px;">
                    <label style="${LBL}">📹 Media (video preferred)</label>
                    <input type="file" id="dropMedia" accept="video/*,image/*" onchange="d_autoExtractDuration('dropMedia','dropVideoDuration','dropVideoDurationLabel')" style="${INP} padding:10px; font-size:13px;">
                    <div id="mediaUploadProgress" style="display:none; margin-top:8px; padding:8px; background:rgba(194,144,47,0.1); border-radius:6px; color:var(--gold); font-size:12px;"></div>
                    <!-- Auto-detected video duration. Hidden number input keeps the rest
                         of the ported form code working unchanged; the visible label tells
                         the admin what was extracted. For images / no upload, label stays
                         blank and value stays empty (instant-claim coin). -->
                    <input type="hidden" id="dropVideoDuration" value="">
                    <div id="dropVideoDurationLabel" style="display:none; margin-top:8px; padding:8px 10px; background:rgba(194,144,47,0.08); border:1px solid rgba(194,144,47,0.25); border-radius:6px; color:var(--gold); font-size:12px;"></div>
                </div>

                <h3 style="${H3}">📬 Step 4: Push notification (optional)</h3>
                <div style="margin-bottom:14px;">
                    <textarea id="dropNotificationMessage" rows="2" placeholder="e.g. 💰 A new coin has dropped near you!" style="${INP} resize:vertical;"></textarea>
                </div>
                <div style="margin-bottom:20px;">
                    <label style="${LBL}">Notification radius (miles)</label>
                    <input type="number" id="dropNotificationRadius" value="5" min="0.1" max="100" step="0.1" style="${INP}">
                    <small style="${HINT}">Users with location data within this distance will get a push notification</small>
                </div>

                <button class="btn gold" onclick="d_createAdminDrop()" style="width:100%; padding:14px; font-size:15px; font-weight:700; justify-content:center;">
                    🪙 Drop the Coin
                </button>

                <!-- Success callout — populated by d_createAdminDrop() with the new coin's coin_code. -->
                <div id="singleDropResultCallout" style="${CALLOUT}"></div>
            </div>`;
    }

    function paneBulkHtml() {
        return `
            <div class="card" style="margin-bottom:30px;">
                <h3 style="${H3} margin-top:0;">🌆 Step 1: Pick a city</h3>
                <input type="text" id="bulkCitySearch" placeholder="🔍 Search a city (e.g. Los Angeles, NYC)" style="${INP} margin-bottom:12px;">
                <div id="bulkDropMap" style="width:100%; height:400px; border-radius:8px; margin-bottom:8px; background:var(--well);"></div>
                <div id="bulkDropCenterInfo" style="color:var(--muted); font-size:13px; padding:8px 0;">Search a city or click on the map to set the center</div>

                <h3 style="${H3}">📐 Step 2: How wide to scatter</h3>
                <div>
                    <label style="${LBL}">Spread radius (km from center)</label>
                    <div style="display:flex; gap:10px; align-items:center;">
                        <input type="range" id="bulkSpreadKm" min="0.5" max="50" step="0.5" value="10" style="flex:1;" oninput="d_updateBulkSpreadCircle()">
                        <span id="bulkSpreadKmLabel" style="color:var(--gold); font-weight:bold; min-width:70px; text-align:right;">10 km</span>
                    </div>
                    <small style="display:block; margin-top:6px; color:var(--muted); font-size:11px;">Coins are placed at random points within this circle. Larger = more spread out.</small>
                </div>

                <h3 style="${H3}">💎 Step 3: Coin specs</h3>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px;">
                    <div>
                        <label style="${LBL}">Number of coins</label>
                        <input type="number" id="bulkCount" value="50" min="1" max="500" style="${INP}" oninput="d_updateBulkPreview()">
                        <small style="${HINT}">Max 500 per bulk drop</small>
                    </div>
                    <div>
                        <label style="${LBL}">Currency</label>
                        <select id="bulkCurrency" style="${INP}" onchange="d_updateBulkPreview()">
                            <option value="CREDITS">Credits (in-app)</option>
                            <option value="USD">USD (cents)</option>
                        </select>
                    </div>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; margin-bottom:14px;">
                    <div>
                        <label style="${LBL}">Min value (per coin)</label>
                        <input type="number" id="bulkValueMin" value="50" min="1" style="${INP}" oninput="d_updateBulkPreview()">
                    </div>
                    <div>
                        <label style="${LBL}">Max value (per coin)</label>
                        <input type="number" id="bulkValueMax" value="500" min="1" style="${INP}" oninput="d_updateBulkPreview()">
                    </div>
                    <div>
                        <label style="${LBL}">Per-coin geofence (m)</label>
                        <input type="number" id="bulkGeofence" value="30" min="5" max="5000" style="${INP}">
                        <small style="${HINT}">30m ≈ 100ft</small>
                    </div>
                </div>

                <!-- Live preview of cost -->
                <div id="bulkPreview" style="background:rgba(194,144,47,0.08); border:1px solid rgba(194,144,47,0.3); border-radius:8px; padding:14px; margin-bottom:18px; color:var(--text); font-size:13px; line-height:1.6;">
                    Configure values to see the estimate.
                </div>

                <h3 style="${H3}">🎬 Step 4: Shared media (every coin uses this)</h3>
                <div style="display:grid; grid-template-columns:2fr 1fr; gap:14px; margin-bottom:14px;">
                    <div>
                        <label style="${LBL}">Title</label>
                        <input type="text" id="bulkTitle" placeholder="e.g. LA Launch Drop" style="${INP}">
                    </div>
                    <div>
                        <label style="${LBL}">Claim limit (per coin)</label>
                        <input type="number" id="bulkViewLimit" value="1" min="1" style="${INP}">
                    </div>
                </div>
                <div style="margin-bottom:14px;">
                    <label style="${LBL}">Description (optional)</label>
                    <textarea id="bulkDescription" rows="2" placeholder="Optional context" style="${INP} resize:vertical;"></textarea>
                </div>
                <div style="margin-bottom:14px;">
                    <label style="${LBL}">📹 Shared media (video preferred)</label>
                    <input type="file" id="bulkMedia" accept="video/*,image/*" onchange="d_autoExtractDuration('bulkMedia','bulkVideoDuration','bulkVideoDurationLabel')" style="${INP} padding:10px; font-size:13px;">
                    <div id="bulkMediaProgress" style="display:none; margin-top:8px; padding:8px; background:rgba(194,144,47,0.1); border-radius:6px; color:var(--gold); font-size:12px;"></div>
                    <!-- Auto-detected duration — same pattern as single-coin form. -->
                    <input type="hidden" id="bulkVideoDuration" value="">
                    <div id="bulkVideoDurationLabel" style="display:none; margin-top:8px; padding:8px 10px; background:rgba(194,144,47,0.08); border:1px solid rgba(194,144,47,0.25); border-radius:6px; color:var(--gold); font-size:12px;"></div>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px;">
                    <div>
                        <label style="${LBL}">Expires at</label>
                        <input type="datetime-local" id="bulkExpiresAt" style="${INP}" oninput="d_updateExpiryHint('bulk')">
                        <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">${expiryButtonsHtml('bulk')}</div>
                        <small id="bulkExpiryHint" style="display:block; margin-top:6px; color:var(--muted); font-size:11px;">Default: never expires.</small>
                    </div>
                    <div>
                        <label style="${LBL}">Notification radius (miles)</label>
                        <input type="number" id="bulkNotificationRadius" value="5" min="0.1" max="100" step="0.1" style="${INP}">
                    </div>
                </div>
                <div style="margin-bottom:18px;">
                    <label style="${LBL}">📬 Push notification message (optional, sent once)</label>
                    <textarea id="bulkNotificationMessage" rows="2" placeholder="e.g. 💰 50 coins just dropped across LA — go find them!" style="${INP} resize:vertical;"></textarea>
                </div>

                <button class="btn gold" onclick="d_createBulkAdminDrop()" id="bulkCreateBtn" style="width:100%; padding:14px; font-size:15px; font-weight:700; justify-content:center;">
                    🎯 Drop the Coins
                </button>

                <!-- Success callout — populated by d_createBulkAdminDrop() with the array of coin_codes. -->
                <div id="bulkDropResultCallout" style="${CALLOUT}"></div>
            </div>`;
    }

    function paneBrowseHtml() {
        return `
            <div class="card" style="margin-bottom:18px; display:grid; grid-template-columns:2fr 1fr 1fr auto; gap:10px; align-items:end;">
                <div>
                    <label style="${LBL} text-transform:uppercase; letter-spacing:0.05em; font-size:11px;">Search</label>
                    <input type="text" id="browseSearchInput" placeholder="🔍 Coin code or title…" oninput="d_browseSearchDebounced()" style="${INP} font-size:13px;">
                </div>
                <div>
                    <label style="${LBL} text-transform:uppercase; letter-spacing:0.05em; font-size:11px;">Currency</label>
                    <select id="browseCurrencyFilter" onchange="d_browseApplyFilters()" style="${INP} font-size:13px;">
                        <option value="all">All</option>
                        <option value="USD">USD</option>
                        <option value="CREDITS">CREDITS</option>
                    </select>
                </div>
                <div>
                    <label style="${LBL} text-transform:uppercase; letter-spacing:0.05em; font-size:11px;">Status</label>
                    <select id="browseStatusFilter" onchange="d_browseApplyFilters()" style="${INP} font-size:13px;">
                        <option value="all">All</option>
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                        <option value="expired">Expired</option>
                        <option value="fully_claimed">Fully Claimed</option>
                    </select>
                </div>
                <button class="btn" onclick="d_loadBrowseCoins(true)">Refresh</button>
            </div>
            <div id="browseCoinsStats" style="color:var(--muted); font-size:12px; margin-bottom:10px;"></div>
            <div id="browseCoinsTable"><div class="spin">Loading coins…</div></div>
            <div style="text-align:center; margin-top:18px;">
                <button id="browseLoadMoreBtn" class="btn" onclick="d_loadBrowseCoins(false)" style="display:none; padding:12px 24px;">Load 50 more</button>
            </div>`;
    }

    function paneBatchesHtml() {
        return `
            <!-- ── MODE A: list of batch cards (default) ────────── -->
            <div id="dropBatchesListMode">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px;">
                    <div>
                        <div style="color:var(--cream); font-size:16px; font-weight:700;">Bulk drop batches</div>
                        <div style="color:var(--muted); font-size:12px; margin-top:4px;">Each card is one bulk drop. Click a card to drill into its coins.</div>
                    </div>
                    <button class="btn" onclick="d_loadDropBatches()">🔄 Refresh</button>
                </div>
                <div id="dropBatchesStats" style="color:var(--muted); font-size:12px; margin-bottom:14px;"></div>
                <div id="dropBatchesList"><div class="spin">Loading batches…</div></div>
            </div>

            <!-- ── MODE B: detail of one batch ──────────────────── -->
            <div id="dropBatchesDetailMode" style="display:none;">
                <button class="btn sm" onclick="d_closeBatchDetail()" style="margin-bottom:16px;">← Back to all batches</button>
                <div id="dropBatchDetailHeader"></div>
                <div id="dropBatchDetailCoins"></div>
            </div>`;
    }

    function paneMapHtml() {
        return `
            <div class="card" style="margin-bottom:14px; display:grid; grid-template-columns:1fr 1fr auto; gap:10px; align-items:end;">
                <div>
                    <label style="${LBL} text-transform:uppercase; letter-spacing:0.05em; font-size:11px;">Currency</label>
                    <select id="mapCurrencyFilter" onchange="d_loadMapView()" style="${INP} font-size:13px;">
                        <option value="all">All</option>
                        <option value="USD">USD</option>
                        <option value="CREDITS">CREDITS</option>
                    </select>
                </div>
                <div>
                    <label style="${LBL} text-transform:uppercase; letter-spacing:0.05em; font-size:11px;">Status</label>
                    <select id="mapStatusFilter" onchange="d_loadMapView()" style="${INP} font-size:13px;">
                        <option value="active">Active only</option>
                        <option value="all">All (incl. inactive)</option>
                        <option value="inactive">Inactive only</option>
                        <option value="fully_claimed">Fully Claimed</option>
                    </select>
                </div>
                <button class="btn" onclick="d_loadMapView()">🔄 Refresh</button>
            </div>
            <div id="mapViewStats" style="color:var(--muted); font-size:12px; margin-bottom:10px;"></div>
            <div id="adminDropsMapContainer" style="width:100%; height:600px; border-radius:12px; overflow:hidden; border:1px solid var(--border); background:var(--panel);">
                <div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--muted);">Loading map…</div>
            </div>
            <div style="display:flex; gap:18px; margin-top:14px; flex-wrap:wrap; color:var(--muted); font-size:12px;">
                <div style="display:flex; align-items:center; gap:6px;"><span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:#4CAF50;"></span> Active</div>
                <div style="display:flex; align-items:center; gap:6px;"><span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:#9E9E9E;"></span> Inactive</div>
                <div style="display:flex; align-items:center; gap:6px;"><span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:#FF9800;"></span> Expired</div>
                <div style="display:flex; align-items:center; gap:6px;"><span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:#9C27B0;"></span> Fully Claimed</div>
            </div>`;
    }

    function paneAuditHtml() {
        return `
            <div class="card" style="margin-bottom:18px; display:flex; gap:10px; align-items:end;">
                <div style="flex:1;">
                    <label style="${LBL} text-transform:uppercase; letter-spacing:0.05em; font-size:11px;">Look up a coin by code</label>
                    <input type="text" id="auditCoinCodeInput" placeholder="COIN-XXXX-XXXX-XXXX" onkeydown="if(event.key==='Enter')d_lookupCoinByCode()" style="${INP} font-size:13px; font-family:Menlo,Monaco,monospace;">
                </div>
                <button class="btn gold" onclick="d_lookupCoinByCode()">Look up</button>
                <button class="btn" onclick="d_showAuditDashboard()">📊 Dashboard</button>
            </div>
            <!-- Mode A: Dashboard tiles -->
            <div id="auditDashboardPane"><div class="spin">Loading dashboard…</div></div>
            <!-- Mode B: Coin detail view -->
            <div id="auditCoinDetailPane" style="display:none;"></div>`;
    }

    // ═════════ Single-coin picker map (legacy initializeDropMap) ═════════
    function initializeDropMap() {
        if (dropMap) return; // Already initialized

        try {
            // Default to San Francisco
            const defaultLocation = { lat: 37.7749, lng: -122.4194 };

            dropMap = new google.maps.Map(document.getElementById('dropMap'), {
                center: defaultLocation,
                zoom: 13,
                mapTypeControl: true,
                streetViewControl: false,
                fullscreenControl: true,
                styles: [
                    { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
                ],
            });

            // Initialize Google Places Autocomplete
            const searchInput = document.getElementById('addressSearch');
            const autocomplete = new google.maps.places.Autocomplete(searchInput);
            autocomplete.bindTo('bounds', dropMap);

            autocomplete.addListener('place_changed', () => {
                const place = autocomplete.getPlace();
                if (!place.geometry || !place.geometry.location) return;

                dropMap.setCenter(place.geometry.location);
                dropMap.setZoom(15);

                if (dropMarker) dropMarker.setMap(null);
                dropMarker = new google.maps.Marker({
                    position: place.geometry.location,
                    map: dropMap,
                    title: 'Drop Location',
                });

                selectedDropLocation = {
                    lat: place.geometry.location.lat(),
                    lng: place.geometry.location.lng(),
                };

                document.getElementById('dropLocationInfo').innerHTML =
                    `<strong>Location:</strong> ${esc(place.formatted_address || place.name)}`;
            });

            // Add click listener to place marker
            dropMap.addListener('click', (event) => {
                placeDropMarker(event.latLng);
            });

            // Try to get user's current location
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(
                    (position) => {
                        dropMap.setCenter({ lat: position.coords.latitude, lng: position.coords.longitude });
                    },
                    (error) => { console.log('Geolocation error:', error); }
                );
            }
        } catch (error) {
            console.error('Error initializing map:', error);
            adminToast('Failed to initialize map. Please refresh the page.', 'error', 5000);
        }
    }

    function placeDropMarker(location) {
        if (dropMarker) dropMarker.setMap(null);

        dropMarker = new google.maps.Marker({
            position: location,
            map: dropMap,
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

        selectedDropLocation = { lat: location.lat(), lng: location.lng() };

        document.getElementById('dropLocationInfo').innerHTML =
            `<strong>Location set:</strong> ${selectedDropLocation.lat.toFixed(6)}, ${selectedDropLocation.lng.toFixed(6)}`;
    }

    // ═════════ Form helpers (expiry / value hint / bulk preview) ═════════
    window.d_setExpiry = function (form /* 'drop' | 'bulk' */, preset) {
        const input = document.getElementById(form === 'drop' ? 'dropExpiresAt' : 'bulkExpiresAt');
        if (!input) return;
        if (preset === 'never') {
            input.value = '';
            window.d_updateExpiryHint(form);
            return;
        }
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
        input.value = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}`;
        window.d_updateExpiryHint(form);
    };

    window.d_updateExpiryHint = function (form) {
        const input = document.getElementById(form === 'drop' ? 'dropExpiresAt' : 'bulkExpiresAt');
        const hint  = document.getElementById(form === 'drop' ? 'dropExpiryHint' : 'bulkExpiryHint');
        if (!input || !hint) return;
        if (!input.value) {
            hint.textContent = 'Never expires (leave blank for indefinite).';
            hint.style.color = 'var(--muted)';
            return;
        }
        const target = new Date(input.value);
        const now = new Date();
        const diffMs = target - now;
        if (diffMs <= 0) {
            hint.textContent = '⚠️ This time is in the past — drop will be expired immediately.';
            hint.style.color = 'var(--danger)';
            return;
        }
        const totalMin = Math.round(diffMs / (60 * 1000));
        const days = Math.floor(totalMin / (60 * 24));
        const hours = Math.floor((totalMin % (60 * 24)) / 60);
        const mins = totalMin % 60;
        let label;
        if (days > 0)       label = `${days} day${days === 1 ? '' : 's'}` + (hours > 0 ? `, ${hours}h` : '');
        else if (hours > 0) label = `${hours} hour${hours === 1 ? '' : 's'}` + (mins > 0 ? `, ${mins}m` : '');
        else                label = `${mins} minute${mins === 1 ? '' : 's'}`;
        hint.textContent = `Expires in ${label} (${target.toLocaleString()})`;
        hint.style.color = 'var(--muted)';
    };

    // Live "X credits" / "$X.YY" hint under the value input on single-coin mode
    window.d_updateValueHint = function () {
        const amt = parseInt(document.getElementById('dropRewardAmount')?.value || '0');
        const cur = document.getElementById('dropCurrency')?.value || 'CREDITS';
        const hint = document.getElementById('dropValueHint');
        if (!hint) return;
        if (cur === 'USD') hint.textContent = `$${(amt / 100).toFixed(2)} (${amt} cents)`;
        else hint.textContent = `${amt} credits`;
    };

    // Bulk preview: shows total value, average per coin, currency formatting
    window.d_updateBulkPreview = function () {
        const count = parseInt(document.getElementById('bulkCount')?.value || '0');
        const min   = parseInt(document.getElementById('bulkValueMin')?.value || '0');
        const max   = parseInt(document.getElementById('bulkValueMax')?.value || '0');
        const cur   = document.getElementById('bulkCurrency')?.value || 'CREDITS';
        const box   = document.getElementById('bulkPreview');
        if (!box) return;
        if (count <= 0 || min < 0 || max < min) {
            box.innerHTML = '<span style="color:var(--danger);">Set count and a valid min ≤ max range.</span>';
            return;
        }
        const avg = (min + max) / 2;
        const totalAvg = avg * count;
        const minTotal = min * count;
        const maxTotal = max * count;
        const fmt = v => cur === 'USD' ? `$${(v / 100).toFixed(2)}` : `${Math.round(v).toLocaleString()} credits`;
        box.innerHTML = `
            <strong style="color:var(--cream);">${count} coins</strong>, each worth between
            <strong style="color:var(--gold);">${fmt(min)}</strong> and
            <strong style="color:var(--gold);">${fmt(max)}</strong>.<br>
            Estimated total: <strong style="color:var(--cream);">${fmt(totalAvg)}</strong>
            (range: ${fmt(minTotal)} – ${fmt(maxTotal)}).`;
    };

    // ═════════ Bulk-drop area picker map ═════════
    function initBulkDropMap() {
        const mapEl = document.getElementById('bulkDropMap');
        if (!mapEl || bulkDropMap || typeof google === 'undefined') return;

        bulkDropMap = new google.maps.Map(mapEl, {
            center: { lat: 34.0522, lng: -118.2437 }, // LA default
            zoom: 11,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: true,
            styles: [
                { elementType: 'geometry', stylers: [{ color: '#1E1712' }] },
                { elementType: 'labels.text.stroke', stylers: [{ color: '#000' }] },
                { elementType: 'labels.text.fill', stylers: [{ color: '#9C8F80' }] },
                { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#000' }] },
                { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#261E18' }] },
            ],
        });

        // City autocomplete
        const cityInput = document.getElementById('bulkCitySearch');
        if (cityInput && google.maps.places) {
            const ac = new google.maps.places.Autocomplete(cityInput, { types: ['(cities)'] });
            ac.bindTo('bounds', bulkDropMap);
            ac.addListener('place_changed', () => {
                const place = ac.getPlace();
                if (!place.geometry) return;
                bulkDropMap.setCenter(place.geometry.location);
                bulkDropMap.setZoom(11);
                setBulkCenter(place.geometry.location.lat(), place.geometry.location.lng(), place.formatted_address || place.name);
            });
        }

        // Click to set center
        bulkDropMap.addListener('click', e => {
            setBulkCenter(e.latLng.lat(), e.latLng.lng());
        });
    }

    function setBulkCenter(lat, lng, label) {
        bulkSelectedCenter = { lat, lng };
        const labelText = label ? ` — ${esc(label)}` : '';
        document.getElementById('bulkDropCenterInfo').innerHTML =
            `<strong style="color:var(--gold);">Center set:</strong> ${lat.toFixed(5)}, ${lng.toFixed(5)}${labelText}`;

        if (bulkCenterMarker) bulkCenterMarker.setMap(null);
        bulkCenterMarker = new google.maps.Marker({
            position: { lat, lng },
            map: bulkDropMap,
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 8,
                fillColor: '#C2902F',
                fillOpacity: 1,
                strokeColor: '#fff',
                strokeWeight: 2,
            },
        });
        window.d_updateBulkSpreadCircle();
    }

    window.d_updateBulkSpreadCircle = function () {
        const km = parseFloat(document.getElementById('bulkSpreadKm')?.value || '10');
        const lbl = document.getElementById('bulkSpreadKmLabel');
        if (lbl) lbl.textContent = `${km} km`;
        if (!bulkSelectedCenter || !bulkDropMap) return;
        if (bulkSpreadCircle) bulkSpreadCircle.setMap(null);
        bulkSpreadCircle = new google.maps.Circle({
            center: bulkSelectedCenter,
            radius: km * 1000, // meters
            map: bulkDropMap,
            fillColor: '#C2902F',
            fillOpacity: 0.10,
            strokeColor: '#C2902F',
            strokeOpacity: 0.7,
            strokeWeight: 2,
        });
    };

    // ═════════ Road snapping (legacy comments preserved) ═════════
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

    // Snap arbitrary scattered points to the NEAREST road using Google's
    // Roads "nearestRoads" API. Unlike snapToRoads (designed for GPS traces —
    // it silently drops points not already on a road, which is how coins
    // ended up in lakes), nearestRoads returns the closest road segment for
    // each independent point. Roads API caps at 100 points per request.
    // Returns { points: [{lat,lng}], errorMsg } containing ONLY on-road
    // points — points with no road anywhere nearby are OMITTED, never kept.
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

    // ═════════ Bulk create ═════════
    window.d_createBulkAdminDrop = async function () {
        try {
            if (!bulkSelectedCenter) {
                adminToast('Pick a city or click on the map first', 'error');
                return;
            }

            const count    = parseInt(document.getElementById('bulkCount').value);
            const valueMin = parseInt(document.getElementById('bulkValueMin').value);
            const valueMax = parseInt(document.getElementById('bulkValueMax').value);
            const currency = document.getElementById('bulkCurrency').value;
            const geofence = parseInt(document.getElementById('bulkGeofence').value);
            const spreadKm = parseFloat(document.getElementById('bulkSpreadKm').value);
            const title    = document.getElementById('bulkTitle').value.trim();
            const desc     = document.getElementById('bulkDescription').value.trim();
            const limit    = parseInt(document.getElementById('bulkViewLimit').value || '1');
            const expires  = document.getElementById('bulkExpiresAt').value;
            const notif    = document.getElementById('bulkNotificationMessage').value.trim();
            const notifRad = parseFloat(document.getElementById('bulkNotificationRadius').value || '5');
            // Optional: video duration for server-side watch validation. Blank → instant-claim.
            const vidDurRaw = document.getElementById('bulkVideoDuration')?.value;
            const videoDurationSeconds = vidDurRaw ? parseInt(vidDurRaw) : null;

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

            const mediaFile = document.getElementById('bulkMedia').files[0];
            if (!mediaFile) { adminToast('Pick a media file', 'error'); return; }

            const progress = document.getElementById('bulkMediaProgress');
            progress.style.display = 'block';
            progress.textContent = 'Uploading shared media…';

            const fileExt = mediaFile.name.split('.').pop();
            const fileName = `admin-drops/${Date.now()}_bulk.${fileExt}`;
            const { error: upErr } = await supabaseClient.storage.from('blip-videos').upload(fileName, mediaFile);
            if (upErr) { progress.textContent = 'Upload failed: ' + upErr.message; return; }
            const { data: { publicUrl } } = supabaseClient.storage.from('blip-videos').getPublicUrl(fileName);

            // Steps 1+2: generate random candidates and snap each to the
            // NEAREST road. Points that land far from any road (deep water,
            // wilderness) won't snap — and we must NEVER place those. So we
            // oversample and keep snapping fresh random points until we have
            // `count` on-road points or hit the round cap.
            progress.textContent = `Snapping ${count} coins to nearest roads…`;
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
                progress.textContent = `Snapping coins to roads… ${onRoad.length}/${count}`;
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
                if (!proceed) { progress.style.display = 'none'; return; }
                placedRandom = true;
                while (onRoad.length < count) {
                    onRoad.push(randomPointInDisc(bulkSelectedCenter.lat, bulkSelectedCenter.lng, spreadKm * 1000));
                }
            }

            if (onRoad.length === 0) {
                progress.style.display = 'none';
                adminToast('No roads found near that area — pick a denser spot or a larger spread.', 'error', 6000);
                return;
            }
            if (!placedRandom && onRoad.length < count) {
                adminToast(`Only ${onRoad.length}/${count} coins could be placed on roads near that area. Try a larger spread or a denser area for more.`, 'info', 6000);
            }

            // Step 3: assign each a random value in [min, max]
            const points = onRoad.map(p => ({
                lat: p.lat,
                lng: p.lng,
                value: valueMin === valueMax
                    ? valueMin
                    : Math.floor(Math.random() * (valueMax - valueMin + 1)) + valueMin,
            }));

            // Step 4: insert via the points-list RPC
            progress.textContent = 'Saving coins…';
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

            progress.style.display = 'none';

            if (error) {
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
                    progress.style.display = 'block';
                    progress.textContent = 'Sending notifications…';
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
                } finally {
                    progress.style.display = 'none';
                }
            }

            // Show generated coin codes in a callout (with copy-all).
            showBulkCoinCodesCallout(data.coin_codes || [], currency, data.total_value, data.batch_id, bulkNotif, notif);

            // Refresh Browse table if it's been loaded so the new coins appear.
            if (_browseCoinsLoaded) window.d_loadBrowseCoins(true);
        } catch (err) {
            console.error('Bulk drop error:', err);
            adminToast('Unexpected error: ' + err.message, 'error');
        }
    };

    // Renders the post-bulk-drop callout showing generated coin codes + copy-all.
    function showBulkCoinCodesCallout(codes, currency, totalValue, batchId, notifResult, notifMessage) {
        const box = document.getElementById('bulkDropResultCallout');
        if (!box) return;
        const batchLink = batchId
            ? `<button class="btn sm" onclick="d_setSubTab('batches')">📦 Manage this batch →</button>`
            : '';
        const notifSection = buildDropNotifSectionHtml(notifResult, notifMessage, 'batch', batchId);
        if (!Array.isArray(codes) || codes.length === 0) {
            box.style.display = 'block';
            box.innerHTML = `
                <div style="color:var(--gold-soft); font-weight:700; margin-bottom:6px;">✅ Dropped ${currency === 'USD' ? `$${(totalValue / 100).toFixed(2)}` : `${totalValue} credits`} worth of coins</div>
                <div style="color:var(--muted); font-size:12px;">No coin codes were returned by the RPC. Open the Browse sub-tab to see them.</div>
                ${batchLink ? `<div style="margin-top:10px;">${batchLink}</div>` : ''}
                ${notifSection}`;
            return;
        }
        const codeListHtml = codes.map(c => `<div style="padding:4px 0; font-family:Menlo,Monaco,monospace; font-size:12px; color:var(--gold);">${esc(c)}</div>`).join('');
        box.style.display = 'block';
        box.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; gap:10px; flex-wrap:wrap;">
                <strong style="color:var(--gold); font-size:14px;">✅ ${codes.length} coin codes generated</strong>
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                    ${batchLink}
                    <button class="btn sm" onclick="d_copyCoinCodesToClipboard()">📋 Copy all</button>
                </div>
            </div>
            ${batchId ? `<div style="font-family:Menlo,Monaco,monospace; font-size:11px; color:var(--muted); margin-bottom:8px;">batch: ${esc(batchId)}</div>` : ''}
            <div id="bulkDropCoinCodesList" style="max-height:200px; overflow-y:auto; background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:10px;">
                ${codeListHtml}
            </div>
            ${notifSection}`;
        // Stash the raw codes for the copy button (avoids re-querying DOM)
        _lastBulkCoinCodes = codes.slice();
        console.log('[admin-coins] bulk drop produced codes:', codes);
    }

    // Builds the "who got notified" section shown in the post-drop callouts.
    // notifResult = { notificationsSent, recipients: [{username, distance_miles}] }
    // lookupKind/lookupId let the admin re-fetch the saved recipient list
    // later (kind = 'drop' for single drops, 'batch' for bulk batches).
    function buildDropNotifSectionHtml(notifResult, notifMessage, lookupKind, lookupId) {
        // No message entered → nothing was sent (push notification is optional).
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

    // Saved per-drop lookup: fetch the recipient list from the DB for a past
    // single drop (kind='drop') or bulk batch (kind='batch'). Works long
    // after the drop because the fan-out logs every recipient to
    // admin_drop_notifications.
    window.d_viewDropRecipients = async function (kind, id) {
        try {
            const col = kind === 'batch' ? 'batch_id' : 'drop_id';
            const { data, error } = await supabaseClient
                .from('admin_drop_notifications')
                .select('username, distance_miles, sent_at')
                .eq(col, id)
                .order('distance_miles', { ascending: true });
            if (error) { adminToast('Could not load recipients: ' + error.message, 'error', 5000); return; }
            showRecipientsDrawer(data || []);
        } catch (e) {
            console.warn('[admin-coins] viewDropRecipients failed', e);
            adminToast('Could not load recipients — see console', 'error');
        }
    };

    // Legacy showRecipientsModal — rendered via the shell's drawer instead of
    // the hand-rolled modal root.
    function showRecipientsDrawer(recipients) {
        const n = (recipients || []).length;
        const rows = n
            ? recipients.map(r => `<div style="display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-bottom:1px solid var(--border); font-size:13px; color:var(--text);"><span>@${esc(r.username || 'unknown')}</span><span style="color:var(--muted); white-space:nowrap;">${(r.distance_miles != null) ? Number(r.distance_miles).toFixed(1) + ' mi' : ''}</span></div>`).join('')
            : `<div class="empty">No recipients were recorded for this drop.</div>`;
        ui.drawer({
            title: `👥 Notified ${n} ${n === 1 ? 'person' : 'people'}`,
            html: `<div class="card" style="max-height:70vh; overflow-y:auto;">${rows}</div>`,
        });
    }

    window.d_copyCoinCodesToClipboard = function () {
        const codes = _lastBulkCoinCodes || [];
        if (codes.length === 0) { adminToast('Nothing to copy', 'error'); return; }
        navigator.clipboard.writeText(codes.join('\n'))
            .then(() => adminToast(`Copied ${codes.length} coin codes`, 'success'))
            .catch(err => {
                console.warn('[admin-coins] clipboard copy failed', err);
                adminToast('Copy failed — see console', 'error');
            });
    };

    // ═════════ Single create ═════════
    window.d_createAdminDrop = async function () {
        try {
            // Validate inputs
            const title = document.getElementById('dropTitle').value.trim();
            const description = document.getElementById('dropDescription').value.trim();
            // Drop type field was removed in the redesign — default to 'reward'
            const dropType = 'reward';
            const iconType = document.getElementById('dropIconType').value;
            const rewardAmount = parseInt(document.getElementById('dropRewardAmount').value);
            const valueCurrency = document.getElementById('dropCurrency')?.value || 'CREDITS';
            const radius = parseInt(document.getElementById('dropRadius').value);
            const viewLimit = document.getElementById('dropViewLimit').value;
            const expiresAt = document.getElementById('dropExpiresAt').value;
            const notificationMessage = document.getElementById('dropNotificationMessage').value.trim();
            const notificationRadius = parseFloat(document.getElementById('dropNotificationRadius').value);
            // Optional: video duration for server-side watch validation. Blank → instant-claim.
            const videoDurRaw = document.getElementById('dropVideoDuration')?.value;
            const videoDurationSeconds = videoDurRaw ? parseInt(videoDurRaw) : null;

            if (!title) { adminToast('Please enter a title', 'error', 5000); return; }
            if (!selectedDropLocation) { adminToast('Please select a location on the map', 'error', 5000); return; }
            if (!rewardAmount || rewardAmount < 0) { adminToast('Please enter a valid reward amount', 'error', 5000); return; }
            if (!radius || radius < 1) { adminToast('Please enter a valid radius', 'error', 5000); return; }

            // Handle media upload if file selected
            const mediaInput = document.getElementById('dropMedia');
            const mediaFile = mediaInput.files[0];
            let mediaUrl = null;
            let mediaType = null;

            if (mediaFile) {
                const progressDiv = document.getElementById('mediaUploadProgress');
                progressDiv.style.display = 'block';
                progressDiv.textContent = 'Uploading media...';

                const fileExt = mediaFile.name.split('.').pop();
                const fileName = `admin-drops/${Date.now()}.${fileExt}`;
                mediaType = mediaFile.type.startsWith('video/') ? 'video' : 'image';

                const { error: uploadError } = await supabaseClient.storage
                    .from('blip-videos')
                    .upload(fileName, mediaFile);

                if (uploadError) {
                    progressDiv.textContent = 'Upload failed: ' + uploadError.message;
                    return;
                }

                const { data: { publicUrl } } = supabaseClient.storage
                    .from('blip-videos')
                    .getPublicUrl(fileName);

                mediaUrl = publicUrl;
                progressDiv.textContent = 'Media uploaded successfully!';
                setTimeout(() => { progressDiv.style.display = 'none'; }, 2000);
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

            // Surface the result in the inline callout.
            showSingleCoinResultCallout({
                coinCode,
                dropId,
                notifCount,
                notificationMessage,
                notificationRadius,
                recipients: result.recipients || [],
            });
            adminToast('✅ Coin dropped successfully!', 'success');

            // Clear form (dropType field was removed in the redesign)
            document.getElementById('dropTitle').value = '';
            document.getElementById('dropDescription').value = '';
            document.getElementById('dropIconType').value = 'coin';
            document.getElementById('dropRewardAmount').value = '100';
            document.getElementById('dropCurrency').value = 'CREDITS';
            document.getElementById('dropRadius').value = '30';
            document.getElementById('dropViewLimit').value = '';
            document.getElementById('dropExpiresAt').value = '';
            document.getElementById('dropNotificationMessage').value = '';
            document.getElementById('dropNotificationRadius').value = '5';
            document.getElementById('dropMedia').value = '';
            const vidDurEl = document.getElementById('dropVideoDuration');
            if (vidDurEl) vidDurEl.value = '';
            window.d_updateValueHint();

            // Clear marker
            if (dropMarker) {
                dropMarker.setMap(null);
                dropMarker = null;
            }
            selectedDropLocation = null;
            document.getElementById('dropLocationInfo').textContent = 'Click on the map to set drop location';

            // Refresh Browse table if it's been loaded so the new coin appears.
            if (_browseCoinsLoaded) window.d_loadBrowseCoins(true);
        } catch (error) {
            console.error('[admin-coins] error creating drop:', error);
            adminToast('Failed to create drop: ' + error.message, 'error', 5000);
        }
    };

    // Inline success callout for the single-coin form. Shows coin_code in mono,
    // notification info, and a link to open in the Audit tab.
    function showSingleCoinResultCallout({ coinCode, dropId, notifCount, notificationMessage, notificationRadius, recipients }) {
        const box = document.getElementById('singleDropResultCallout');
        if (!box) return;
        const notifLine = buildDropNotifSectionHtml(
            { notificationsSent: notifCount, recipients: recipients || [] },
            notificationMessage,
            'drop',
            dropId
        );
        const codeBlock = coinCode
            ? `<div style="margin-top:10px; padding:10px 12px; background:var(--bg); border:1px solid var(--border); border-radius:6px; font-family:Menlo,Monaco,monospace; font-size:14px; color:var(--gold); display:flex; justify-content:space-between; align-items:center;">
                   <span id="singleCoinCodeText">${esc(coinCode)}</span>
                   <button class="btn sm" onclick="d_copySingleCoinCode()">📋 Copy</button>
               </div>`
            : `<div style="margin-top:10px; color:var(--muted); font-size:12px;">Coin code not returned — view it in the Browse sub-tab.</div>`;
        const viewBtn = dropId
            ? `<button class="btn sm" onclick="d_openCoinDetail('${jsEsc(dropId)}')" style="margin-top:10px;">📊 View in Audit</button>`
            : '';
        box.style.display = 'block';
        box.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <strong style="color:var(--gold); font-size:14px;">✅ Coin dropped</strong>
                <button onclick="document.getElementById('singleDropResultCallout').style.display='none'" style="background:transparent; border:none; color:var(--muted); cursor:pointer; font-size:16px;">×</button>
            </div>
            ${codeBlock}
            ${notifLine}
            ${viewBtn}`;
        _lastSingleCoinCode = coinCode || '';
    }

    window.d_copySingleCoinCode = function () {
        const code = _lastSingleCoinCode || '';
        if (!code) { adminToast('Nothing to copy', 'error'); return; }
        navigator.clipboard.writeText(code)
            .then(() => adminToast('Coin code copied', 'success'))
            .catch(err => {
                console.warn('[admin-coins] clipboard copy failed', err);
                adminToast('Copy failed — see console', 'error');
            });
    };

    // ═════════ Auto-extract video duration ═════════
    // The admin picks a file; we read its metadata and stash the duration in
    // a hidden input the rest of the form code reads. For images (or a probe
    // failure) we clear it so the coin becomes an instant-claim.
    window.d_autoExtractDuration = function (fileInputId, hiddenDurationId, labelId) {
        const fileInput = document.getElementById(fileInputId);
        const hidden    = document.getElementById(hiddenDurationId);
        const label     = document.getElementById(labelId);
        if (!fileInput || !hidden || !label) return;

        // Reset previous state on every new selection.
        hidden.value = '';
        label.style.display = 'none';
        label.textContent = '';

        const file = fileInput.files && fileInput.files[0];
        if (!file) return;

        // Images / non-video MIME types → no duration, instant-claim.
        if (!file.type || !file.type.startsWith('video/')) {
            label.style.display = 'block';
            label.textContent = `📸 Image upload — instant-claim coin (no watch required).`;
            return;
        }

        // Use a hidden video element to load metadata via an object URL so we
        // don't have to upload first.
        const url   = URL.createObjectURL(file);
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.muted   = true;       // satisfy autoplay rules on some browsers
        probe.src     = url;

        label.style.display = 'block';
        label.textContent = '⏳ Reading video duration…';

        probe.onloadedmetadata = () => {
            const seconds = probe.duration;
            URL.revokeObjectURL(url);
            if (!isFinite(seconds) || seconds <= 0) {
                label.textContent = '⚠️ Could not read duration from this video file. Re-encode and try again.';
                return;
            }
            // Round up so the server's 90% threshold definitely fires
            // after the user actually watches to the end.
            const rounded = Math.max(1, Math.ceil(seconds));
            hidden.value  = String(rounded);
            label.textContent = `🎬 Detected: ${seconds.toFixed(1)}s — users must watch the full video to claim.`;
            console.log('[admin-coins] auto-detected video duration:', rounded, 's for', fileInputId);
        };

        probe.onerror = () => {
            URL.revokeObjectURL(url);
            label.textContent = '⚠️ Could not read this video. Make sure it\'s an H.264 MP4 / MOV that the browser can preview.';
            console.warn('[admin-coins] video metadata load failed for', fileInputId);
        };
    };

    // ═════════ Browse sub-view ═════════
    // Loads admin_drops in pages of 50, applies client-side filters
    // (currency, status, text search on coin_code/title).
    window.d_browseSearchDebounced = function () {
        clearTimeout(_browseSearchTimer);
        _browseSearchTimer = setTimeout(window.d_browseApplyFilters, 200);
    };

    window.d_loadBrowseCoins = async function (resetFirst) {
        if (_browseCoinsLoading) return;
        _browseCoinsLoading = true;
        if (resetFirst) {
            _browseCoinsAll = [];
            _browseCoinsOffset = 0;
            _browseCoinsExhausted = false;
            const tbl = document.getElementById('browseCoinsTable');
            if (tbl) tbl.innerHTML = '<div class="spin">Loading coins…</div>';
        }
        try {
            const from = _browseCoinsOffset;
            const to = _browseCoinsOffset + BROWSE_PAGE_SIZE - 1;
            console.log('[admin-coins] browse fetch range', from, to);
            const { data, error } = await supabaseClient
                .from('admin_drops')
                .select('id, coin_code, title, reward_amount, value_currency, view_limit, views_count, is_active, expires_at, latitude, longitude, created_at, radius, video_duration_seconds')
                .order('created_at', { ascending: false })
                .range(from, to);
            if (error) {
                console.log('[admin-coins] browse fetch error', error);
                adminToast('Failed to load coins: ' + error.message, 'error');
                return;
            }
            _browseCoinsAll = _browseCoinsAll.concat(data || []);
            _browseCoinsOffset += (data || []).length;
            if (!data || data.length < BROWSE_PAGE_SIZE) _browseCoinsExhausted = true;
            _browseCoinsLoaded = true;
            window.d_browseApplyFilters();
        } catch (err) {
            console.error('[admin-coins] browse load threw', err);
            adminToast('Unexpected error loading coins', 'error');
        } finally {
            _browseCoinsLoading = false;
        }
    };

    // Compute the live status of a coin row given the inactive / expired /
    // fully-claimed precedence rules.
    function computeCoinStatus(d) {
        if (!d.is_active) return 'inactive';
        if (d.expires_at && new Date(d.expires_at) < new Date()) return 'expired';
        if (d.view_limit != null && d.views_count != null && d.views_count >= d.view_limit) return 'fully_claimed';
        return 'active';
    }

    window.d_browseApplyFilters = function () {
        const q = (document.getElementById('browseSearchInput')?.value || '').trim().toLowerCase();
        const curr = document.getElementById('browseCurrencyFilter')?.value || 'all';
        const status = document.getElementById('browseStatusFilter')?.value || 'all';

        const filtered = _browseCoinsAll.filter(d => {
            if (q) {
                const hay = `${d.coin_code || ''} ${d.title || ''}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            if (curr !== 'all' && d.value_currency !== curr) return false;
            if (status !== 'all' && computeCoinStatus(d) !== status) return false;
            return true;
        });

        renderBrowseCoinsTable(filtered);

        const stats = document.getElementById('browseCoinsStats');
        if (stats) {
            stats.textContent =
                `Showing ${filtered.length} of ${_browseCoinsAll.length} loaded` +
                (_browseCoinsExhausted ? ' (all coins loaded)' : ' — more available');
        }

        const moreBtn = document.getElementById('browseLoadMoreBtn');
        if (moreBtn) moreBtn.style.display = _browseCoinsExhausted ? 'none' : 'inline-block';
    };

    function coinTableHtml(rows, rowFn, tbodyId) {
        return `
            <div class="tblwrap">
                <table class="tbl">
                    <thead>
                        <tr>
                            <th>Coin Code</th><th>Title</th><th>Value</th><th>Currency</th>
                            <th>Created</th><th>Status</th><th>Claims</th><th style="text-align:center;">Actions</th>
                        </tr>
                    </thead>
                    <tbody${tbodyId ? ` id="${tbodyId}"` : ''}>${rows.map(rowFn).join('')}</tbody>
                </table>
            </div>`;
    }

    function renderBrowseCoinsTable(rows) {
        const container = document.getElementById('browseCoinsTable');
        if (!container) return;
        if (rows.length === 0) {
            container.innerHTML = `
                <div class="empty">
                    <p style="font-size:16px; margin-bottom:8px;">No coins match the current filters.</p>
                    <p style="font-size:13px;">Try clearing the search or status filter.</p>
                </div>`;
            return;
        }
        container.innerHTML = coinTableHtml(rows, browseRowHtml, null);
    }

    function coinRowCellsHtml(d) {
        const status = computeCoinStatus(d);
        const valueLabel = d.value_currency === 'USD'
            ? `$${((d.reward_amount || 0) / 100).toFixed(2)}`
            : `${(d.reward_amount || 0).toLocaleString()}`;
        const createdLabel = d.created_at ? new Date(d.created_at).toLocaleString() : '—';
        const claimsLabel = `${d.views_count || 0}${d.view_limit ? ` / ${d.view_limit}` : ' / ∞'}`;
        return `
            <td style="font-family:Menlo,Monaco,monospace; font-size:12px; color:var(--gold);">${esc(d.coin_code || '—')}</td>
            <td><strong style="color:var(--cream);">${esc(d.title || '(untitled)')}</strong></td>
            <td style="color:#FFD700; font-weight:700;">${valueLabel}</td>
            <td style="color:var(--muted);">${esc(d.value_currency || '—')}</td>
            <td style="font-size:12px; color:var(--muted);">${createdLabel}</td>
            <td>${statusBadgeHtml(status)}</td>
            <td>${claimsLabel}</td>`;
    }

    function browseRowHtml(d) {
        return `
            <tr>
                ${coinRowCellsHtml(d)}
                <td style="text-align:center;">
                    <div style="display:flex; gap:6px; justify-content:center; flex-wrap:wrap;">
                        <button class="btn sm" onclick="d_openCoinDetail('${jsEsc(d.id)}')">View</button>
                        <button class="btn sm ${d.is_active ? 'warn' : 'ok'}" onclick="d_browseToggleCoinActive('${jsEsc(d.id)}', ${!d.is_active})">${d.is_active ? 'Deactivate' : 'Activate'}</button>
                        <button class="btn sm danger" onclick="d_browseDeleteCoin('${jsEsc(d.id)}', '${jsEsc(d.coin_code || d.id)}')">Delete</button>
                    </div>
                </td>
            </tr>`;
    }

    window.d_browseToggleCoinActive = async function (coinId, makeActive) {
        const { error } = await supabaseClient
            .from('admin_drops')
            .update({ is_active: makeActive })
            .eq('id', coinId);
        if (error) {
            console.log('[admin-coins] toggle active error', error);
            adminToast('Failed to update: ' + error.message, 'error');
            return;
        }
        adminToast(`Coin ${makeActive ? 'activated' : 'deactivated'}`, 'success');
        // Update local cache so the table reflects immediately, no full reload
        const row = _browseCoinsAll.find(d => d.id === coinId);
        if (row) row.is_active = makeActive;
        window.d_browseApplyFilters();
    };

    window.d_browseDeleteCoin = async function (coinId, label) {
        const ok = await adminConfirm({
            title: 'Delete this coin?',
            message: `Permanently removes coin ${label} and its claim history.\n\nThis cannot be undone.`,
            dangerLevel: 'destructive',
            confirmLabel: 'Delete coin',
        });
        if (!ok) return;
        const { error } = await supabaseClient.rpc('admin_bulk_delete_admin_drops', { p_drop_ids: [coinId] });
        if (error) {
            console.log('[admin-coins] delete coin error', error);
            adminToast('Delete failed: ' + error.message, 'error');
            return;
        }
        adminToast('Coin deleted', 'success');
        _browseCoinsAll = _browseCoinsAll.filter(d => d.id !== coinId);
        window.d_browseApplyFilters();
    };

    // ═════════ Batches sub-view ═════════
    window.d_loadDropBatches = async function () {
        const listEl  = document.getElementById('dropBatchesList');
        const statsEl = document.getElementById('dropBatchesStats');
        if (!listEl) return;
        listEl.innerHTML = `<div class="spin">Loading batches…</div>`;
        statsEl.textContent = '';

        const { data, error } = await supabaseClient.rpc('admin_list_drop_batches');
        if (error) {
            listEl.innerHTML = `<div class="empty" style="color:var(--danger);">Failed to load batches: ${esc(error.message)}</div>`;
            return;
        }
        const batches = data || [];
        if (batches.length === 0) {
            listEl.innerHTML = `
                <div class="empty" style="border:1px dashed var(--border-strong); border-radius:12px;">
                    <div style="font-size:38px; margin-bottom:12px;">📦</div>
                    <div style="font-size:15px; color:var(--text); margin-bottom:6px;">No bulk drops yet</div>
                    <div style="font-size:12px;">Use the Create Bulk sub-tab to create one.</div>
                </div>`;
            return;
        }

        const totalCoins  = batches.reduce((s, b) => s + Number(b.coin_count || 0), 0);
        const totalActive = batches.reduce((s, b) => s + Number(b.active_count || 0), 0);
        statsEl.textContent = `${batches.length} batch${batches.length === 1 ? '' : 'es'} · ${totalCoins} coins total (${totalActive} still active)`;

        // Cache the batch list so the detail view can grab the batch's
        // metadata (title, total_value, etc.) without a second RPC call.
        _dropBatchesCache = {};
        for (const b of batches) _dropBatchesCache[b.batch_id] = b;

        listEl.innerHTML = batches.map(b => {
            const fmtValue = b.value_currency === 'USD'
                ? `$${(Number(b.total_value) / 100).toFixed(2)}`
                : `${Number(b.total_value).toLocaleString()} credits`;
            const center = (b.center_lat != null && b.center_lng != null)
                ? `<a href="https://www.google.com/maps?q=${b.center_lat},${b.center_lng}" target="_blank" rel="noopener" onclick="event.stopPropagation();">📍 ${Number(b.center_lat).toFixed(4)}, ${Number(b.center_lng).toFixed(4)}</a>`
                : '<span style="color:var(--muted);">no location</span>';
            // The card body is clickable to open the detail; buttons and the
            // Maps link stopPropagation so they don't also open it.
            return `
                <div class="card" onclick="d_openBatchDetail('${jsEsc(b.batch_id)}')"
                     style="margin-bottom:14px; cursor:pointer; transition:border-color 0.15s;"
                     onmouseover="this.style.borderColor='var(--gold)'"
                     onmouseout="this.style.borderColor='var(--border)'">
                    <div style="display:flex; justify-content:space-between; align-items:start; gap:16px; margin-bottom:14px;">
                        <div style="flex:1; min-width:0;">
                            <div style="color:var(--cream); font-size:17px; font-weight:700; margin-bottom:4px;">${esc(b.title || '(no title)')} <span style="color:var(--gold); font-size:12px; font-weight:400; margin-left:6px;">click to view coins →</span></div>
                            <div style="color:var(--muted); font-size:12px;">${esc(b.description || '')}</div>
                            <div style="color:var(--muted); font-size:11px; margin-top:8px; font-family:monospace;">batch: ${esc(b.batch_id)}</div>
                        </div>
                        <div style="display:flex; flex-direction:column; gap:6px; flex-shrink:0;">
                            <button class="btn sm" onclick="event.stopPropagation(); d_openBatchDetail('${jsEsc(b.batch_id)}')" style="white-space:nowrap;">🔍 View Coins</button>
                            <button class="btn sm" onclick="event.stopPropagation(); d_viewDropRecipients('batch','${jsEsc(b.batch_id)}')" style="white-space:nowrap;">👥 Notified</button>
                            <button class="btn sm danger" onclick="event.stopPropagation(); d_deleteDropBatch('${jsEsc(b.batch_id)}', ${Number(b.coin_count)})" style="white-space:nowrap;">🗑️ Delete All</button>
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:12px; padding-top:14px; border-top:1px solid var(--border);">
                        <div>
                            <div style="color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:4px;">Coins</div>
                            <div style="color:var(--cream); font-size:18px; font-weight:700;">${Number(b.coin_count)}</div>
                            <div style="color:var(--muted); font-size:11px;">${Number(b.active_count)} active · ${Number(b.claimed_count)} claimed</div>
                        </div>
                        <div>
                            <div style="color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:4px;">Total value</div>
                            <div style="color:#FFD700; font-size:18px; font-weight:700;">${fmtValue}</div>
                            <div style="color:var(--muted); font-size:11px;">${esc(b.value_currency || '?')}</div>
                        </div>
                        <div>
                            <div style="color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:4px;">Created</div>
                            <div style="color:var(--text); font-size:13px;">${new Date(b.created_at).toLocaleString()}</div>
                            <div style="color:var(--muted); font-size:11px;">by ${esc(b.created_by_username || '?')}</div>
                        </div>
                        <div>
                            <div style="color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:4px;">Center</div>
                            <div style="font-size:13px;">${center}</div>
                        </div>
                    </div>
                </div>`;
        }).join('');
    };

    window.d_closeBatchDetail = function () {
        _currentBatchDetail = null;
        document.getElementById('dropBatchesListMode').style.display   = 'block';
        document.getElementById('dropBatchesDetailMode').style.display = 'none';
    };

    window.d_openBatchDetail = async function (batchId) {
        _currentBatchDetail = batchId;
        document.getElementById('dropBatchesListMode').style.display   = 'none';
        document.getElementById('dropBatchesDetailMode').style.display = 'block';

        const headerEl = document.getElementById('dropBatchDetailHeader');
        const coinsEl  = document.getElementById('dropBatchDetailCoins');

        const b = _dropBatchesCache[batchId];
        if (b) {
            // Render the header immediately using cached aggregate data.
            const fmtValue = b.value_currency === 'USD'
                ? `$${(Number(b.total_value) / 100).toFixed(2)}`
                : `${Number(b.total_value).toLocaleString()} credits`;
            headerEl.innerHTML = `
                <div class="card" style="margin-bottom:18px;">
                    <div style="display:flex; justify-content:space-between; align-items:start; gap:16px; margin-bottom:14px;">
                        <div style="flex:1; min-width:0;">
                            <div style="color:var(--cream); font-size:20px; font-weight:700; margin-bottom:4px;">${esc(b.title || '(no title)')}</div>
                            <div style="color:var(--muted); font-size:13px;">${esc(b.description || '')}</div>
                            <div style="color:var(--muted); font-size:11px; margin-top:8px; font-family:monospace;">batch: ${esc(b.batch_id)}</div>
                        </div>
                        <button class="btn danger" onclick="d_deleteDropBatch('${jsEsc(b.batch_id)}', ${Number(b.coin_count)})" style="white-space:nowrap;">🗑️ Delete Entire Batch</button>
                    </div>
                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:12px; padding-top:14px; border-top:1px solid var(--border);">
                        <div>
                            <div style="color:var(--muted); font-size:11px; text-transform:uppercase;">Coins</div>
                            <div style="color:var(--cream); font-size:18px; font-weight:700;">${Number(b.coin_count)}</div>
                            <div style="color:var(--muted); font-size:11px;">${Number(b.active_count)} active · ${Number(b.claimed_count)} claimed</div>
                        </div>
                        <div>
                            <div style="color:var(--muted); font-size:11px; text-transform:uppercase;">Total value</div>
                            <div style="color:#FFD700; font-size:18px; font-weight:700;">${fmtValue}</div>
                        </div>
                        <div>
                            <div style="color:var(--muted); font-size:11px; text-transform:uppercase;">Created</div>
                            <div style="color:var(--text); font-size:13px;">${new Date(b.created_at).toLocaleString()}</div>
                            <div style="color:var(--muted); font-size:11px;">by ${esc(b.created_by_username || '?')}</div>
                        </div>
                    </div>
                </div>`;
        } else {
            headerEl.innerHTML = '';
        }

        coinsEl.innerHTML = '<div class="spin">Loading coins in this batch…</div>';

        // Pull every coin in the batch. No pagination — a single bulk drop is
        // capped at 500 coins by the RPC.
        const { data, error } = await supabaseClient
            .from('admin_drops')
            .select('id, coin_code, title, reward_amount, value_currency, view_limit, views_count, is_active, expires_at, latitude, longitude, created_at, radius, video_duration_seconds, bulk_batch_id')
            .eq('bulk_batch_id', batchId)
            .order('created_at', { ascending: true });

        if (error) {
            coinsEl.innerHTML = `<div class="empty" style="color:var(--danger);">Failed to load coins: ${esc(error.message)}</div>`;
            return;
        }
        renderBatchDetailCoins(data || []);
    };

    function renderBatchDetailCoins(rows) {
        const coinsEl = document.getElementById('dropBatchDetailCoins');
        if (!coinsEl) return;
        if (rows.length === 0) {
            coinsEl.innerHTML = `
                <div class="empty" style="border:1px dashed var(--border-strong); border-radius:12px;">
                    <div style="font-size:38px; margin-bottom:12px;">∅</div>
                    <div style="font-size:14px;">No coins remain in this batch. (All deleted?)</div>
                </div>`;
            return;
        }
        // Stash for in-place updates after delete/toggle without re-fetch.
        _dropBatchDetailRows = rows.slice();
        coinsEl.innerHTML = `
            <div style="color:var(--muted); font-size:12px; margin-bottom:10px;">${rows.length} coins in this batch</div>
            ${coinTableHtml(rows, batchDetailRowHtml, 'dropBatchDetailCoinsTbody')}`;
    }

    // Same row cells as Browse but with batch-detail-scoped action handlers
    // so toggling/deleting from here updates THIS view's cache.
    function batchDetailRowHtml(d) {
        return `
            <tr>
                ${coinRowCellsHtml(d)}
                <td style="text-align:center;">
                    <div style="display:flex; gap:6px; justify-content:center; flex-wrap:wrap;">
                        <button class="btn sm" onclick="d_openCoinDetail('${jsEsc(d.id)}')">View</button>
                        <button class="btn sm ${d.is_active ? 'warn' : 'ok'}" onclick="d_batchDetailToggleCoinActive('${jsEsc(d.id)}', ${!d.is_active})">${d.is_active ? 'Deactivate' : 'Activate'}</button>
                        <button class="btn sm danger" onclick="d_batchDetailDeleteCoin('${jsEsc(d.id)}', '${jsEsc(d.coin_code || d.id)}')">Delete</button>
                    </div>
                </td>
            </tr>`;
    }

    window.d_batchDetailToggleCoinActive = async function (coinId, makeActive) {
        const { error } = await supabaseClient
            .from('admin_drops')
            .update({ is_active: makeActive })
            .eq('id', coinId);
        if (error) {
            adminToast('Failed to update: ' + error.message, 'error');
            return;
        }
        adminToast(`Coin ${makeActive ? 'activated' : 'deactivated'}`, 'success');
        const row = _dropBatchDetailRows.find(d => d.id === coinId);
        if (row) row.is_active = makeActive;
        renderBatchDetailCoins(_dropBatchDetailRows);
    };

    window.d_batchDetailDeleteCoin = async function (coinId, label) {
        const ok = await adminConfirm({
            title: 'Delete this coin?',
            message: `Permanently removes coin ${label} from this batch.\n\nThis cannot be undone.`,
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
        _dropBatchDetailRows = _dropBatchDetailRows.filter(d => d.id !== coinId);
        renderBatchDetailCoins(_dropBatchDetailRows);
        // If the batch is now empty, head back to the list (it'll have
        // disappeared from the list too — admin_list_drop_batches only
        // returns batches with at least 1 coin).
        if (_dropBatchDetailRows.length === 0) {
            window.d_closeBatchDetail();
            window.d_loadDropBatches();
        }
        // Also invalidate browse cache so the Browse table reloads next visit.
        _browseCoinsLoaded = false;
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
        // If we triggered this from inside the detail view, bounce back to
        // the list — the batch we were viewing no longer exists.
        if (_currentBatchDetail === batchId) window.d_closeBatchDetail();
        window.d_loadDropBatches();
        // Also refresh the Browse cache so deleted coins aren't shown there.
        _browseCoinsLoaded = false;
    };

    // ═════════ Map sub-view ═════════
    // Markers colored by status. Click → InfoWindow with details + edit
    // (jumps to Audit detail) / toggle active / delete buttons.
    window.d_loadMapView = async function () {
        const container = document.getElementById('adminDropsMapContainer');
        const statsEl = document.getElementById('mapViewStats');
        if (!container) return;

        // Clear previous markers (if any) before re-fetching.
        for (const m of _adminMapMarkers) m.setMap(null);
        _adminMapMarkers = [];
        if (_adminMapInfoWindow) _adminMapInfoWindow.close();

        statsEl.textContent = 'Loading coins…';

        const currencyFilter = document.getElementById('mapCurrencyFilter')?.value || 'all';
        const statusFilter = document.getElementById('mapStatusFilter')?.value || 'active';

        let query = supabaseClient
            .from('admin_drops')
            .select('id, coin_code, title, latitude, longitude, reward_amount, value_currency, view_limit, views_count, is_active, expires_at, radius, created_at')
            .order('created_at', { ascending: false })
            // Cap at a reasonable number — beyond ~2000 markers performance
            // suffers without clustering (which we haven't added yet).
            .limit(2000);

        if (currencyFilter !== 'all') query = query.eq('value_currency', currencyFilter);

        const { data: coins, error } = await query;
        if (error) {
            statsEl.textContent = '';
            // Don't nuke the container if a live map is inside it — just report.
            if (!_adminMapInstance) {
                container.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--danger);">Failed to load coins: ${esc(error.message)}</div>`;
            } else {
                adminToast('Failed to load coins: ' + error.message, 'error');
            }
            return;
        }

        // Apply status filter client-side (computeCoinStatus combines
        // is_active + expired + view_limit).
        const filtered = (coins || []).filter(c => {
            const status = computeCoinStatus(c);
            if (statusFilter === 'active') return status === 'active';
            if (statusFilter === 'inactive') return status === 'inactive';
            if (statusFilter === 'fully_claimed') return status === 'fully_claimed';
            return true; // 'all'
        }).filter(c =>
            c.latitude != null && c.longitude != null && !isNaN(c.latitude) && !isNaN(c.longitude)
        );

        if (filtered.length === 0) {
            statsEl.textContent = '0 coins match the current filters.';
            // Legacy replaced container.innerHTML here, which orphaned an
            // already-created map. Keep the map alive; only show the empty
            // placeholder when no map has been created yet.
            if (!_adminMapInstance) {
                container.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--muted); flex-direction:column; gap:10px;"><div style="font-size:38px;">🗺️</div><div>No coins to show on the map.</div></div>`;
            }
            return;
        }

        statsEl.textContent = `Showing ${filtered.length} coin${filtered.length === 1 ? '' : 's'} on the map. Click a marker to edit.`;

        // Initialize the map on first load. Reuse on subsequent reloads
        // (just clear + add new markers) so pan/zoom state isn't lost.
        if (!_adminMapInstance) {
            container.innerHTML = '';
            _adminMapInstance = new google.maps.Map(container, {
                center: { lat: filtered[0].latitude, lng: filtered[0].longitude },
                zoom: 10,
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: true,
                // Dark map styling to match the admin theme.
                styles: [
                    { elementType: 'geometry', stylers: [{ color: '#261E18' }] },
                    { elementType: 'labels.text.stroke', stylers: [{ color: '#261E18' }] },
                    { elementType: 'labels.text.fill', stylers: [{ color: '#9C8F80' }] },
                    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2C241D' }] },
                    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#1E1712' }] },
                    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
                ],
            });
            _adminMapInfoWindow = new google.maps.InfoWindow();
        }

        // Build markers + auto-fit bounds.
        const bounds = new google.maps.LatLngBounds();
        for (const coin of filtered) {
            const status = computeCoinStatus(coin);
            const color = {
                active:        '#4CAF50',
                inactive:      '#9E9E9E',
                expired:       '#FF9800',
                fully_claimed: '#9C27B0',
            }[status] || '#9C8F80';

            const marker = new google.maps.Marker({
                position: { lat: coin.latitude, lng: coin.longitude },
                map: _adminMapInstance,
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
                _adminMapInfoWindow.setContent(buildMapInfoWindowHtml(coin, status));
                _adminMapInfoWindow.open(_adminMapInstance, marker);
            });

            _adminMapMarkers.push(marker);
            bounds.extend({ lat: coin.latitude, lng: coin.longitude });
        }

        // Fit bounds with a tiny padding so markers aren't at the edge.
        // Skip if only one marker (fit-to-1 produces extreme zoom).
        if (filtered.length > 1) {
            _adminMapInstance.fitBounds(bounds, 60);
        } else {
            _adminMapInstance.setCenter({ lat: filtered[0].latitude, lng: filtered[0].longitude });
            _adminMapInstance.setZoom(15);
        }
    };

    // InfoWindow content renders inside Google's white popover — dark text
    // for the title, same as legacy.
    function buildMapInfoWindowHtml(coin, status) {
        const badge = STATUS_BADGE[status] || STATUS_BADGE.inactive;
        const valueLabel = coin.value_currency === 'USD'
            ? `$${((coin.reward_amount || 0) / 100).toFixed(2)}`
            : `${(coin.reward_amount || 0).toLocaleString()} credits`;
        const claimsLabel = `${coin.views_count || 0}${coin.view_limit ? ` / ${coin.view_limit}` : ' / ∞'}`;
        return `
            <div style="font-family:-apple-system, BlinkMacSystemFont, sans-serif; min-width:240px; max-width:320px;">
                <div style="font-size:14px; font-weight:700; color:#1E1712; margin-bottom:4px;">${esc(coin.title || '(untitled)')}</div>
                <div style="font-size:11px; font-family:Menlo,Monaco,monospace; color:#9C8F80; margin-bottom:8px;">${esc(coin.coin_code || coin.id)}</div>
                <div style="display:grid; grid-template-columns:auto 1fr; gap:4px 10px; font-size:12px; color:#3d3226; margin-bottom:10px;">
                    <span style="color:#9C8F80;">Value:</span> <span style="font-weight:600; color:#B8860B;">${valueLabel}</span>
                    <span style="color:#9C8F80;">Status:</span> <span style="color:${badge.color}; font-weight:600;">${badge.label}</span>
                    <span style="color:#9C8F80;">Claims:</span> <span>${claimsLabel}</span>
                    <span style="color:#9C8F80;">Radius:</span> <span>${coin.radius || '?'} m</span>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button onclick="d_openCoinDetail('${jsEsc(coin.id)}')" style="padding:6px 12px; background:#C2902F; color:#F2E9DA; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">✏️ Edit / View</button>
                    <button onclick="d_mapToggleCoinActive('${jsEsc(coin.id)}', ${!coin.is_active})" style="padding:6px 12px; background:${coin.is_active ? '#FF9800' : '#4CAF50'}; color:#F2E9DA; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">${coin.is_active ? 'Deactivate' : 'Activate'}</button>
                    <button onclick="d_mapDeleteCoin('${jsEsc(coin.id)}', '${jsEsc(coin.coin_code || coin.id)}')" style="padding:6px 12px; background:#FF4757; color:#F2E9DA; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">🗑️ Delete</button>
                </div>
            </div>`;
    }

    window.d_mapToggleCoinActive = async function (coinId, makeActive) {
        const { error } = await supabaseClient
            .from('admin_drops')
            .update({ is_active: makeActive })
            .eq('id', coinId);
        if (error) {
            adminToast('Failed to update: ' + error.message, 'error');
            return;
        }
        adminToast(`Coin ${makeActive ? 'activated' : 'deactivated'}`, 'success');
        if (_adminMapInfoWindow) _adminMapInfoWindow.close();
        _browseCoinsLoaded = false;
        window.d_loadMapView();
    };

    window.d_mapDeleteCoin = async function (coinId, label) {
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
        if (_adminMapInfoWindow) _adminMapInfoWindow.close();
        _browseCoinsLoaded = false;
        window.d_loadMapView();
    };

    // ═════════ Audit sub-view ═════════
    // Mode A: dashboard tiles. Mode B: coin detail (via lookup or "View").
    async function loadAuditDashboard() {
        const pane = document.getElementById('auditDashboardPane');
        const detailPane = document.getElementById('auditCoinDetailPane');
        if (detailPane) detailPane.style.display = 'none';
        if (!pane) return;
        pane.style.display = 'block';
        pane.innerHTML = '<div class="spin">Loading dashboard…</div>';

        try {
            const nowIso = new Date().toISOString();
            const oneDayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

            // Active coins: is_active AND (expires_at IS NULL OR expires_at > NOW())
            //              AND (view_limit IS NULL OR views_count < view_limit).
            // PostgREST can't compare views_count < view_limit column-to-column,
            // so we fetch active+non-expired rows and apply that check here.
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

            pane.innerHTML = renderAuditDashboardHtml({
                totalActive,
                usdOnMap,
                creditsOnMap,
                claimsToday: claimsToday || 0,
                claimsAllTime: claimsAllTime || 0,
                topClaimants,
            });
        } catch (err) {
            console.error('[admin-coins] dashboard threw', err);
            pane.innerHTML = `<div class="empty" style="color:var(--danger);">Failed to load dashboard: ${esc(err.message || String(err))}</div>`;
        }
    }

    function renderAuditDashboardHtml({ totalActive, usdOnMap, creditsOnMap, claimsToday, claimsAllTime, topClaimants }) {
        const usdLabel = `$${(usdOnMap / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const creditsLabel = creditsOnMap.toLocaleString();
        const tile = (title, value, sub) => `
            <div class="stat">
                <h4>${esc(title)}</h4>
                <div class="num">${value}</div>
                ${sub ? `<div style="color:var(--muted); font-size:12px; margin-top:6px;">${sub}</div>` : ''}
            </div>`;
        const topClaimantsHtml = topClaimants.length === 0
            ? '<div style="color:var(--muted); font-size:13px;">No claims yet.</div>'
            : topClaimants.map((c, i) => `
                <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border);">
                    <div style="color:var(--cream);">
                        <span style="color:var(--gold); font-weight:700; margin-right:8px;">#${i + 1}</span>
                        ${esc(c.username)}
                    </div>
                    <div style="color:#FFD700; font-weight:700;">${c.count} claim${c.count === 1 ? '' : 's'}</div>
                </div>`).join('');
        return `
            <div class="stats" style="margin-bottom:24px;">
                ${tile('Total coins active', totalActive.toLocaleString(), 'Still claimable right now')}
                ${tile('USD on the map',     `<span style="color:#FFD700;">${usdLabel}</span>`, 'Sum of active USD coins')}
                ${tile('Credits on the map', `<span style="color:#FFD700;">${creditsLabel}</span>`, 'Sum of active CREDITS coins')}
                ${tile('Claims today',       claimsToday.toLocaleString(),   'Last 24 hours')}
                ${tile('Claims all-time',    claimsAllTime.toLocaleString(), 'Across every coin ever')}
            </div>
            <div class="card">
                <h3 style="color:var(--gold); font-size:14px; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:12px;">🏆 Top 5 Claimants</h3>
                ${topClaimantsHtml}
                <div style="color:var(--muted); font-size:11px; margin-top:12px;">Based on the most recent 2,000 claims.</div>
            </div>`;
    }

    window.d_showAuditDashboard = function () {
        // Clear the lookup input so the dashboard view is "clean"
        const inp = document.getElementById('auditCoinCodeInput');
        if (inp) inp.value = '';
        loadAuditDashboard();
    };

    // Look up by coin_code (the public-facing identifier on the coin).
    // Codes are stored uppercase ("COIN-XXXX-XXXX-XXXX") so we normalize the
    // input — but fall back to a case-insensitive ilike if the exact match fails.
    window.d_lookupCoinByCode = async function () {
        const raw = (document.getElementById('auditCoinCodeInput')?.value || '').trim();
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
            // Try a case-insensitive match in case the stored format differs
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

    // Open the coin detail view (also reachable from Browse/Batches/Map).
    // Switches to the Audit sub-tab if we're not already there.
    window.d_openCoinDetail = async function (coinId) {
        if (_sub !== 'audit') window.d_setSubTab('audit');
        const dashPane = document.getElementById('auditDashboardPane');
        const detailPane = document.getElementById('auditCoinDetailPane');
        if (dashPane) dashPane.style.display = 'none';
        if (!detailPane) return;
        detailPane.style.display = 'block';
        detailPane.innerHTML = '<div class="spin">Loading coin…</div>';

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
                detailPane.innerHTML = `<div class="empty" style="color:var(--danger);">Failed to load coin: ${esc(coinRes.error.message)}</div>`;
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
            // attach to each user so the coin-claim viewer list shows it.
            const coinEmap = await fetchEmailMap(viewerIds);
            usersById.forEach((u, id) => { u.email = coinEmap[id] || null; });
            const ledgerByClaimId = new Map((ledgerRes.data || []).map(l => [l.source_id, l]));

            detailPane.innerHTML = renderCoinDetailHtml(coin, claims, usersById, ledgerByClaimId);

            // Viewer log ("who watched/claimed" audit — legacy loadViewerData)
            loadViewerAudit(coinId);
        } catch (err) {
            console.error('[admin-coins] coin detail threw', err);
            detailPane.innerHTML = `<div class="empty" style="color:var(--danger);">Unexpected error: ${esc(err.message || String(err))}</div>`;
        }
    };

    function renderCoinDetailHtml(coin, claims, usersById, ledgerByClaimId) {
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
                            <strong class="userchip"><span class="nm" onclick="openUser('${jsEsc(c.viewer_id || '')}')">${esc(u?.username || '(unknown)')}</span></strong>
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
            <div class="card" style="margin-bottom:18px;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:14px;">
                    <div>
                        <div style="font-family:Menlo,Monaco,monospace; font-size:20px; color:var(--gold); margin-bottom:6px;">${esc(coin.coin_code || coin.id)}</div>
                        <h3 style="color:var(--cream); font-size:18px; margin-bottom:6px;">${esc(coin.title || '(untitled)')}</h3>
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
                        <button class="btn sm" onclick="d_viewDropRecipients('drop','${jsEsc(coin.id)}')" style="margin-top:8px;">👥 Who was notified</button>
                    </div>
                </div>
            </div>

            <div class="card">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
                    <h3 style="color:var(--gold); font-size:14px; text-transform:uppercase; letter-spacing:0.05em;">📜 Claim History</h3>
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
            <div id="d_coinViewerAudit" style="margin-top:18px;"><div class="spin">Loading claim audit…</div></div>`;
    }

    // Placeholder — wire up to a real "reverse claim" RPC later (legacy TODO).
    window.d_reverseClaimTodo = function (claimId) {
        console.log('[admin-coins] reverseClaimTodo for claim', claimId);
        adminToast('Reverse-claim flow is not yet implemented.', 'info');
    };

    // Ported legacy loadViewerData: the full viewer audit trail for one coin
    // (claimed vs preview-only, avatars, emails via admin RPC). Its legacy
    // home was an expandable row in the retired Manage Drops table; here it
    // renders as a section of the coin detail view.
    async function loadViewerAudit(dropId) {
        const contentDiv = document.getElementById('d_coinViewerAudit');
        if (!contentDiv) return;

        try {
            // Pull claimed_at + watch_progress_pct so we can distinguish
            // "started watching" vs "fully claimed" vs "preview only" — this
            // is the audit trail the admin needs to know WHO got each prize.
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
                contentDiv.innerHTML = `<div class="card" style="color:var(--muted); text-align:center;">No claims yet — this coin hasn't been viewed by anyone.</div>`;
                return;
            }

            // email REVOKE'd from authenticated → fetch via admin RPC +
            // attach to each viewer so the audit table still shows email.
            const emap = await fetchEmailMap(views.map(v => v.viewer?.id || v.viewer_id));
            views.forEach(v => { if (v.viewer) v.viewer.email = emap[v.viewer.id] || null; });

            const claimedCount = views.filter(v => v.claimed_at).length;
            const previewCount = views.length - claimedCount;

            const rowsHtml = views.map((view, idx) => {
                const viewedDate = new Date(view.viewed_at);
                const claimedDate = view.claimed_at ? new Date(view.claimed_at) : null;
                const viewer = view.viewer || {};
                const isClaimed = !!view.claimed_at;
                const statusBadge = isClaimed
                    ? `<span class="pill ok">✓ CLAIMED</span>`
                    : `<span class="pill muted">PREVIEW</span>`;
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
                        <td>${statusBadge}</td>
                        <td style="color:${view.watch_progress_pct === 100 ? 'var(--ok)' : 'var(--warn)'}; font-weight:700;">${view.watch_progress_pct}%</td>
                        <td style="color:var(--muted); font-size:12px;">${whenLabel}</td>
                    </tr>`;
            }).join('');

            contentDiv.innerHTML = `
                <div class="card">
                    <div style="margin-bottom:14px; display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
                        <h4 style="color:var(--cream); margin:0; font-size:14px;">🧾 Claim audit</h4>
                        <span class="pill ok">${claimedCount} CLAIMED</span>
                        <span class="pill muted">${previewCount} PREVIEW ONLY</span>
                    </div>
                    <div class="tblwrap">
                        <table class="tbl">
                            <thead>
                                <tr><th>#</th><th>User</th><th>Email</th><th>Status</th><th>Watched %</th><th>When</th></tr>
                            </thead>
                            <tbody>${rowsHtml}</tbody>
                        </table>
                    </div>
                </div>`;
        } catch (error) {
            console.error('Error loading viewer data:', error);
            contentDiv.innerHTML = `<div class="empty" style="color:var(--danger);">Failed to load viewer data: ${esc(error.message)}</div>`;
        }
    }

    // Legacy getTimeAgo — the shared timeAgo() takes an ISO string; this one
    // takes a Date and has finer wording, kept for the viewer audit panel.
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
