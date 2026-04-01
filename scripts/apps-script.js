/**
 * Google Apps Script — deploy this as a web app on your Google Sheet.
 *
 * SETUP:
 * 1. Open your Google Sheet
 * 2. Extensions → Apps Script
 * 3. Replace the default code with this entire file
 * 4. Click Deploy → New deployment
 * 5. Type: Web app
 * 6. Execute as: Me
 * 7. Who has access: Anyone (this makes the URL callable without auth)
 * 8. Click Deploy, authorize when prompted
 * 9. Copy the Web app URL → put it in your .env as GOOGLE_APPS_SCRIPT_URL
 * 10. Generate a random secret: node -e "console.log(crypto.randomUUID())"
 * 11. Paste it below in SECRET_TOKEN and in your .env as GOOGLE_SHEETS_TOKEN
 * 12. Re-deploy (Deploy → Manage deployments → edit → Deploy)
 */

// ── CHANGE THIS to a random string, then put the same value in your .env ──
var SECRET_TOKEN = "CHANGE_ME";

function verifyToken(e) {
  var token = e.parameter.token;
  if (token !== SECRET_TOKEN) {
    return jsonResponse({ error: "Unauthorized" });
  }
  return null;
}

function doGet(e) {
  var authError = verifyToken(e);
  if (authError) return authError;

  var action = e.parameter.action;
  var sheetName = e.parameter.sheet;

  if (!action || !sheetName) {
    return jsonResponse({ error: "Missing action or sheet parameter" });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    return jsonResponse({ error: "Sheet not found: " + sheetName });
  }

  if (action === "read") {
    return handleRead(sheet);
  } else if (action === "find") {
    var column = e.parameter.column;
    var value = e.parameter.value;
    return handleFind(sheet, column, value);
  }

  return jsonResponse({ error: "Unknown GET action: " + action });
}

function doPost(e) {
  var body = JSON.parse(e.postData.contents);

  if (body.token !== SECRET_TOKEN) {
    return jsonResponse({ error: "Unauthorized" });
  }

  var action = body.action;
  var sheetName = body.sheet;

  if (!action || !sheetName) {
    return jsonResponse({ error: "Missing action or sheet in body" });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    return jsonResponse({ error: "Sheet not found: " + sheetName });
  }

  if (action === "append") {
    return handleAppend(sheet, body.row);
  } else if (action === "update") {
    return handleUpdate(sheet, body.rowNumber, body.row);
  }

  return jsonResponse({ error: "Unknown POST action: " + action });
}

function handleRead(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) {
    return jsonResponse({ rows: [] });
  }

  var headers = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = data[i][j];
    }
    rows.push(obj);
  }
  return jsonResponse({ rows: rows });
}

function handleFind(sheet, column, value) {
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) {
    return jsonResponse({ matches: [] });
  }

  var headers = data[0];
  var colIndex = -1;
  for (var j = 0; j < headers.length; j++) {
    if (headers[j] === column) {
      colIndex = j;
      break;
    }
  }
  if (colIndex === -1) {
    return jsonResponse({ error: "Column not found: " + column, available: headers });
  }

  var matches = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][colIndex]) === String(value)) {
      var obj = { _rowNumber: i + 1 };
      for (var j = 0; j < headers.length; j++) {
        obj[headers[j]] = data[i][j];
      }
      matches.push(obj);
    }
  }
  return jsonResponse({ matches: matches });
}

function handleAppend(sheet, row) {
  if (!row || !Array.isArray(row)) {
    return jsonResponse({ error: "row must be an array" });
  }
  sheet.appendRow(row);
  return jsonResponse({ message: "Row appended", rowCount: sheet.getLastRow() });
}

function handleUpdate(sheet, rowNumber, row) {
  if (!rowNumber || !row || !Array.isArray(row)) {
    return jsonResponse({ error: "rowNumber and row (array) required" });
  }
  var range = sheet.getRange(rowNumber, 1, 1, row.length);
  range.setValues([row]);
  return jsonResponse({ message: "Row " + rowNumber + " updated" });
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
