// Frame Launcher – Dienst-Lader (läuft in TizenBrews Node-Runtime auf dem TV).
// Holt core.js in der neuesten Commit-Version, weil der unversionierte jsDelivr-Pfad
// nach Updates teils stundenlang veraltet ist. ES5, nur Node-Bordmittel.
'use strict';

var https = require('https');
var url = require('url');
var REPO = 'hando8488/frame_launcher';

function get(target, headers, cb) {
  var opts = url.parse(target);
  opts.headers = Object.assign({ 'User-Agent': 'FrameLauncher' }, headers || {});
  https.get(opts, function (r) {
    var body = '';
    r.setEncoding('utf8');
    r.on('data', function (c) { body += c; });
    r.on('end', function () { cb(r.statusCode === 200 ? null : new Error('HTTP ' + r.statusCode), body); });
  }).on('error', cb);
}

function run(ref) {
  get('https://cdn.jsdelivr.net/gh/' + REPO + '@' + ref + '/service/core.js', null, function (err, code) {
    if (err) {
      if (ref !== 'main') run('main');
      return;
    }
    try {
      new Function('require', 'tizen', 'FL_VERSION', code)(require, tizen, ref);
    } catch (e) {
      // Ein Fehler hier darf TizenBrews Dienst nicht mitreißen.
    }
  });
}

get('https://api.github.com/repos/' + REPO + '/commits/main', { Accept: 'application/vnd.github.sha' }, function (err, sha) {
  sha = (sha || '').trim();
  run(!err && /^[0-9a-f]{40}$/.test(sha) ? sha : 'main');
});
