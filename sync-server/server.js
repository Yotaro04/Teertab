'use strict';

/**
 * TealFolder 同期サーバー（簡易認証・バンドル同期）
 *
 * 起動: npm install && npm start
 * ブラウザ: http://127.0.0.1:3847/index.html?sync=auto
 * 別端末: 同じLANの IP で上記を開く（例: http://192.168.1.10:3847/index.html?sync=auto）
 *
 * 同期対象: vol-user-*、通知、DM、ユーザー（表示名・自己紹介・シークレット）
 * POST/PATCH の一部は X-Teal-User-Id + X-Teal-Secret 必須（GET /api/bundle は公開）
 *
 * Phone login: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM. Dev: TEAL_SMS_DEV=1 (OTP in console).
 *
 * Dev データ掃除: POST /api/dev/clear-user-vols で vol-user-* をサーバーから全削除（data.json 更新）。
 * 127.0.0.1 / ::1 からのリクエストは常に可。LAN などからは TEAL_DEV_RESET=1 が必要。
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const querystring = require('querystring');
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 3847;
const DATA_FILE = path.join(__dirname, 'data.json');
const ROOT = path.join(__dirname, '..');

function loadBundle() {
    try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const d = JSON.parse(raw);
        if (!d.vols || typeof d.vols !== 'object') d.vols = {};
        if (!Array.isArray(d.notifications)) d.notifications = [];
        if (!d.dmThreads || typeof d.dmThreads !== 'object') d.dmThreads = {};
        if (!d.users || typeof d.users !== 'object') d.users = {};
        Object.keys(d.users).forEach(function (id) {
            var u = d.users[id];
            if (u && u.bio == null) u.bio = '';
            if (u && (u.thanksCount == null || !isFinite(Number(u.thanksCount)))) {
                u.thanksCount = 10;
            }
            if (u && u.photoDataUrl == null) u.photoDataUrl = '';
        });
        return d;
    } catch (_) {
        return { vols: {}, notifications: [], dmThreads: {}, users: {} };
    }
}

function randomToken(prefix) {
    return prefix + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
}

function getAuth(req) {
    const userId = String(req.get('x-teal-user-id') || '').trim();
    const secret = String(req.get('x-teal-secret') || '').trim();
    if (!userId || !secret || userId.indexOf('usr-') !== 0) return null;
    const u = bundle.users[userId];
    if (!u || u.secret !== secret) return null;
    return { userId: userId, displayName: u.displayName || '' };
}

function usersPublicMap() {
    const o = {};
    Object.keys(bundle.users || {}).forEach(function (id) {
        const u = bundle.users[id];
        if (u && u.displayName) {
            var tc = Number(u.thanksCount);
            o[id] = {
                displayName: u.displayName,
                bio: u.bio || '',
                thanksCount: isFinite(tc) && tc >= 0 ? Math.floor(tc) : 10,
                photoDataUrl: (typeof u.photoDataUrl === 'string' && u.photoDataUrl.indexOf('data:image/') === 0)
                    ? u.photoDataUrl
                    : ''
            };
        }
    });
    return o;
}

function saveBundle(b) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(b, null, 2), 'utf8');
}

function normalizePhoneJp(raw) {
    var s = String(raw || '').replace(/[\s\-().]/g, '');
    if (!s) return null;
    if (s.indexOf('+81') === 0) {
        return /^\+81[789]0\d{8}$/.test(s) ? s : null;
    }
    if (s.indexOf('81') === 0 && s.length >= 11) {
        s = '+' + s;
        return /^\+81[789]0\d{8}$/.test(s) ? s : null;
    }
    if (s.indexOf('0') === 0) {
        s = '+81' + s.slice(1);
        return /^\+81[789]0\d{8}$/.test(s) ? s : null;
    }
    return null;
}

function findUserIdByPhone(phoneE164) {
    var users = bundle.users || {};
    var ids = Object.keys(users);
    for (var i = 0; i < ids.length; i++) {
        var u = users[ids[i]];
        if (u && u.phoneE164 === phoneE164) return ids[i];
    }
    return null;
}

function randomOtp6() {
    return String(100000 + Math.floor(Math.random() * 900000));
}

/** @type {Map<string, { code: string, expires: number, attempts: number, lastSend: number }>} */
const phoneOtps = new Map();

