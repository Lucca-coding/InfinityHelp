'use strict';

const EVENT_TIME_ZONE =
  'America/Sao_Paulo';

const ALARM_ONE_MINUTE =
  'infinity-help-event-minus-60';

const ALARM_THIRTY_SECONDS =
  'infinity-help-event-minus-30';

const SCHEDULE_STORAGE_KEY =
  'infinityHelpEventBackgroundScheduleV1';

const SETTINGS_STORAGE_KEY =
  'infinityHelpSettings';

let offscreenCreation = null;


function zonedParts(date = new Date()) {
  const formatter =
    new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone: EVENT_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      }
    );

  const values = {};

  for (
    const part of formatter.formatToParts(date)
  ) {
    if (part.type !== 'literal') {
      values[part.type] =
        Number(part.value);
    }
  }

  return values;
}


function zoneOffsetMs(date) {
  const parts = zonedParts(date);

  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return representedAsUtc -
    Math.floor(date.getTime() / 1000) * 1000;
}


function zonedWallTimeToEpoch(parts) {
  const wallUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute || 0,
    parts.second || 0
  );

  let epoch = wallUtc;

  for (let attempt = 0; attempt < 3; attempt++) {
    epoch = wallUtc -
      zoneOffsetMs(new Date(epoch));
  }

  return epoch;
}


function nextOddWindowEpoch(
  reference = new Date()
) {
  const now = zonedParts(reference);

  const pseudo = new Date(Date.UTC(
    now.year,
    now.month - 1,
    now.day,
    now.hour,
    0,
    0
  ));

  pseudo.setUTCHours(
    pseudo.getUTCHours() +
      (
        now.hour % 2 === 0
          ? 1
          : 2
      )
  );

  return zonedWallTimeToEpoch({
    year: pseudo.getUTCFullYear(),
    month: pseudo.getUTCMonth() + 1,
    day: pseudo.getUTCDate(),
    hour: pseudo.getUTCHours(),
    minute: 0,
    second: 0
  });
}


async function clearEventAlarms() {
  await Promise.all([
    chrome.alarms.clear(ALARM_ONE_MINUTE),
    chrome.alarms.clear(ALARM_THIRTY_SECONDS)
  ]);
}


async function scheduleEventAlarms(
  reference = new Date()
) {
  await clearEventAlarms();

  const now = Date.now();
  const target =
    nextOddWindowEpoch(reference);

  const oneMinute = target - 60000;
  const thirtySeconds = target - 30000;

  if (oneMinute > now + 500) {
    chrome.alarms.create(
      ALARM_ONE_MINUTE,
      { when: oneMinute }
    );
  } else if (
    now < thirtySeconds - 500
  ) {
    chrome.alarms.create(
      ALARM_ONE_MINUTE,
      { when: now + 750 }
    );
  }

  if (thirtySeconds > now + 500) {
    chrome.alarms.create(
      ALARM_THIRTY_SECONDS,
      { when: thirtySeconds }
    );
  } else if (now < target - 500) {
    chrome.alarms.create(
      ALARM_THIRTY_SECONDS,
      { when: now + 1250 }
    );
  }

  await chrome.storage.local.set({
    [SCHEDULE_STORAGE_KEY]: {
      target,
      scheduledAt: now
    }
  });

  return target;
}


async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) {
    return false;
  }

  const contexts =
    await chrome.runtime.getContexts({
      contextTypes: [
        'OFFSCREEN_DOCUMENT'
      ],
      documentUrls: [
        chrome.runtime.getURL(
          'offscreen.html'
        )
      ]
    });

  return contexts.length > 0;
}


async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error(
      'Offscreen API não disponível.'
    );
  }

  if (await hasOffscreenDocument()) {
    return;
  }

  if (offscreenCreation) {
    await offscreenCreation;
    return;
  }

  offscreenCreation =
    chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification:
        'Reproduzir alertas sonoros das janelas de evento.'
    });

  try {
    await offscreenCreation;
  } catch (error) {
    const text = String(
      error?.message || error || ''
    );

    if (
      !/single offscreen|already exists/i.test(text)
    ) {
      throw error;
    }
  } finally {
    offscreenCreation = null;
  }
}


async function playBackgroundTone(kind) {
  const stored =
    await chrome.storage.local.get(
      SETTINGS_STORAGE_KEY
    );

  const soundEnabled =
    stored[SETTINGS_STORAGE_KEY]
      ?.soundEnabled !== false;

  if (!soundEnabled) {
    return true;
  }

  await ensureOffscreenDocument();

  const response =
    await chrome.runtime.sendMessage({
      target: 'infinityHelpOffscreen',
      action: 'playEventTone',
      kind
    });

  if (!response?.ok) {
    throw new Error(
      response?.error ||
      'Documento de áudio não respondeu.'
    );
  }

  return true;
}


chrome.storage.onChanged.addListener(
  (changes, area) => {
    if (area !== 'local') return;

    const nextSettings =
      changes[SETTINGS_STORAGE_KEY]
        ?.newValue;

    if (
      nextSettings &&
      nextSettings.soundEnabled === false
    ) {
      chrome.runtime.sendMessage({
        target: 'infinityHelpOffscreen',
        action: 'stopEventTone'
      }).catch(() => {});
    }
  }
);


chrome.alarms.onAlarm.addListener(
  alarm => {
    if (alarm.name === ALARM_ONE_MINUTE) {
      playBackgroundTone('minute')
        .catch(() => {});
      return;
    }

    if (
      alarm.name ===
      ALARM_THIRTY_SECONDS
    ) {
      playBackgroundTone('thirty')
        .catch(() => {})
        .finally(async () => {
          const stored =
            await chrome.storage.local.get(
              SCHEDULE_STORAGE_KEY
            );

          const target =
            stored[SCHEDULE_STORAGE_KEY]
              ?.target;

          const afterCurrentWindow =
            Number.isFinite(target)
              ? new Date(target + 1000)
              : new Date();

          scheduleEventAlarms(
            afterCurrentWindow
          ).catch(() => {});
        });
    }
  }
);


chrome.runtime.onInstalled.addListener(
  () => {
    scheduleEventAlarms()
      .catch(() => {});
  }
);


chrome.runtime.onStartup.addListener(
  () => {
    scheduleEventAlarms()
      .catch(() => {});
  }
);


chrome.runtime.onMessage.addListener(
  (message, _sender, sendResponse) => {
    if (
      message?.target ===
      'infinityHelpOffscreen'
    ) {
      return false;
    }

    if (
      message?.action ===
      'infinityHelpScheduleEventAlarms'
    ) {
      scheduleEventAlarms()
        .then(target =>
          sendResponse({ ok: true, target })
        )
        .catch(error =>
          sendResponse({
            ok: false,
            error: String(
              error?.message || error
            )
          })
        );

      return true;
    }

    return false;
  }
);


scheduleEventAlarms().catch(() => {});
