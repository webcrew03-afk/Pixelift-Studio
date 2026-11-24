/**
 * Pixelift Studio — purchase email sender (Google Apps Script)
 *
 * Sends emails from YOUR Gmail when the website asks (purchase links and
 * personal offers) and saves every "Get the code" form entry to a Google
 * Sheet called "Pixelift leads" in your Drive.
 *
 * Setup (about 5 minutes):
 *  1. Go to https://script.google.com → New project. Delete the sample code and paste this file.
 *  2. Replace CHANGE_ME below with a long random password (the same value goes into the
 *     Cloudflare secret EMAIL_SCRIPT_TOKEN). Never commit the real password to GitHub.
 *  3. Deploy → New deployment → type "Web app"
 *       Execute as: Me      Who has access: Anyone
 *     Click Deploy and allow access (Advanced → Go to project → Allow).
 *  4. Copy the Web app URL (ends in /exec) into the Cloudflare secret EMAIL_SCRIPT_URL.
 *  5. Run setupLeadsSheet once from the editor to create the leads sheet and allow access.
 *
 * Updating an existing deployment: paste the new code, Save, then
 * Deploy → Manage deployments → ✏️ → Version: New version → Deploy (the URL stays the same).
 *
 * Gmail limits: about 100 emails/day on a free account, 1,500/day on Google Workspace.
 */

var TOKEN = "CHANGE_ME";

function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);
    if (!TOKEN || TOKEN === "CHANGE_ME" || d.token !== TOKEN) return out({ ok: false, error: "unauthorised" });
    if (!d.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.to)) return out({ ok: false, error: "bad recipient" });

    var opts = { to: d.to, subject: String(d.subject || "Your download"), htmlBody: String(d.html || ""), body: String(d.text || ""), name: d.name || "Pixelift Studio" };
    if (d.replyTo) opts.replyTo = d.replyTo;
    MailApp.sendEmail(opts);
    if (d.lead) { try { logLead(d.lead); } catch (err) {} }
    return out({ ok: true, remaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function doGet() {
  return out({ ok: true, service: "pixelift-mailer" });
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Adds a row to the "Pixelift leads" sheet (created on first use). */
function logLead(l) {
  var sheet = leadsSheet();
  sheet.appendRow([new Date(), String(l.name || ""), String(l.email || ""), String(l.src || "")]);
}

function leadsSheet() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("LEADS_SHEET_ID"), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) {} }
  if (!ss) {
    ss = SpreadsheetApp.create("Pixelift leads");
    props.setProperty("LEADS_SHEET_ID", ss.getId());
    var sh = ss.getSheets()[0];
    sh.appendRow(["Date", "Name", "Email", "Source"]);
    sh.setFrozenRows(1);
  }
  return ss.getSheets()[0];
}

/** Run once from the editor: creates the leads sheet and asks for Sheets permission. */
function setupLeadsSheet() {
  var sheet = leadsSheet();
  Logger.log("Leads sheet: " + sheet.getParent().getUrl());
}

/** Run this once from the editor to grant Gmail permission and send yourself a test email. */
function testSend() {
  MailApp.sendEmail(Session.getActiveUser().getEmail(), "Pixelift mailer test", "It works!");
}