function sendSmsTwilio(toE164, textBody) {
    var sid = process.env.TWILIO_ACCOUNT_SID;
    var token = process.env.TWILIO_AUTH_TOKEN;
    var from = process.env.TWILIO_FROM;
    if (!sid || !token || !from) {
        return Promise.reject(new Error('twilio_not_configured'));
    }
    var auth = Buffer.from(sid + ':' + token).toString('base64');
    var postData = querystring.stringify({ To: toE164, From: from, Body: textBody });
    return new Promise(function (resolve, reject) {
        var req = https.request({
            hostname: 'api.twilio.com',
            path: '/2010-04-01/Accounts/' + sid + '/Messages.json',
            method: 'POST',
            headers: {
                Authorization: 'Basic ' + auth,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
                else reject(new Error(data || String(res.statusCode)));
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

let bundle = loadBundle();

function requestIsLocalLoopback(req) {
    const raw = req.ip || req.socket.remoteAddress || '';
    const ip = String(raw);
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.endsWith('127.0.0.1');
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '18mb' }));

app.get('/api/health', function (_, res) {
    res.json({
        ok: true,
        name: 'tealfolder-sync',
        /* 古いプロセスは postApi/phoneOtp なし。POST が 404 になりがち */
        postApi: true,
        phoneOtp: true
    });
});

app.get('/api/bundle', function (_, res) {
    res.json({
        vols: bundle.vols,
        notifications: bundle.notifications,
        dmThreads: bundle.dmThreads || {},
        usersPublic: usersPublicMap()
    });
});

app.post('/api/auth/register', function (req, res) {
    const displayName = req.body && String(req.body.displayName || '').trim();
    if (!displayName || displayName.length > 80) {
        return res.status(400).json({ error: 'displayName' });
    }
    if (!bundle.users) bundle.users = {};
    const userId = randomToken('usr-');
    const secret = randomToken('sec-');
    bundle.users[userId] = {
        displayName: displayName.slice(0, 80),
        secret: secret,
        bio: '',
        thanksCount: 10,
        photoDataUrl: ''
    };
    saveBundle(bundle);
    res.json({ ok: true, userId: userId, secret: secret, displayName: displayName.slice(0, 80) });
});

app.patch('/api/auth/me', function (req, res) {
    const auth = getAuth(req);
    if (!auth) {
        return res.status(401).json({ error: 'auth required' });
    }
    const u = bundle.users[auth.userId];
    if (!u) {
        return res.status(404).json({ error: 'no user' });
    }
    const body = req.body || {};
    if (body.displayName != null) {
        const dn = String(body.displayName || '').trim();
        if (!dn || dn.length > 80) {
            return res.status(400).json({ error: 'displayName' });
        }
        u.displayName = dn.slice(0, 80);
    }
    if (body.bio != null) {
        u.bio = String(body.bio || '').trim().slice(0, 500);
    }
    if (body.thanksCount != null) {
        const tc = Number(body.thanksCount);
        if (!isFinite(tc) || tc < 0 || tc > 1e9) {
            return res.status(400).json({ error: 'thanksCount' });
        }
        u.thanksCount = Math.floor(tc);
    }
    if (body.photoDataUrl != null) {
        const photo = String(body.photoDataUrl || '');
        if (photo) {
            if (photo.indexOf('data:image/') !== 0 || photo.length > 2000000) {
                return res.status(400).json({ error: 'photoDataUrl' });
            }
            u.photoDataUrl = photo;
        } else {
            u.photoDataUrl = '';
        }
    }
    saveBundle(bundle);
    res.json({
        ok: true,
        displayName: u.displayName,
        bio: u.bio || '',
        thanksCount: typeof u.thanksCount === 'number' && isFinite(u.thanksCount) ? u.thanksCount : 10,
        photoDataUrl: (typeof u.photoDataUrl === 'string' && u.photoDataUrl.indexOf('data:image/') === 0)
            ? u.photoDataUrl
            : ''
    });
});

app.post('/api/auth/phone/send', function (req, res) {
    var norm = normalizePhoneJp(req.body && req.body.phone);
    if (!norm) {
        return res.status(400).json({ error: 'invalid_phone', hint: '090 / 080 / 070 の携帯電話番号（ハイフン可）' });
    }
    var now = Date.now();
    var prev = phoneOtps.get(norm);
    if (prev && prev.lastSend && now - prev.lastSend < 45000) {
        return res.status(429).json({ error: 'rate_limit', retryAfterSec: Math.ceil((45000 - (now - prev.lastSend)) / 1000) });
    }
    var code = randomOtp6();
    phoneOtps.set(norm, {
        code: code,
        expires: now + 10 * 60 * 1000,
        attempts: 0,
        lastSend: now
    });
    var dev = process.env.TEAL_SMS_DEV === '1' || process.env.TEAL_SMS_DEV === 'true';
    if (dev) {
        /* eslint-disable no-console */
        console.log('[TEAL_SMS_DEV] OTP for ' + norm + ' : ' + code);
        return res.json({ ok: true, devMode: true });
    }
    var msg = 'TealFolder 認証コード: ' + code + '（10分以内に入力）';
    sendSmsTwilio(norm, msg)
        .then(function () {
            res.json({ ok: true });
        })
        .catch(function (e) {
            phoneOtps.delete(norm);
            if (String(e && e.message) === 'twilio_not_configured') {
                return res.status(503).json({ error: 'sms_not_configured', hint: 'Twilio か TEAL_SMS_DEV=1' });
            }
            /* eslint-disable no-console */
            console.error('Twilio SMS error', e && e.message);
            res.status(502).json({ error: 'sms_send_failed' });
        });
});

app.post('/api/auth/phone/verify', function (req, res) {
    var norm = normalizePhoneJp(req.body && req.body.phone);
    if (!norm) {
        return res.status(400).json({ error: 'invalid_phone' });
    }
    var bodyCode = req.body && String(req.body.code || '').replace(/\D/g, '');
    var rec = phoneOtps.get(norm);
    if (!rec || Date.now() > rec.expires) {
        return res.status(400).json({ error: 'code_expired' });
    }
    if (bodyCode !== rec.code) {
        rec.attempts = (rec.attempts || 0) + 1;
        if (rec.attempts >= 10) {
            phoneOtps.delete(norm);
        }
        return res.status(400).json({ error: 'bad_code' });
    }
    phoneOtps.delete(norm);

    var existingId = findUserIdByPhone(norm);
    if (!bundle.users) bundle.users = {};
    if (existingId) {
        var eu = bundle.users[existingId];
        if (!eu || !eu.secret) {
            return res.status(500).json({ error: 'user_broken' });
        }
        saveBundle(bundle);
        return res.json({
            ok: true,
            userId: existingId,
            secret: eu.secret,
            displayName: eu.displayName || '',
            phoneE164: norm
        });
    }
    var dn = req.body && String(req.body.displayName || '').trim();
    if (!dn || dn.length > 80) {
        return res.status(400).json({ error: 'displayName', hint: '初回登録は表示名が必要です' });
    }
    var userId = randomToken('usr-');
    var secret = randomToken('sec-');
    bundle.users[userId] = {
        displayName: dn.slice(0, 80),
        secret: secret,
        bio: '',
        phoneE164: norm,
        thanksCount: 10,
        photoDataUrl: ''
    };
    saveBundle(bundle);
    res.json({
        ok: true,
        userId: userId,
        secret: secret,
        displayName: dn.slice(0, 80),
        phoneE164: norm
    });
});

app.post('/api/vols', function (req, res) {
    const auth = getAuth(req);
    if (!auth) {
        return res.status(401).json({ error: 'auth required' });
    }
    const vol = req.body;
    if (!vol || typeof vol.id !== 'string' || vol.id.indexOf('vol-user-') !== 0) {
        return res.status(400).json({ error: 'invalid vol id' });
    }
    vol.hostedByUserId = auth.userId;
    bundle.vols[vol.id] = vol;
    saveBundle(bundle);
    res.json({ ok: true, id: vol.id });
});

app.delete('/api/vols/:id', function (req, res) {
    const id = req.params.id;
    if (!id || id.indexOf('vol-user-') !== 0) {
        return res.status(400).json({ error: 'bad id' });
    }
    const vol = bundle.vols[id];
    const auth = getAuth(req);
    if (vol && vol.hostedByUserId) {
        if (!auth || auth.userId !== vol.hostedByUserId) {
            return res.status(403).json({ error: 'not owner' });
        }
    } else if (vol && vol.hostedByLocal) {
        const key = String(req.get('x-tealdevice') || '');
        if (!key || vol.hostedByLocal !== key) {
            return res.status(403).json({ error: 'not owner' });
        }
    }
    delete bundle.vols[id];
    saveBundle(bundle);
    res.json({ ok: true });
});

app.post('/api/notifications', function (req, res) {
    const n = req.body;
    if (!n || typeof n.id !== 'string') {
        return res.status(400).json({ error: 'bad notification' });
    }
    const auth = getAuth(req);
    if (n.type === 'join_request') {
        if (!auth) {
            return res.status(401).json({ error: 'auth required' });
        }
        n.applicantUserId = auth.userId;
        const v = n.volId ? bundle.vols[n.volId] : null;
        if (v && v.hostedByUserId) {
            n.organizerUserId = v.hostedByUserId;
        }
    } else if (n.type === 'thanks_granted') {
        if (!auth) {
            return res.status(401).json({ error: 'auth required' });
        }
        n.organizerUserId = auth.userId;
        var tga = Number(n.thanksAmount);
        if (n.thanksAmount != null) {
            if (!isFinite(tga) || tga < 1 || tga > 10000) {
                return res.status(400).json({ error: 'thanksAmount' });
            }
            n.thanksAmount = Math.floor(tga);
        }
    } else if (n.type === 'thanks_tip') {
        if (!auth) {
            return res.status(401).json({ error: 'auth required' });
        }
        n.applicantUserId = auth.userId;
        var tta = Number(n.thanksAmount);
        if (!isFinite(tta) || tta < 1 || tta > 10000) {
            return res.status(400).json({ error: 'thanksAmount' });
        }
        n.thanksAmount = Math.floor(tta);
        var orgUid = String(n.organizerUserId || '').trim();
        if (!orgUid) {
            return res.status(400).json({ error: 'organizerUserId' });
        }
        n.organizerUserId = orgUid;
    }
    if (n.type === 'thanks_granted') {
        var appUidGrant = String(n.applicantUserId || '').trim();
        if (appUidGrant && bundle.users[appUidGrant]) {
            var addGrant =
                n.thanksAmount != null ? Math.floor(Number(n.thanksAmount)) : 1;
            if (!isFinite(addGrant) || addGrant < 1) addGrant = 1;
            var uGrant = bundle.users[appUidGrant];
            var tcGrant = Number(uGrant.thanksCount);
            var baseGrant = isFinite(tcGrant) ? Math.floor(tcGrant) : 10;
            uGrant.thanksCount = baseGrant + addGrant;
        }
    }
    if (n.type === 'thanks_tip') {
        var orgTip = String(n.organizerUserId || '').trim();
        if (orgTip && bundle.users[orgTip]) {
            var addTip =
                n.thanksAmount != null ? Math.floor(Number(n.thanksAmount)) : 1;
            if (!isFinite(addTip) || addTip < 1) addTip = 1;
            var uTip = bundle.users[orgTip];
            var tcTip = Number(uTip.thanksCount);
            var baseTip = isFinite(tcTip) ? Math.floor(tcTip) : 10;
            uTip.thanksCount = baseTip + addTip;
        }
    }
    bundle.notifications = bundle.notifications.filter(function (x) {
        return x && x.id !== n.id;
    });
    bundle.notifications.unshift(n);
    if (bundle.notifications.length > 200) {
        bundle.notifications.length = 200;
    }
    saveBundle(bundle);
    res.json({ ok: true });
});

app.patch('/api/notifications/:id', function (req, res) {
    const id = req.params.id;
    const it = bundle.notifications.find(function (x) {
        return x && x.id === id;
    });
    if (!it) {
        return res.status(404).json({ error: 'not found' });
    }
    const auth = getAuth(req);
    const patch = req.body || {};
    if (it.type === 'join_request' && it.organizerUserId) {
        if (patch.joinStatus != null || patch.thanksGranted != null) {
            if (!auth || auth.userId !== it.organizerUserId) {
                return res.status(403).json({ error: 'not organizer' });
            }
        }
    }
    Object.assign(it, patch);
    saveBundle(bundle);
    res.json({ ok: true });
});

app.post('/api/notifications/prune-vol', function (req, res) {
    const volId = req.body && req.body.volId;
    if (!volId || typeof volId !== 'string') {
        return res.status(400).json({ error: 'volId' });
    }
    bundle.notifications = bundle.notifications.filter(function (n) {
        return n && n.volId !== volId;
    });
    saveBundle(bundle);
    res.json({ ok: true });
});

/** DM: threadKey = usr-a|usr-b（ソート済み）または 表示名\\n表示名（レガシー） */
app.post('/api/dm/append', function (req, res) {
    const auth = getAuth(req);
    if (!auth) {
        return res.status(401).json({ error: 'auth required' });
    }
    const threadKey = req.body && req.body.threadKey;
    const message = req.body && req.body.message;
    if (!threadKey || typeof threadKey !== 'string' || threadKey.length > 240) {
        return res.status(400).json({ error: 'threadKey' });
    }
    if (threadKey.indexOf('|') !== -1) {
        const parts = threadKey.split('|');
        if (parts.length !== 2 || (parts[0] !== auth.userId && parts[1] !== auth.userId)) {
            return res.status(403).json({ error: 'bad thread' });
        }
    }
    if (!message || typeof message.id !== 'string' || typeof message.text !== 'string') {
        return res.status(400).json({ error: 'message' });
    }
    message.fromUserId = auth.userId;
    if (!bundle.dmThreads || typeof bundle.dmThreads !== 'object') bundle.dmThreads = {};
    if (!bundle.dmThreads[threadKey] || typeof bundle.dmThreads[threadKey] !== 'object') {
        bundle.dmThreads[threadKey] = { messages: [] };
    }
    const arr = bundle.dmThreads[threadKey].messages;
    if (arr.some(function (x) { return x && x.id === message.id; })) {
        return res.json({ ok: true, duplicate: true });
    }
    arr.push({
        id: message.id,
        device: String(message.device || ''),
        name: String(message.name || ''),
        fromUserId: String(message.fromUserId || ''),
        text: message.text.slice(0, 8000),
        at: typeof message.at === 'number' ? message.at : Date.now()
    });
    if (arr.length > 500) {
        arr.splice(0, arr.length - 500);
    }
    saveBundle(bundle);
    res.json({ ok: true });
});

app.post('/api/dev/clear-user-vols', function (req, res) {
    const allowRemote = String(process.env.TEAL_DEV_RESET || '').trim() === '1';
    if (!requestIsLocalLoopback(req) && !allowRemote) {
        return res.status(403).json({ error: 'forbidden', hint: 'localhost の curl か TEAL_DEV_RESET=1' });
    }
    var n = 0;
    Object.keys(bundle.vols || {}).forEach(function (k) {
        if (k.indexOf('vol-user-') === 0) {
            delete bundle.vols[k];
            n++;
        }
    });
    saveBundle(bundle);
    res.json({ ok: true, removed: n });
});

/** DM 全削除または1スレッド削除（threadKey 指定時）。localhost または TEAL_DEV_RESET=1 */
app.post('/api/dev/clear-dm-threads', function (req, res) {
    const allowRemote = String(process.env.TEAL_DEV_RESET || '').trim() === '1';
    if (!requestIsLocalLoopback(req) && !allowRemote) {
        return res.status(403).json({ error: 'forbidden', hint: 'localhost の curl か TEAL_DEV_RESET=1' });
    }
    if (!bundle.dmThreads || typeof bundle.dmThreads !== 'object') bundle.dmThreads = {};
    const tk = req.body && typeof req.body.threadKey === 'string' ? req.body.threadKey.trim() : '';
    if (tk) {
        if (tk.length > 480) {
            return res.status(400).json({ error: 'threadKey' });
        }
        const had = !!bundle.dmThreads[tk];
        if (had) delete bundle.dmThreads[tk];
        saveBundle(bundle);
        return res.json({ ok: true, removed: had ? 1 : 0 });
    }
    const n = Object.keys(bundle.dmThreads).length;
    bundle.dmThreads = {};
    saveBundle(bundle);
    res.json({ ok: true, removed: n });
});

app.use(express.static(ROOT));

app.listen(PORT, function () {
    /* eslint-disable no-console */
    console.log('');
    console.log('TealFolder sync + static  http://127.0.0.1:' + PORT + '/index.html?sync=auto');
    console.log('Health                    http://127.0.0.1:' + PORT + '/api/health');
    console.log('(電話OTPなど POST /api/auth/* はこのプロセスで受けます。404 のときは古い node を止めて再起動してください)');
    console.log('Dev 募集クリア: curl -X POST http://127.0.0.1:' + PORT + '/api/dev/clear-user-vols（このマシンから）');
    console.log('Dev DMクリア:   curl -X POST http://127.0.0.1:' + PORT + '/api/dev/clear-dm-threads');
    console.log('  または ?sync=auto&purgeServerVols=1 を付けて index を開く');
    console.log('');
});
