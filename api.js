/**
 * Firestore / Firebase Auth API（購読・投稿同期・参加申請/DM のサーバー書き込み）
 */
        var teertabUserDefaultListenerAttached = false;
        var teertabUserDocUnsub = null;
        var teertabUserCardsUnsub = null;
        var teertabFsNotificationsUnsub = null;
        /** 参加通知バッジ専用: viewedJoinState==false のみ（DM の unseen は chats を参照） */
        var teertabFsNotificationsUnreadUnsub = null;
        var teertabFsApplicationsOwnerUnsub = null;
        var teertabFsApplicationsApplicantUnsub = null;
        var teertabFsChatsUnsub = null;
        var teertabFsChatMessagesUnsub = null;


        var currentUserDocRef = null;


        function tf() {
            return window.__TF && window.__TF.ready ? window.__TF : null;
        }

        function getCurrentUserDocRef() {
            var TF = tf();
            if (!TF || !TF.userDocRef) return null;
            var uid = getMyUserId();
            if (!uid) return null;
            if (!currentUserDocRef || currentUserDocRef.id !== uid) {
                currentUserDocRef = TF.userDocRef(uid);
            }
            return currentUserDocRef;
        }

        function getPostsColRef() {
            var TF = tf();
            if (!TF || !TF.postsColRef) return null;
            return TF.postsColRef();
        }


        function teertabParseDataUrlForUpload(dataUrl) {
            var s = String(dataUrl || '');
            var m = s.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
            if (!m) return null;
            return { contentType: m[1], base64: m[2] };
        }

        function teertabUploadDataUrlToStorage(path, dataUrl) {
            var TF = tf();
            if (!TF) return Promise.reject(new Error('no storage'));
            var parsed = teertabParseDataUrlForUpload(dataUrl);
            if (!parsed) return Promise.reject(new Error('bad data url'));
            var r = TF.storageRef(TF.storage, path);
            return TF.uploadString(r, parsed.base64, 'base64', { contentType: parsed.contentType }).then(function () {
                return TF.getDownloadURL(r);
            });
        }


        function teertabFirestoreEnsureBundleThenUpdate(fields) {
            var TF = tf();
            if (!TF) return Promise.reject(new Error('no bundle ref'));
            return TF.getDoc(TF.bundleRef).then(function (snap) {
                if (!snap.exists) {
                    return TF.setDoc(TF.bundleRef, {
                        vols: {},
                        notifications: [],
                        dmThreads: {},
                        usersPublic: {}
                    }).then(function () {
                        return TF.updateDoc(TF.bundleRef, fields);
                    });
                }
                return TF.updateDoc(TF.bundleRef, fields);
            });
        }


        function migrateLegacyLocalStorageToFirestoreOnce() {
            try {
                var uid = getMyUserId();
                if (!tf() || !uid) return Promise.resolve();
                var migratedKey = 'teertab.firestoreMigrated.' + uid + '.v1';
                if (localStorage.getItem(migratedKey)) return Promise.resolve();
                var patch = {};
                var legacyCards = [];
                var prof = localStorage.getItem('tealfolder.profile.v1');
                if (prof) {
                    try {
                        var o = JSON.parse(prof);
                        if (o && typeof o === 'object') {
                            if (typeof o.name === 'string' && o.name.trim()) patch.name = o.name.trim().slice(0, 80);
                            if (typeof o.avatar === 'string' && o.avatar.trim()) patch.avatar = o.avatar.trim().slice(0, 8);
                            if (typeof o.bio === 'string') patch.bio = o.bio.slice(0, 500);
                            if (typeof o.thanksCount === 'number' && isFinite(o.thanksCount) && o.thanksCount >= 0) {
                                patch.thanksCount = Math.floor(o.thanksCount);
                            }
                            if (typeof o.photoDataUrl === 'string' && o.photoDataUrl.indexOf('http') === 0) {
                                patch.photoStorageUrl = o.photoDataUrl.trim();
                            }
                        }
                    } catch (_) {}
                }
                var vols = localStorage.getItem('tealfolder.userVols.v1');
                if (vols) {
                    try {
                        var arr = JSON.parse(vols);
                        if (Array.isArray(arr)) legacyCards = arr;
                    } catch (_) {}
                }
                var dis = localStorage.getItem('tealfolder.dismissedNotifs.v1');
                if (dis) {
                    try {
                        var m = JSON.parse(dis);
                        if (m && typeof m === 'object') patch.dismissedNotifs = m;
                    } catch (_) {}
                }
                var TFm = tf();
                var done = function () {
                    try {
                        localStorage.setItem(migratedKey, '1');
                    } catch (_) {}
                };
                var userDocRef = getCurrentUserDocRef();
                if (!userDocRef) {
                    done();
                    return Promise.resolve();
                }
                if (Object.keys(patch).length) {
                    return TFm.setDoc(userDocRef, Object.assign({}, patch, { updatedAt: TFm.serverTimestamp() }), { merge: true })
                        .then(function () { return migrateLegacyPostsToFirestore(legacyCards); })
                        .then(done)
                        .catch(done);
                }
                if (legacyCards.length) {
                    return migrateLegacyPostsToFirestore(legacyCards)
                        .then(done)
                        .catch(done);
                }
                done();
                return Promise.resolve();
            } catch (_) {
                return Promise.resolve();
            }
        }

        function applyUserDefaultDocToState(data) {
            if (!data || typeof data !== 'object') return;
            var hasNameField = Object.prototype.hasOwnProperty.call(data, 'name');
            var hasDisplayNameField = Object.prototype.hasOwnProperty.call(data, 'displayName');
            var displayName = '';
            if (typeof data.displayName === 'string') displayName = data.displayName.trim();
            else if (typeof data.name === 'string') displayName = data.name.trim();
            if (hasNameField || hasDisplayNameField) {
                state.profile.name = displayName ? displayName.slice(0, 80) : '';
            }
            if (typeof data.avatar === 'string' && data.avatar.trim()) state.profile.avatar = data.avatar.trim().slice(0, 8);
            if (typeof data.bio === 'string') state.profile.bio = data.bio.slice(0, 500);
            if (typeof data.thanksCount === 'number' && isFinite(data.thanksCount) && data.thanksCount >= 0) {
                state.profile.thanksCount = Math.floor(data.thanksCount);
            }
            var hasPhotoStorageUrlField = Object.prototype.hasOwnProperty.call(data, 'photoStorageUrl');
            var hasPhotoURLField = Object.prototype.hasOwnProperty.call(data, 'photoURL');
            var hasPhotoDataUrlField = Object.prototype.hasOwnProperty.call(data, 'photoDataUrl');
            var pic = '';
            if (typeof data.photoStorageUrl === 'string' && data.photoStorageUrl.trim()) pic = data.photoStorageUrl.trim();
            else if (typeof data.photoURL === 'string' && data.photoURL.trim()) pic = data.photoURL.trim();
            else if (typeof data.photoDataUrl === 'string' && data.photoDataUrl.trim()) pic = data.photoDataUrl.trim();
            if (hasPhotoStorageUrlField || hasPhotoURLField || hasPhotoDataUrlField) {
                state.profile.photoDataUrl = pic || '';
            }
            if (data.dismissedNotifs && typeof data.dismissedNotifs === 'object') {
                state.dismissedNotifsRemote = Object.assign({}, data.dismissedNotifs);
            }
            state.userDefaultHydrated = true;
            applyProfileToAccountDom();
            if (typeof liveSyncReconcileHomeCards === 'function') liveSyncReconcileHomeCards();
            renderProfilePhotoPreview();
            if (typeof refreshOwnHomeCardIcons === 'function') refreshOwnHomeCardIcons();
            if (typeof refreshAllHomeCardIcons === 'function') refreshAllHomeCardIcons();
            renderAccount();
            renderSearchResults();
        }

        function reloadUserProfileFromFirestore() {
            var TF = tf();
            var userDocRef = getCurrentUserDocRef();
            if (!TF || !userDocRef) return Promise.resolve(false);
            return TF.getDoc(userDocRef)
                .then(function (snap) {
                    if (snap.exists) {
                        applyUserDefaultDocToState(snap.data());
                        return true;
                    }
                    return false;
                })
                .catch(function () { return false; });
        }

        function refreshAccountViewFromFirestore() {
            var seq = ++accountViewRefreshSeq;
            return reloadUserProfileFromFirestore().then(function () {
                if (seq !== accountViewRefreshSeq) return false;
                // Firestore を正として、取得完了後に描画する
                applyProfileToAccountDom();
                renderAccount();
                populateProfileEditForm();
                return true;
            });
        }

        function attachUserDefaultFirestoreListener() {
            var TFu = tf();
            if (!TFu || teertabUserDefaultListenerAttached) return;
            var userDocRef = getCurrentUserDocRef();
            if (!userDocRef) return;
            teertabUserDefaultListenerAttached = true;
            teertabUserDocUnsub = TFu.onSnapshot(userDocRef, function (snap) {
                if (!snap.exists) return;
                applyUserDefaultDocToState(snap.data());
            });
        }

        function applyPostsToState(cards) {
            var nextList = Array.isArray(cards) ? cards.filter(function (v) {
                return v && typeof v.id === 'string' && v.id.indexOf('vol-user-') === 0;
            }) : [];
            var idsInPosts = {};
            var myUid = getMyUserId();
            nextList.forEach(function (raw) {
                var v = Object.assign({}, raw);
                v.id = v.id || raw.id;
                idsInPosts[v.id] = true;
                if (v.authorId) v.hostedByUserId = v.authorId;
                else if (v.hostedByUserId) v.authorId = v.hostedByUserId;
                var disp = String(v.authorName || v.chatWith || '').trim();
                if (disp) v.chatWith = disp.slice(0, 80);
                state.vols[v.id] = v;
            });
            Object.keys(state.vols || {}).forEach(function (k) {
                if (k.indexOf('vol-user-') !== 0) return;
                if (!idsInPosts[k]) delete state.vols[k];
            });
            var mine = nextList.filter(function (v) {
                return myUid && v.authorId === myUid;
            });
            state.userDefaultHostedVols = mine;
            state.myHostedVolIds = {};
            mine.forEach(function (v) {
                if (v && v.id) state.myHostedVolIds[v.id] = true;
            });
            renderSearchResults();
            renderAccount();
            renderHomeCardsFromState();
        }

        function attachUserCardsFirestoreListener() {
            var TF = tf();
            var col = getPostsColRef();
            if (!TF || !col) return;
            /** ログアウトまで一度だけ購読。解除→再接続のちらつきと、キャッシュ空の一時スナップショットでの全消しを防ぐ */
            if (typeof teertabUserCardsUnsub === 'function') return;
            teertabUserCardsUnsub = TF.onSnapshot(
                col,
                function (snap) {
                    var cards = [];
                    var sigParts = [];
                    snap.forEach(function (d) {
                        var card = d.data() || {};
                        card.id = card.id || d.id;
                        cards.push(card);
                        var updatedAt = card.updatedAt;
                        var updatedSig = '';
                        if (updatedAt && typeof updatedAt.toMillis === 'function') {
                            updatedSig = String(updatedAt.toMillis());
                        } else if (updatedAt && typeof updatedAt === 'object' && typeof updatedAt.seconds === 'number') {
                            updatedSig = String(updatedAt.seconds) + ':' + String(updatedAt.nanoseconds || 0);
                        }
                        sigParts.push([
                            card.id || '',
                            card.title || '',
                            card.authorId || '',
                            card.joined || 0,
                            card.capacity || 0,
                            card.image ? 1 : 0,
                            updatedSig
                        ].join('|'));
                    });
                    sigParts.sort();
                    var sig = sigParts.join('||');
                    var fromCache = !!(snap.metadata && snap.metadata.fromCache);
                    var hasCachedPostsInState = Object.keys(state.vols || {}).some(function (k) {
                        if (k.indexOf('vol-user-') !== 0) return false;
                        var v = state.vols[k];
                        return v && !isVolFilled(v);
                    });
                    /** キャッシュのみ・0件のイベントで state を空にしない（タブ復帰・WebView でよくある） */
                    if (!cards.length && fromCache) {
                        if (state.homePostsLoadedOnce || hasCachedPostsInState) {
                            state.homePostsLoading = false;
                            updateHomeEmptyState();
                            return;
                        }
                        state.homePostsLoading = true;
                        updateHomeEmptyState();
                        return;
                    }
                    state.homePostsLoading = false;
                    if (state.homePostsLoadedOnce && state._postsSnapshotSig === sig) {
                        updateHomeEmptyState();
                        return;
                    }
                    state.homePostsLoadedOnce = true;
                    state._postsSnapshotSig = sig;
                    applyPostsToState(cards);
                },
                function (e) {
                    console.warn('Teertab posts listener', e);
                }
            );
        }

        function upsertPostDocument(v) {
            var TF = tf();
            var uid = getMyUserId();
            if (!TF || !v || !v.id || !uid || !TF.postDocRef) return;
            var payload = Object.assign({}, v);
            var latestName = getLatestProfileDisplayName();
            payload.authorId = uid;
            payload.authorName = latestName;
            payload.authorPhotoUrl = String(state.profile.photoDataUrl || payload.authorPhotoUrl || '').trim();
            payload.hostedByUserId = uid;
            payload.chatWith = latestName;
            payload.updatedAt = TF.serverTimestamp();
            TF.setDoc(TF.postDocRef(v.id), payload, { merge: true }).catch(function () {});
        }

        function migrateLegacyPostsToFirestore(legacyCards) {
            var TF = tf();
            var uid = getMyUserId();
            if (!TF || !uid || !TF.postDocRef || !legacyCards || !legacyCards.length) return Promise.resolve();
            var name = String(state.profile.name || state.auth.displayName || '').trim().slice(0, 80) || 'ユーザーネーム';
            var jobs = legacyCards
                .filter(function (v) {
                    return v && typeof v.id === 'string' && v.id.indexOf('vol-user-') === 0;
                })
                .map(function (v) {
                    var payload = Object.assign({}, v);
                    payload.authorId = uid;
                    payload.authorName = name;
                    payload.authorPhotoUrl = String(state.profile.photoDataUrl || payload.authorPhotoUrl || '').trim();
                    payload.hostedByUserId = uid;
                    if (!payload.chatWith) payload.chatWith = name;
                    payload.updatedAt = TF.serverTimestamp();
                    return TF.setDoc(TF.postDocRef(v.id), payload, { merge: true });
                });
            return Promise.all(jobs).catch(function () {});
        }

        function syncMyPostsToFirestore(clean, prevList) {
            var TF = tf();
            var uid = getMyUserId();
            if (!TF || !uid || !TF.postDocRef) return;
            var prevIds = {};
            (prevList || []).forEach(function (v) {
                if (v && v.id) prevIds[v.id] = true;
            });
            var nextIds = {};
            (clean || []).forEach(function (v) {
                if (v && v.id) nextIds[v.id] = true;
            });
            Object.keys(prevIds).forEach(function (id) {
                if (!nextIds[id]) TF.deleteDoc(TF.postDocRef(id)).catch(function () {});
            });
            (clean || []).forEach(function (v) {
                upsertPostDocument(v);
            });
        }


        function flushUserDefaultDoc() {
            var TF = tf();
            if (!TF) return Promise.resolve(false);
            var userDocRef = getCurrentUserDocRef();
            if (!userDocRef) return Promise.resolve(false);
            var url = String(state.profile.photoDataUrl || '').trim();
            var photoStorageUrl = url.indexOf('http') === 0 ? url : '';
            var payload = {
                name: state.profile.name || '',
                displayName: state.profile.name || '',
                avatar: state.profile.avatar || '🙂',
                bio: state.profile.bio || '',
                thanksCount:
                    typeof state.profile.thanksCount === 'number' && isFinite(state.profile.thanksCount)
                        ? Math.max(0, Math.floor(state.profile.thanksCount))
                        : 10,
                photoStorageUrl: photoStorageUrl,
                photoURL: photoStorageUrl,
                updatedAt: TF.serverTimestamp()
            };
            if (state.dismissedNotifsRemote && typeof state.dismissedNotifsRemote === 'object') {
                payload.dismissedNotifs = state.dismissedNotifsRemote;
            }
            return TF.setDoc(userDocRef, payload, { merge: true })
                .then(function () { return true; })
                .catch(function () { return false; });
        }


        function detachFirestoreChatMessagesListener() {
            if (typeof teertabFsChatMessagesUnsub === 'function') teertabFsChatMessagesUnsub();
            teertabFsChatMessagesUnsub = null;
        }

        function detachFirestoreJoinFlowListeners() {
            if (typeof teertabFsNotificationsUnreadUnsub === 'function') teertabFsNotificationsUnreadUnsub();
            teertabFsNotificationsUnreadUnsub = null;
            if (typeof teertabFsNotificationsUnsub === 'function') teertabFsNotificationsUnsub();
            teertabFsNotificationsUnsub = null;
            if (typeof teertabFsApplicationsOwnerUnsub === 'function') teertabFsApplicationsOwnerUnsub();
            teertabFsApplicationsOwnerUnsub = null;
            if (typeof teertabFsApplicationsApplicantUnsub === 'function') teertabFsApplicationsApplicantUnsub();
            teertabFsApplicationsApplicantUnsub = null;
            if (typeof teertabFsChatsUnsub === 'function') teertabFsChatsUnsub();
            teertabFsChatsUnsub = null;
            detachFirestoreChatMessagesListener();
            state._fsNotificationRows = [];
            state._fsPendingOwnerApplicationCount = 0;
            state._fsJoinNotifUnreadFromQuery = 0;
            state._fsHasDmUnread = false;
            setUnreadFlag();
        }

        function rebuildFsNotificationsFromQuerySnapshot(snap) {
            var rows = [];
            snap.forEach(function (d) {
                rows.push(fsNotificationDocToUi(d));
            });
            state._fsNotificationRows = rows;
            mergeNotificationsIntoState();
        }

        function rebuildFsUnreadJoinNotificationsFromQuerySnapshot(snap) {
            state._fsJoinNotifUnreadFromQuery = snap.size;
            try {
                console.log(
                    '[Teertab] 参加通知未読 onSnapshot where(viewedJoinState==false):',
                    snap.size,
                    snap.docs.map(function (d) {
                        return d.id;
                    })
                );
            } catch (_) {}
            updateNotifBadge();
            syncAccountTabNotifDot();
        }

        function findThreadByFirestoreChatId(cid) {
            if (!cid) return null;
            return (
                (state.threads || []).find(function (t) {
                    return t && t.firestoreChatId === cid;
                }) || null
            );
        }

        function attachFirestoreChatMessagesListener(chatId) {
            var TF = tf();
            if (!TF || !chatId || !TF.chatMessagesColRef || !TF.orderBy) return;
            detachFirestoreChatMessagesListener();
            var col = TF.chatMessagesColRef(chatId);
            var mq = TF.query(col, TF.orderBy('createdAt', 'asc'), TF.limit(200));
            var myUid = getMyUserId() || '';
            var myDev = getDeviceOwnerKey();
            teertabFsChatMessagesUnsub = TF.onSnapshot(
                mq,
                function (snap) {
                    var th = findThreadByFirestoreChatId(chatId);
                    if (!th) return;
                    th.messages = [];
                    snap.forEach(function (d) {
                        var row = d.data() || {};
                        var fromUid = String(row.senderId || '');
                        var isMe = fromUid && myUid ? fromUid === myUid : false;
                        var ms = fsTimestampToMs(row.createdAt) || Date.now();
                        insertDmSorted(th, {
                            id: d.id,
                            me: isMe,
                            text: String(row.text || ''),
                            fromUserId: fromUid,
                            device: String(row.device || ''),
                            name: String(row.senderName || ''),
                            at: ms
                        });
                    });
                    if (th.messages.length) th.lastAt = '今';
                    var chatEl = document.getElementById('chat');
                    var viewing = !!(chatEl && chatEl.classList.contains('active') && threadMatchesOpenChat(th));
                    if (viewing) {
                        renderChat();
                        clearFirestoreChatUnseenForMe(chatId).finally(function () {
                            setUnreadFlag();
                            renderDmThreads();
                        });
                    } else {
                        setUnreadFlag();
                        renderDmThreads();
                    }
                },
                function (e) {
                    console.warn('Teertab chat messages listener', e);
                }
            );
        }

        function attachFirestoreJoinFlowListeners() {
            var TF = tf();
            if (!TF || !useFirestoreJoinFlow()) return;
            detachFirestoreJoinFlowListeners();
            var uid = getMyUserId();
            try {
                var nq = TF.query(TF.notificationsColRef(), TF.where('recipientId', '==', uid), TF.limit(80));
                teertabFsNotificationsUnsub = TF.onSnapshot(nq, rebuildFsNotificationsFromQuerySnapshot, function (e) {
                    console.warn('Teertab notifications listener', e);
                });
            } catch (err) {
                console.warn('Teertab notifications query', err);
            }
            try {
                var nqUnread = TF.query(
                    TF.notificationsColRef(),
                    TF.where('recipientId', '==', uid),
                    TF.where('viewedJoinState', '==', false),
                    TF.limit(80)
                );
                teertabFsNotificationsUnreadUnsub = TF.onSnapshot(
                    nqUnread,
                    rebuildFsUnreadJoinNotificationsFromQuerySnapshot,
                    function (e) {
                        console.warn('Teertab notifications unread listener', e);
                    }
                );
            } catch (errUnread) {
                console.warn('Teertab notifications unread query', errUnread);
            }
            try {
                var qOwn = TF.query(TF.applicationsColRef(), TF.where('ownerId', '==', uid), TF.limit(60));
                teertabFsApplicationsOwnerUnsub = TF.onSnapshot(
                    qOwn,
                    function (snap) {
                        var c = 0;
                        snap.forEach(function (d) {
                            var x = d.data() || {};
                            if (String(x.status || 'pending') === 'pending') c++;
                        });
                        state._fsPendingOwnerApplicationCount = c;
                        updateHomeJoinRequestBanner();
                    },
                    function (e) {
                        console.warn('Teertab applications owner listener', e);
                    }
                );
            } catch (err2) {
                console.warn('Teertab applications owner query', err2);
            }
            try {
                var qApp = TF.query(TF.applicationsColRef(), TF.where('applicantId', '==', uid), TF.limit(60));
                teertabFsApplicationsApplicantUnsub = TF.onSnapshot(
                    qApp,
                    function () {
                        syncDetailActionBars();
                    },
                    function (e) {
                        console.warn('Teertab applications applicant listener', e);
                    }
                );
            } catch (err3) {
                console.warn('Teertab applications applicant query', err3);
            }
            try {
                var cq = TF.query(TF.chatsColRef(), TF.where('participantIds', 'array-contains', uid), TF.limit(40));
                teertabFsChatsUnsub = TF.onSnapshot(
                    cq,
                    function (snap) {
                        applyFirestoreChatsSnapshotForDmUnread(snap, uid);
                    },
                    function (e) {
                        console.warn('Teertab chats listener', e);
                    }
                );
            } catch (err4) {
                console.warn('Teertab chats query', err4);
            }
        }

        /** chats コレクションの onSnapshot: 未読カウンタとスレッド一覧の ● を同期（リロード不要） */
        function applyFirestoreChatsSnapshotForDmUnread(snap, myUid) {
            myUid = String(myUid || '').trim();
            if (!myUid) {
                state._fsHasDmUnread = false;
                setUnreadFlag();
                return;
            }
            var openChatId = getOpenFirestoreChatIdIfOnChatTab();
            var anyUnread = false;
            var openRoomRawUnread = 0;
            snap.forEach(function (d) {
                var data = d.data() || {};
                var ids = Array.isArray(data.participantIds) ? data.participantIds : [];
                var peerUid =
                    ids.filter(function (x) {
                        return x && x !== myUid;
                    })[0] || '';
                var peerName = displayNameForUserId(peerUid) || 'DM';
                var th = ensureThread(peerName, peerUid);
                th.firestoreChatId = d.id;
                if (data.postId || data.volId) th.relatedVolId = String(data.postId || data.volId || '');
                var rawUn = data.unseenCountByUser;
                var rawCnt = rawUn && typeof rawUn === 'object' ? Number(rawUn[myUid]) || 0 : 0;
                if (openChatId && d.id === openChatId) openRoomRawUnread = rawCnt;
                var viewingThis = openChatId && d.id === openChatId;
                var displayCnt = viewingThis ? 0 : rawCnt;
                if (displayCnt > 0) anyUnread = true;
                th.unread = displayCnt > 0;
            });
            state._fsHasDmUnread = anyUnread;
            setUnreadFlag();
            renderDmThreads();
            if (document.getElementById('chat') && document.getElementById('chat').classList.contains('active')) {
                renderChat();
            }
            if (openChatId && openRoomRawUnread > 0) {
                clearFirestoreChatUnseenForMe(openChatId);
            }
        }

        /** チャット詳細を開いているときの chats/{chatId}（data-tab=chat かつスレッド一致） */
        function getOpenFirestoreChatIdIfOnChatTab() {
            var shell = document.getElementById('appShell');
            if (!shell || shell.dataset.tab !== 'chat') return '';
            var th = findChatThread();
            return th && th.firestoreChatId ? String(th.firestoreChatId) : '';
        }

        /** 自分の unseen を 0 に（マップ丸ごと更新でドット記法の不整合を避ける） */
        function clearFirestoreChatUnseenForMe(chatId) {
            console.log('バッジ消去処理を実行: ', chatId);
            var TF = tf();
            var myUid = String(getMyUserId() || '').trim();
            if (!TF || !chatId || !myUid || !TF.runTransaction) return Promise.resolve();
            var ref = TF.chatDocRef(chatId);
            return TF.runTransaction(TF.db, function (transaction) {
                return transaction.get(ref).then(function (snap) {
                    if (!snap.exists) return;
                    var data = snap.data() || {};
                    var ids = Array.isArray(data.participantIds) ? data.participantIds : [];
                    if (ids.indexOf(myUid) === -1) return;
                    var raw = data.unseenCountByUser;
                    var u = raw && typeof raw === 'object' ? Object.assign({}, raw) : {};
                    var prev = Number(u[myUid]);
                    if (!isFinite(prev) || prev <= 0) return;
                    u[myUid] = 0;
                    transaction.update(ref, { unseenCountByUser: u });
                });
            }).catch(function (e) {
                console.warn('Teertab clearFirestoreChatUnseenForMe', e);
            });
        }

        /** 通知一覧を開いたとき: 自分宛の参加通知を viewedJoinState:true（joinStatus は承認状態のまま） */
        function markFirestoreJoinNotificationsSeenWhenOpeningList() {
            console.log('[Teertab] 通知一覧既読バッチ開始: notifications → updateDoc viewedJoinState:true');
            var TF = tf();
            var myUid = String(getMyUserId() || '').trim();
            if (!TF || !useFirestoreJoinFlow() || !myUid || !TF.updateDoc) return Promise.resolve();
            var tasks = [];
            (state.notifications || []).forEach(function (n) {
                if (!n || !n._firestoreNotification || n.type !== 'join_request') return;
                if (n.recipientId && n.recipientId !== myUid) return;
                if (!n._joinNotifUnread) return;
                var ref = TF.notificationDocRef(n.id);
                tasks.push(
                    TF.updateDoc(ref, { viewedJoinState: true }).then(function () {
                        console.log('[Teertab] updateDoc viewedJoinState:true OK (一覧)', n.id);
                    })
                );
            });
            if (!tasks.length) {
                console.log('[Teertab] 通知一覧既読: 対象なし');
                return Promise.resolve();
            }
            return Promise.all(tasks).catch(function (e) {
                console.warn('Teertab markFirestoreJoinNotificationsSeenWhenOpeningList', e);
            });
        }

        /** チャットルーム表示時: 当該 applicationId の参加通知を自分宛のみ既読 */
        function markFirestoreJoinNotificationsSeenForChatRoom(chatRoomId) {
            console.log('[Teertab] チャット連動既読開始:', chatRoomId, '→ updateDoc viewedJoinState:true');
            var TF = tf();
            var myUid = String(getMyUserId() || '').trim();
            var cid = String(chatRoomId || '').trim();
            if (!TF || !useFirestoreJoinFlow() || !myUid || !cid || !TF.updateDoc) return Promise.resolve();
            var tasks = [];
            (state.notifications || []).forEach(function (n) {
                if (!n || !n._firestoreNotification || n.type !== 'join_request') return;
                if (String(n.applicationId || '') !== cid) return;
                if (n.recipientId && n.recipientId !== myUid) return;
                if (!n._joinNotifUnread) return;
                var ref = TF.notificationDocRef(n.id);
                tasks.push(
                    TF.updateDoc(ref, { viewedJoinState: true }).then(function () {
                        console.log('[Teertab] updateDoc viewedJoinState:true OK (チャット)', n.id);
                    })
                );
            });
            if (!tasks.length) {
                console.log('[Teertab] チャット連動既読: 対象なし', cid);
                return Promise.resolve();
            }
            return Promise.all(tasks).catch(function (e) {
                console.warn('Teertab markFirestoreJoinNotificationsSeenForChatRoom', e);
            });
        }

        /** 1件タップ等: 参加通知ドキュメントのみ既読（DM の unseen は触らない） */
        function markFirestoreSingleJoinNotificationSeen(notifId) {
            var id = String(notifId || '').trim();
            console.log('[Teertab] 参加通知1件既読 markFirestoreSingleJoinNotificationSeen:', id);
            var TF = tf();
            var myUid = String(getMyUserId() || '').trim();
            if (!TF || !useFirestoreJoinFlow() || !myUid || !id || !TF.updateDoc) return Promise.resolve();
            return TF.updateDoc(TF.notificationDocRef(id), { viewedJoinState: true })
                .then(function () {
                    console.log('[Teertab] updateDoc viewedJoinState:true OK (単体)', id);
                })
                .catch(function (e) {
                    console.warn('[Teertab] markFirestoreSingleJoinNotificationSeen failed', id, e);
                });
        }

        function submitJoinApplicationFirestore(vol, done) {
            if (typeof done !== 'function') done = function () {};
            var TF = tf();
            var applicantId = String(getMyUserId() || '').trim();
            var rawOwner = vol && (vol.hostedByUserId || vol.authorId);
            var ownerId = rawOwner ? String(rawOwner).trim() : '';
            var postId = vol && vol.id ? String(vol.id).trim() : '';
            if (!TF || !applicantId || !ownerId || ownerId === applicantId || !postId) {
                if (!postId || !ownerId) {
                    console.error('[Teertab] submitJoinApplicationFirestore: missing postId or ownerId', {
                        postId: postId,
                        ownerId: ownerId,
                        hostedByUserId: vol && vol.hostedByUserId,
                        authorId: vol && vol.authorId
                    });
                }
                done(false);
                return;
            }
            var appCol = TF.applicationsColRef();
            var appRef = TF.doc(appCol);
            var appId = appRef.id;
            var organizerName = vol.chatWith || '募集者';
            var applicant = state.profile.name || '参加者';
            var volTitle = vol.title || '';
            var ownerNotifRef = TF.notificationDocRef(appId + '__owner');
            var applicantNotifRef = TF.notificationDocRef(appId + '__applicant');
            var commonTs = TF.serverTimestamp();
            /** ルールと完全一致: applications はこの4キーのみ（型は string / literal） */
            var applicationPayload = {
                postId: postId,
                applicantId: applicantId,
                ownerId: ownerId,
                status: 'pending'
            };
            function notifPayload(recipientId) {
                return {
                    recipientId: String(recipientId),
                    ownerId: ownerId,
                    applicantId: applicantId,
                    applicationId: appId,
                    type: 'join_request',
                    joinStatus: 'pending',
                    viewedJoinState: false,
                    volTitle: volTitle,
                    volId: postId,
                    postId: postId,
                    organizerUserId: ownerId,
                    applicantUserId: applicantId,
                    organizerName: organizerName,
                    applicantName: applicant,
                    createdAt: commonTs
                };
            }
            TF.setDoc(appRef, applicationPayload)
                .then(function () {
                    var batch = TF.writeBatch(TF.db);
                    batch.set(ownerNotifRef, notifPayload(ownerId));
                    batch.set(applicantNotifRef, notifPayload(applicantId));
                    return batch.commit();
                })
                .then(function () {
                    done(true);
                })
                .catch(function (err) {
                    var code = err && err.code ? String(err.code) : '';
                    var msg = err && err.message ? String(err.message) : String(err);
                    console.error('[Teertab] submitJoinApplicationFirestore FAILED', code, msg, err);
                    done(false, code || msg);
                });
        }

        function approveJoinApplicationFirestore(applicationId, onSuccess, onErr) {
            if (typeof onSuccess !== 'function') onSuccess = function () {};
            if (typeof onErr !== 'function') onErr = function () {};
            var TF = tf();
            if (!TF || !applicationId) {
                onErr();
                return;
            }
            TF.getDoc(TF.applicationDocRef(applicationId))
                .then(function (snap) {
                    if (!snap.exists) {
                        onErr();
                        return;
                    }
                    var app = snap.data() || {};
                    if (String(app.ownerId || '') !== getMyUserId()) {
                        showToast('権限がありません');
                        onErr();
                        return;
                    }
                    if (String(app.status || 'pending') !== 'pending') {
                        onErr();
                        return;
                    }
                    var batch = TF.writeBatch(TF.db);
                    var participantIds = [String(app.ownerId || ''), String(app.applicantId || '')].filter(Boolean).sort();
                    batch.update(TF.applicationDocRef(applicationId), { status: 'approved', approvedAt: TF.serverTimestamp() });
                    var unseenInit = {};
                    unseenInit[String(app.ownerId || '')] = 0;
                    unseenInit[String(app.applicantId || '')] = 0;
                    batch.set(
                        TF.chatDocRef(applicationId),
                        {
                            applicationId: applicationId,
                            postId: String(app.postId || ''),
                            ownerId: app.ownerId,
                            applicantId: app.applicantId,
                            participantIds: participantIds,
                            unseenCountByUser: unseenInit,
                            lastMessageAt: TF.serverTimestamp(),
                            createdAt: TF.serverTimestamp()
                        },
                        { merge: true }
                    );
                    batch.update(TF.notificationDocRef(applicationId + '__owner'), {
                        joinStatus: 'approved',
                        viewedJoinState: true
                    });
                    batch.update(TF.notificationDocRef(applicationId + '__applicant'), {
                        joinStatus: 'approved',
                        viewedJoinState: false
                    });
                    return batch.commit();
                })
                .then(function () {
                    onSuccess();
                })
                .catch(function (err) {
                    var code = err && err.code ? String(err.code) : '';
                    var msg = err && err.message ? String(err.message) : String(err);
                    console.error('[Teertab] approveJoinApplicationFirestore FAILED', code, msg, err);
                    onErr();
                });
        }

        function firestoreAppendChatMessage(chatId, text, recipientUserId) {
            var TF = tf();
            var myUid = getMyUserId() || '';
            var peer = String(recipientUserId || '').trim();
            if (!TF || !chatId || !TF.chatMessagesColRef || !TF.writeBatch) {
                return Promise.reject(new Error('bad message'));
            }
            var dev = getDeviceOwnerKey();
            var nm = syncAccountNameFromDom();
            var msgRef = TF.doc(TF.chatMessagesColRef(chatId));
            var batch = TF.writeBatch(TF.db);
            batch.set(msgRef, {
                senderId: myUid,
                senderName: nm,
                device: dev,
                text: String(text || '').slice(0, 8000),
                createdAt: TF.serverTimestamp()
            });
            if (peer && peer !== myUid && TF.increment) {
                var chatRef = TF.chatDocRef(chatId);
                var chatUpd = { lastMessageAt: TF.serverTimestamp() };
                chatUpd['unseenCountByUser.' + peer] = TF.increment(1);
                batch.update(chatRef, chatUpd);
            }
            return batch.commit();
        }


        function signInWithGoogle() {
            var TF = tf();
            if (!TF || !TF.auth) return Promise.reject(new Error('auth not ready'));
            var provider = new TF.GoogleAuthProvider();
            provider.setCustomParameters({ prompt: 'select_account' });
            return TF.signInWithPopup(TF.auth, provider);
        }

        function formatFirebaseAuthError(err) {
            var code = err && err.code ? String(err.code) : '';
            if (code === 'auth/invalid-email') return 'メールアドレスの形式が正しくありません';
            if (code === 'auth/user-disabled') return 'このアカウントは無効化されています';
            if (code === 'auth/user-not-found') return 'ユーザーが見つかりません。新規登録するか、メールアドレスを確認してください';
            if (code === 'auth/wrong-password') return 'パスワードが正しくありません';
            if (code === 'auth/invalid-credential') return 'メールアドレスまたはパスワードが正しくありません';
            if (code === 'auth/invalid-login-credentials') return 'メールアドレスまたはパスワードが正しくありません';
            if (code === 'auth/email-already-in-use') return 'このメールアドレスは既に登録されています';
            if (code === 'auth/weak-password') return 'パスワードが弱すぎます（6文字以上を推奨）';
            if (code === 'auth/network-request-failed') return 'ネットワークエラーです。接続を確認してください';
            var msg = (err && err.message) ? String(err.message) : '';
            return msg || '認証に失敗しました';
        }

        function signInWithEmailPassword(email, password) {
            var TF = tf();
            if (!TF || !TF.auth || !TF.signInWithEmailAndPassword) {
                return Promise.reject(new Error('auth not ready'));
            }
            return TF.signInWithEmailAndPassword(TF.auth, String(email || '').trim(), String(password || ''));
        }

        function createUserWithEmailPassword(email, password) {
            var TF = tf();
            if (!TF || !TF.auth || !TF.createUserWithEmailAndPassword) {
                return Promise.reject(new Error('auth not ready'));
            }
            return TF.createUserWithEmailAndPassword(TF.auth, String(email || '').trim(), String(password || ''));
        }
