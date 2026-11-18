/**
 * Baton inbox for Google Sheets.
 *
 * Paste this whole file into the Sheet (Extensions > Apps Script), then
 * Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
 * The /exec URL it gives you goes in baton.yaml under inbox.script_url.
 *
 * - Forms POST leads here (Baton's snippet, or any tool) and they become rows.
 *   Tools that write rows to this Sheet directly work too.
 * - Baton reads rows it hasn't routed yet and marks them routed. Those calls
 *   need BATON_SECRET, so only your Baton can read leads back out.
 */

var BATON_SECRET = '__BATON_SECRET__';
var SHEET_NAME = '__SHEET_NAME__';
var BATON_COLUMNS = ['baton_status', 'baton_routed_to', 'baton_rule', 'baton_routed_at', 'baton_id'];
var MAX_FIELDS = 60;
var MAX_VALUE_LENGTH = 2000;
var PAGE_SIZE = 200;

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.secret !== BATON_SECRET) return json_({ ok: false, error: 'bad secret' });
  if (p.action === 'pending') return json_(pending_());
  if (p.action === 'ping') return json_({ ok: true, sheet: sheet_().getName() });
  return json_({ ok: false, error: 'unknown action' });
}

function doPost(e) {
  var body = parseBody_(e);
  if (body.action) {
    if (body.secret !== BATON_SECRET) return json_({ ok: false, error: 'bad secret' });
    if (body.action === 'mark') return json_(mark_(body.rows || []));
    return json_({ ok: false, error: 'unknown action' });
  }
  return json_(append_(body.fields || body));
}

function parseBody_(e) {
  if (e && e.postData && e.postData.contents) {
    try {
      var parsed = JSON.parse(e.postData.contents);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (err) {
      // Not JSON: fall through to form-encoded parameters.
    }
  }
  return (e && e.parameter) || {};
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = SHEET_NAME && SHEET_NAME.indexOf('__') !== 0 ? SHEET_NAME : null;
  var sheet = name ? ss.getSheetByName(name) : ss.getSheets()[0];
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

/** Header row, adding any of `wanted` that are missing. Returns the full header list. */
function headers_(sheet, wanted) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  while (headers.length && headers[headers.length - 1] === '') headers.pop();
  var added = false;
  for (var i = 0; i < wanted.length; i++) {
    if (headers.indexOf(wanted[i]) === -1) {
      headers.push(wanted[i]);
      added = true;
    }
  }
  if (added) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return headers;
}

function append_(fields) {
  var keys = [];
  for (var k in fields) {
    if (k === 'action' || k === 'secret' || k.indexOf('baton_') === 0) continue;
    keys.push(k);
    if (keys.length >= MAX_FIELDS) break;
  }
  if (keys.length === 0) return { ok: false, error: 'no fields' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = sheet_();
    var headers = headers_(sheet, ['received_at'].concat(keys).concat(BATON_COLUMNS));
    var row = headers.map(function (h) {
      if (h === 'received_at') return new Date().toISOString();
      if (keys.indexOf(h) === -1) return '';
      return String(fields[h]).slice(0, MAX_VALUE_LENGTH);
    });
    sheet.appendRow(row);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function pending_() {
  var sheet = sheet_();
  var headers = headers_(sheet, BATON_COLUMNS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, rows: [] };
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var statusCol = headers.indexOf('baton_status');
  var rows = [];
  for (var r = 0; r < values.length && rows.length < PAGE_SIZE; r++) {
    var v = values[r];
    if (String(v[statusCol]) !== '') continue;
    var fields = {};
    var hasData = false;
    for (var c = 0; c < headers.length; c++) {
      var h = headers[c];
      if (!h || h.indexOf('baton_') === 0) continue;
      var cell = v[c];
      var text = cell instanceof Date ? cell.toISOString() : String(cell);
      if (text !== '') hasData = true;
      fields[h] = text;
    }
    if (hasData) rows.push({ row: r + 2, fields: fields });
  }
  return { ok: true, rows: rows };
}

/** rows: [{ row, email, status, routed_to, rule, routed_at, baton_id }] */
function mark_(rows) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = sheet_();
    var headers = headers_(sheet, BATON_COLUMNS);
    var emailCol = findEmailColumn_(headers);
    var results = [];
    for (var i = 0; i < rows.length; i++) {
      var m = rows[i];
      var rowNum = Number(m.row);
      if (!(rowNum >= 2 && rowNum <= sheet.getLastRow())) {
        results.push({ row: m.row, ok: false, error: 'no such row' });
        continue;
      }
      // Someone may have sorted or edited the Sheet since Baton read it.
      if (emailCol !== -1 && m.email) {
        var current = String(sheet.getRange(rowNum, emailCol + 1).getValue()).trim().toLowerCase();
        if (current !== String(m.email).toLowerCase()) {
          results.push({ row: m.row, ok: false, error: 'row changed' });
          continue;
        }
      }
      var cells = { baton_status: m.status, baton_routed_to: m.routed_to || '', baton_rule: m.rule, baton_routed_at: m.routed_at, baton_id: m.baton_id };
      for (var key in cells) {
        sheet.getRange(rowNum, headers.indexOf(key) + 1).setValue(cells[key]);
      }
      results.push({ row: m.row, ok: true });
    }
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

function findEmailColumn_(headers) {
  for (var i = 0; i < headers.length; i++) {
    var k = headers[i].toLowerCase().replace(/[\s_\-]+/g, '');
    if (/^(work)?e?-?mail(address)?$/.test(k)) return i;
  }
  for (var j = 0; j < headers.length; j++) {
    if (headers[j].toLowerCase().indexOf('email') !== -1) return j;
  }
  return -1;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
