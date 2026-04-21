/**
 * UI components: 募集カード・検索/履歴カード・ホーム一覧表示
 * グローバル state および isVolFilled / isOwnVol / openDetailFromCardElement 等に依存（実行時解決）
 */
        function formatVolDateTimeFromIso(isoText) {
            if (!isoText) return '';
            var d = new Date(isoText);
            if (isNaN(d.getTime())) return '';
            var m = d.getMonth() + 1;
            var day = d.getDate();
            var h = String(d.getHours()).padStart(2, '0');
            var min = String(d.getMinutes()).padStart(2, '0');
            return m + '/' + day + ' ' + h + ':' + min + '~';
        }
        function formatVolDateTime(v) {
            if (!v) return '';
            var fromIso = v.startsAt && formatVolDateTimeFromIso(v.startsAt);
            if (fromIso) return fromIso;
            return v.dateTimeText || v.when || '';
        }
        function formatVolPlace(v) {
            if (!v) return '';
            if (v.venue) return v.venue;
            if (v.remote) return 'オンライン';
            return v.place || '現地';
        }
        function formatVolPeople(v) {
            if (typeof v.joined === 'number' && typeof v.capacity === 'number') {
                return v.joined + '/' + v.capacity;
            }
            return '－';
        }
        function escapeHtml(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }
        function hashTag(t) {
            var s = String(t == null ? '' : t).trim();
            if (!s) return '';
            if (s[0] === '#') return s;
            return '#' + s.replace(/\s+/g, '');
        }

        function renderHistoryCards(containerEl, historyItems) {
            if (!containerEl) return;
            containerEl.innerHTML = '';
            (historyItems || []).forEach(function (h) {
                var card = document.createElement('div');
                card.className = 'card';
                card.style.marginBottom = '0';

                // Match vol by explicit id (organizer/account open cards) or by title.
                var vol = null;
                if (h && h._volId && state.vols[h._volId]) {
                    vol = state.vols[h._volId];
                } else {
                    Object.keys(state.vols || {}).some(function (k) {
                        var v = state.vols[k];
                        if (v && v.title === h.title) { vol = v; return true; }
                        return false;
                    });
                }

                var org = (vol && vol.chatWith) ? vol.chatWith : 'コミュニティ';
                var avatar = (org || '？').trim().slice(0, 2) || '？';
                var right = (vol && vol.thumb) ? vol.thumb : '🤝';

                // Use meta pieces as tags when possible.
                var tags = [];
                if (h && h.meta) {
                    tags = h.meta.split('·').map(function (s) { return s.trim(); }).filter(Boolean);
                }
                if (!tags.length && vol) tags = [vol.when, vol.place];

                card.innerHTML =
                    '<div class="home-card-row">' +
                        '<div class="home-avatar home-avatar--teal" aria-hidden="true"><span aria-hidden="true">🕘</span></div>' +
                        '<div class="home-center">' +
                            '<div class="home-title-row">' +
                                '<div class="home-title">' + (h.title || '') + '</div>' +
                            '</div>' +
                            '<div class="home-tag-row home-tag-row--extra" style="margin-top:8px;">' + tags.slice(0, 4).map(function (t) { return '<span class="home-tag home-tag--muted">' + t + '</span>'; }).join('') + '</div>' +
                        '</div>' +
                    '</div>';
                if (h._volId) {
                    card.classList.add('card-clickable');
                    card.style.cursor = 'pointer';
                    card.addEventListener('click', function () { openDetail(h._volId); });
                }
                containerEl.appendChild(card);
            });
        }
        function updateHomeEmptyState() {
            var homeCards = document.getElementById('homeCards');
            var hint = document.getElementById('homeEmptyHint');
            var loading = document.getElementById('homeLoadingState');
            if (!homeCards || !hint || !loading) return;
            /** DOM が一瞬空でも、取得済み state があれば「空」と誤表示しない */
            var hasCards = Object.keys(state.vols || {}).some(function (k) {
                var v = state.vols[k];
                return k.indexOf('vol-user-') === 0 && v && !isVolFilled(v);
            });
            var cacheLen = (typeof window !== 'undefined' && window.allPostsCache && window.allPostsCache.length) || 0;
            var domHasCards = !!homeCards.querySelector('[data-open-detail]');
            /** Firestore 応答完了後・ローディングでない・state もキャッシュも DOM も空のときだけ「ありません」 */
            var showEmptyHint =
                state.homePostsLoadedOnce &&
                !state.homePostsLoading &&
                !hasCards &&
                cacheLen === 0 &&
                !domHasCards;
            /** 取得中、またはキャッシュからまだ state に載っていない間はローディング扱い */
            var showLoadingUi = state.homePostsLoading || (!hasCards && cacheLen > 0);
            loading.hidden = !showLoadingUi;
            hint.hidden = !showEmptyHint;
        }

        function renderHomeCardsFromState() {
            var homeCards = document.getElementById('homeCards');
            var create = window.__tfCreateHomeCard;
            if (!homeCards || typeof create !== 'function') return;

            var cacheLen = (typeof window !== 'undefined' && window.allPostsCache && window.allPostsCache.length) || 0;
            /** いったん state を埋めてから DOM を触る（空のまま全削除しない） */
            if (cacheLen > 0 && typeof applyPostsToState === 'function') {
                var hasVisible = Object.keys(state.vols || {}).some(function (k) {
                    var v = state.vols[k];
                    return k.indexOf('vol-user-') === 0 && v && !isVolFilled(v);
                });
                if (!hasVisible) {
                    applyPostsToState(
                        window.allPostsCache.map(function (item) {
                            return Object.assign({}, item);
                        })
                    );
                }
            }

            var ordered = Object.keys(state.vols || {}).map(function (id) {
                return state.vols[id];
            }).filter(function (vol) {
                return vol && vol.id && String(vol.id).indexOf('vol-user-') === 0 && !isVolFilled(vol);
            });

            var mayPurgeStaleDom =
                ordered.length > 0 ||
                (cacheLen === 0 && !state.homePostsLoading && state.homePostsLoadedOnce);

            if (ordered.length > 0) {
                homeCards.querySelectorAll('[data-open-detail]').forEach(function (el) {
                    if (el && el.parentNode) el.parentNode.removeChild(el);
                });
                for (var i = ordered.length - 1; i >= 0; i--) {
                    homeCards.insertBefore(create(ordered[i]), homeCards.firstChild);
                }
            } else if (mayPurgeStaleDom) {
                homeCards.querySelectorAll('[data-open-detail]').forEach(function (el) {
                    if (el && el.parentNode) el.parentNode.removeChild(el);
                });
            }

            updateHomeEmptyState();
        }

        function liveSyncReconcileHomeCards() {
            renderHomeCardsFromState();
        }
        function renderSearchResults() {
            var wrap = document.getElementById('searchResults');
            if (!wrap) return;
            wrap.innerHTML = '';
            function reqCardHTML(v) {
                var thumb = v.thumb || '🤝';
                var tags = (v.tags || []).slice(0, 4).map(hashTag).filter(Boolean);
                return '' +
                    '<div class="req-card">' +
                        '<div class="req-icon" aria-hidden="true"><span aria-hidden="true">' + thumb + '</span></div>' +
                        '<div class="req-card-main">' +
                            '<div>' +
                                '<div class="req-title">' + (v.title || '') + '</div>' +
                                '<div class="req-author">' + (v.chatWith || '主催者') + '</div>' +
                            '</div>' +
                            '<div class="req-meta" aria-label="日時・場所・人数">' +
                                '<span class="req-meta-item"><span class="ic" aria-hidden="true">📅</span>' + formatVolDateTime(v) + '</span>' +
                                '<span class="req-meta-item req-meta-place"><span class="ic" aria-hidden="true">📍</span>' + formatVolPlace(v) + '</span>' +
                                '<span class="req-meta-item"><span class="ic" aria-hidden="true">👥</span>' + formatVolPeople(v) + '</span>' +
                            '</div>' +
                            '<div class="req-tags" aria-label="タグ">' +
                                (tags.length ? tags.map(function (t) { return '<span class="req-tag">' + t + '</span>'; }).join('') : '') +
                            '</div>' +
                        '</div>' +
                    '</div>';
            }
            var q = (state.filters.q || '').trim().toLowerCase();
            if (!q) {
                var hint = document.createElement('div');
                hint.className = 'search-empty-hint';
                hint.textContent = 'キーワードを入力すると、該当する募集がここに表示されます。';
                wrap.appendChild(hint);
                return;
            }
            var items = Object.keys(state.vols).map(function (k) { return state.vols[k]; });
            items = items.filter(function (v) {
                if (state.filters.near && !v.near) return false;
                if (state.filters.thisWeek && !v.thisWeek) return false;
                if (state.filters.remote && !v.remote) return false;
                var tagsStr = ((v.tags || []).join(' ')).toLowerCase();
                var hay = (
                    (v.tag || '') + ' ' + (v.title || '') + ' ' + (v.desc || '') + ' ' +
                    (v.place || '') + ' ' + (v.venue || '') + ' ' + (v.when || '') + ' ' +
                    (v.chatWith || '') + ' ' + tagsStr + ' ' + formatVolDateTime(v) + ' ' + formatVolPlace(v)
                ).toLowerCase();
                return hay.indexOf(q) !== -1;
            });
            if (!items.length) {
                var empty = document.createElement('div');
                empty.className = 'card';
                empty.innerHTML = '<div class="tag">該当なし</div><div style="color:var(--text-sub);margin-top:8px;font-size:0.92rem;">別の言葉や絞り込みを試してみてください。</div>';
                wrap.appendChild(empty);
                return;
            }
            items.forEach(function (v) {
                var card = document.createElement('div');
                card.className = 'card card-clickable';
                card.setAttribute('data-open-detail', v.id || '');
                card.setAttribute('data-id', v.id || '');
                card.setAttribute('role', 'button');
                card.setAttribute('tabindex', '0');
                card.innerHTML = reqCardHTML(v);
                card.addEventListener('click', function () {
                    openDetailFromCardElement(card);
                });
                card.addEventListener('keydown', function (e) {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    openDetailFromCardElement(card);
                });
                wrap.appendChild(card);
            });
        }
        function makeHomeCardIconInnerHtml(v) {
            var own = isOwnVol(v);
            var photo = '';
            if (own) photo = String(state.profile.photoDataUrl || '');
            if (!photo && v && v.hostedByUserId) photo = syncedPhotoForUserId(v.hostedByUserId);
            if (!photo && v && v.authorPhotoUrl) photo = String(v.authorPhotoUrl || '').trim();
            if (!photo && v && v.chatWith) {
                var uidByName = userIdForDisplayName(v.chatWith);
                if (uidByName) photo = syncedPhotoForUserId(uidByName);
            }
            if (photo && (photo.indexOf('data:image/') === 0 || photo.indexOf('https://') === 0 || photo.indexOf('http://') === 0)) {
                return '<img class="req-icon-photo" src="' + escapeHtml(photo) + '" alt="" loading="lazy" decoding="async">';
            }
            return '<span aria-hidden="true">' + escapeHtml(v.thumb || '🤝') + '</span>';
        }

        function hydrateHomeCardImageStates(cardEl) {
            if (!cardEl) return;
            var iconWrap = cardEl.querySelector('.req-icon');
            var iconImg = iconWrap ? iconWrap.querySelector('.req-icon-photo') : null;
            if (iconWrap && iconImg) {
                iconWrap.classList.add('is-loading-photo');
                var iconDone = function () {
                    iconWrap.classList.remove('is-loading-photo');
                };
                if (iconImg.complete && iconImg.naturalWidth > 0) {
                    iconDone();
                } else {
                    iconImg.addEventListener('load', iconDone, { once: true });
                    iconImg.addEventListener('error', iconDone, { once: true });
                }
            } else if (iconWrap) {
                iconWrap.classList.remove('is-loading-photo');
            }

            var mediaWrap = cardEl.querySelector('.home-card-media');
            var mediaImg = mediaWrap ? mediaWrap.querySelector('.home-card-media-img') : null;
            if (mediaWrap && mediaImg) {
                mediaWrap.classList.add('is-loading-media');
                var mediaDone = function () {
                    mediaWrap.classList.remove('is-loading-media');
                };
                if (mediaImg.complete && mediaImg.naturalWidth > 0) {
                    mediaDone();
                } else {
                    mediaImg.addEventListener('load', mediaDone, { once: true });
                    mediaImg.addEventListener('error', mediaDone, { once: true });
                }
            }
        }

        function refreshOwnHomeCardIcons() {
            var homeCards = document.getElementById('homeCards');
            if (!homeCards) return;
            homeCards.querySelectorAll('[data-open-detail]').forEach(function (cardEl) {
                var vid = cardEl.getAttribute('data-open-detail');
                var vol = vid && state.vols ? state.vols[vid] : null;
                if (!vol || !isOwnVol(vol)) return;
                var iconEl = cardEl.querySelector('.req-icon');
                if (!iconEl) return;
                iconEl.innerHTML = makeHomeCardIconInnerHtml(vol);
                hydrateHomeCardImageStates(cardEl);
            });
        }

        function refreshAllHomeCardIcons() {
            var homeCards = document.getElementById('homeCards');
            if (!homeCards) return;
            homeCards.querySelectorAll('[data-open-detail]').forEach(function (cardEl) {
                var vid = cardEl.getAttribute('data-open-detail');
                var vol = vid && state.vols ? state.vols[vid] : null;
                if (!vol) return;
                var iconEl = cardEl.querySelector('.req-icon');
                if (!iconEl) return;
                iconEl.innerHTML = makeHomeCardIconInnerHtml(vol);
                hydrateHomeCardImageStates(cardEl);
            });
        }

        function createHomeCardElement(v) {
            var card = document.createElement('div');
            card.className = 'card card-clickable';
            card.setAttribute('data-open-detail', v.id);
            card.setAttribute('data-id', v.id);
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');

            var tags = (v.tags || []).slice(0, 4).map(hashTag).filter(Boolean);
            var mediaHtml = '';
            if (v.image) {
                mediaHtml = '<div class="home-card-media" aria-hidden="true"><img class="home-card-media-img" src="' + escapeHtml(v.image) + '" alt="" loading="lazy" decoding="async"></div>';
            }
            var own = isOwnVol(v);
            var iconInner = makeHomeCardIconInnerHtml(v);
            var iconHtml = own
                ? '<div class="req-icon" role="button" tabindex="0" data-open-account="1" aria-label="アカウント">' + iconInner + '</div>'
                : '<div class="req-icon" role="button" tabindex="0" data-open-organizer="' + escapeHtml(v.chatWith || '主催者') + '"' +(v.hostedByUserId ? (' data-organizer-user-id="' + escapeHtml(v.hostedByUserId) + '"') : '') + ' aria-label="' + escapeHtml((v.chatWith || '主催者') + 'のプロフィール') + '">' + iconInner + '</div>';
            card.innerHTML = '' +
                '<div class="home-card-body">' +
                    '<div class="req-card">' +
                        '<div class="req-card-top">' +
                        iconHtml +
                        '<div class="req-card-head">' +
                                '<div class="req-title">' + escapeHtml(v.title || '') + '</div>' +
                                '<div class="req-author">' + escapeHtml(v.chatWith || '主催者') + '</div>' +
                        '</div>' +
                        '</div>' +
                            '<div class="req-meta" aria-label="日時・場所・人数">' +
                                '<span class="req-meta-item"><span class="ic" aria-hidden="true">📅</span>' + escapeHtml(formatVolDateTime(v)) + '</span>' +
                                '<span class="req-meta-item req-meta-place"><span class="ic" aria-hidden="true">📍</span>' + escapeHtml(formatVolPlace(v)) + '</span>' +
                                '<span class="req-meta-item"><span class="ic" aria-hidden="true">👥</span>' + escapeHtml(formatVolPeople(v)) + '</span>' +
                            '</div>' +
                            '<div class="req-tags" aria-label="タグ">' +
                                (tags.length ? tags.map(function (t) { return '<span class="req-tag">' + escapeHtml(t) + '</span>'; }).join('') : '') +
                            '</div>' +
                    '</div>' +
                '</div>' +
                mediaHtml;
            card.addEventListener('click', function () {
                openDetailFromCardElement(card);
            });
            card.addEventListener('keydown', function (e) {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                openDetailFromCardElement(card);
            });
            var icon = card.querySelector('.req-icon');
            if (icon) {
                var goAccount = function () {
                    var accNav = document.querySelector('.bottom-nav .nav-item[data-section="account"]');
                    showSection('account', accNav);
                };
                var onIconActivate = function (e) {
                    e.stopPropagation();
                    if (isOwnVol(v)) goAccount();
                    else openOrganizerProfile(v.chatWith || '主催者', v.hostedByUserId || '');
                };
                icon.addEventListener('click', onIconActivate);
                icon.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        onIconActivate(e);
                    }
                });
            }
            hydrateHomeCardImageStates(card);
            return card;
        }
window.__tfCreateHomeCard = createHomeCardElement;
