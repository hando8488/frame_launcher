// Frame Launcher – Hintergrunddienst (läuft in TizenBrews Node-Runtime auf dem TV).
// Bewusst ES5 und nur Node-Bordmittel: Tizen bringt teils noch Node 4 mit.
//
// HTTP-API auf 127.0.0.1:8093 (für die Launcher-Seite):
//   GET /ping
//   GET /apps                       installierte Apps
//   GET /launch?id=<appId>          App starten
//   GET /open?url=<url>             URL im Samsung-Browser öffnen
//   GET /key?k=KEY_HDMI1&token=     Fernbedienungstaste senden
//   GET /art?on=1&token=            Art Mode einschalten
//   GET /feed?url=<rss-url>         RSS-/iCal-Feed holen (für Quellen ohne CORS)
//   GET /info, /log?msg=            Kalender-Link abholen, Meldungen der Seite protokollieren
// Aus dem Heimnetz erreichbar: /ping und /setup (Kalender-Link eintragen, Log ansehen).
'use strict';

var http = require('http');
var https = require('https');
var tls = require('tls');
var crypto = require('crypto');
var url = require('url');

var PORT = 8093;
var CLIENT_NAME = new Buffer('Frame Launcher').toString('base64');
var BROWSER_IDS = ['org.tizen.browser', 'com.samsung.tv.browser'];
var token = null;

// ---------- Minimaler WebSocket-Client (wss, selbstsigniertes TV-Zertifikat) ----------

function sendFrame(sock, data, opcode) {
  var len = data.length;
  var head;
  if (len < 126) {
    head = new Buffer(2);
    head[1] = 0x80 | len;
  } else if (len < 65536) {
    head = new Buffer(4);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = new Buffer(10);
    head[1] = 0x80 | 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  head[0] = 0x80 | opcode;
  var mask = crypto.randomBytes(4);
  var masked = new Buffer(len);
  for (var i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
  sock.write(Buffer.concat([head, mask, masked]));
}

function wsConnect(channel, handlers) {
  var path = '/api/v2/channels/' + channel + '?name=' + CLIENT_NAME + (token ? '&token=' + token : '');
  var sock = tls.connect({ host: '127.0.0.1', port: 8002, rejectUnauthorized: false }, function () {
    sock.write(
      'GET ' + path + ' HTTP/1.1\r\n' +
      'Host: 127.0.0.1:8002\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\n' +
      'Sec-WebSocket-Version: 13\r\n\r\n'
    );
  });
  var buf = new Buffer(0);
  var upgraded = false;

  sock.on('data', function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      var idx = buf.toString('binary').indexOf('\r\n\r\n');
      if (idx < 0) return;
      var head = buf.slice(0, idx).toString();
      buf = buf.slice(idx + 4);
      if (head.indexOf(' 101') < 0) {
        handlers.error(new Error(head.split('\r\n')[0]));
        sock.destroy();
        return;
      }
      upgraded = true;
    }
    while (buf.length >= 2) {
      var len = buf[1] & 127;
      var off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = buf.readUInt32BE(6);
        off = 10;
      }
      if (buf.length < off + len) return;
      var opcode = buf[0] & 15;
      var payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (opcode === 1) {
        var msg;
        try { msg = JSON.parse(payload.toString()); } catch (e) { continue; }
        handlers.message(msg);
      } else if (opcode === 8) {
        sock.end();
      } else if (opcode === 9) {
        sendFrame(sock, payload, 10);
      }
    }
  });
  sock.on('error', function (e) { handlers.error(e); });
  sock.on('close', function () { handlers.close(); });

  return {
    send: function (obj) { sendFrame(sock, new Buffer(JSON.stringify(obj)), 1); },
    close: function () { sock.end(); }
  };
}

// ---------- Fernbedienungs-Kanal (bleibt offen, Befehle werden gepuffert) ----------

var remote = null;
var remoteReady = false;
var queue = [];

function flushQueue(err) {
  var pending = queue;
  queue = [];
  pending.forEach(function (item) {
    if (!err) remote.send(item.obj);
    item.cb(err || null);
  });
}

function remoteSend(obj, cb) {
  queue.push({ obj: obj, cb: cb });
  if (remoteReady) return flushQueue();
  if (remote) return;
  remote = wsConnect('samsung.remote.control', {
    message: function (msg) {
      if (msg.event === 'ms.channel.connect') {
        if (msg.data && msg.data.token) token = msg.data.token;
        remoteReady = true;
        flushQueue();
      } else if (msg.event === 'ms.channel.unauthorized' || msg.event === 'ms.channel.timeOut') {
        flushQueue(new Error('Verbindung am TV nicht erlaubt'));
        remote.close();
      }
    },
    error: function (e) {
      flushQueue(e);
    },
    close: function () {
      remote = null;
      remoteReady = false;
    }
  });
}

