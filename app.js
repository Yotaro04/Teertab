        /**
         * Firebase: firebase-config.js で initializeApp 済み。モジュラー API は teertab-firebase-runtime.mjs が window.__TF に載せる。
         * Firestore: teertabSync/bundle（共有同期）+ posts（全ユーザー共通募集）+ users/{uid}（プロフィール等）
         */
        var teertabFirebaseListenerAttached = false;
        var userDefaultSaveTimer = null;
        var accountViewRefreshSeq = 0;
        var teertabMainBooted = false;
        var firebaseAuthUnsub = null;

        function firebaseSyncMode() {
            try {
                var q = new URLSearchParams(window.location.search);
                if (q.get('sync') === 'firebase' || q.get('firebase') === '1') return true;
            } catch (_) {}
            try {
                return localStorage.getItem('tealfolder.syncMode') === 'firebase';
            } catch (_) {
                return false;
            }
        }

        /** Render 本番など: クエリなしでも Firebase 同期をオンにする（?sync=auto は除外して HTTP 同期を残す） */
        function firebaseSyncHostAuto() {
            try {
                if (window.location.protocol === 'file:') return false;
                var q = new URLSearchParams(window.location.search);
                var syncQ = q.get('sync');
                if (syncQ === 'auto' || syncQ === '1') return false;
                var h = String(window.location.hostname || '');
                if (!h || h === 'localhost' || h === '127.0.0.1') return false;
                return h.indexOf('onrender.com') !== -1;
            } catch (_) {
                return false;
            }
        }

        function firebaseSyncBackendWanted() {
            return firebaseSyncMode() || firebaseSyncHostAuto();
        }


        function setAuthGateVisible(visible, statusText) {
            var gate = document.getElementById('authGate');
            var appShell = document.getElementById('appShell');
            var st = document.getElementById('authGateStatus');
            if (st) st.textContent = statusText || '';
            if (gate) gate.classList.toggle('open', !!visible);
            if (appShell) appShell.style.display = visible ? 'none' : '';
        }

        function firebaseSyncActive() {
            if (!tf() || !tf().bundleRef) return false;
            if (firebaseSyncHostAuto()) return true;
            return firebaseSyncMode() && !getLiveSyncBase();
        }

        function initTeertabFirebase() {
            if (!firebaseSyncBackendWanted()) return false;
            if (!tf()) return false;
            return true;
        }

        function attachFirebaseBundleListener() {
            var TF = tf();
            if (!firebaseSyncActive() || !TF || teertabFirebaseListenerAttached) return;
            teertabFirebaseListenerAttached = true;
            TF.onSnapshot(TF.bundleRef, function (snap) {
                if (!snap.exists) return;
                var data = snap.data();
                if (!data) return;
                liveSyncApplyBundle(data);
                if (!liveSyncConnectedOnce) {
                    liveSyncConnectedOnce = true;
                    showToast('Firebase（Firestore）とつながりました');
                }
            });
        }

        function randomTealToken(prefix) {
            return prefix + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
        }

        function publicProfilePhotoUrl(pub) {
            if (!pub) return '';
            var s = pub.photoStorageUrl || pub.photoDataUrl;
            if (typeof s !== 'string') return '';
            s = s.trim();
            if (!s) return '';
            if (s.indexOf('data:image/') === 0) return s;
            if (s.indexOf('https://') === 0 || s.indexOf('http://') === 0) return s;
            return '';
        }


        function profilePhotoInSyncWithPublic(localPhoto, pub) {
            var srv = publicProfilePhotoUrl(pub);
            var loc = String(localPhoto || '').trim();
            if (!loc && !srv) return true;
            if (loc === srv) return true;
            if (loc.indexOf('data:image/') === 0 && srv && (srv.indexOf('https://') === 0 || srv.indexOf('http://') === 0)) {
                return true;
            }
            return false;
        }


        var state = {
            viewStack: ['home'],
            currentDetailId: '',
            currentChatWith: '',
            currentChatPeerUserId: '',
            currentOrganizerName: '',
            currentOrganizerUserId: '',
            myHostedVolIds: {},
            pendingThankOrganizer: '',
            pendingThankOrganizerUserId: '',
            pendingThankVolTitle: '',
            hostGrantThanksPendingUniq: 0,
            thanksTipCooldownByUserId: {},
            auth: { userId: '', secret: '', displayName: '', phoneE164: '' },
            usersPublic: {},
            profile: { thanksCount: 10, name: '', avatar: '🙂', bio: '', photoDataUrl: '' },
            filters: { near: true, thisWeek: true, remote: false, q: '' },
            vols: {},
            threads: [],
            history: [],
            notifications: [],
            _bundleNotificationsRaw: [],
            _fsNotificationRows: [],
            _fsPendingOwnerApplicationCount: 0,
            /** Firestore 参加通知: where(viewedJoinState==false) の件数（DM とは別系統） */
            _fsJoinNotifUnreadFromQuery: 0,
            /** Firestore DM: chats.unseenCountByUser 由来のヘッダー未読ドット */
            _fsHasDmUnread: false,
            userDefaultHydrated: false,
            userDefaultHostedVols: [],
            dismissedNotifsRemote: {},
            homePostsLoading: true,
            homePostsLoadedOnce: false,
            _postsSnapshotSig: ''
        };

        /** Firestore posts の最終スナップショット（タブ復帰時に state が空でも即再描画） */
        window.allPostsCache = [];

        /** true にするとアカウントに「同期ログイン」（電話番号）を出す。準備中は false のまま */
        var PHONE_LOGIN_ACCOUNT_UI_ENABLED = false;

        function persistTealAuthToStorage() {
            var key = 'tealfolder.auth.v1';
            try {
                localStorage.setItem(key, JSON.stringify({
                    userId: state.auth.userId,
                    secret: state.auth.secret,
                    displayName: state.auth.displayName || '',
                    phoneE164: state.auth.phoneE164 || ''
                }));
            } catch (_) {}
        }


        function getLatestProfileDisplayName() {
            var byState = String((state.profile && state.profile.name) || '').trim();
            if (byState) return byState.slice(0, 80);
            var byDom = '';
            try {
                var el = document.getElementById('accountDisplayName');
                byDom = String((el && el.textContent) || '').trim();
            } catch (_) {}
            if (byDom) return byDom.slice(0, 80);
            var byAuth = String((state.auth && state.auth.displayName) || '').trim();
            if (byAuth) return byAuth.slice(0, 80);
            return 'ユーザーネーム';
        }

        function syncMyPostAuthorProfileFields() {
            var latestName = getLatestProfileDisplayName();
            var mine = (state.userDefaultHostedVols || []).filter(function (v) {
                return v && typeof v.id === 'string';
            });
            mine.forEach(function (v) {
                var patch = Object.assign({}, v, {
                    authorId: getMyUserId() || '',
                    authorName: latestName,
                    authorPhotoUrl: String(state.profile.photoDataUrl || '').trim()
                });
                upsertPostDocument(patch);
            });
        }


        function savePersistedProfile() {
            var TF = tf();
            if (!TF) return;
            var url = String(state.profile.photoDataUrl || '').trim();
            if (url.indexOf('data:image/') === 0) {
                teertabUploadDataUrlToStorage('users/' + getMyUserId() + '/profile.jpg', url)
                    .then(function (got) {
                        state.profile.photoDataUrl = got;
                        return flushUserDefaultDoc();
                    })
                    .catch(function () {
                        return flushUserDefaultDoc();
                    });
                return;
            }
            clearTimeout(userDefaultSaveTimer);
            userDefaultSaveTimer = setTimeout(function () {
                flushUserDefaultDoc();
            }, 100);
        }

        function persistProfileThanksCount() {
            savePersistedProfile();
            renderAccount();
            if (liveSyncEnabled() && getMyUserId()) {
                liveSyncPatchProfile({ thanksCount: state.profile.thanksCount }, function () {});
            }
        }

        function syncAuthStorageDisplayNameFromProfile() {
            if (!getMyUserId()) return;
            state.auth.displayName = state.profile.name;
            persistTealAuthToStorage();
        }

        function hasSavedProfileInStorage() {
            return !!(state.userDefaultHydrated && state.profile.name && String(state.profile.name).trim());
        }

        function applyProfileToAccountDom() {
            var nameEl = document.getElementById('accountDisplayName');
            var av = document.getElementById('accountAvatar');
            var bioEl = document.getElementById('accountBioText');
            if (nameEl) nameEl.textContent = state.profile.name || 'ユーザーネーム';
            if (bioEl) bioEl.textContent = state.profile.bio || '';
            if (av) {
                if (state.profile.photoDataUrl) {
                    av.textContent = '';
                    av.style.backgroundImage = 'url(' + JSON.stringify(state.profile.photoDataUrl) + ')';
                    av.classList.add('account-avatar--photo');
                } else {
                    av.classList.remove('account-avatar--photo');
                    av.style.backgroundImage = '';
                    av.textContent = state.profile.avatar || '🙂';
                }
            }
        }

        function populateProfileEditForm() {
            var n = document.getElementById('profileEditName');
            var b = document.getElementById('profileEditBio');
            if (n) n.value = state.profile.name || '';
            if (b) b.value = state.profile.bio || '';
            renderProfilePhotoPreview();
        }

        function renderProfilePhotoPreview() {
            var frame = document.getElementById('profilePhotoPreviewFrame');
            var img = document.getElementById('profilePhotoPreviewImg');
            var clrBtn = document.getElementById('profileEditPhotoClear');
            if (!frame || !img) return;
            var src = String(state.profile.photoDataUrl || '');
            if (src && (src.indexOf('data:image/') === 0 || src.indexOf('https://') === 0 || src.indexOf('http://') === 0)) {
                img.src = src;
                frame.classList.add('has-image');
                if (clrBtn) {
                    clrBtn.hidden = false;
                    clrBtn.style.display = 'inline-flex';
                }
            } else {
                img.removeAttribute('src');
                frame.classList.remove('has-image');
                if (clrBtn) {
                    clrBtn.hidden = true;
                    clrBtn.style.display = 'none';
                }
            }
        }

        function fileToResizedJpegDataURL(file, maxSide, quality, cb) {
            if (!file || !file.type || file.type.indexOf('image/') !== 0) {
                if (cb) cb(new Error('type'));
                return;
            }
            var fr = new FileReader();
            fr.onload = function () {
                var img = new Image();
                img.onload = function () {
                    var w = img.width;
                    var h = img.height;
                    var scale = Math.min(1, maxSide / Math.max(w, h));
                    var cw = Math.max(1, Math.round(w * scale));
                    var ch = Math.max(1, Math.round(h * scale));
                    var c = document.createElement('canvas');
                    c.width = cw;
                    c.height = ch;
                    var ctx = c.getContext('2d');
                    ctx.drawImage(img, 0, 0, cw, ch);
                    try {
                        cb(null, c.toDataURL('image/jpeg', quality));
                    } catch (e) {
                        cb(e);
                    }
                };
                img.onerror = function () { cb(new Error('img')); };
                img.src = fr.result;
            };
            fr.onerror = function () { cb(new Error('read')); };
            fr.readAsDataURL(file);
        }

        function liveSyncPatchProfile(patch, done) {
            if (typeof done !== 'function') done = function () {};
            var uid = getMyUserId();
            if (!uid) {
                done(true);
                return;
            }
            if (firebaseSyncActive() && tf()) {
                var TF = tf();
                TF.getDoc(TF.bundleRef).then(function (snap) {
                    var data = snap.exists ? snap.data() : {};
                    var usersPublic = (data && data.usersPublic) || {};
                    var cur = usersPublic[uid] || {};
                    var next = {
                        displayName:
                            patch.displayName != null
                                ? String(patch.displayName || '').trim().slice(0, 80)
                                : (cur.displayName || ''),
                        bio: patch.bio != null ? String(patch.bio || '').trim().slice(0, 500) : (cur.bio || ''),
                        thanksCount:
                            patch.thanksCount != null
                                ? Math.max(0, Math.floor(Number(patch.thanksCount)))
                                : typeof cur.thanksCount === 'number' && isFinite(cur.thanksCount)
                                  ? cur.thanksCount
                                  : 10,
                        photoDataUrl: cur.photoDataUrl || '',
                        photoStorageUrl: cur.photoStorageUrl || ''
                    };
                    var photoPromise = Promise.resolve(null);
                    if (patch.photoDataUrl != null) {
                        var raw = String(patch.photoDataUrl || '').trim();
                        if (!raw) {
                            next.photoDataUrl = '';
                            next.photoStorageUrl = '';
                        } else if (raw.indexOf('data:image/') === 0) {
                            if (raw.length > 12000000) {
                                done(false);
                                return;
                            }
                            photoPromise = teertabUploadDataUrlToStorage('profilePhotos/' + uid + '.jpg', raw).then(function (url) {
                                next.photoDataUrl = '';
                                next.photoStorageUrl = url;
                            });
                        } else if (raw.indexOf('https://') === 0 || raw.indexOf('http://') === 0) {
                            next.photoStorageUrl = raw;
                            next.photoDataUrl = '';
                        } else {
                            done(false);
                            return;
                        }
                    }
                    photoPromise
                        .then(function () {
                            var upd = {};
                            upd['usersPublic.' + uid] = next;
                            return teertabFirestoreEnsureBundleThenUpdate(upd);
                        })
                        .then(function () { done(true); })
                        .catch(function () { done(false); });
                }).catch(function () { done(false); });
                return;
            }
            var base = getLiveSyncBase();
            if (!base) {
                done(true);
                return;
            }
            fetch(base + '/api/auth/me', {
                method: 'PATCH',
                headers: liveSyncHeaders(),
                body: JSON.stringify(patch || {})
            })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) {
                    var ok = !!(j && (j.ok === true || j.displayName));
                    if (ok) {
                        if (j.displayName) {
                            state.auth.displayName = j.displayName;
                            persistTealAuthToStorage();
                        }
                    }
                    done(ok);
                })
                .catch(function () { done(false); });
        }

        function syncedPhotoForUserId(uid) {
            if (!uid || !state.usersPublic || !state.usersPublic[uid]) return '';
            return publicProfilePhotoUrl(state.usersPublic[uid]);
        }

        function syncMyPhotoToServerIfNeeded() {
            if (!liveSyncEnabled() || !getMyUserId()) return;
            var localPhoto = String(state.profile.photoDataUrl || '');
            var myUid = getMyUserId();
            var pub = state.usersPublic && state.usersPublic[myUid];
            if (firebaseSyncActive() && profilePhotoInSyncWithPublic(localPhoto, pub)) return;
            if (!firebaseSyncActive()) {
                var serverPhoto = syncedPhotoForUserId(myUid);
                if (localPhoto === serverPhoto) return;
            }
            var key = localPhoto || '__empty__';
            if (state._lastPhotoSyncAttemptKey === key) return;
            state._lastPhotoSyncAttemptKey = key;
            liveSyncPatchProfile({ photoDataUrl: localPhoto }, function (ok) {
                if (!ok) return;
                if (!state.usersPublic) state.usersPublic = {};
                var u = getMyUserId();
                if (!state.usersPublic[u]) state.usersPublic[u] = {};
                if (firebaseSyncActive()) {
                    state.usersPublic[u].photoDataUrl = '';
                } else {
                    state.usersPublic[u].photoDataUrl = localPhoto;
                }
            });
        }

        function userIdForDisplayName(displayName) {
            var nm = normalizeDisplayName(displayName || '');
            if (!nm || !state.usersPublic) return '';
            var hit = '';
            Object.keys(state.usersPublic).forEach(function (uid) {
                if (hit) return;
                var pub = state.usersPublic[uid];
                if (!pub) return;
                if (normalizeDisplayName(pub.displayName || '') === nm) {
                    hit = uid;
                }
            });
            return hit;
        }

        function publicProfileForUidOrName(uid, displayName) {
            var byUid = uid && state.usersPublic ? state.usersPublic[uid] : null;
            if (byUid) return byUid;
            var guessedUid = userIdForDisplayName(displayName || '');
            return guessedUid && state.usersPublic ? state.usersPublic[guessedUid] : null;
        }

        function saveProfileFromForm() {
            var n = document.getElementById('profileEditName');
            var b = document.getElementById('profileEditBio');
            var name = n && String(n.value || '').trim();
            if (!name) {
                showToast('表示名を入力してください');
                return;
            }
            state.profile.name = name.slice(0, 80);
            state.profile.bio = b ? String(b.value || '').trim().slice(0, 500) : '';
            applyProfileToAccountDom();
            savePersistedProfile();
            var persistUserDoc = flushUserDefaultDoc();
            syncMyPostAuthorProfileFields();
            syncAuthStorageDisplayNameFromProfile();
            populateProfileEditForm();
            renderAccount();
            renderSearchResults();
            persistUserDoc.then(function (ok) {
                if (ok) {
                    refreshAccountViewFromFirestore();
                    showToast('プロフィールを保存しました');
                } else {
                    showToast('プロフィール保存に失敗しました');
                }
                if (state.viewStack.length && state.viewStack[state.viewStack.length - 1] === 'accountProfileEdit') {
                    goBack();
                }
            });
            if (liveSyncEnabled() && getMyUserId()) {
                // bundle 側の public 情報更新はベストエフォート（users/{uid} の保存成否とは切り離す）
                liveSyncPatchProfile({
                    displayName: state.profile.name,
                    bio: state.profile.bio,
                    thanksCount: state.profile.thanksCount,
                    photoDataUrl: state.profile.photoDataUrl || ''
                }, function () {});
            }
        }


        function getDeviceOwnerKey() {
            var KEY = 'tealfolder.deviceOwner.v1';
            try {
                var x = localStorage.getItem(KEY);
                if (x && String(x).length >= 4) return String(x);
                var nk = 'dev-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
                localStorage.setItem(KEY, nk);
                return nk;
            } catch (_) {
                return 'mem-fallback';
            }
        }

        function normalizeDisplayName(s) {
            return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        }

        function syncAccountNameFromDom() {
            var nameEl = document.getElementById('accountDisplayName') || document.querySelector('#account .account-name');
            var t = nameEl && nameEl.textContent;
            if (t) state.profile.name = String(t).trim();
            return normalizeDisplayName(state.profile.name || '');
        }

        function accountsMatch(a, b) {
            return normalizeDisplayName(a) === normalizeDisplayName(b);
        }

        function newDmSyncId() {
            return 'dm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
        }

        function dmCanonicalKey(peerName) {
            var me = normalizeDisplayName(syncAccountNameFromDom());
            var peer = normalizeDisplayName(peerName);
            if (!me || !peer) return '';
            return me < peer ? (me + '\n' + peer) : (peer + '\n' + me);
        }

        function dmUserThreadKey(peerUserId) {
            var me = getMyUserId();
            if (!me || !peerUserId) return '';
            return me < peerUserId ? (me + '|' + peerUserId) : (peerUserId + '|' + me);
        }

        function displayNameForUserId(uid) {
            if (!uid) return '';
            var u = state.usersPublic[uid];
            if (u && u.displayName) return String(u.displayName).trim();
            var tail = String(uid).replace(/^usr-/, '').slice(0, 8);
            return tail ? ('ユーザー·' + tail) : 'ユーザー';
        }

        function threadMatchesOpenChat(th) {
            if (!th) return false;
            var ouid = state.currentChatPeerUserId || '';
            if (ouid && th.peerUserId && ouid === th.peerUserId) return true;
            return accountsMatch(state.currentChatWith || '', th.with);
        }

        function findChatThread() {
            var ouid = state.currentChatPeerUserId || '';
            if (ouid) {
                var byUid = state.threads.find(function (x) { return x.peerUserId === ouid; });
                if (byUid) return byUid;
            }
            return state.threads.find(function (x) { return x.with === state.currentChatWith; });
        }

        function insertDmSorted(th, msg) {
            var ta = typeof msg.at === 'number' ? msg.at : 0;
            var tid = msg.id ? String(msg.id) : '';
            var i = 0;
            while (i < th.messages.length) {
                var m = th.messages[i];
                var ua = typeof m.at === 'number' ? m.at : 0;
                if (ua > ta) break;
                if (ua === ta && tid && m.id && String(m.id).localeCompare(tid) > 0) break;
                i++;
            }
            th.messages.splice(i, 0, msg);
        }


        /** この端末で作成・保存した自分の募集のみ */
        function isOwnVol(v) {
            if (!v || typeof v.id !== 'string' || v.id.indexOf('vol-user-') !== 0) return false;
            var uid = getMyUserId();
            if (uid && v.hostedByUserId) return v.hostedByUserId === uid;
            var key = getDeviceOwnerKey();
            if (v.hostedByLocal && v.hostedByLocal !== key) return false;
            if (v.hostedByLocal === key) return true;
            return !!(state.myHostedVolIds && state.myHostedVolIds[v.id]);
        }

        /** localStorage に残す募集か（同期バンドル由来の他人分を保存しない／起動時の混入を落とす） */
        function shouldKeepVolInLocalCache(v) {
            if (!v || typeof v.id !== 'string' || v.id.indexOf('vol-user-') !== 0) return false;
            var uid = getMyUserId();
            if (v.hostedByUserId) {
                if (!uid) return false;
                return v.hostedByUserId === uid;
            }
            var key = getDeviceOwnerKey();
            if (v.hostedByLocal && v.hostedByLocal !== key) return false;
            if (v.hostedByLocal === key) return true;
            return false;
        }

        function getApprovedJoinNotificationsForVol(volId) {
            return (state.notifications || []).filter(function (n) {
                return n && n.type === 'join_request' && n.volId === volId
                    && (n.joinStatus != null ? n.joinStatus : 'pending') === 'approved'
                    && notifIsOrganizer(n);
            });
        }

        function hasApprovedJoinWithOrganizer(organizerUserId, organizerName) {
            var myUid = getMyUserId() || '';
            var myName = normalizeDisplayName(syncAccountNameFromDom() || '');
            var orgNameNorm = normalizeDisplayName(organizerName || '');
            return (state.notifications || []).some(function (n) {
                if (!n || n.type !== 'join_request') return false;
                var st = n.joinStatus != null ? n.joinStatus : 'pending';
                if (st !== 'approved') return false;
                var mine = false;
                if (myUid && n.applicantUserId) mine = n.applicantUserId === myUid;
                else mine = myName && accountsMatch(n.applicantName, myName);
                if (!mine) return false;
                if (organizerUserId && n.organizerUserId) return n.organizerUserId === organizerUserId;
                if (orgNameNorm) return accountsMatch(n.organizerName, orgNameNorm);
                return false;
            });
        }

        function canHostSendThanksToUser(targetUserId, targetName) {
            var targetNameNorm = normalizeDisplayName(targetName || '');
            return (state.notifications || []).some(function (n) {
                if (!n || n.type !== 'join_request') return false;
                var st = n.joinStatus != null ? n.joinStatus : 'pending';
                if (st !== 'approved') return false;
                if (!notifIsOrganizer(n)) return false;
                if (targetUserId && n.applicantUserId) return n.applicantUserId === targetUserId;
                if (targetNameNorm) return accountsMatch(n.applicantName, targetNameNorm);
                return false;
            });
        }

        function deriveChatPeerRole(targetUserId, targetName) {
            var targetNameNorm = normalizeDisplayName(targetName || '');
            var role = '';
            (state.notifications || []).forEach(function (n) {
                if (role || !n || n.type !== 'join_request') return;
                var st = n.joinStatus != null ? n.joinStatus : 'pending';
                if (st !== 'approved') return;

                var targetIsApplicant = false;
                if (targetUserId && n.applicantUserId) targetIsApplicant = n.applicantUserId === targetUserId;
                else if (targetNameNorm) targetIsApplicant = accountsMatch(n.applicantName, targetNameNorm);
                var targetIsOrganizer = false;
                if (targetUserId && n.organizerUserId) targetIsOrganizer = n.organizerUserId === targetUserId;
                else if (targetNameNorm) targetIsOrganizer = accountsMatch(n.organizerName, targetNameNorm);

                if (notifIsOrganizer(n) && targetIsApplicant) role = 'applicant';
                else if (notifIsApplicant(n) && targetIsOrganizer) role = 'organizer';
            });
            return role;
        }

        function updateChatThanksButtonUI() {
            var btn = document.getElementById('chatThanksSend');
            if (!btn) return;
            var targetUid = state.currentChatPeerUserId || '';
            var targetName = state.currentChatWith || '';
            var th = findChatThread();
            var knownRole = th && th.peerRole ? th.peerRole : '';
            if (!knownRole) {
                knownRole = deriveChatPeerRole(targetUid, targetName);
                if (th && knownRole) th.peerRole = knownRole;
            }
            if (!knownRole && th && Array.isArray(th.messages)) {
                var hasHostApprovalMsg = th.messages.some(function (m) {
                    if (!m || !m.me) return false;
                    var txt = String(m.text || '');
                    return txt.indexOf('参加申請を承認しました') !== -1;
                });
                if (hasHostApprovalMsg) {
                    knownRole = 'applicant';
                    th.peerRole = knownRole;
                }
            }
            if (knownRole === 'organizer') {
                btn.hidden = true;
                btn.disabled = true;
                return;
            }
            var allowed = knownRole === 'applicant'
                ? true
                : canHostSendThanksToUser(targetUid, targetName);
            btn.hidden = !allowed;
            btn.disabled = !allowed;
        }

        function approvedJoinCountForVol(volId) {
            var seen = {};
            var cnt = 0;
            (state.notifications || []).forEach(function (n) {
                if (!n || n.type !== 'join_request') return;
                if (n.volId !== volId) return;
                if ((n.joinStatus != null ? n.joinStatus : 'pending') !== 'approved') return;
                var key = n.applicantUserId
                    ? ('uid:' + n.applicantUserId)
                    : ('name:' + (normalizeDisplayName(n.applicantName || '') || '参加者'));
                if (seen[key]) return;
                seen[key] = true;
                cnt += 1;
            });
            return cnt;
        }

        function isVolFilled(v) {
            if (!v || !v.id) return false;
            var cap = Number(v.capacity);
            if (!isFinite(cap) || cap < 1) cap = 1;
            return approvedJoinCountForVol(v.id) >= Math.floor(cap);
        }

        function updateDetailVolunteerDayUI() {
            var block = document.getElementById('detailHostThanksBlock');
            var btn = document.getElementById('detailHostThanksBtn');
            if (!block || !btn) return;
            var vid = state.currentDetailId;
            var v = vid && state.vols[vid];
            var own = !!(v && isOwnVol(v));
            if (!own) {
                block.hidden = true;
                return;
            }
            var approved = getApprovedJoinNotificationsForVol(vid);
            if (!approved.length) {
                block.hidden = true;
                return;
            }
            block.hidden = false;
            var pending = approved.filter(function (n) { return !n.thanksGranted; });
            btn.disabled = !pending.length;
            btn.textContent = pending.length ? 'ありがとうを送る（ありがとう付与）' : 'ありがとう送信済み';
        }

        function consumeThanksGrantedForMe() {
            var me = syncAccountNameFromDom();
            if (!me) return;
            if (!state.consumedThanksNotifIds) state.consumedThanksNotifIds = {};
            var bumped = false;
            (state.notifications || []).forEach(function (n) {
                if (!n || n.type !== 'thanks_granted') return;
                if (n.applicantUserId && getMyUserId()) {
                    if (n.applicantUserId !== getMyUserId()) return;
                } else if (!accountsMatch(n.applicantName, me)) return;
                if (state.consumedThanksNotifIds[n.id]) return;
                state.consumedThanksNotifIds[n.id] = true;
                var add = 1;
                if (n.thanksAmount != null) {
                    var ta = Number(n.thanksAmount);
                    add = isFinite(ta) && ta >= 1 ? Math.floor(ta) : 1;
                }
                state.profile.thanksCount = (state.profile.thanksCount || 0) + add;
                bumped = true;
            });
            if (bumped) persistProfileThanksCount();
        }

        function consumeThanksTipForOrganizer() {
            var me = getMyUserId();
            if (!me) return;
            if (!state.consumedThanksTipNotifIds) state.consumedThanksTipNotifIds = {};
            var bumped = false;
            (state.notifications || []).forEach(function (n) {
                if (!n || n.type !== 'thanks_tip') return;
                if (n.organizerUserId !== me) return;
                if (state.consumedThanksTipNotifIds[n.id]) return;
                state.consumedThanksTipNotifIds[n.id] = true;
                var add = 1;
                if (n.thanksAmount != null) {
                    var ta = Number(n.thanksAmount);
                    add = isFinite(ta) && ta >= 1 ? Math.floor(ta) : 1;
                }
                state.profile.thanksCount = (state.profile.thanksCount || 0) + add;
                bumped = true;
            });
            if (bumped) persistProfileThanksCount();
        }

        function closeHostGrantThanksModal() {
            var m = document.getElementById('hostGrantThanksModal');
            if (m) m.classList.remove('open');
            state.hostGrantThanksPendingUniq = 0;
        }

        function updateHostGrantThanksModalSummary() {
            var sumEl = document.getElementById('hostGrantThanksModalSummary');
            var inp = document.getElementById('hostGrantThanksAmount');
            if (!sumEl) return;
            var uniq = state.hostGrantThanksPendingUniq || 0;
            var bal = Math.max(0, Math.floor(state.profile.thanksCount || 0));
            var per = parseInt(inp && inp.value, 10);
            if (!isFinite(per) || per < 1) per = 1;
            var total = per * uniq;
            sumEl.textContent = '参加者' + uniq + '名 × ' + per + ' ＝ 合計' + total + ' / 所持 ' + bal;
        }

        function openHostGrantThanksModal() {
            var vid = state.currentDetailId;
            var v = vid && state.vols[vid];
            if (!v || !isOwnVol(v)) return;
            var pendingList = getApprovedJoinNotificationsForVol(vid).filter(function (n) { return !n.thanksGranted; });
            if (!pendingList.length) return;
            var uniqueNames = {};
            pendingList.forEach(function (n) {
                var app = normalizeDisplayName(n.applicantName || '参加者') || '参加者';
                uniqueNames[app] = true;
            });
            var uniq = Object.keys(uniqueNames).length;
            if (!uniq) return;
            var bal = Math.max(0, Math.floor(state.profile.thanksCount || 0));
            var maxPer = Math.floor(bal / uniq);
            if (maxPer < 1) {
                showToast('ありがとうが足りません（' + uniq + '名に渡すには合計' + uniq + '以上必要です）');
                return;
            }
            var inp = document.getElementById('hostGrantThanksAmount');
            if (inp) {
                inp.min = '1';
                inp.max = String(maxPer);
                inp.value = String(Math.min(1, maxPer));
            }
            state.hostGrantThanksPendingUniq = uniq;
            updateHostGrantThanksModalSummary();
            var m = document.getElementById('hostGrantThanksModal');
            if (m) m.classList.add('open');
        }

        function confirmHostGrantThanksFromModal() {
            var vid = state.currentDetailId;
            var v = vid && state.vols[vid];
            if (!v || !isOwnVol(v)) {
                closeHostGrantThanksModal();
                return;
            }
            var inp = document.getElementById('hostGrantThanksAmount');
            var per = parseInt(inp && inp.value, 10);
            if (!isFinite(per) || per < 1) {
                showToast('1以上の数を指定してください');
                return;
            }
            var pendingList = getApprovedJoinNotificationsForVol(vid).filter(function (n) { return !n.thanksGranted; });
            if (!pendingList.length) {
                closeHostGrantThanksModal();
                return;
            }
            var uniqueNames = {};
            pendingList.forEach(function (n) {
                var app = normalizeDisplayName(n.applicantName || '参加者') || '参加者';
                uniqueNames[app] = true;
            });
            var uniq = Object.keys(uniqueNames).length;
            var total = per * uniq;
            var bal = Math.max(0, Math.floor(state.profile.thanksCount || 0));
            if (bal < total) {
                showToast('ありがとうが足りません（必要 ' + total + ' / 所持 ' + bal + '）');
                return;
            }
            state.profile.thanksCount = bal - total;
            persistProfileThanksCount();

            var me = syncAccountNameFromDom();
            var applicantsDone = {};
            var dmDone = {};
            var tick = Date.now();
            pendingList.forEach(function (n, idx) {
                n.thanksGranted = true;
                liveSyncPatchNotification(n.id, { thanksGranted: true });
                var app = normalizeDisplayName(n.applicantName || '参加者') || '参加者';
                if (!applicantsDone[app]) {
                    applicantsDone[app] = true;
                    var tgN = {
                        id: 'notif-thanks-' + tick + '-' + idx + '-' + Math.random().toString(36).slice(2, 7),
                        type: 'thanks_granted',
                        at: '今',
                        organizerName: me,
                        applicantName: app,
                        organizerUserId: getMyUserId() || undefined,
                        applicantUserId: n.applicantUserId || undefined,
                        volTitle: n.volTitle || v.title || '',
                        volId: vid,
                        thanksAmount: per
                    };
                    liveSyncPostNotification(tgN);
                    state.notifications.unshift(tgN);
                }
                if (!dmDone[app]) {
                    dmDone[app] = true;
                    appendOutgoingDm(app, '当日はありがとうございました。とても助かりました。', n.applicantUserId || '');
                }
            });
            closeHostGrantThanksModal();
            setUnreadFlag();
            renderDmThreads();
            renderNotifications();
            updateDetailVolunteerDayUI();
            showToast('ありがとうを送り、参加者に付与しました。');
        }

        function syncDetailActionBars() {
            var vid = state.currentDetailId;
            var v = vid && state.vols[vid];
            var own = !!(v && isOwnVol(v));
            var part = document.getElementById('detailParticipantActions');
            var ownBar = document.getElementById('detailOwnerActions');
            var joinBtn = document.getElementById('joinBtn');
            if (part) {
                part.hidden = own;
                part.style.display = own ? 'none' : 'flex';
            }
            if (ownBar) {
                ownBar.hidden = !own;
                ownBar.style.display = own ? 'flex' : 'none';
            }
            if (joinBtn) {
                if (!own && v) {
                    var statusLabel = getJoinButtonStatusLabel(vid);
                    if (statusLabel) {
                        joinBtn.textContent = statusLabel;
                        joinBtn.disabled = true;
                        joinBtn.classList.remove('btn-primary');
                        joinBtn.classList.add('btn-secondary', 'join-btn--status');
                        if (statusLabel === '承認済み') {
                            joinBtn.classList.add('join-btn--approved');
                        } else {
                            joinBtn.classList.remove('join-btn--approved');
                        }
                    } else {
                        joinBtn.textContent = '参加する';
                        joinBtn.disabled = false;
                        joinBtn.classList.add('btn-primary');
                        joinBtn.classList.remove('btn-secondary', 'join-btn--status', 'join-btn--approved');
                    }
                } else {
                    joinBtn.textContent = '参加する';
                    joinBtn.disabled = false;
                    joinBtn.classList.add('btn-primary');
                    joinBtn.classList.remove('btn-secondary', 'join-btn--status', 'join-btn--approved');
                }
            }
            updateDetailVolunteerDayUI();
        }

        var liveSyncConnectedOnce = false;

        function getLiveSyncBase() {
            function stashSyncBase(b) {
                try {
                    localStorage.setItem('tealfolder.syncBase', b);
                } catch (_) {}
                return b;
            }
            function asHttpSyncBase(raw) {
                var s = String(raw || '').trim();
                if (!s || s === 'null') return '';
                if (!/^https?:\/\//i.test(s)) return '';
                try {
                    /* /index.html などが付くと .../index.html/api/... になり 404 になるので origin のみ使う */
                    return new URL(s).origin;
                } catch (_) {
                    return '';
                }
            }
            try {
                var q = new URLSearchParams(window.location.search).get('sync');
                if (q === 'auto' || q === '1') {
                    var o = asHttpSyncBase(window.location.origin);
                    if (o) return stashSyncBase(o);
                }
                if (q) {
                    var b = asHttpSyncBase(decodeURIComponent(String(q)));
                    if (b) return stashSyncBase(b);
                }
            } catch (_) {}
            try {
                return asHttpSyncBase(localStorage.getItem('tealfolder.syncBase'));
            } catch (_) {}
            return '';
        }

        function syncJsonFromFetchResponse(r) {
            return r.text().then(function (t) {
                var j = null;
                if (t) {
                    try {
                        j = JSON.parse(t);
                    } catch (_) {}
                }
                return { ok: r.ok, status: r.status, j: j };
            });
        }

        function getMyUserId() {
            return (state.auth && state.auth.userId) ? String(state.auth.userId) : '';
        }

        function liveSyncHeaders() {
            var h = {
                'Content-Type': 'application/json',
                'X-Tealdevice': getDeviceOwnerKey()
            };
            if (state.auth && state.auth.userId && state.auth.secret) {
                h['X-Teal-User-Id'] = state.auth.userId;
                h['X-Teal-Secret'] = state.auth.secret;
            }
            return h;
        }

        function ensureAuthSession(done) {
            if (typeof done !== 'function') done = function () {};
            if (!liveSyncEnabled()) {
                done();
                return;
            }
            if (firebaseSyncActive() && tf() && state.auth && state.auth.userId && !state.auth.secret) {
                done();
                return;
            }
            var key = 'tealfolder.auth.v1';
            try {
                var raw = localStorage.getItem(key);
                if (raw) {
                    var o = JSON.parse(raw);
                    if (o && typeof o.userId === 'string' && typeof o.secret === 'string') {
                        state.auth.userId = o.userId;
                        state.auth.secret = o.secret;
                        state.auth.displayName = o.displayName || '';
                        state.auth.phoneE164 = o.phoneE164 || '';
                        if (state.auth.displayName && !hasSavedProfileInStorage()) {
                            state.profile.name = state.auth.displayName;
                            applyProfileToAccountDom();
                        }
                        done();
                        return;
                    }
                }
            } catch (_) {}
            var dn = syncAccountNameFromDom();
            if (!dn) {
                done();
                return;
            }
            if (firebaseSyncActive() && tf()) {
                var TFreg = tf();
                var userId = randomTealToken('usr-');
                var secret = randomTealToken('sec-');
                state.auth.userId = userId;
                state.auth.secret = secret;
                state.auth.displayName = dn.slice(0, 80);
                state.auth.phoneE164 = '';
                if (state.auth.displayName && !hasSavedProfileInStorage()) {
                    state.profile.name = state.auth.displayName;
                    applyProfileToAccountDom();
                }
                persistTealAuthToStorage();
                var photo = String(state.profile.photoDataUrl || '');
                function commitRegister(pub) {
                    return TFreg.runTransaction(TFreg.db, function (transaction) {
                        return transaction.get(TFreg.bundleRef).then(function (snap) {
                            if (!snap.exists) {
                                var o = {};
                                o[userId] = pub;
                                transaction.set(TFreg.bundleRef, {
                                    vols: {},
                                    notifications: [],
                                    dmThreads: {},
                                    usersPublic: o
                                });
                            } else {
                                var upd = {};
                                upd['usersPublic.' + userId] = pub;
                                transaction.update(TFreg.bundleRef, upd);
                            }
                        });
                    });
                }
                if (photo.indexOf('data:image/') === 0) {
                    teertabUploadDataUrlToStorage('profilePhotos/' + userId + '.jpg', photo)
                        .then(function (url) {
                            return commitRegister({
                                displayName: state.auth.displayName,
                                bio: String(state.profile.bio || '').trim().slice(0, 500),
                                thanksCount: Math.max(0, Math.floor(Number(state.profile.thanksCount) || 10)),
                                photoDataUrl: '',
                                photoStorageUrl: url
                            });
                        })
                        .catch(function () {
                            return commitRegister({
                                displayName: state.auth.displayName,
                                bio: String(state.profile.bio || '').trim().slice(0, 500),
                                thanksCount: Math.max(0, Math.floor(Number(state.profile.thanksCount) || 10)),
                                photoDataUrl: '',
                                photoStorageUrl: ''
                            });
                        })
                        .then(function () { done(); })
                        .catch(function () { done(); });
                } else {
                    commitRegister({
                        displayName: state.auth.displayName,
                        bio: String(state.profile.bio || '').trim().slice(0, 500),
                        thanksCount: Math.max(0, Math.floor(Number(state.profile.thanksCount) || 10)),
                        photoDataUrl: '',
                        photoStorageUrl: ''
                    })
                        .then(function () { done(); })
                        .catch(function () { done(); });
                }
                return;
            }
            var base = getLiveSyncBase();
            if (!base) {
                done();
                return;
            }
            fetch(base + '/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ displayName: dn })
            })
                .then(function (r) { return r.json(); })
                .then(function (j) {
                    if (j && j.userId && j.secret) {
                        state.auth.userId = j.userId;
                        state.auth.secret = j.secret;
                        state.auth.displayName = j.displayName || dn;
                        state.auth.phoneE164 = '';
                        if (state.auth.displayName && !hasSavedProfileInStorage()) {
                            state.profile.name = state.auth.displayName;
                            applyProfileToAccountDom();
                        }
                        persistTealAuthToStorage();
                    }
                    done();
                })
                .catch(function () { done(); });
        }

        function notifIsOrganizer(n) {
            if (!n) return false;
            var uid = getMyUserId();
            if (n.organizerUserId && uid) return n.organizerUserId === uid;
            return accountsMatch(n.organizerName, syncAccountNameFromDom());
        }

        function notifIsApplicant(n) {
            if (!n) return false;
            var uid = getMyUserId();
            if (n.applicantUserId && uid) return n.applicantUserId === uid;
            return accountsMatch(n.applicantName, syncAccountNameFromDom());
        }

        /** 参加ボタンの表示（空なら「参加する」・押下可） */
        function getJoinButtonStatusLabel(volId) {
            if (!volId) return '';
            var n = (state.notifications || []).find(function (x) {
                return x && x.type === 'join_request' && x.volId === volId && notifIsApplicant(x);
            });
            if (!n) return '';
            var st = n.joinStatus != null ? n.joinStatus : 'pending';
            if (st === 'rejected') return '';
            if (st === 'approved') return '承認済み';
            return '申請済み';
        }

        function liveSyncEnabled() {
            return !!getLiveSyncBase() || firebaseSyncActive();
        }

        function liveSyncRebuildMyHostedIds() {
            state.myHostedVolIds = {};
            var uid = getMyUserId();
            var dev = getDeviceOwnerKey();
            Object.keys(state.vols || {}).forEach(function (k) {
                if (k.indexOf('vol-user-') !== 0) return;
                var v = state.vols[k];
                if (v && uid && v.hostedByUserId === uid) state.myHostedVolIds[k] = true;
                else if (v && v.hostedByLocal === dev) state.myHostedVolIds[k] = true;
            });
        }

        function useFirestoreJoinFlow() {
            var TF = tf();
            return !!(
                TF &&
                getMyUserId() &&
                !state.auth.secret &&
                TF.notificationsColRef &&
                TF.applicationsColRef &&
                TF.chatsColRef &&
                TF.writeBatch
            );
        }

        function fsTimestampToMs(ts) {
            if (!ts) return 0;
            if (typeof ts.toMillis === 'function') return ts.toMillis();
            if (typeof ts.seconds === 'number') return ts.seconds * 1000;
            return 0;
        }

        function formatRelativeNotifShort(ms) {
            if (!ms) return '今';
            var diff = Date.now() - ms;
            if (diff < 60000) return '今';
            if (diff < 3600000) return Math.floor(diff / 60000) + '分前';
            if (diff < 86400000) return Math.floor(diff / 3600000) + '時間前';
            return Math.floor(diff / 86400000) + '日前';
        }

        function notificationSortKey(n) {
            if (!n) return 0;
            if (typeof n._sortAt === 'number') return n._sortAt;
            return 0;
        }

        function fsNotificationDocToUi(docSnap) {
            var data = docSnap.data() || {};
            var ms = fsTimestampToMs(data.createdAt) || Date.now();
            var joinStatusRaw = data.joinStatus != null ? String(data.joinStatus) : 'pending';
            var legacyListRead = joinStatusRaw === 'read';
            var effectiveJoin = joinStatusRaw;
            if (legacyListRead && typeof data.viewedJoinState === 'string') {
                effectiveJoin = String(data.viewedJoinState);
            }
            if (effectiveJoin !== 'pending' && effectiveJoin !== 'approved' && effectiveJoin !== 'rejected') {
                effectiveJoin = 'pending';
            }
            var viewedExplicitTrue = data.viewedJoinState === true;
            var joinNotifUnread = !viewedExplicitTrue && !legacyListRead;
            var viewedJoinStateUnset = data.viewedJoinState === undefined || data.viewedJoinState === null;
            return {
                id: docSnap.id,
                applicationId: String(data.applicationId || '').trim(),
                type: data.type || 'join_request',
                joinStatus: effectiveJoin,
                _rawJoinStatus: joinStatusRaw,
                _joinNotifUnread: joinNotifUnread,
                _viewedJoinStateUnset: viewedJoinStateUnset,
                recipientId: String(data.recipientId || '').trim(),
                at: formatRelativeNotifShort(ms),
                _sortAt: ms,
                organizerName: String(data.organizerName || '').trim(),
                applicantName: String(data.applicantName || '').trim(),
                organizerUserId: String(data.organizerUserId || data.ownerId || '').trim(),
                applicantUserId: String(data.applicantUserId || '').trim(),
                volTitle: String(data.volTitle || '').trim(),
                volId: String(data.volId || data.postId || '').trim(),
                _firestoreNotification: true
            };
        }

        function mergeNotificationsIntoState() {
            var bundle = Array.isArray(state._bundleNotificationsRaw) ? state._bundleNotificationsRaw.slice() : [];
            if (useFirestoreJoinFlow()) {
                bundle = bundle.filter(function (n) {
                    return !n || n.type !== 'join_request';
                });
            }
            var fsList = Array.isArray(state._fsNotificationRows) ? state._fsNotificationRows.slice() : [];
            var merged = bundle.concat(fsList);
            var map = {};
            merged.forEach(function (n) {
                if (n && n.id) map[n.id] = n;
            });
            state.notifications = Object.keys(map)
                .map(function (k) {
                    return map[k];
                })
                .sort(function (a, b) {
                    return notificationSortKey(b) - notificationSortKey(a);
                });
            renderNotifications();
            updateNotifBadge();
            syncDetailActionBars();
            updateHomeJoinRequestBanner();
        }

        function countPendingJoinRequestsForOrganizer() {
            var uid = getMyUserId();
            if (!uid) return 0;
            return (state.notifications || []).filter(function (n) {
                if (!n || n.type !== 'join_request') return false;
                if (isNotificationDismissedFromList(n.id)) return false;
                var st = n.joinStatus != null ? n.joinStatus : 'pending';
                if (st !== 'pending') return false;
                if (n.organizerUserId && uid) return n.organizerUserId === uid;
                return notifIsOrganizer(n);
            }).length;
        }

        function updateHomeJoinRequestBanner() {
            var el = document.getElementById('homeJoinRequestBanner');
            if (!el) return;
            if (!useFirestoreJoinFlow()) {
                el.hidden = true;
                el.textContent = '';
                return;
            }
            var fromApps = state._fsPendingOwnerApplicationCount || 0;
            var fromNotifs = countPendingJoinRequestsForOrganizer();
            var n = Math.max(fromApps, fromNotifs);
            if (n <= 0) {
                el.hidden = true;
                el.textContent = '';
                return;
            }
            el.hidden = false;
            el.textContent = '申請が来ています（参加申請 ' + n + ' 件）。通知タブから承認できます。';
        }



        function liveSyncApplyBundle(data) {
            if (!data) return;
            if (data.usersPublic && typeof data.usersPublic === 'object') {
                state.usersPublic = Object.assign({}, data.usersPublic);
                var myUid = getMyUserId();
                var syncedPhoto = syncedPhotoForUserId(myUid);
                if (myUid && syncedPhoto && syncedPhoto !== state.profile.photoDataUrl) {
                    state.profile.photoDataUrl = syncedPhoto;
                    savePersistedProfile();
                    applyProfileToAccountDom();
                    renderProfilePhotoPreview();
                    if (typeof refreshOwnHomeCardIcons === 'function') refreshOwnHomeCardIcons();
                }
                if (typeof refreshAllHomeCardIcons === 'function') refreshAllHomeCardIcons();
                if (document.getElementById('appShell') && document.getElementById('appShell').dataset.tab === 'organizer') {
                    renderOrganizerProfile();
                }
                syncMyPhotoToServerIfNeeded();
            }
            var sv = data.vols || {};
            Object.keys(sv).forEach(function (k) {
                if (k.indexOf('vol-user-') === 0 && sv[k]) state.vols[k] = sv[k];
            });
            state._bundleNotificationsRaw = (data.notifications || []).map(function (x) {
                return Object.assign({}, x);
            });
            mergeNotificationsIntoState();
            var dmTouched = liveSyncMergeDmThreads(data.dmThreads || {});
            liveSyncRebuildMyHostedIds();
            if (typeof window.__tfSyncSaveUserVolsFromState === 'function') {
                window.__tfSyncSaveUserVolsFromState();
            }
            renderSearchResults();
            renderAccount();
            liveSyncReconcileHomeCards();
            if (dmTouched) {
                renderDmThreads();
                var chatEl = document.getElementById('chat');
                if (chatEl && chatEl.classList.contains('active')) renderChat();
                setUnreadFlag();
            }
            updateChatThanksButtonUI();
        }

        function liveSyncPostVol(v) {
            if (firebaseSyncActive() && tf() && v && v.id) {
                var copy = Object.assign({}, v);
                var w = {};
                if (copy.image && copy.image.indexOf('data:image/') === 0) {
                    teertabUploadDataUrlToStorage('volImages/' + copy.id + '.jpg', copy.image)
                        .then(function (url) {
                            copy.image = url;
                            w['vols.' + copy.id] = copy;
                            return teertabFirestoreEnsureBundleThenUpdate(w);
                        })
                        .catch(function (e) {
                            console.warn('Teertab vol image upload', e);
                            copy.image = '';
                            w['vols.' + copy.id] = copy;
                            return teertabFirestoreEnsureBundleThenUpdate(w);
                        });
                } else {
                    w['vols.' + copy.id] = copy;
                    teertabFirestoreEnsureBundleThenUpdate(w).catch(function () {});
                }
                return;
            }
            var base = getLiveSyncBase();
            if (!base || !v) return;
            fetch(base + '/api/vols', { method: 'POST', headers: liveSyncHeaders(), body: JSON.stringify(v) }).catch(function () {});
        }

        function liveSyncDeleteVolRemote(id) {
            var TFd = tf();
            if (firebaseSyncActive() && TFd && id) {
                var w = {};
                w['vols.' + id] = TFd.deleteField();
                TFd.updateDoc(TFd.bundleRef, w).catch(function () {});
                return;
            }
            var base = getLiveSyncBase();
            if (!base || !id) return;
            fetch(base + '/api/vols/' + encodeURIComponent(id), { method: 'DELETE', headers: liveSyncHeaders() }).catch(function () {});
        }

        function liveSyncPostNotification(n) {
            var TFn = tf();
            if (firebaseSyncActive() && TFn && n) {
                TFn.runTransaction(TFn.db, function (transaction) {
                    return transaction.get(TFn.bundleRef).then(function (snap) {
                        var arr;
                        if (!snap.exists) {
                            arr = [n];
                            transaction.set(TFn.bundleRef, {
                                vols: {},
                                notifications: arr,
                                dmThreads: {},
                                usersPublic: {}
                            });
                        } else {
                            arr = Array.isArray(snap.data().notifications) ? snap.data().notifications.slice() : [];
                            arr.unshift(n);
                            if (arr.length > 200) arr = arr.slice(0, 200);
                            transaction.update(TFn.bundleRef, { notifications: arr });
                        }
                    });
                }).catch(function () {});
                return;
            }
            var base = getLiveSyncBase();
            if (!base || !n) return;
            fetch(base + '/api/notifications', { method: 'POST', headers: liveSyncHeaders(), body: JSON.stringify(n) }).catch(function () {});
        }

        function liveSyncPatchNotification(id, patch) {
            var TFp = tf();
            if (firebaseSyncActive() && TFp && id) {
                TFp.getDoc(TFp.bundleRef).then(function (pre) {
                    if (!pre.exists) return;
                    return TFp.runTransaction(TFp.db, function (transaction) {
                        return transaction.get(TFp.bundleRef).then(function (snap) {
                            if (!snap.exists) return;
                            var arr = Array.isArray(snap.data().notifications) ? snap.data().notifications.slice() : [];
                            for (var i = 0; i < arr.length; i++) {
                                if (arr[i] && arr[i].id === id) {
                                    arr[i] = Object.assign({}, arr[i], patch || {});
                                    break;
                                }
                            }
                            transaction.update(TFp.bundleRef, { notifications: arr });
                        });
                    });
                }).catch(function () {});
                return;
            }
            var base = getLiveSyncBase();
            if (!base || !id) return;
            fetch(base + '/api/notifications/' + encodeURIComponent(id), {
                method: 'PATCH',
                headers: liveSyncHeaders(),
                body: JSON.stringify(patch || {})
            }).catch(function () {});
        }

        function liveSyncPruneNotificationsForVol(volId) {
            var TFpr = tf();
            if (firebaseSyncActive() && TFpr && volId) {
                TFpr.getDoc(TFpr.bundleRef).then(function (pre) {
                    if (!pre.exists) return;
                    return TFpr.runTransaction(TFpr.db, function (transaction) {
                        return transaction.get(TFpr.bundleRef).then(function (snap) {
                            if (!snap.exists) return;
                            var arr = Array.isArray(snap.data().notifications) ? snap.data().notifications : [];
                            var next = arr.filter(function (n) { return !n || n.volId !== volId; });
                            transaction.update(TFpr.bundleRef, { notifications: next });
                        });
                    });
                }).catch(function () {});
                return;
            }
            var base = getLiveSyncBase();
            if (!base || !volId) return;
            fetch(base + '/api/notifications/prune-vol', {
                method: 'POST',
                headers: liveSyncHeaders(),
                body: JSON.stringify({ volId: volId })
            }).catch(function () {});
        }

        function liveSyncPostDmAppend(threadKey, message) {
            var TFdm = tf();
            if (firebaseSyncActive() && TFdm && threadKey && message) {
                var tk = String(threadKey);
                TFdm.runTransaction(TFdm.db, function (transaction) {
                    return transaction.get(TFdm.bundleRef).then(function (snap) {
                        var dm;
                        var data = snap.exists ? snap.data() : null;
                        if (!snap.exists) {
                            dm = {};
                        } else {
                            dm =
                                data.dmThreads && typeof data.dmThreads === 'object'
                                    ? JSON.parse(JSON.stringify(data.dmThreads))
                                    : {};
                        }
                        var bucket = dm[tk] && typeof dm[tk] === 'object' ? dm[tk] : { messages: [] };
                        var arr = Array.isArray(bucket.messages) ? bucket.messages.slice() : [];
                        var mid = message && message.id ? String(message.id) : '';
                        if (mid && arr.some(function (x) { return x && x.id === mid; })) {
                            if (snap.exists) {
                                transaction.update(TFdm.bundleRef, {
                                    dmThreads: data.dmThreads || {}
                                });
                            }
                            return;
                        }
                        arr.push({
                            id: mid || randomTealToken('dm-'),
                            device: String((message && message.device) || ''),
                            name: String((message && message.name) || ''),
                            fromUserId: String((message && message.fromUserId) || ''),
                            text: String((message && message.text) || '').slice(0, 8000),
                            at: message && typeof message.at === 'number' ? message.at : Date.now()
                        });
                        if (arr.length > 500) arr.splice(0, arr.length - 500);
                        dm[tk] = { messages: arr };
                        if (!snap.exists) {
                            transaction.set(TFdm.bundleRef, {
                                vols: {},
                                notifications: [],
                                dmThreads: dm,
                                usersPublic: {}
                            });
                        } else {
                            transaction.update(TFdm.bundleRef, { dmThreads: dm });
                        }
                    });
                }).catch(function () {});
                return;
            }
            var base = getLiveSyncBase();
            if (!base || !threadKey || !message) return;
            fetch(base + '/api/dm/append', {
                method: 'POST',
                headers: liveSyncHeaders(),
                body: JSON.stringify({ threadKey: threadKey, message: message })
            }).catch(function () {});
        }

        function appendOutgoingDm(peerName, text, peerUserId) {
            peerUserId = peerUserId || '';
            var th = ensureThread(peerName, peerUserId);
            if (th.firestoreChatId && useFirestoreJoinFlow()) {
                th.lastAt = '今';
                th.unread = false;
                firestoreAppendChatMessage(th.firestoreChatId, text, peerUserId).catch(function () {
                    showToast('送信に失敗しました');
                });
                return;
            }
            var id = newDmSyncId();
            var dev = getDeviceOwnerKey();
            var nm = syncAccountNameFromDom();
            var at = Date.now();
            var myUid = getMyUserId() || '';
            insertDmSorted(th, { id: id, me: true, text: text, device: dev, name: nm, fromUserId: myUid, at: at });
            th.lastAt = '今';
            th.unread = false;
            if (liveSyncEnabled()) {
                var tk = '';
                if (peerUserId && myUid) tk = dmUserThreadKey(peerUserId);
                if (!tk) tk = dmCanonicalKey(peerName);
                if (tk) {
                    liveSyncPostDmAppend(tk, { id: id, device: dev, name: nm, text: text, at: at, fromUserId: myUid });
                }
            }
        }

        function liveSyncMergeDmThreads(dmThreads) {
            if (!dmThreads || typeof dmThreads !== 'object') return false;
            var meName = normalizeDisplayName(syncAccountNameFromDom());
            var myDev = getDeviceOwnerKey();
            var myUid = getMyUserId() || '';
            var touched = false;
            Object.keys(dmThreads).forEach(function (threadKey) {
                var tk = String(threadKey);
                var peer = '';
                var peerUserId = '';
                if (tk.indexOf('|') !== -1) {
                    var uparts = tk.split('|');
                    if (uparts.length !== 2) return;
                    var u0 = String(uparts[0] || '').trim();
                    var u1 = String(uparts[1] || '').trim();
                    if (!myUid || (u0 !== myUid && u1 !== myUid)) return;
                    peerUserId = u0 === myUid ? u1 : u0;
                    peer = displayNameForUserId(peerUserId);
                } else {
                    var parts = tk.split('\n');
                    if (parts.length !== 2 || !meName) return;
                    var p0 = normalizeDisplayName(parts[0]);
                    var p1 = normalizeDisplayName(parts[1]);
                    if (p0 === meName) peer = parts[1];
                    else if (p1 === meName) peer = parts[0];
                    else return;
                }
                var bucket = dmThreads[threadKey];
                var incoming = bucket && bucket.messages;
                if (!Array.isArray(incoming) || !incoming.length) return;
                var th = ensureThread(peer, peerUserId);
                if (th.firestoreChatId) return;
                var have = {};
                th.messages.forEach(function (m) {
                    if (m && m.id) have[m.id] = true;
                });
                incoming.forEach(function (row) {
                    if (!row || typeof row.id !== 'string' || have[row.id]) return;
                    have[row.id] = true;
                    var fromDev = String(row.device || '');
                    var fromUid = String(row.fromUserId || '');
                    var isMe = (fromUid && myUid) ? (fromUid === myUid) : (fromDev === myDev);
                    var msg = {
                        id: row.id,
                        me: isMe,
                        text: String(row.text || ''),
                        device: fromDev,
                        name: String(row.name || ''),
                        fromUserId: fromUid,
                        at: typeof row.at === 'number' ? row.at : Date.now()
                    };
                    insertDmSorted(th, msg);
                    if (!isMe && !threadMatchesOpenChat(th)) {
                        th.unread = true;
                    }
                    touched = true;
                });
                if (th.messages.length) th.lastAt = '今';
            });
            return touched;
        }

        function syncThreadKeyForThread(t) {
            if (!t) return '';
            if (t.peerUserId && getMyUserId()) {
                var uidKey = dmUserThreadKey(t.peerUserId);
                if (uidKey) return uidKey;
            }
            return dmCanonicalKey(t.with);
        }

        function liveSyncClearDmRemote(threadKey, all) {
            if (!liveSyncEnabled()) return;
            var TFclr = tf();
            if (firebaseSyncActive() && TFclr) {
                if (all) {
                    TFclr.updateDoc(TFclr.bundleRef, { dmThreads: {} }).catch(function () {});
                } else if (String(threadKey || '').trim()) {
                    var tk = String(threadKey);
                    TFclr.runTransaction(TFclr.db, function (transaction) {
                        return transaction.get(TFclr.bundleRef).then(function (snap) {
                            if (!snap.exists) return;
                            var data = snap.data();
                            var dm =
                                data.dmThreads && typeof data.dmThreads === 'object'
                                    ? JSON.parse(JSON.stringify(data.dmThreads))
                                    : {};
                            delete dm[tk];
                            transaction.update(TFclr.bundleRef, { dmThreads: dm });
                        });
                    }).catch(function () {});
                }
                return;
            }
            var base = getLiveSyncBase();
            var body = all ? '{}' : JSON.stringify({ threadKey: String(threadKey || '') });
            if (!all && !String(threadKey || '').trim()) return;
            fetch(base + '/api/dev/clear-dm-threads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: body
            }).catch(function () {});
        }

        function removeDmThreadAndSync(th) {
            if (!th) return;
            if (!window.confirm('このスレッドを削除しますか？')) return;
            var wasOpen = threadMatchesOpenChat(th);
            var tk = syncThreadKeyForThread(th);
            state.threads = (state.threads || []).filter(function (x) { return x !== th; });
            setUnreadFlag();
            renderDmThreads();
            if (wasOpen) {
                goBack();
                renderChat();
            }
            liveSyncClearDmRemote(tk, false);
            showToast('スレッドを削除しました');
        }

        function clearAllDmThreadsAndSync() {
            if (!window.confirm('すべてのDMを削除しますか？\n（同期オン時はサーバー上のDMも空になります）')) return;
            state.threads = [];
            state.currentChatWith = '';
            state.currentChatPeerUserId = '';
            while (state.viewStack.length > 1 && state.viewStack[state.viewStack.length - 1] === 'chat') {
                state.viewStack.pop();
            }
            if (state.viewStack.length) {
                activateView(state.viewStack[state.viewStack.length - 1]);
            }
            setUnreadFlag();
            renderDmThreads();
            renderChat();
            liveSyncClearDmRemote('', true);
            showToast('DMを削除しました');
        }

        function liveSyncPullOnce() {
            var TFpl = tf();
            if (firebaseSyncActive() && TFpl) {
                TFpl.getDoc(TFpl.bundleRef).then(function (snap) {
                    if (!snap.exists) return;
                    var data = snap.data();
                    if (!data) return;
                    liveSyncApplyBundle(data);
                    if (!liveSyncConnectedOnce) {
                        liveSyncConnectedOnce = true;
                        showToast('Firebase（Firestore）とつながりました');
                    }
                }).catch(function () {});
                return;
            }
            if (!getLiveSyncBase()) return;
            var base = getLiveSyncBase();
            fetch(base + '/api/bundle')
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    if (!data) return;
                    liveSyncApplyBundle(data);
                    if (!liveSyncConnectedOnce) {
                        liveSyncConnectedOnce = true;
                        showToast('同期サーバーとつながりました');
                    }
                })
                .catch(function () {});
        }

        function showToast(text) {
            var t = document.getElementById('toast');
            if (!t) return;
            t.textContent = text || '完了しました';
            t.classList.add('show');
            window.clearTimeout(showToast._timer);
            showToast._timer = window.setTimeout(function () {
                t.classList.remove('show');
            }, 1800);
        }


        function setHeaderTitleForTab(tab) {
            var t = document.getElementById('headerTitle');
            if (!t) return;
            if (tab === 'home') t.textContent = 'ホーム';
            else if (tab === 'account') t.textContent = 'アカウント';
            else if (tab === 'search') t.textContent = '検索';
            else if (tab === 'detail') t.textContent = '詳細';
            else if (tab === 'dm') t.textContent = 'DM';
            else if (tab === 'notifications') t.textContent = '通知';
            else if (tab === 'chat') t.textContent = state.currentChatWith || 'DM';
            else if (tab === 'organizer') t.textContent = 'プロフィール';
            else if (tab === 'accountProfileEdit') t.textContent = 'プロフィール編集';
            else if (tab === 'request') t.textContent = '募集する';
            else t.textContent = '検索';
        }


        function restoreHomeFromPostsCacheIfNeeded() {
            var cache = window.allPostsCache;
            if (!Array.isArray(cache) || !cache.length) return;
            applyPostsToState(cache.map(function (item) {
                return Object.assign({}, item);
            }));
        }

        function activateView(id) {
            /** 先に表示セクションを切り替える（ホームの復元処理で例外が出てもタブ遷移が死なないようにする） */
            document.querySelectorAll('.content-section').forEach(function (s) { s.classList.remove('active'); });
            var el = document.getElementById(id);
            if (el) el.classList.add('active');
            var shell = document.getElementById('appShell');
            if (shell) {
                shell.dataset.tab = id;
                shell.classList.toggle('has-back', state.viewStack.length > 1);
            }
            setHeaderTitleForTab(id);
            if (id === 'home') {
                try {
                    restoreHomeFromPostsCacheIfNeeded();
                    renderHomeCardsFromState();
                    updateHomeJoinRequestBanner();
                    if (typeof liveSyncPullOnce === 'function') {
                        liveSyncPullOnce();
                    }
                } catch (err) {
                    console.warn('Teertab activateView home', err);
                }
            }
            if (id === 'search') {
                var sq = document.getElementById('search-q');
                if (sq && typeof state.filters.q === 'string') sq.value = state.filters.q;
                renderSearchResults();
            }
            if (id === 'notifications') {
                renderNotifications();
                markFirestoreJoinNotificationsSeenWhenOpeningList().finally(function () {
                    updateNotifBadge();
                    syncAccountTabNotifDot();
                    renderNotifications();
                });
            }
            if (id === 'detail') {
                syncDetailActionBars();
            }
            if (id === 'request') {
                window.setTimeout(function () {
                    var titleInput = document.getElementById('req-title');
                    if (titleInput) titleInput.focus({ preventScroll: true });
                }, 50);
            }
            if (id === 'chat') {
                updateChatThanksButtonUI();
            }
            if (id === 'dm' || id === 'chat') {
                if (markAllDmAsRead()) {
                    renderDmThreads();
                }
                if (id === 'chat' && useFirestoreJoinFlow()) {
                    var thClear = findChatThread();
                    if (thClear && thClear.firestoreChatId) {
                        var cid = thClear.firestoreChatId;
                        Promise.all([
                            clearFirestoreChatUnseenForMe(cid),
                            markFirestoreJoinNotificationsSeenForChatRoom(cid)
                        ]).finally(function () {
                            setUnreadFlag();
                            renderDmThreads();
                            updateNotifBadge();
                            syncAccountTabNotifDot();
                        });
                    } else {
                        setUnreadFlag();
                    }
                } else {
                    setUnreadFlag();
                }
            }
            // Keep bottom nav highlight consistent on back navigation.
            document.querySelectorAll('.bottom-nav .nav-item').forEach(function (n) { n.classList.remove('active'); });
            if (id === 'home') {
                var homeNav = document.querySelector('.bottom-nav .nav-item[data-section="home"]');
                if (homeNav) homeNav.classList.add('active');
            }
            if (id === 'account') {
                var accountNav = document.querySelector('.bottom-nav .nav-item[data-section="account"]');
                if (accountNav) accountNav.classList.add('active');
                refreshAccountViewFromFirestore();
            }
            if (id === 'accountProfileEdit') {
                populateProfileEditForm();
                var accountNav2 = document.querySelector('.bottom-nav .nav-item[data-section="account"]');
                if (accountNav2) accountNav2.classList.add('active');
                window.setTimeout(function () {
                    var el = document.getElementById('profileEditName');
                    if (el) el.focus({ preventScroll: true });
                }, 80);
            }
            syncAccountTabNotifDot();
        }

        function navigateTo(id) {
            state.viewStack.push(id);
            activateView(id);
        }

        function goBack() {
            if (state.viewStack.length <= 1) return;
            state.viewStack.pop();
            activateView(state.viewStack[state.viewStack.length - 1]);
        }

        function showSection(id, navEl) {
            state.viewStack = [id];
            activateView(id);
            document.querySelectorAll('.bottom-nav .nav-item').forEach(function (n) { n.classList.remove('active'); });
            var tabBtn =
                (navEl && navEl.getAttribute && navEl.getAttribute('data-section') === id && navEl) ||
                document.querySelector('.bottom-nav .nav-item[data-section="' + id + '"]');
            if (tabBtn) tabBtn.classList.add('active');
            syncAccountTabNotifDot();
        }

        function markAllDmAsRead() {
            var changed = false;
            (state.threads || []).forEach(function (t) {
                /** Firestore DM の未読は chats.unseenCountByUser で管理（一覧の ● もスナップショットに合わせる） */
                if (t && t.unread && !t.firestoreChatId) {
                    t.unread = false;
                    changed = true;
                }
            });
            return changed;
        }

        function setUnreadFlag() {
            var hasThreadUnread = state.threads.some(function (t) {
                return t && t.unread;
            });
            var hasFsDm = !!state._fsHasDmUnread;
            var shell = document.getElementById('appShell');
            if (shell) shell.classList.toggle('has-unread', hasThreadUnread || hasFsDm);
        }

        function hasVisibleNotificationsForMe() {
            var me = syncAccountNameFromDom();
            /** 参加申請の未読は notifications.viewedJoinState のみ（DM は chats.unseenCountByUser → setUnreadFlag） */
            if (useFirestoreJoinFlow()) {
                var qn = Number(state._fsJoinNotifUnreadFromQuery) || 0;
                if (qn > 0) return true;
                var legacyUnreadNoField = (state.notifications || []).some(function (n) {
                    return (
                        n &&
                        n._firestoreNotification &&
                        n.type === 'join_request' &&
                        n._joinNotifUnread &&
                        n._viewedJoinStateUnset
                    );
                });
                if (legacyUnreadNoField) return true;
            }
            return (state.notifications || []).some(function (n) {
                if (!n) return false;
                if (isNotificationDismissedFromList(n.id)) return false;
                if (n._firestoreNotification && n.type === 'join_request') return false;
                if (n.type === 'thanks_granted') {
                    if (n.applicantUserId && getMyUserId()) return n.applicantUserId === getMyUserId();
                    return accountsMatch(n.applicantName, me);
                }
                if (n.type === 'thanks_tip') {
                    return !!(getMyUserId() && n.organizerUserId === getMyUserId());
                }
                if (n.type === 'join_request') {
                    return notifIsOrganizer(n) || notifIsApplicant(n);
                }
                return true;
            });
        }

        function syncAccountTabNotifDot() {
            var acc = document.querySelector('.bottom-nav .nav-item[data-section="account"]');
            var home = document.querySelector('.bottom-nav .nav-item[data-section="home"]');
            if (!acc || !home) return;
            var onHome = home.classList.contains('active');
            acc.classList.toggle('nav-item--pending-notif', onHome && hasVisibleNotificationsForMe());
        }

        function updateNotifBadge() {
            var shell = document.getElementById('appShell');
            if (!shell) return;
            shell.classList.toggle('has-notif-unread', hasVisibleNotificationsForMe());
            syncAccountTabNotifDot();
        }

        function getDismissedNotifIdMap() {
            return state.dismissedNotifsRemote && typeof state.dismissedNotifsRemote === 'object'
                ? state.dismissedNotifsRemote
                : {};
        }

        function persistDismissedNotifIdMap(map) {
            state.dismissedNotifsRemote = map || {};
            if (tf()) {
                flushUserDefaultDoc();
            }
        }

        function isNotificationDismissedFromList(id) {
            return !!(id && getDismissedNotifIdMap()[id]);
        }

        function dismissNotificationFromList(id) {
            if (!id) return;
            var m = getDismissedNotifIdMap();
            m[id] = true;
            persistDismissedNotifIdMap(m);
        }

        function deleteNotificationById(id) {
            dismissNotificationFromList(id);
            renderNotifications();
            updateNotifBadge();
            syncDetailActionBars();
        }

        function createNotifDismissButton(n) {
            var dismiss = document.createElement('button');
            dismiss.type = 'button';
            dismiss.className = 'notif-dismiss';
            dismiss.setAttribute('aria-label', 'この通知を一覧から消す');
            dismiss.textContent = '×';
            dismiss.addEventListener('click', function (e) {
                e.stopPropagation();
                if (n && n.id) deleteNotificationById(n.id);
            });
            return dismiss;
        }

        function clearAllNotificationsFromList() {
            if (!window.confirm('通知をすべて一覧から消しますか？\n参加・承認の状態は変わりません（この端末だけ非表示になります）。')) return;
            var me = syncAccountNameFromDom();
            var rawList = state.notifications || [];
            var visible = rawList.filter(function (n) {
                if (!n || isNotificationDismissedFromList(n.id)) return false;
                if (n.type === 'thanks_granted') {
                    if (n.applicantUserId && getMyUserId()) return n.applicantUserId === getMyUserId();
                    return accountsMatch(n.applicantName, me);
                }
                if (n.type === 'thanks_tip') {
                    return !!(getMyUserId() && n.organizerUserId === getMyUserId());
                }
                if (n.type !== 'join_request') return true;
                return notifIsOrganizer(n) || notifIsApplicant(n);
            });
            var m = getDismissedNotifIdMap();
            visible.forEach(function (n) {
                if (n && n.id) m[n.id] = true;
            });
            persistDismissedNotifIdMap(m);
            renderNotifications();
            updateNotifBadge();
            syncDetailActionBars();
            showToast('通知を消しました');
        }

        function renderNotifications() {
            var wrap = document.getElementById('notificationList');
            if (!wrap) return;
            wrap.innerHTML = '';
            consumeThanksGrantedForMe();
            consumeThanksTipForOrganizer();
            var me = syncAccountNameFromDom();
            var rawList = state.notifications || [];
            var list = rawList.filter(function (n) {
                if (!n) return false;
                if (isNotificationDismissedFromList(n.id)) return false;
                if (n.type === 'thanks_granted') {
                    if (n.applicantUserId && getMyUserId()) return n.applicantUserId === getMyUserId();
                    return accountsMatch(n.applicantName, me);
                }
                if (n.type === 'thanks_tip') {
                    return !!(getMyUserId() && n.organizerUserId === getMyUserId());
                }
                if (n.type !== 'join_request') return true;
                return notifIsOrganizer(n) || notifIsApplicant(n);
            });
            var notifTools = document.getElementById('notifListTools');
            if (notifTools) notifTools.hidden = list.length === 0;
            if (!list.length) {
                updateNotifBadge();
                return;
            }
            list.forEach(function (n) {
                if (n.type === 'thanks_granted') {
                    var tgRow = document.createElement('div');
                    tgRow.className = 'notif-row';
                    var tgTop = document.createElement('div');
                    tgTop.className = 'notif-row-top';
                    var tgTy = document.createElement('span');
                    tgTy.className = 'notif-type';
                    tgTy.textContent = 'ありがとう';
                    var tgAt = document.createElement('span');
                    tgAt.className = 'notif-at';
                    tgAt.textContent = n.at || '';
                    tgTop.appendChild(tgTy);
                    tgTop.appendChild(tgAt);
                    var tgHead = document.createElement('div');
                    tgHead.className = 'notif-row-head';
                    tgHead.appendChild(tgTop);
                    tgHead.appendChild(createNotifDismissButton(n));
                    var tgTit = document.createElement('div');
                    tgTit.className = 'notif-title';
                    tgTit.textContent = '募集者からありがとうが届きました';
                    var tgBody = document.createElement('div');
                    tgBody.className = 'notif-body';
                    tgBody.textContent = '「' + (n.volTitle || '募集') + '」';
                    var tgMeta = document.createElement('div');
                    tgMeta.className = 'notif-meta';
                    var tgAmt = 1;
                    if (n.thanksAmount != null) {
                        var tgx = Number(n.thanksAmount);
                        tgAmt = isFinite(tgx) && tgx >= 1 ? Math.floor(tgx) : 1;
                    }
                    tgMeta.textContent = 'ありがとうが' + String(tgAmt) + '付与されました。';
                    tgRow.appendChild(tgHead);
                    tgRow.appendChild(tgTit);
                    tgRow.appendChild(tgBody);
                    tgRow.appendChild(tgMeta);
                    var tgBtn = document.createElement('button');
                    tgBtn.type = 'button';
                    tgBtn.className = 'btn btn-notif-ghost';
                    tgBtn.style.marginTop = '10px';
                    tgBtn.textContent = '募集を見る';
                    tgBtn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        if (n.volId) openDetail(n.volId);
                    });
                    tgRow.appendChild(tgBtn);
                    wrap.appendChild(tgRow);
                    return;
                }

                if (n.type === 'thanks_tip') {
                    var tipRow = document.createElement('div');
                    tipRow.className = 'notif-row';
                    var tipTop = document.createElement('div');
                    tipTop.className = 'notif-row-top';
                    var tipTy = document.createElement('span');
                    tipTy.className = 'notif-type';
                    tipTy.textContent = 'ありがとう';
                    var tipAt = document.createElement('span');
                    tipAt.className = 'notif-at';
                    tipAt.textContent = n.at || '';
                    tipTop.appendChild(tipTy);
                    tipTop.appendChild(tipAt);
                    var tipHead = document.createElement('div');
                    tipHead.className = 'notif-row-head';
                    tipHead.appendChild(tipTop);
                    tipHead.appendChild(createNotifDismissButton(n));
                    var tipTit = document.createElement('div');
                    tipTit.className = 'notif-title';
                    tipTit.textContent = (n.applicantName || '参加者') + 'さんからありがとうが届きました';
                    var tipBody = document.createElement('div');
                    tipBody.className = 'notif-body';
                    tipBody.textContent = n.volTitle ? ('「' + n.volTitle + '」') : 'お礼のありがとう';
                    var tipMeta = document.createElement('div');
                    tipMeta.className = 'notif-meta';
                    var tipAmt = 1;
                    if (n.thanksAmount != null) {
                        var tipx = Number(n.thanksAmount);
                        tipAmt = isFinite(tipx) && tipx >= 1 ? Math.floor(tipx) : 1;
                    }
                    tipMeta.textContent = 'ありがとうが' + String(tipAmt) + '加わりました。';
                    tipRow.appendChild(tipHead);
                    tipRow.appendChild(tipTit);
                    tipRow.appendChild(tipBody);
                    tipRow.appendChild(tipMeta);
                    wrap.appendChild(tipRow);
                    return;
                }

                var isHost = n.type === 'join_request' && notifIsOrganizer(n);
                var isApplicant = n.type === 'join_request' && notifIsApplicant(n);
                var row = document.createElement('div');
                var joinSt = (n.type === 'join_request') ? (n.joinStatus != null ? n.joinStatus : 'pending') : 'none';
                var joinRowUnread =
                    n.type === 'join_request' &&
                    n._joinNotifUnread &&
                    (isHost || isApplicant);
                row.className = 'notif-row' + (joinRowUnread ? ' notif-row--unread' : '');
                if (n._firestoreNotification && n._joinNotifUnread && n.id) {
                    row.classList.add('card-clickable');
                    row.addEventListener('click', function (e) {
                        if (e.target && e.target.closest && e.target.closest('button')) return;
                        markFirestoreSingleJoinNotificationSeen(n.id);
                    });
                }
                var top = document.createElement('div');
                top.className = 'notif-row-top';
                var ty = document.createElement('span');
                ty.className = 'notif-type';
                var tyLabel = '参加申請';
                if (joinSt === 'approved' && isApplicant && !isHost) tyLabel = '承認';
                ty.textContent = tyLabel;
                var at = document.createElement('span');
                at.className = 'notif-at';
                at.textContent = n.at || '';
                top.appendChild(ty);
                top.appendChild(at);
                var tit = document.createElement('div');
                tit.className = 'notif-title';
                if (n.type === 'join_request' && isApplicant && !isHost) {
                    tit.textContent = joinSt === 'approved'
                        ? ('「' + (n.volTitle || '募集') + '」の参加が承認されました')
                        : ('「' + (n.volTitle || '募集') + '」に参加を申請しました');
                } else {
                    tit.textContent = (n.applicantName || '参加者') + 'さんが参加を希望しています';
                }
                var body = document.createElement('div');
                body.className = 'notif-body';
                body.textContent = '「' + (n.volTitle || '募集') + '」';
                var meta = document.createElement('div');
                meta.className = 'notif-meta';
                if (n.type === 'join_request') {
                    if (joinSt === 'approved') {
                        if (isHost) {
                            meta.textContent = n.thanksGranted
                                ? ('ありがとう送信済み。DMで参加者（' + (n.applicantName || '') + '）とやりとりできます。')
                                : ('承認済み。当日は募集詳細の「ボランティア当日」からありがとうを送れます。DMで参加者（' + (n.applicantName || '') + '）に連絡できます。');
                        } else {
                            meta.textContent = '承認されました。募集者（' + (n.organizerName || '') + '）へDMで連絡できます。'
                                + (n.thanksGranted ? ' 当日のお礼のありがとうも届いています。' : ' 当日のあと、募集者からありがとうが届きます。');
                        }
                    } else if (isHost) {
                        meta.textContent = '承認すると、参加者（' + (n.applicantName || '') + '）へ承認の通知とDMで進められます。';
                    } else if (isApplicant) {
                        meta.textContent = '募集者の承認をお待ちください。';
                    } else {
                        meta.textContent = '';
                    }
                } else {
                    meta.textContent = '';
                }
                var joinHead = document.createElement('div');
                joinHead.className = 'notif-row-head';
                joinHead.appendChild(top);
                joinHead.appendChild(createNotifDismissButton(n));
                row.appendChild(joinHead);
                row.appendChild(tit);
                row.appendChild(body);
                if (meta.textContent) row.appendChild(meta);

                if (n.type === 'join_request') {
                    var actions = document.createElement('div');
                    actions.className = 'notif-actions';
                    if (joinSt === 'pending') {
                        if (isHost) {
                            var btnApprove = document.createElement('button');
                            btnApprove.type = 'button';
                            btnApprove.className = 'btn btn-primary';
                            btnApprove.textContent = '承認';
                            btnApprove.addEventListener('click', function (e) {
                                e.stopPropagation();
                                if (n.applicationId && useFirestoreJoinFlow()) {
                                    approveJoinApplicationFirestore(
                                        n.applicationId,
                                        function () {
                                            var th2 = ensureThread(n.applicantName || '参加者', n.applicantUserId || '', 'applicant');
                                            th2.firestoreChatId = n.applicationId;
                                            updateNotifBadge();
                                            renderNotifications();
                                            syncDetailActionBars();
                                            liveSyncReconcileHomeCards();
                                            renderAccount();
                                            if (document.getElementById('appShell') && document.getElementById('appShell').dataset.tab === 'organizer') {
                                                renderOrganizerProfile();
                                            }
                                            updateHomeJoinRequestBanner();
                                            showToast('承認しました。参加者に承認通知が届きます。');
                                        },
                                        function () {
                                            showToast('承認の更新に失敗しました');
                                        }
                                    );
                                    return;
                                }
                                n.joinStatus = 'approved';
                                liveSyncPatchNotification(n.id, { joinStatus: 'approved' });
                                updateNotifBadge();
                                renderNotifications();
                                syncDetailActionBars();
                                liveSyncReconcileHomeCards();
                                renderAccount();
                                if (document.getElementById('appShell') && document.getElementById('appShell').dataset.tab === 'organizer') {
                                    renderOrganizerProfile();
                                }
                                showToast('承認しました。参加者に承認通知が届きます。');
                            });
                            var btnView = document.createElement('button');
                            btnView.type = 'button';
                            btnView.className = 'btn btn-notif-ghost';
                            btnView.textContent = '募集を見る';
                            btnView.addEventListener('click', function (e) {
                                e.stopPropagation();
                                if (n.volId) openDetail(n.volId);
                            });
                            actions.appendChild(btnApprove);
                            actions.appendChild(btnView);
                        } else if (isApplicant) {
                            var btnViewOnly = document.createElement('button');
                            btnViewOnly.type = 'button';
                            btnViewOnly.className = 'btn btn-notif-ghost';
                            btnViewOnly.textContent = '募集を見る';
                            btnViewOnly.addEventListener('click', function (e) {
                                e.stopPropagation();
                                if (n.volId) openDetail(n.volId);
                            });
                            actions.appendChild(btnViewOnly);
                        }
                    } else {
                        var dmTarget = isHost ? (n.applicantName || '参加者') : (n.organizerName || '募集者');
                        var btnDm = document.createElement('button');
                        btnDm.type = 'button';
                        btnDm.className = 'btn btn-primary';
                        btnDm.textContent = 'DMで連絡';
                        btnDm.addEventListener('click', function (e) {
                            e.stopPropagation();
                            var dmPeer = isHost ? (n.applicantUserId || '') : (n.organizerUserId || '');
                            var thDm = ensureThread(dmTarget, dmPeer, isHost ? 'applicant' : 'organizer');
                            if (n.applicationId && useFirestoreJoinFlow()) {
                                thDm.firestoreChatId = n.applicationId;
                            }
                            appendOutgoingDm(dmTarget, isHost
                                ? '参加申請を承認しました。詳細はこちらからご連絡します。'
                                : '承認ありがとうございます。当日までに確認したいことがあればお送りします。', dmPeer);
                            setUnreadFlag();
                            renderDmThreads();
                            openChat(dmTarget, dmPeer);
                        });
                        actions.appendChild(btnDm);
                    }
                    if (actions.childNodes.length) row.appendChild(actions);
                }

                wrap.appendChild(row);
            });
            updateNotifBadge();
            updateChatThanksButtonUI();
        }

        function ensureThread(withName, peerUserId, peerRole) {
            peerUserId = peerUserId || '';
            var t = null;
            if (peerUserId) {
                t = state.threads.find(function (x) { return x.peerUserId === peerUserId; });
            }
            if (!t && withName) {
                t = state.threads.find(function (x) { return x.with === withName; });
            }
            if (t) {
                if (peerUserId) t.peerUserId = peerUserId;
                if (peerRole) t.peerRole = peerRole;
                if (withName) {
                    t.with = withName;
                    t.avatar = (withName || '？').trim().slice(0, 1) || '？';
                }
                return t;
            }
            var dis = withName || displayNameForUserId(peerUserId) || '？';
            var avatar = (dis || '？').trim().slice(0, 1) || '？';
            t = { with: dis, avatar: avatar, unread: true, lastAt: '今', messages: [] };
            if (peerUserId) t.peerUserId = peerUserId;
            if (peerRole) t.peerRole = peerRole;
            state.threads.unshift(t);
            return t;
        }

        function openDetail(volId) {
            state.currentDetailId = volId;
            var d = state.vols[volId];
            if (!d) {
                showToast('この募集は見つかりません');
                return;
            }
            var title = document.getElementById('detailTitle');
            var desc = document.getElementById('detailDesc');
            if (title) title.textContent = d.title || '';
            if (desc) desc.textContent = d.desc || '';

            var cover = document.getElementById('detailCover');
            if (cover) {
                var img = d.image ? String(d.image) : '';
                if (img) {
                    cover.hidden = false;
                    cover.className = 'detail-cover detail-cover--photo';
                    cover.style.backgroundImage = 'url(\'' + img.replace(/'/g, '%27') + '\')';
                } else {
                    cover.hidden = true;
                    cover.className = 'detail-cover';
                    cover.style.backgroundImage = '';
                }
            }

            var slotsEl = document.getElementById('detailMetaSlots');
            var placeEl = document.getElementById('detailMetaPlace');
            var dtEl = document.getElementById('detailMetaDateTime');
            if (slotsEl) slotsEl.textContent = formatVolPeople(d);
            if (placeEl) placeEl.textContent = formatVolPlace(d);
            if (dtEl) dtEl.textContent = formatVolDateTime(d);

            var orgIcon = document.getElementById('detailOrganizerIcon');
            if (orgIcon) {
                var pub = publicProfileForUidOrName(d.hostedByUserId || '', d.chatWith || '');
                var syncedPhoto = publicProfilePhotoUrl(pub);
                if (!syncedPhoto && d.authorPhotoUrl) syncedPhoto = String(d.authorPhotoUrl || '').trim();
                if (syncedPhoto) {
                    orgIcon.classList.add('detail-organizer-ic--photo');
                    orgIcon.style.backgroundImage = 'url(' + JSON.stringify(syncedPhoto) + ')';
                    orgIcon.innerHTML = '';
                } else {
                    orgIcon.classList.remove('detail-organizer-ic--photo');
                    orgIcon.style.backgroundImage = '';
                    orgIcon.innerHTML = '<span>' + escapeHtml(d.thumb || '🤝') + '</span>';
                }
            }
            var orgName = document.getElementById('detailOrganizerName');
            if (orgName) orgName.textContent = d.chatWith || '主催者';

            var tagsWrap = document.getElementById('detailTags');
            if (tagsWrap) {
                tagsWrap.innerHTML = '';
                (d.tags || []).forEach(function (t) {
                    var span = document.createElement('span');
                    span.className = 'detail-tag';
                    var s = String(t == null ? '' : t).trim();
                    if (!s) return;
                    span.textContent = s[0] === '#' ? s : ('#' + s.replace(/\s+/g, ''));
                    tagsWrap.appendChild(span);
                });
            }

            var dmBtn = document.getElementById('detailDmBtn');
            if (dmBtn) {
                dmBtn.dataset.chatWith = d.chatWith || '主催者';
                if (d.hostedByUserId) dmBtn.dataset.organizerUserId = d.hostedByUserId;
                else delete dmBtn.dataset.organizerUserId;
            }

            navigateTo('detail');
            syncDetailActionBars();
        }

        function openDetailFromCardElement(cardEl) {
            if (!cardEl) return;
            var id = cardEl.getAttribute('data-id') || cardEl.getAttribute('data-open-detail') || '';
            if (!id) return;
            console.log('Card clicked!', id);
            openDetail(id);
        }

        function setupCardEventDelegation() {
            function handleCardActivationFromEvent(e, container) {
                var organizerBtn = e.target && e.target.closest ? e.target.closest('[data-open-organizer]') : null;
                if (organizerBtn) {
                    e.stopPropagation();
                    var who = organizerBtn.getAttribute('data-open-organizer') || '';
                    if (!who) return true;
                    var uid = organizerBtn.getAttribute('data-organizer-user-id') || '';
                    console.log('Organizer clicked!', uid || who);
                    openOrganizerProfile(who, uid);
                    return true;
                }
                var accBtn = e.target && e.target.closest ? e.target.closest('[data-open-account]') : null;
                if (accBtn) {
                    e.stopPropagation();
                    var accNav = document.querySelector('.bottom-nav .nav-item[data-section="account"]');
                    console.log('Account icon clicked');
                    showSection('account', accNav);
                    return true;
                }
                var card = e.target && e.target.closest ? e.target.closest('[data-open-detail]') : null;
                if (!card) return false;
                if (container && !container.contains(card)) return false;
                if (!(card.getAttribute('data-id') || card.getAttribute('data-open-detail') || '')) return false;
                openDetailFromCardElement(card);
                return true;
            }

            function bindContainer(containerId) {
                var container = document.getElementById(containerId);
                if (!container || container.dataset.cardDelegationBound === '1') return;
                container.dataset.cardDelegationBound = '1';

                container.addEventListener('click', function (e) {
                    handleCardActivationFromEvent(e, container);
                });

                container.addEventListener('keydown', function (e) {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    var card = e.target && e.target.closest ? e.target.closest('[data-open-detail]') : null;
                    if (!card || !container.contains(card)) return;
                    e.preventDefault();
                    handleCardActivationFromEvent(e, container);
                });
            }

            bindContainer('homeCards');
            bindContainer('searchResults');

            // Fallback: 万一コンテナ差し替え等で委譲が外れても、document で最後に拾う
            if (document.body && document.body.dataset.cardDelegationFallbackBound !== '1') {
                document.body.dataset.cardDelegationFallbackBound = '1';
                document.addEventListener('click', function (e) {
                    var t = e.target;
                    if (t && t.closest) {
                        if (
                            t.closest('.bottom-nav') ||
                            t.closest('.header') ||
                            t.closest('#requestFab') ||
                            t.closest('.modal.open') ||
                            t.closest('#authGate.open')
                        ) {
                            return;
                        }
                    }
                    var consumed = handleCardActivationFromEvent(e, null);
                    if (consumed) {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                }, true);
            }
        }

        function openChat(withName, peerUserId) {
            state.currentChatWith = withName || 'DM';
            state.currentChatPeerUserId = peerUserId || '';
            navigateTo('chat');
            var th = findChatThread();
            if (th && th.firestoreChatId && useFirestoreJoinFlow()) {
                var cidOpen = th.firestoreChatId;
                attachFirestoreChatMessagesListener(cidOpen);
                Promise.all([
                    clearFirestoreChatUnseenForMe(cidOpen),
                    markFirestoreJoinNotificationsSeenForChatRoom(cidOpen)
                ]).finally(function () {
                    setUnreadFlag();
                    renderDmThreads();
                    updateNotifBadge();
                    syncAccountTabNotifDot();
                });
            } else {
                detachFirestoreChatMessagesListener();
            }
            renderChat();
            updateChatThanksButtonUI();
        }

        function openOrganizerProfile(withName, peerUserId) {
            state.currentOrganizerName = withName || '主催者';
            state.currentOrganizerUserId = peerUserId || '';
            var dmBtn = document.getElementById('organizerDmBtn');
            if (dmBtn) dmBtn.dataset.chatWith = withName || '主催者';
            renderOrganizerProfile();
            navigateTo('organizer');
        }


        function renderDmThreads() {
            var wrap = document.getElementById('dmThreads');
            if (!wrap) return;
            function dmEsc(s) {
                return String(s == null ? '' : s)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
            }
            var tools = document.getElementById('dmListTools');
            if (tools) tools.hidden = state.threads.length === 0;
            wrap.innerHTML = '';
            state.threads.forEach(function (t) {
                var card = document.createElement('div');
                card.className = 'card dm-thread-card';
                var last = t.messages[t.messages.length - 1];
                var preview = last ? last.text : '…';
                var peerPub = publicProfileForUidOrName(t.peerUserId || '', t.with || '');
                var peerPhoto = publicProfilePhotoUrl(peerPub);
                var avatarInner = peerPhoto
                    ? ('<img class="dm-avatar-img" src="' + dmEsc(peerPhoto) + '" alt="">')
                    : dmEsc(t.avatar);
                card.innerHTML =
                    '<div class="dm-thread-card-inner" role="button" tabindex="0">' +
                        '<div class="dm-thread">' +
                            '<div class="dm-avatar" role="button" tabindex="0" aria-label="' + dmEsc((t.with || '相手') + 'のプロフィール') + '">' + avatarInner + '</div>' +
                            '<div class="dm-meta">' +
                                '<div class="dm-name">' + dmEsc(t.with) + (t.unread ? ' <span style="color:var(--accent);font-size:0.75rem;font-weight:900;">●</span>' : '') + '</div>' +
                                '<div class="dm-preview">' + dmEsc(preview) + '</div>' +
                            '</div>' +
                            '<div style="color:#6a6a6a;font-size:0.75rem;flex-shrink:0;">' + dmEsc(t.lastAt || '') + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<button type="button" class="dm-thread-delete" aria-label="このスレッドを削除">×</button>';
                var openThread = function () {
                    t.unread = false;
                    setUnreadFlag();
                    openChat(t.with, t.peerUserId || '');
                    renderDmThreads();
                };
                var inner = card.querySelector('.dm-thread-card-inner');
                if (inner) {
                    inner.addEventListener('click', openThread);
                    inner.addEventListener('keydown', function (e) {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openThread();
                        }
                    });
                }
                var avatarEl = card.querySelector('.dm-avatar');
                if (avatarEl) {
                    var openProfile = function (e) {
                        e.stopPropagation();
                        openOrganizerProfile(t.with || '主催者', t.peerUserId || '');
                    };
                    avatarEl.addEventListener('click', openProfile);
                    avatarEl.addEventListener('keydown', function (e) {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openProfile(e);
                        }
                    });
                }
                var delBtn = card.querySelector('.dm-thread-delete');
                if (delBtn) {
                    delBtn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        removeDmThreadAndSync(t);
                    });
                }
                wrap.appendChild(card);
            });
        }

        function renderChat() {
            var wrap = document.getElementById('chatMessages');
            if (!wrap) return;
            wrap.innerHTML = '';
            var t = findChatThread();
            if (!t) return;
            function renderedLineCount(el) {
                if (!el) return 1;
                var txt = String(el.textContent || '');
                if (!txt) return 1;
                try {
                    var range = document.createRange();
                    range.selectNodeContents(el);
                    var rects = range.getClientRects();
                    if (rects && rects.length) return rects.length;
                } catch (_) {}
                return txt.indexOf('\n') !== -1 ? 2 : 1;
            }
            t.messages.forEach(function (m) {
                var b = document.createElement('div');
                b.className = 'bubble' + (m.me ? ' me' : '');
                b.textContent = m.text;
                wrap.appendChild(b);
                var isMulti = renderedLineCount(b) >= 2;
                b.classList.toggle('bubble--multi', isMulti);
            });
            wrap.scrollTop = wrap.scrollHeight;
        }

        function renderAccountMyOpenings() {
            var block = document.getElementById('accountMyOpenBlock');
            var listEl = document.getElementById('accountMyOpenList');
            if (!block || !listEl) return;
            var vols = Object.keys(state.vols || {}).map(function (k) { return state.vols[k]; }).filter(function (v) {
                return v && isOwnVol(v) && !isVolFilled(v);
            });
            if (!vols.length) {
                block.hidden = true;
                listEl.innerHTML = '';
                return;
            }
            block.hidden = false;
            var openAsHistory = vols.map(function (v) {
                return {
                    title: v.title || '',
                    meta: [formatVolDateTime(v), formatVolPlace(v), formatVolPeople(v)].filter(Boolean).join(' · '),
                    _volId: v.id
                };
            });
            renderHistoryCards(listEl, openAsHistory);
        }

        function renderAccount() {
            var thanksCountEl = document.getElementById('accountThanksCount');
            if (thanksCountEl) thanksCountEl.textContent = String(state.profile.thanksCount.toLocaleString());
            var list = document.getElementById('accountHistoryList');
            if (list) renderHistoryCards(list, state.history);
            renderAccountMyOpenings();
            var phoneBlk = document.getElementById('accountPhoneAuthBlock');
            if (phoneBlk) {
                phoneBlk.hidden = !PHONE_LOGIN_ACCOUNT_UI_ENABLED || !getLiveSyncBase();
                var pst = document.getElementById('accountPhoneAuthStatus');
                if (pst && getLiveSyncBase() && PHONE_LOGIN_ACCOUNT_UI_ENABLED) {
                    if (getMyUserId()) {
                        pst.textContent = state.auth.phoneE164
                            ? ('ログイン中（' + state.auth.phoneE164 + '）')
                            : 'ログイン中（電話番号は未登録・この端末で発行されたID）';
                    } else {
                        pst.textContent = '電話番号でログインすると、同じ番号の端末同士で同じアカウントになります。';
                    }
                }
            }
        }

        function openPhoneAuthModal() {
            if (!PHONE_LOGIN_ACCOUNT_UI_ENABLED) return;
            var m = document.getElementById('phoneAuthModal');
            var phoneIn = document.getElementById('phoneAuthInput');
            var codeIn = document.getElementById('phoneAuthCodeInput');
            var dnIn = document.getElementById('phoneAuthDisplayName');
            if (codeIn) codeIn.value = '';
            if (dnIn) dnIn.value = state.profile.name || state.auth.displayName || '';
            if (m) m.classList.add('open');
            window.setTimeout(function () {
                if (phoneIn) phoneIn.focus();
            }, 80);
        }

        function closePhoneAuthModal() {
            var m = document.getElementById('phoneAuthModal');
            if (m) m.classList.remove('open');
        }

        function phoneAuthSendCode() {
            var base = getLiveSyncBase();
            if (!base) {
                showToast(
                    '同期がオフです（sync-server で npm start し、http://127.0.0.1:3847/index.html?sync=auto のように HTTP で開いてください。file:// では電話認証は使えません）'
                );
                return;
            }
            var phoneIn = document.getElementById('phoneAuthInput');
            var phone = phoneIn && String(phoneIn.value || '').trim();
            if (!phone) {
                showToast('電話番号を入力してください');
                return;
            }
            fetch(base + '/api/auth/phone/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: phone })
            })
                .then(syncJsonFromFetchResponse)
                .then(function (x) {
                    if (x.j && x.j.devMode) {
                        showToast('開発モード: サーバーのターミナルに認証コードが出ます');
                    } else if (x.ok) {
                        showToast('SMSを送信しました');
                    } else {
                        var sendErr =
                            (x.j && (x.j.hint || x.j.error)) ||
                            (x.status ? 'HTTP ' + x.status : '') ||
                            '送信できませんでした';
                        if (x.status === 404) {
                            sendErr +=
                                '（同期サーバーが POST を受け付けていません。3847 を使う古い node を止め、Teertab/sync-server で npm start し直してください。ブラウザで /api/health に phoneOtp:true があるか確認）';
                        }
                        showToast(sendErr);
                    }
                })
                .catch(function (err) {
                    var msg = (err && err.message) || '';
                    showToast(
                        msg
                            ? '送信に失敗しました（' + msg + '）'
                            : '送信に失敗しました（同期サーバーに届いていません。npm start 後に http://127.0.0.1:3847/index.html?sync=auto で開いてください）'
                    );
                });
        }

        function phoneAuthVerifySubmit() {
            var base = getLiveSyncBase();
            if (!base) return;
            var phoneIn = document.getElementById('phoneAuthInput');
            var codeIn = document.getElementById('phoneAuthCodeInput');
            var dnIn = document.getElementById('phoneAuthDisplayName');
            var phone = phoneIn && String(phoneIn.value || '').trim();
            var code = codeIn && String(codeIn.value || '').replace(/\D/g, '');
            var dn = dnIn && String(dnIn.value || '').trim();
            if (!phone || !code) {
                showToast('電話番号と認証コードを入力してください');
                return;
            }
            fetch(base + '/api/auth/phone/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: phone, code: code, displayName: dn })
            })
                .then(syncJsonFromFetchResponse)
                .then(function (x) {
                    var j = x.j;
                    if (!x.ok || !j || !j.userId || !j.secret) {
                        showToast(
                            (j && (j.hint || j.error)) ||
                                (x.status ? 'HTTP ' + x.status : '') ||
                                '認証に失敗しました'
                        );
                        return;
                    }
                    state.auth.userId = j.userId;
                    state.auth.secret = j.secret;
                    state.auth.displayName = j.displayName || '';
                    state.auth.phoneE164 = j.phoneE164 || '';
                    if (state.auth.displayName && !hasSavedProfileInStorage()) {
                        state.profile.name = state.auth.displayName;
                    }
                    persistTealAuthToStorage();
                    applyProfileToAccountDom();
                    populateProfileEditForm();
                    renderAccount();
                    closePhoneAuthModal();
                    showToast('ログインしました');
                    liveSyncPullOnce();
                })
                .catch(function (err) {
                    var msg = (err && err.message) || '';
                    showToast(
                        msg
                            ? '認証に失敗しました（' + msg + '）'
                            : '認証に失敗しました（ネットワーク。同期サーバーの URL で開いているか確認してください）'
                    );
                });
        }

        function renderOrganizerProfile() {
            var name = state.currentOrganizerName || '主催者';

            var nameEl = document.getElementById('organizerName');
            if (nameEl) nameEl.textContent = name;

            var uid = state.currentOrganizerUserId || '';
            var pub = publicProfileForUidOrName(uid, name);
            var avatarEl = document.getElementById('organizerAvatar');
            if (avatarEl) {
                var syncedPhoto = publicProfilePhotoUrl(pub);
                if (syncedPhoto) {
                    avatarEl.textContent = '';
                    avatarEl.style.backgroundImage = 'url(' + JSON.stringify(syncedPhoto) + ')';
                    avatarEl.classList.add('account-avatar--photo');
                } else {
                    avatarEl.classList.remove('account-avatar--photo');
                    avatarEl.style.backgroundImage = '';
                    var sampleVol = Object.keys(state.vols || {}).map(function (k) { return state.vols[k]; }).find(function (v) { return v && v.chatWith === name; });
                    avatarEl.textContent = (sampleVol && sampleVol.thumb) ? sampleVol.thumb : ((name || '？').trim().slice(0, 1) || '？');
                }
            }

            var organizerBioEl = document.getElementById('organizerBio');
            var bioText = pub && String(pub.bio || '').trim() ? String(pub.bio).trim() : '自己紹介はまだありません。';
            var thanksCountEl = document.getElementById('organizerThanksCount');
            if (thanksCountEl) {
                var pubThanks = pub && typeof pub.thanksCount === 'number' && isFinite(pub.thanksCount)
                    ? Math.max(0, Math.floor(pub.thanksCount))
                    : null;
                thanksCountEl.textContent = pubThanks != null ? String(pubThanks.toLocaleString()) : '—';
            }
            if (organizerBioEl) organizerBioEl.textContent = bioText;

            var openWrap = document.getElementById('organizerOpenCards');
            if (openWrap) {
                openWrap.innerHTML = '';
                var openVols = Object.keys(state.vols).map(function (k) { return state.vols[k]; }).filter(function (v) {
                    return v.chatWith === name && !isVolFilled(v);
                });
                if (!openVols.length) {
                    var emptyOpen = document.createElement('div');
                    emptyOpen.className = 'account-history-item';
                    emptyOpen.textContent = '募集中の活動はありません';
                    openWrap.appendChild(emptyOpen);
                } else {
                    var openAsHistory = openVols.map(function (v) {
                        return {
                            title: v.title || '',
                            meta: [formatVolDateTime(v), formatVolPlace(v), formatVolPeople(v)].filter(Boolean).join(' · '),
                            _volId: v.id
                        };
                    });
                    renderHistoryCards(openWrap, openAsHistory);
                }
            }

            var historyList = document.getElementById('organizerHistoryList');
            if (historyList) {
                renderHistoryCards(historyList, state.history);
            }

            var orgAct = document.querySelector('#organizer .organizer-actions');
            if (orgAct) {
                var me = syncAccountNameFromDom();
                var hasThread = (state.threads || []).some(function (t) {
                    if (!t) return false;
                    if (uid && t.peerUserId) return t.peerUserId === uid;
                    return accountsMatch(t.with, name);
                });
                orgAct.hidden = accountsMatch(name, me) || hasThread;
            }
        }

        function openJoinModal() {
            var jb = document.getElementById('joinBtn');
            if (jb && jb.disabled) return;
            var m = document.getElementById('joinModal');
            if (!m) return;
            m.classList.add('open');
        }
        function closeJoinModal() {
            var m = document.getElementById('joinModal');
            if (!m) return;
            m.classList.remove('open');
        }
        function closeThankOrganizerModal() {
            var m = document.getElementById('thankOrganizerModal');
            if (!m) return;
            m.classList.remove('open');
            state.pendingThankOrganizer = '';
            state.pendingThankOrganizerUserId = '';
            state.pendingThankVolTitle = '';
        }
        function openThankOrganizerModal(organizerName, volTitle, organizerUserId) {
            var org = String(organizerName || '募集者').trim() || '募集者';
            var title = String(volTitle || 'この募集').trim() || 'この募集';
            state.pendingThankOrganizer = org;
            state.pendingThankOrganizerUserId = organizerUserId || '';
            state.pendingThankVolTitle = title;
            var bal = Math.max(0, Math.floor(state.profile.thanksCount || 0));
            var amtEl = document.getElementById('thankOrganizerAmount');
            if (amtEl) {
                amtEl.min = '1';
                amtEl.max = String(Math.max(1, bal));
                amtEl.value = String(Math.min(1, Math.max(1, bal)));
            }
            var m = document.getElementById('thankOrganizerModal');
            if (m) {
                m.classList.add('open');
                window.setTimeout(function () {
                    if (amtEl) amtEl.focus({ preventScroll: true });
                }, 80);
            }
        }
        function sendThankOrganizerFromModal() {
            var org = String(state.pendingThankOrganizer || '').trim();
            if (!org) {
                closeThankOrganizerModal();
                return;
            }
            var orgUid = String(state.pendingThankOrganizerUserId || '').trim();
            if (!orgUid || orgUid.indexOf('usr-') !== 0) {
                showToast('募集者の同期アカウント情報がないため、ありがとうを送れません（同期ログインと募集のホスト情報が必要です）');
                return;
            }
            var th = findChatThread();
            var peerRole = th && th.peerRole ? th.peerRole : deriveChatPeerRole(orgUid, org);
            if (th && peerRole && !th.peerRole) {
                th.peerRole = peerRole;
            }
            if (peerRole === 'organizer' || hasApprovedJoinWithOrganizer(orgUid, org)) {
                showToast('参加者側からはありがとうを送れません（主催者→参加者のみ）');
                return;
            }
            if (peerRole !== 'applicant' && !canHostSendThanksToUser(orgUid, org)) {
                showToast('参加者側からはありがとうを送れません（主催者のみ送信できます）');
                return;
            }
            var cooldownMs = 60 * 1000;
            if (!state.thanksTipCooldownByUserId) state.thanksTipCooldownByUserId = {};
            var now = Date.now();
            var lastAt = Number(state.thanksTipCooldownByUserId[orgUid] || 0);
            if (isFinite(lastAt) && lastAt > 0 && now - lastAt < cooldownMs) {
                var remain = Math.ceil((cooldownMs - (now - lastAt)) / 1000);
                showToast('連続送信はできません。' + remain + '秒後にもう一度お試しください');
                return;
            }
            var amtEl = document.getElementById('thankOrganizerAmount');
            var per = parseInt(amtEl && amtEl.value, 10);
            if (!isFinite(per) || per < 1) {
                showToast('1以上の数を指定してください');
                return;
            }
            var bal = Math.max(0, Math.floor(state.profile.thanksCount || 0));
            if (bal < per) {
                showToast('ありがとうが足りません（所持 ' + bal + '）');
                return;
            }
            state.profile.thanksCount = bal - per;
            persistProfileThanksCount();
            var text = 'ありがとうを送りました。';
            appendOutgoingDm(org, text, orgUid);
            var tipN = {
                id: 'notif-tip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
                type: 'thanks_tip',
                at: '今',
                organizerName: org,
                organizerUserId: orgUid,
                applicantName: syncAccountNameFromDom() || '参加者',
                applicantUserId: getMyUserId() || undefined,
                volTitle: state.pendingThankVolTitle || '',
                thanksAmount: per
            };
            liveSyncPostNotification(tipN);
            state.thanksTipCooldownByUserId[orgUid] = now;
            setUnreadFlag();
            renderDmThreads();
            closeThankOrganizerModal();
            showToast('お礼とありがとうを送信しました');
        }
        function confirmJoin() {
            var v = state.vols[state.currentDetailId];
            if (!v) {
                closeJoinModal();
                return;
            }
            if (isOwnVol(v)) {
                closeJoinModal();
                return;
            }
            var organizerName = v.chatWith || '募集者';
            var orgUid = v.hostedByUserId || '';
            var volTitle = v.title || '';
            if (useFirestoreJoinFlow()) {
                var ownerUidForJoin = String(v.hostedByUserId || v.authorId || '').trim();
                if (!ownerUidForJoin) {
                    showToast('募集者のユーザー情報がないため、参加申請を同期できません');
                    return;
                }
                submitJoinApplicationFirestore(v, function (ok, errDetail) {
                    if (ok) {
                        state.history.unshift({ title: v.title, meta: '2026年4月 · ' + v.place + ' · 参加申請' });
                        renderAccount();
                        closeJoinModal();
                        syncDetailActionBars();
                        updateHomeJoinRequestBanner();
                        showToast('参加申請しました。募集者に参加申請通知が届きます。');
                    } else {
                        var hint = errDetail ? ('（' + errDetail + '）') : '';
                        showToast('参加申請の保存に失敗しました' + hint + '。コンソール（F12）の詳細を確認してください。');
                    }
                });
                return;
            }
            state.history.unshift({ title: v.title, meta: '2026年4月 · ' + v.place + ' · 参加申請' });
            renderAccount();
            var th = ensureThread(organizerName, orgUid);
            th.unread = true;
            th.lastAt = '今';
            th.messages.push({ me: false, text: '参加申請ありがとうございます！承認後に当日の流れを共有します。' });
            setUnreadFlag();
            renderDmThreads();
            var applicant = state.profile.name || '参加者';
            var notif = {
                id: 'notif-' + Date.now(),
                type: 'join_request',
                joinStatus: 'pending',
                at: '今',
                organizerName: organizerName,
                applicantName: applicant,
                organizerUserId: orgUid || undefined,
                applicantUserId: getMyUserId() || undefined,
                volTitle: volTitle,
                volId: v.id
            };
            state.notifications.unshift(notif);
            liveSyncPostNotification(notif);
            updateNotifBadge();
            renderNotifications();
            closeJoinModal();
            syncDetailActionBars();
            showToast('参加申請しました。募集者に参加申請通知が届きます。');
        }


        function openAccountSettingsModal() {
            var modal = document.getElementById('accountSettingsModal');
            if (modal) modal.classList.add('open');
        }

        function closeAccountSettingsModal() {
            var modal = document.getElementById('accountSettingsModal');
            if (modal) modal.classList.remove('open');
        }

        function logoutFirebaseUser() {
            var TF = tf();
            if (!TF || !TF.auth || !TF.signOut) {
                showToast('ログアウトに失敗しました');
                return;
            }
            TF.signOut(TF.auth)
                .then(function () {
                    closeAccountSettingsModal();
                    showToast('ログアウトしました');
                })
                .catch(function (err) {
                    showToast('ログアウトに失敗しました');
                    console.warn('Teertab logout failed', err);
                });
        }

        function hydrateAndStartForCurrentUser() {
            var TB = tf();
            var userDocRef = getCurrentUserDocRef();
            if (!TB || !userDocRef) return;
            migrateLegacyLocalStorageToFirestoreOnce()
                .then(function () {
                    return TB.getDoc(userDocRef);
                })
                .then(function (snap) {
                    if (snap.exists) applyUserDefaultDocToState(snap.data());
                    else {
                        state.userDefaultHydrated = true;
                        state.userDefaultHostedVols = [];
                    }
                    return Promise.resolve();
                })
                .then(function () {
                    attachUserDefaultFirestoreListener();
                    attachUserCardsFirestoreListener();
                    attachFirestoreJoinFlowListeners();
                    if (!teertabMainBooted) {
                        teertabMainBooted = true;
                        teertabRunMainAfterUserDefaultHydrate();
                    }
                })
                .catch(function () {
                    attachUserDefaultFirestoreListener();
                    attachUserCardsFirestoreListener();
                    attachFirestoreJoinFlowListeners();
                    if (!teertabMainBooted) {
                        teertabMainBooted = true;
                        teertabRunMainAfterUserDefaultHydrate();
                    }
                });
        }

        function initFirebaseAuthGate() {
            var TF = tf();
            if (!TF || !TF.auth) return;
            setAuthGateVisible(true, 'ログイン状態を確認中...');
            var loginBtn = document.getElementById('googleLoginBtn');
            if (loginBtn) {
                loginBtn.addEventListener('click', function () {
                    setAuthGateVisible(true, 'Google ログインを開いています...');
                    signInWithGoogle().catch(function (err) {
                        var msg = (err && err.message) ? String(err.message) : '';
                        setAuthGateVisible(true, msg ? ('ログインに失敗しました: ' + msg) : 'ログインに失敗しました');
                    });
                });
            }
            var emailLoginBtn = document.getElementById('authEmailTestLoginBtn');
            var emailSignupBtn = document.getElementById('authEmailSignupBtn');
            function readAuthEmailPasswordInputs() {
                var emEl = document.getElementById('authEmailLogin');
                var pwEl = document.getElementById('authPasswordLogin');
                return {
                    email: emEl ? String(emEl.value || '').trim() : '',
                    password: pwEl ? String(pwEl.value || '') : ''
                };
            }
            if (emailLoginBtn) {
                emailLoginBtn.addEventListener('click', function () {
                    var v = readAuthEmailPasswordInputs();
                    if (!v.email || !v.password) {
                        setAuthGateVisible(true, 'メールアドレスとパスワードを入力してください');
                        return;
                    }
                    setAuthGateVisible(true, 'ログインしています...');
                    signInWithEmailPassword(v.email, v.password).catch(function (err) {
                        setAuthGateVisible(true, 'ログインに失敗しました: ' + formatFirebaseAuthError(err));
                    });
                });
            }
            if (emailSignupBtn) {
                emailSignupBtn.addEventListener('click', function () {
                    var v = readAuthEmailPasswordInputs();
                    if (!v.email || !v.password) {
                        setAuthGateVisible(true, 'メールアドレスとパスワードを入力してください');
                        return;
                    }
                    setAuthGateVisible(true, 'アカウントを作成しています...');
                    createUserWithEmailPassword(v.email, v.password).catch(function (err) {
                        setAuthGateVisible(true, '登録に失敗しました: ' + formatFirebaseAuthError(err));
                    });
                });
            }
            if (firebaseAuthUnsub) return;
            firebaseAuthUnsub = TF.onAuthStateChanged(TF.auth, function (user) {
                if (!user) {
                    closeAccountSettingsModal();
                    state.auth.userId = '';
                    state.auth.secret = '';
                    state.auth.displayName = '';
                    state.auth.phoneE164 = '';
                    currentUserDocRef = null;
                    state.userDefaultHydrated = false;
                    state.userDefaultHostedVols = [];
                    state.myHostedVolIds = {};
                    Object.keys(state.vols || {}).forEach(function (k) {
                        if (k.indexOf('vol-user-') === 0) delete state.vols[k];
                    });
                    state.homePostsLoading = true;
                    state.homePostsLoadedOnce = false;
                    state._postsSnapshotSig = '';
                    window.allPostsCache = [];
                    state.dismissedNotifsRemote = {};
                    if (typeof teertabUserDocUnsub === 'function') teertabUserDocUnsub();
                    teertabUserDocUnsub = null;
                    if (typeof teertabUserCardsUnsub === 'function') teertabUserCardsUnsub();
                    teertabUserCardsUnsub = null;
                    detachFirestoreJoinFlowListeners();
                    teertabUserDefaultListenerAttached = false;
                    setAuthGateVisible(true, '');
                    return;
                }
                state.auth.userId = user.uid;
                state.auth.secret = '';
                state.auth.displayName = user.displayName || '';
                state.auth.phoneE164 = '';
                setAuthGateVisible(false, '');
                reloadUserProfileFromFirestore()
                    .then(function () {
                        hydrateAndStartForCurrentUser();
                    });
            });
        }

        (function teertabAppBoot() {
            if (!tf()) {
                if (!window.__teertabTfSpin) window.__teertabTfSpin = 0;
                window.__teertabTfSpin += 1;
                if (window.__teertabTfSpin < 400) {
                    setTimeout(teertabAppBoot, 25);
                    return;
                }
                console.warn('Teertab: Firebase が読み込めませんでした（HTTPS で開き import map を確認してください）');
                setAuthGateVisible(true, 'Firebase の読み込みに失敗しました');
                return;
            }
            initTeertabFirebase();
            initFirebaseAuthGate();
        })();

        function teertabRunMainAfterUserDefaultHydrate() {
            applyProfileToAccountDom();
            var deviceOwnerKey = getDeviceOwnerKey();
            ensureAuthSession(function () {
            function getCurrentUserProfile() {
                var name = String(state.profile.name || '').trim() || 'ユーザーネーム';
                var avatar = String(state.profile.avatar || '').trim() || '🙂';
                state.profile.name = name;
                state.profile.avatar = avatar;
                return { name: name, avatar: avatar };
            }
            function loadUserVols() {
                if (!Array.isArray(state.userDefaultHostedVols)) return [];
                return state.userDefaultHostedVols.filter(function (v) {
                    return v && typeof v.id === 'string' && v.id.indexOf('vol-user-') === 0;
                });
            }
            function saveUserVols(list) {
                var clean = (list || []).filter(function (v) {
                    return v && typeof v.id === 'string' && v.id.indexOf('vol-user-') === 0;
                });
                var prevList = (state.userDefaultHostedVols || []).slice();
                state.userDefaultHostedVols = clean;
                if (tf()) {
                    syncMyPostsToFirestore(clean, prevList);
                    return true;
                }
                return false;
            }
            (function migrateLocalUserVolsStorage() {
                try {
                    var scrub = false;
                    try {
                        scrub = new URLSearchParams(window.location.search).get('scrubLocalVols') === '1';
                    } catch (_) {}
                    var parsed = state.userDefaultHostedVols;
                    if (!Array.isArray(parsed) || !parsed.length) return;
                    var next = parsed.filter(shouldKeepVolInLocalCache);
                    if (next.length !== parsed.length) {
                        saveUserVols(next);
                        showToast(scrub ? 'この端末の募集保存を整理しました（他人分を削除）' : '保存されていた他人の募集を取り除きました');
                    } else if (scrub) {
                        showToast('整理の必要はありませんでした');
                    }
                    if (scrub) {
                        try {
                            var u = new URL(window.location.href);
                            u.searchParams.delete('scrubLocalVols');
                            window.history.replaceState({}, '', u.pathname + u.search + u.hash);
                        } catch (_) {}
                    }
                } catch (_) {}
            })();
            function persistUserVol(v) {
                if (v && !v.hostedByLocal) v.hostedByLocal = deviceOwnerKey;
                var authUid = getMyUserId();
                if (v && authUid) {
                    v.hostedByUserId = authUid;
                    v.authorId = authUid;
                    if (!v.authorName) {
                        v.authorName = String(state.profile.name || state.auth.displayName || v.chatWith || '')
                            .trim()
                            .slice(0, 80) || 'ユーザーネーム';
                    }
                }
                if (v && v.id) state.myHostedVolIds[v.id] = true;
                var list = loadUserVols();
                list = [v].concat(list.filter(function (x) { return x && x.id !== v.id; }));
                if (saveUserVols(list)) {
                    return { ok: true, imageDropped: false };
                }
                // Fallback for quota errors: keep requests but drop image payloads.
                var compact = list.map(function (item) {
                    if (!item || typeof item !== 'object') return item;
                    var cloned = Object.assign({}, item);
                    if (cloned.image) cloned.image = '';
                    return cloned;
                });
                if (saveUserVols(compact)) {
                    return { ok: true, imageDropped: true };
                }
                return { ok: false, imageDropped: false };
            }

            // Request lightweight helpers
            var requestForm = document.getElementById('requestForm');
            var imageInput = document.getElementById('req-image-input');
            var imageZone = document.getElementById('req-image-zone');
            var imagePreview = document.getElementById('req-image-preview');
            var pendingImageDataUrl = '';
            if (imageInput && imageZone && imagePreview) {
                imageInput.addEventListener('change', function () {
                    var file = imageInput.files && imageInput.files[0];
                    if (!file) {
                        pendingImageDataUrl = '';
                        imagePreview.removeAttribute('src');
                        imageZone.classList.remove('has-image');
                        return;
                    }
                    var reader = new FileReader();
                    reader.onload = function () {
                        pendingImageDataUrl = String(reader.result || '');
                        imagePreview.src = pendingImageDataUrl;
                        imageZone.classList.add('has-image');
                    };
                    reader.readAsDataURL(file);
                });
            }
            if (requestForm) {
                requestForm.addEventListener('submit', function (e) {
                    e.preventDefault();
                    var me = getCurrentUserProfile();
                    var latestName = getLatestProfileDisplayName();

                    var titleInput = document.getElementById('req-title');
                    var whenInput = document.getElementById('req-when');
                    var placeInput = document.getElementById('req-place');
                    var peopleInput = document.getElementById('req-people');
                    var tagsInput = document.getElementById('req-tags');
                    var descInput = document.getElementById('req-desc');

                    var title = String((titleInput && titleInput.value) || '').trim();
                    if (!title) {
                        showToast('タイトルを入力してください');
                        if (titleInput) titleInput.focus();
                        return;
                    }

                    var place = String((placeInput && placeInput.value) || '').trim();
                    var when = String((whenInput && whenInput.value) || '').trim();
                    var people = parseInt(String((peopleInput && peopleInput.value) || '1'), 10) || 1;
                    var desc = String((descInput && descInput.value) || '').trim();
                    var tagRaw = String((tagsInput && tagsInput.value) || '');
                    var tags = tagRaw.split(/[\s,、]+/).map(hashTag).filter(Boolean);

                    /** Date.now() のみだと同一ミリ秒内の投稿が同じ id になり Firestore で上書きされる */
                    var id =
                        'vol-user-' +
                        (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                            ? crypto.randomUUID()
                            : Date.now() + '-' + Math.random().toString(36).slice(2, 12));
                    var posterUid = getMyUserId();
                    var v = {
                        id: id,
                        authorId: posterUid || '',
                        authorName: latestName,
                        authorPhotoUrl: String(state.profile.photoDataUrl || '').trim(),
                        hostedByLocal: deviceOwnerKey,
                        thumb: me.avatar,
                        tag: 'New',
                        title: title,
                        desc: desc || '詳細は主催者へお問い合わせください。',
                        place: place || '未設定',
                        venue: place || '未設定',
                        startsAt: when || '',
                        when: when || '相談',
                        near: !/オンライン/.test(place),
                        thisWeek: true,
                        remote: /オンライン/.test(place),
                        chatWith: latestName,
                        capacity: Math.max(1, people),
                        joined: 0,
                        durationText: '相談',
                        dateBadge: 'New',
                        dateTimeText: formatVolDateTimeFromIso(when) || '日時は相談',
                        tags: tags.slice(0, 4),
                        image: pendingImageDataUrl || '',
                        details: {
                            what: [desc || '募集内容は相談して決定します。'],
                            who: ['参加できる方ならどなたでも'],
                            prep: ['特になし']
                        }
                    };
                    state.myHostedVolIds[id] = true;
                    state.vols = Object.assign({}, { [id]: v }, state.vols);
                    var persistResult = persistUserVol(v);
                    liveSyncPostVol(v);

                    var homeCards = document.getElementById('homeCards');
                    if (homeCards) homeCards.insertBefore(createHomeCardElement(v), homeCards.firstChild);
                    updateHomeEmptyState();

                    requestForm.reset();
                    pendingImageDataUrl = '';
                    if (imagePreview) imagePreview.removeAttribute('src');
                    if (imageZone) imageZone.classList.remove('has-image');
                    setPeople(1);
                    document.querySelectorAll('[data-preset-duration], [data-preset-thanks]').forEach(function (b) { b.classList.remove('is-active'); });

                    renderSearchResults();
                    renderAccount();
                    showSection('home', null);
                    if (!persistResult.ok) {
                        showToast('募集は追加しましたが保存に失敗しました');
                    } else if (persistResult.imageDropped) {
                        showToast('画像が大きいため、画像なしで保存しました');
                    } else {
                        showToast('募集を作成してホームに追加しました');
                    }
                });
            }
            var requestHeaderSubmit = document.getElementById('requestHeaderSubmit');
            if (requestHeaderSubmit && requestForm) {
                requestHeaderSubmit.addEventListener('click', function () {
                    if (typeof requestForm.requestSubmit === 'function') {
                        requestForm.requestSubmit();
                    } else {
                        requestForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
                    }
                });
            }

            var peopleHidden = document.getElementById('req-people');
            var peopleValue = document.getElementById('reqPeopleValue');
            var peopleDec = document.getElementById('reqPeopleDec');
            var peopleInc = document.getElementById('reqPeopleInc');
            var setPeople = function (n) {
                var v = Math.max(1, Math.min(99, n || 1));
                if (peopleHidden) peopleHidden.value = String(v);
                if (peopleValue) peopleValue.textContent = String(v);
            };
            if (peopleDec) peopleDec.addEventListener('click', function () {
                var cur = parseInt((peopleHidden && peopleHidden.value) || '1', 10) || 1;
                setPeople(cur - 1);
            });
            if (peopleInc) peopleInc.addEventListener('click', function () {
                var cur = parseInt((peopleHidden && peopleHidden.value) || '1', 10) || 1;
                setPeople(cur + 1);
            });

            // Hydrate user-created requests from localStorage (memory + UI)
            var storedUserVols = loadUserVols();
            if (storedUserVols.length) {
                var me = getCurrentUserProfile();
                var beforeN = storedUserVols.length;
                storedUserVols = storedUserVols.map(function (v) {
                    if (!v || typeof v !== 'object') return v;
                    var updated = Object.assign({}, v);
                    if (updated.chatWith === 'あなた' || !updated.chatWith) updated.chatWith = me.name;
                    if (updated.thumb === '🆕' || !updated.thumb) updated.thumb = me.avatar;
                    if (!updated.hostedByUserId && !updated.hostedByLocal) {
                        updated.hostedByLocal = deviceOwnerKey;
                    }
                    return updated;
                }).filter(shouldKeepVolInLocalCache);
                storedUserVols.forEach(function (v) {
                    if (v && v.id) state.myHostedVolIds[v.id] = true;
                });
                if (storedUserVols.length !== beforeN) {
                    saveUserVols(storedUserVols);
                    if (storedUserVols.length < beforeN) {
                        showToast('保存されていた他人の募集を取り除きました');
                    }
                }
                var userVolMap = {};
                storedUserVols.forEach(function (v) { userVolMap[v.id] = v; });
                state.vols = Object.assign({}, userVolMap, state.vols);
                var homeCards = document.getElementById('homeCards');
                if (homeCards) {
                    for (var i = storedUserVols.length - 1; i >= 0; i--) {
                        homeCards.insertBefore(createHomeCardElement(storedUserVols[i]), homeCards.firstChild);
                    }
                    updateHomeEmptyState();
                }
            }

            var durationHidden = document.getElementById('req-duration');
            document.querySelectorAll('[data-preset-duration]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var val = btn.getAttribute('data-preset-duration') || '60';
                    if (durationHidden) durationHidden.value = val;
                    document.querySelectorAll('[data-preset-duration]').forEach(function (b) { b.classList.remove('is-active'); });
                    btn.classList.add('is-active');
                });
            });

            var thanksHidden = document.getElementById('req-thanks');
            document.querySelectorAll('[data-preset-thanks]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var val = btn.getAttribute('data-preset-thanks') || '10';
                    if (thanksHidden) thanksHidden.value = val;
                    document.querySelectorAll('[data-preset-thanks]').forEach(function (b) { b.classList.remove('is-active'); });
                    btn.classList.add('is-active');
                });
            });

            // Header buttons
            var backBtn = document.getElementById('backBtn');
            if (backBtn) backBtn.addEventListener('click', goBack);

            var searchBtn = document.getElementById('searchBtn');
            if (searchBtn) searchBtn.addEventListener('click', function () {
                document.querySelectorAll('.bottom-nav .nav-item').forEach(function (n) { n.classList.remove('active'); });
                navigateTo('search');
                var sq = document.getElementById('search-q');
                if (sq) {
                    window.setTimeout(function () {
                        sq.focus();
                        try { sq.select(); } catch (_) {}
                    }, 80);
                }
            });

            var dmBtn = document.getElementById('dmBtn');
            if (dmBtn) dmBtn.addEventListener('click', function () {
                document.querySelectorAll('.bottom-nav .nav-item').forEach(function (n) { n.classList.remove('active'); });
                navigateTo('dm');
                renderDmThreads();
            });
            var dmClearAllBtn = document.getElementById('dmClearAllBtn');
            if (dmClearAllBtn) dmClearAllBtn.addEventListener('click', clearAllDmThreadsAndSync);

            var notifBtn = document.getElementById('notifBtn');
            if (notifBtn) notifBtn.addEventListener('click', function () {
                document.querySelectorAll('.bottom-nav .nav-item').forEach(function (n) { n.classList.remove('active'); });
                navigateTo('notifications');
                renderNotifications();
            });
            var notifClearAllBtn = document.getElementById('notifClearAllBtn');
            if (notifClearAllBtn) notifClearAllBtn.addEventListener('click', clearAllNotificationsFromList);

            // Home feed "募集する" button (XのPost風)
            var requestFab = document.getElementById('requestFab');
            if (requestFab) {
                requestFab.addEventListener('click', function () {
                    document.querySelectorAll('.bottom-nav .nav-item').forEach(function (n) { n.classList.remove('active'); });
                    navigateTo('request');
                });
            }

            document.querySelectorAll('.bottom-nav .nav-item[data-section]').forEach(function (btn) {
                var section = btn.getAttribute('data-section');
                if (!section) return;
                btn.addEventListener('click', function () {
                    showSection(section, btn);
                });
            });

            setupCardEventDelegation();

            // Join flow modal
            var joinBtn = document.getElementById('joinBtn');
            if (joinBtn) joinBtn.addEventListener('click', openJoinModal);
            var joinCancel = document.getElementById('joinCancel');
            var joinConfirm = document.getElementById('joinConfirm');
            var joinModal = document.getElementById('joinModal');
            if (joinCancel) joinCancel.addEventListener('click', closeJoinModal);
            if (joinConfirm) joinConfirm.addEventListener('click', confirmJoin);
            if (joinModal) joinModal.addEventListener('click', function (e) {
                if (e.target === joinModal) closeJoinModal();
            });

            var detailHostThanksBtn = document.getElementById('detailHostThanksBtn');
            if (detailHostThanksBtn) detailHostThanksBtn.addEventListener('click', openHostGrantThanksModal);
            var hostGrantThanksModal = document.getElementById('hostGrantThanksModal');
            var hostGrantThanksCancel = document.getElementById('hostGrantThanksCancel');
            var hostGrantThanksConfirm = document.getElementById('hostGrantThanksConfirm');
            var hostGrantThanksAmount = document.getElementById('hostGrantThanksAmount');
            if (hostGrantThanksCancel) hostGrantThanksCancel.addEventListener('click', closeHostGrantThanksModal);
            if (hostGrantThanksConfirm) hostGrantThanksConfirm.addEventListener('click', confirmHostGrantThanksFromModal);
            if (hostGrantThanksAmount) {
                hostGrantThanksAmount.addEventListener('input', updateHostGrantThanksModalSummary);
                hostGrantThanksAmount.addEventListener('change', updateHostGrantThanksModalSummary);
            }
            if (hostGrantThanksModal) {
                hostGrantThanksModal.addEventListener('click', function (e) {
                    if (e.target === hostGrantThanksModal) closeHostGrantThanksModal();
                });
            }

            var thankOrganizerModal = document.getElementById('thankOrganizerModal');
            var thankOrganizerSkip = document.getElementById('thankOrganizerSkip');
            var thankOrganizerSend = document.getElementById('thankOrganizerSend');
            if (thankOrganizerSkip) thankOrganizerSkip.addEventListener('click', closeThankOrganizerModal);
            if (thankOrganizerSend) thankOrganizerSend.addEventListener('click', sendThankOrganizerFromModal);
            if (thankOrganizerModal) {
                thankOrganizerModal.addEventListener('click', function (e) {
                    if (e.target === thankOrganizerModal) closeThankOrganizerModal();
                });
            }

            var detailDeleteVolBtn = document.getElementById('detailDeleteVolBtn');
            if (detailDeleteVolBtn) {
                detailDeleteVolBtn.addEventListener('click', function () {
                    var id = state.currentDetailId;
                    var vol = id && state.vols[id];
                    if (!vol || !isOwnVol(vol)) return;
                    if (!window.confirm('この募集を削除しますか？')) return;
                    delete state.vols[id];
                    delete state.myHostedVolIds[id];
                    var nextList = loadUserVols().filter(function (x) { return x && x.id !== id; });
                    saveUserVols(nextList);
                    liveSyncDeleteVolRemote(id);
                    liveSyncPruneNotificationsForVol(id);
                    state._bundleNotificationsRaw = (state._bundleNotificationsRaw || []).filter(function (n) {
                        return !n || n.volId !== id;
                    });
                    state._fsNotificationRows = (state._fsNotificationRows || []).filter(function (n) {
                        return !n || n.volId !== id;
                    });
                    mergeNotificationsIntoState();
                    var card = document.querySelector('[data-open-detail="' + id + '"]');
                    if (card && card.parentNode) card.parentNode.removeChild(card);
                    renderSearchResults();
                    renderAccount();
                    var homeNav = document.querySelector('.bottom-nav .nav-item[data-section="home"]');
                    showSection('home', homeNav);
                    showToast('募集を削除しました');
                });
            }

            // Detail DM -> chat
            var detailDmBtn = document.getElementById('detailDmBtn');
            if (detailDmBtn) detailDmBtn.addEventListener('click', function () {
                var who = detailDmBtn.dataset.chatWith || '主催者';
                var peer = detailDmBtn.dataset.organizerUserId || '';
                ensureThread(who, peer, 'organizer');
                openChat(who, peer);
                setUnreadFlag();
            });

            // Organizer DM -> chat
            var organizerDmBtn = document.getElementById('organizerDmBtn');
            if (organizerDmBtn) organizerDmBtn.addEventListener('click', function () {
                var who = organizerDmBtn.dataset.chatWith || '主催者';
                var peer = state.currentOrganizerUserId || '';
                ensureThread(who, peer, 'organizer');
                openChat(who, peer);
                setUnreadFlag();
            });

            // Search filters
            function toggleFilter(btn, key) {
                if (!btn) return;
                btn.addEventListener('click', function () {
                    state.filters[key] = !state.filters[key];
                    btn.setAttribute('aria-pressed', String(state.filters[key]));
                    btn.style.background = state.filters[key] ? '#282828' : '#1f1f1f';
                    btn.style.color = state.filters[key] ? 'var(--text-sub)' : '#6a6a6a';
                    renderSearchResults();
                });
                btn.style.background = state.filters[key] ? '#282828' : '#1f1f1f';
                btn.style.color = state.filters[key] ? 'var(--text-sub)' : '#6a6a6a';
            }
            toggleFilter(document.getElementById('filterNear'), 'near');
            toggleFilter(document.getElementById('filterThisWeek'), 'thisWeek');
            toggleFilter(document.getElementById('filterRemote'), 'remote');

            var searchQ = document.getElementById('search-q');
            if (searchQ) {
                searchQ.addEventListener('input', function () {
                    state.filters.q = searchQ.value || '';
                    renderSearchResults();
                });
            }

            // Chat send
            var chatSend = document.getElementById('chatSend');
            var chatText = document.getElementById('chatText');
            var chatMessages = document.getElementById('chatMessages');
            var chatThanksSend = document.getElementById('chatThanksSend');
            function sendChat() {
                if (!chatText || !chatMessages) return;
                var v = (chatText.value || '').trim();
                if (!v) return;
                var th = findChatThread();
                appendOutgoingDm(state.currentChatWith || 'DM', v, th && th.peerUserId ? th.peerUserId : '');
                chatText.value = '';
                window.requestAnimationFrame(function () {
                    if (chatText) chatText.value = '';
                });
                renderChat();
                renderDmThreads();
            }
            if (chatSend) chatSend.addEventListener('click', sendChat);
            if (chatText) chatText.addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return;
                if (e.isComposing || e.keyCode === 229) return;
                e.preventDefault();
                sendChat();
            });
            if (chatThanksSend) {
                chatThanksSend.addEventListener('click', function () {
                    var toName = state.currentChatWith || '相手';
                    var toUid = state.currentChatPeerUserId || '';
                    if (!canHostSendThanksToUser(toUid, toName)) {
                        showToast('参加者側からはありがとうを送れません（主催者のみ送信できます）');
                        return;
                    }
                    openThankOrganizerModal(toName, 'DM', toUid);
                });
            }

            window.__tfSyncSaveUserVolsFromState = function () {
                var list = Object.keys(state.vols || {}).filter(function (k) {
                    return k.indexOf('vol-user-') === 0;
                }).map(function (k) {
                    return state.vols[k];
                }).filter(function (v) {
                    return v && isOwnVol(v);
                });
                saveUserVols(list);
            };

            var accountProfileEditBtn = document.getElementById('accountProfileEditBtn');
            if (accountProfileEditBtn) {
                accountProfileEditBtn.addEventListener('click', function () {
                    navigateTo('accountProfileEdit');
                });
            }
            var accountSettingsBtn = document.getElementById('accountSettingsBtn');
            if (accountSettingsBtn) accountSettingsBtn.addEventListener('click', openAccountSettingsModal);
            var accountSettingsCloseBtn = document.getElementById('accountSettingsCloseBtn');
            if (accountSettingsCloseBtn) accountSettingsCloseBtn.addEventListener('click', closeAccountSettingsModal);
            var accountLogoutBtn = document.getElementById('accountLogoutBtn');
            if (accountLogoutBtn) accountLogoutBtn.addEventListener('click', logoutFirebaseUser);
            var accountSettingsModal = document.getElementById('accountSettingsModal');
            if (accountSettingsModal) {
                accountSettingsModal.addEventListener('click', function (e) {
                    if (e.target === accountSettingsModal) closeAccountSettingsModal();
                });
            }
            var profileSaveBtn = document.getElementById('profileSaveBtn');
            if (profileSaveBtn) profileSaveBtn.addEventListener('click', saveProfileFromForm);
            var profilePhotoIn = document.getElementById('profileEditPhoto');
            if (profilePhotoIn) {
                profilePhotoIn.addEventListener('change', function () {
                    var f = profilePhotoIn.files && profilePhotoIn.files[0];
                    if (!f) return;
                    fileToResizedJpegDataURL(f, 320, 0.82, function (err, url) {
                        profilePhotoIn.value = '';
                        if (err || !url) {
                            showToast('画像を読み込めませんでした');
                            return;
                        }
                        state.profile.photoDataUrl = url;
                        applyProfileToAccountDom();
                        renderProfilePhotoPreview();
                        refreshOwnHomeCardIcons();
                        savePersistedProfile();
                        if (liveSyncEnabled() && getMyUserId()) {
                            liveSyncPatchProfile({ photoDataUrl: state.profile.photoDataUrl || '' }, function () {});
                        }
                        showToast('プロフィール画像を更新しました');
                    });
                });
            }
            var profilePhotoClr = document.getElementById('profileEditPhotoClear');
            if (profilePhotoClr) profilePhotoClr.addEventListener('click', function () {
                state.profile.photoDataUrl = '';
                applyProfileToAccountDom();
                renderProfilePhotoPreview();
                refreshOwnHomeCardIcons();
                savePersistedProfile();
                if (liveSyncEnabled() && getMyUserId()) {
                    liveSyncPatchProfile({ photoDataUrl: '' }, function () {});
                }
                showToast('プロフィール画像を削除しました');
            });

            var accountPhoneLoginBtn = document.getElementById('accountPhoneLoginBtn');
            if (accountPhoneLoginBtn) accountPhoneLoginBtn.addEventListener('click', openPhoneAuthModal);
            var phoneAuthSendBtn = document.getElementById('phoneAuthSendBtn');
            if (phoneAuthSendBtn) phoneAuthSendBtn.addEventListener('click', phoneAuthSendCode);
            var phoneAuthVerifyBtn = document.getElementById('phoneAuthVerifyBtn');
            if (phoneAuthVerifyBtn) phoneAuthVerifyBtn.addEventListener('click', phoneAuthVerifySubmit);
            var phoneAuthCancelBtn = document.getElementById('phoneAuthCancelBtn');
            if (phoneAuthCancelBtn) phoneAuthCancelBtn.addEventListener('click', closePhoneAuthModal);
            var phoneAuthModal = document.getElementById('phoneAuthModal');
            if (phoneAuthModal) {
                phoneAuthModal.addEventListener('click', function (e) {
                    if (e.target === phoneAuthModal) closePhoneAuthModal();
                });
            }

            // Initial render
            renderAccount();
            renderSearchResults();
            updateHomeEmptyState();
            renderDmThreads();
            renderNotifications();
            setUnreadFlag();
            updateNotifBadge();

            if (liveSyncEnabled()) {
                if (firebaseSyncActive()) {
                    attachFirebaseBundleListener();
                } else {
                    var doPurge = false;
                    try {
                        doPurge = new URLSearchParams(window.location.search).get('purgeServerVols') === '1';
                    } catch (_) {}
                    if (doPurge) {
                        var pb = getLiveSyncBase();
                        fetch(pb + '/api/dev/clear-user-vols', { method: 'POST' })
                            .then(function (r) { return r.json().catch(function () { return null; }); })
                            .then(function (j) {
                                try {
                                    var u = new URL(window.location.href);
                                    u.searchParams.delete('purgeServerVols');
                                    window.history.replaceState({}, '', u.pathname + u.search + u.hash);
                                } catch (_) {}
                                if (j && j.ok) {
                                    showToast('サーバー上のユーザ募集を' + String(j.removed || 0) + '件削除しました');
                                } else {
                                    showToast('サーバーから募集を消せませんでした（127.0.0.1 で同期サーバーを開いているか確認）');
                                }
                                liveSyncPullOnce();
                            })
                            .catch(function () {
                                showToast('同期サーバーに接続できませんでした');
                            });
                        window.setInterval(liveSyncPullOnce, 2800);
                    } else {
                        window.setTimeout(liveSyncPullOnce, 300);
                        window.setInterval(liveSyncPullOnce, 2800);
                    }
                }
            }
            });
        }
