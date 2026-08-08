'use strict';

const AUDIO_FILES = {
  minute: 'sounds/event-minute.wav',
  thirty: 'sounds/event-thirty.wav'
};

let currentAudio = null;


function stopTone() {
  if (!currentAudio) return true;

  try {
    currentAudio.pause();
    currentAudio.currentTime = 0;
  } catch (_) {}

  currentAudio = null;
  return true;
}


async function playTone(kind) {
  const file =
    AUDIO_FILES[kind] ||
    AUDIO_FILES.thirty;

  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } catch (_) {}
  }

  const audio = new Audio(
    chrome.runtime.getURL(file)
  );

  audio.preload = 'auto';
  audio.volume =
    kind === 'thirty'
      ? 0.78
      : 0.68;

  currentAudio = audio;

  await audio.play();

  return true;
}


chrome.runtime.onMessage.addListener(
  (message, _sender, sendResponse) => {
    if (
      message?.target !==
        'infinityHelpOffscreen'
    ) {
      return false;
    }

    if (message?.action === 'stopEventTone') {
      stopTone();
      sendResponse({ ok: true });
      return false;
    }

    if (message?.action !== 'playEventTone') {
      return false;
    }

    playTone(message.kind)
      .then(() =>
        sendResponse({ ok: true })
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
);