function sendKey(key, cb) {
  remoteSend({
    method: 'ms.remote.control',
    params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' }
  }, cb);
}

function setArtMode(on, cb) {
  var done = false;
  function finish(err) {
    if (done) return;
    done = true;
    cb(err || null);
    setTimeout(function () { art.close(); }, 500);
  }
  var art = wsConnect('com.samsung.art-app', {
    message: function (msg) {
      if (msg.event === 'ms.channel.connect' && msg.data && msg.data.token) token = msg.data.token;
      if (msg.event === 'ms.channel.ready') {
        art.send({
          method: 'ms.channel.emit',
          params: {
            event: 'art_app_request',
            to: 'host',
            data: JSON.stringify({
              request: 'set_artmode_status',
              value: on ? 'on' : 'off',
              id: crypto.randomBytes(8).toString('hex')
            })
          }
        });
        finish();
      } else if (msg.event === 'ms.channel.unauthorized') {
        finish(new Error('Verbindung am TV nicht erlaubt'));
      }
    },
    error: finish,
    close: function () { finish(new Error('Verbindung geschlossen')); }
  });
}

// ---------- Tizen-App-Funktionen ----------

function listApps(cb) {
  tizen.application.getAppsInfo(function (apps) {
    cb(null, apps.filter(function (a) { return a.show; }).map(function (a) {
      return { id: a.id, name: a.name };
    }));
  }, function (e) { cb(e); });
}

// TV-REST-API: POST /api/v2/applications/<Store-ID> startet die App (wie die Smartphone-Fernbedienung).
function restLaunch(storeId, cb) {
  var req = http.request({ host: '127.0.0.1', port: 8001, method: 'POST', path: '/api/v2/applications/' + storeId }, function (r) {
    r.resume();
    cb(r.statusCode >= 200 && r.statusCode < 300 ? null : new Error('REST ' + r.statusCode));
  });
  req.setTimeout(4000, function () { req.abort(); });
  req.on('error', cb);
  req.end();
}

function launchApp(id, storeId, cb) {
  var done = function (how) { return function (err) { log('Start ' + id + ' via ' + how + ': ' + (err ? err.message || err : 'ok')); }; };
  function viaTizen() {
    tizen.application.launch(id, function () { done('tizen')(); cb(null); }, function (e) {
      done('tizen')(e);
      // letzter Versuch: über den Fernbedienungs-Kanal
      remoteSend({
        method: 'ms.channel.emit',
        params: { event: 'ed.apps.launch', to: 'host', data: { action_type: 'DEEP_LINK', appId: storeId || id } }
      }, function (err) { done('remote')(err); cb(err || null); });
    });
  }
  if (!storeId) return viaTizen();
  restLaunch(storeId, function (err) {
    done('rest')(err);
    if (err) viaTizen(); else cb(null);
  });
}

function openUrl(target, cb) {
  var ctrl = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', target);
  var i = 0;
  (function next() {
    if (i >= BROWSER_IDS.length) {
      return remoteSend({
        method: 'ms.channel.emit',
        params: { event: 'ed.apps.launch', to: 'host', data: { action_type: 'NATIVE_LAUNCH', appId: BROWSER_IDS[0], metaTag: target } }
      }, cb);
    }
    tizen.application.launchAppControl(ctrl, BROWSER_IDS[i++], function () { cb(null); }, next);
  })();
}

// ---------- Feeds ----------

function fetchText(target, cb, hops) {
  hops = hops || 0;
  if (!/^https?:\/\//.test(target)) return cb(new Error('ungültige URL'));
  var opts = url.parse(target);
  // Tizens Node hat einen alten CA-Store; es geht nur um öffentliche Schlagzeilen.
  opts.rejectUnauthorized = false;
  opts.headers = { 'User-Agent': 'Mozilla/5.0 (SMART-TV; Tizen) FrameLauncher' };
  (target.indexOf('https:') === 0 ? https : http).get(opts, function (r) {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 4) {
      r.resume();
      return fetchText(url.resolve(target, r.headers.location), cb, hops + 1);
    }
    if (r.statusCode !== 200) {
      r.resume();
      return cb(new Error('HTTP ' + r.statusCode));
    }
    var chunks = [];
    r.on('data', function (c) { chunks.push(c); });
    r.on('end', function () { cb(null, Buffer.concat(chunks).toString('utf8')); });
  }).on('error', cb);
}

// ---------- HTTP-Server ----------

var started = new Date();
var logLines = [];
var calendarUrl = null; // per Einrichtungsseite gesetzt, Launcher übernimmt ihn in seinen Speicher

