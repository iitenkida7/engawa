// engawa event webhook receiver for Google Apps Script (sample).
// Appends ended conversations and stays to a Google Sheet.
// Setup: see README.md in this directory. Event format: docs/webhook.md.

// Apps Script cannot read request headers, so the shared secret travels in the
// URL query instead (?token=...). Set it under Project Settings → Script
// Properties as TOKEN; leave it unset to accept any request.
const TOKEN = PropertiesService.getScriptProperties().getProperty('TOKEN');

const SHEETS = {
  'conversation.ended': {
    name: 'conversations',
    header: [
      'startedAt',
      'endedAt',
      'durationSec',
      'zone',
      'transport',
      'participantCount',
      'maxConcurrent',
      'participants',
      'conversationId',
    ],
    row: (d) => [
      new Date(d.startedAt),
      new Date(d.endedAt),
      d.durationSec,
      d.zone ?? 'floor',
      d.transport,
      d.participantCount,
      d.maxConcurrent,
      d.participants.join(', '),
      d.conversationId,
    ],
  },
  'presence.ended': {
    name: 'presence',
    header: ['joinedAt', 'leftAt', 'durationSec', 'participant', 'presenceId'],
    row: (d) => [new Date(d.joinedAt), new Date(d.leftAt), d.durationSec, d.participant, d.presenceId],
  },
};

function doPost(e) {
  if (TOKEN && e.parameter.token !== TOKEN) return reply({ ok: false, error: 'unauthorized' });

  const event = JSON.parse(e.postData.contents);
  // *.started events are not stored: the matching *.ended carries everything.
  const target = SHEETS[event.type];
  if (!target) return reply({ ok: true, ignored: event.type });

  // Events can arrive concurrently; serialize the appends.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sheetFor(target).appendRow(target.row(event.data));
  } finally {
    lock.releaseLock();
  }
  return reply({ ok: true });
}

function sheetFor(target) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(target.name);
  if (!sheet) {
    sheet = book.insertSheet(target.name);
    sheet.appendRow(target.header);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function reply(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
