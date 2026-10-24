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
//   GET /feed?url=<rss-url>         RSS-Feed holen (für Feeds ohne CORS, z. B. ZEIT)
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

function launchApp(id, cb) {
  tizen.application.launch(id, function () { cb(null); }, function (e) {
    // Fallback: Store-IDs (z. B. 3201512006785) über den TV-Kanal starten
    remoteSend({
      method: 'ms.channel.emit',
      params: { event: 'ed.apps.launch', to: 'host', data: { action_type: 'DEEP_LINK', appId: id } }
    }, function (err) { cb(err ? e : null); });
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

function reply(res, err, data) {
  res.writeHead(err ? 500 : 200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(err ? { error: String(err.message || err) } : { ok: true, data: data, token: token }));
}

var server = http.createServer(function (req, res) {
  var u = url.parse(req.url, true);
  var q = u.query;
  if (q.token && !token) token = q.token;
  try {
    switch (u.pathname) {
      case '/ping': return reply(res, null, 'pong');
      case '/apps': return listApps(function (e, apps) { reply(res, e, apps); });
      case '/launch': return launchApp(q.id, function (e) { reply(res, e); });
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
server.listen(PORT, '127.0.0.1');