function log(msg) {
  logLines.push(new Date().toISOString().slice(11, 19) + ' ' + msg);
  if (logLines.length > 60) logLines.shift();
}

function reply(res, err, data) {
  if (err) log('Fehler: ' + (err.message || err));
  res.writeHead(err ? 500 : 200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(err ? { error: String(err.message || err) } : { ok: true, data: data, token: token }));
}

function lanAddresses() {
  var out = [];
  var ifs = require('os').networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    ifs[name].forEach(function (a) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    });
  });
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}

function setupPage(res, note) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '<title>Frame Launcher</title>' +
    '<style>body{font:16px system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;background:#0b0e14;color:#e8ebf2}' +
    'input{width:100%;box-sizing:border-box;padding:12px;font-size:15px;border-radius:8px;border:1px solid #444;background:#151a24;color:#fff}' +
    'button{margin-top:12px;padding:12px 20px;font-size:15px;border:0;border-radius:8px;background:#e8ebf2;color:#0b0e14}' +
    'p,li{color:#9aa3b5;line-height:1.5}pre{background:#151a24;padding:12px;border-radius:8px;overflow:auto;font-size:12px}</style>' +
    '<h1>Frame Launcher</h1>' + (note ? '<p style="color:#7fe0a0">' + escapeHtml(note) + '</p>' : '') +
    '<h2>Familienkalender</h2>' +
    '<p>Google Kalender → Einstellungen → Kalender „Familie“ → <b>Privatadresse im iCal-Format</b> kopieren und hier einfügen.</p>' +
    '<form method="post" action="/setup"><input name="ical" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics">' +
    '<button>Speichern</button></form>' +
    '<p>Status: ' + (calendarUrl ? 'Link gesetzt – der Launcher übernimmt ihn innerhalb einer Minute.' : 'kein neuer Link') + '</p>' +
    '<h2>Dienst</h2><p>läuft seit ' + started.toISOString().slice(0, 19).replace('T', ' ') + ' UTC · Node ' + process.version + '</p>' +
    '<pre>' + escapeHtml(logLines.join('\n') || '(kein Log)') + '</pre>'
  );
}

function readBody(req, cb) {
  var body = '';
  req.on('data', function (c) { body += c; if (body.length > 1e4) req.destroy(); });
  req.on('end', function () { cb(require('querystring').parse(body)); });
}

function isLocal(req) {
  var a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

var server = http.createServer(function (req, res) {
  var u = url.parse(req.url, true);
  var q = u.query;

  // Aus dem Heimnetz nur Ping, Status und Einrichtung – alles andere nur vom TV selbst.
  if (u.pathname === '/setup' || u.pathname === '/') {
    if (req.method === 'POST') {
      return readBody(req, function (form) {
        var link = String(form.ical || '').trim();
        if (/^https:\/\/calendar\.google\.com\/calendar\/ical\//.test(link)) {
          calendarUrl = link;
          log('Kalender-Link gesetzt');
          setupPage(res, 'Gespeichert.');
        } else {
          setupPage(res, 'Das sieht nicht nach einer Google-iCal-Adresse aus.');
        }
      });
    }
    return setupPage(res);
  }
  if (u.pathname === '/ping') return reply(res, null, 'pong');
  // Kurze Rücksprung-Adresse zum Launcher, z. B. als Seite in TizenPortal: 127.0.0.1:8093/home
  if (u.pathname === '/home') {
    res.writeHead(302, { Location: 'http://127.0.0.1:8081/module/' + encodeURIComponent('gh/hando8488/frame_launcher') + '/app/index.html' });
    return res.end();
  }
  if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (!isLocal(req)) return reply(res, new Error('nur lokal'));

  if (q.token && !token) token = q.token;
  try {
    switch (u.pathname) {
      case '/info': return reply(res, null, { ips: lanAddresses(), port: PORT, calendarUrl: calendarUrl });
      case '/log': log('Seite: ' + q.msg); return reply(res, null);
      case '/apps': return listApps(function (e, apps) { reply(res, e, apps); });
      case '/launch': return launchApp(q.id, q.store, function (e) { reply(res, e); });
      case '/open': return openUrl(q.url, function (e) { reply(res, e); });
      case '/key': return sendKey(q.k, function (e) { reply(res, e); });
      case '/art': return setArtMode(q.on !== '0', function (e) { reply(res, e); });
      case '/feed': return fetchText(q.url, function (e, text) { reply(res, e, text); });
      default: return reply(res, new Error('unbekannt'));
    }
  } catch (e) {
    reply(res, e);
  }
});

server.on('error', function (e) {
  // Läuft schon (z. B. nach Neustart des Moduls) – nichts zu tun.
  if (e.code !== 'EADDRINUSE') throw e;
});
server.listen(PORT, '0.0.0.0');
log('Dienst gestartet');
