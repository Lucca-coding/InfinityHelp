(() => {
  'use strict';

  if (window.__INFINITY_HELP_HOOKED__) return;
  window.__INFINITY_HELP_HOOKED__ = true;

  const EVENT_NAME = 'InfinityHelpData';
  const RESCAN_EVENT_NAME =
    'InfinityHelpMoveRescanRequest';
  const MAX_TEXT_LENGTH = 900_000;

  const nativeJsonParse =
    JSON.parse.bind(JSON);

  const sensitiveKeys =
    /password|passwd|senha|token|authorization|cookie|session|secret|email|username|login|refresh.?token|access.?token/i;

  const sensitiveStorageKeys =
    /password|passwd|senha|token|authorization|cookie|secret|email|username|login|refresh.?token|access.?token/i;

  const relevantKeys =
    /(^|_)(iv|ivs|individual.?values?|pokemon|pok[eé]mon|wild|encounter|battle|combat|duel|opponent|enemy|foe|trainer|npc|rival|leader|gym|boss|party|team|lineup|squad|roster|playerparty|playerteam|myteam|activeteam|moves?|moveset|move.?slots?|attacks?|skills?|techniques?|nature|ability|level|types?|stats?|hp|atk|attack|def|defense|spa|spatk|special.?attack|spd|spdef|special.?defense|spe|speed|bst)(_|$)/i;

  const relevantText =
    /\b(iv|ivs|nature|ability|wild|encounter|battle|combat|duel|opponent|enemy|foe|trainer|npc|rival|leader|gym|boss|party|team|lineup|squad|roster|player party|player team|my team|active team|move|moves|moveset|attack|attacks|skill|skills|technique|techniques|pokemon|pokémon|hpiv|atkiv|defiv|spaiv|spdiv|speiv)\b/i;

  function sanitize(value, depth, seen) {
    if (depth > 10) return '[max-depth]';

    if (
      value == null ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    ) {
      return value;
    }

    if (typeof value === 'string') {
      return value.length > 15000
        ? value.slice(0, 15000) + '…'
        : value;
    }

    if (typeof value !== 'object') return String(value);

    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      return value
        .slice(0, 350)
        .map(item => sanitize(item, depth + 1, seen));
    }

    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 600)) {
      out[key] = sensitiveKeys.test(key)
        ? '[hidden]'
        : sanitize(item, depth + 1, seen);
    }
    return out;
  }

  function emit(source, value, meta = {}) {
    try {
      const detail = {
        source,
        timestamp: Date.now(),
        meta,
        value: sanitize(value, 0, new WeakSet())
      };
      window.dispatchEvent(
        new CustomEvent(EVENT_NAME, { detail })
      );
    } catch (_) {}
  }

const recentEmissions = new Map();

function emissionSignature(
  source,
  text
) {
  const value = String(text || '');

  return [
    source,
    value.length,
    value.slice(0, 180),
    value.slice(-180)
  ].join('|');
}

function shouldEmitText(
  source,
  text,
  ttl = 1200
) {
  const signature =
    emissionSignature(source, text);

  const now = Date.now();
  const previous =
    recentEmissions.get(signature) || 0;

  if (now - previous < ttl) {
    return false;
  }

  recentEmissions.set(signature, now);

  if (recentEmissions.size > 180) {
    for (const [key, timestamp] of
      recentEmissions.entries()) {
      if (now - timestamp > 10000) {
        recentEmissions.delete(key);
      }
    }
  }

  return true;
}


  function looksRelevant(value) {
    try {
      if (typeof value === 'string') return relevantText.test(value);
      if (!value || typeof value !== 'object') return false;

      const stack = [value];
      let inspected = 0;

      while (stack.length && inspected < 1800) {
        const current = stack.pop();
        inspected++;

        if (!current || typeof current !== 'object') continue;

        if (Array.isArray(current)) {
          for (const item of current.slice(0, 100)) {
            if (item && typeof item === 'object') {
              stack.push(item);
            } else if (
              typeof item === 'string' &&
              relevantText.test(item)
            ) {
              return true;
            }
          }
          continue;
        }

        for (const [key, item] of Object.entries(current).slice(0, 150)) {
          if (relevantKeys.test(key)) return true;

          if (
            typeof item === 'string' &&
            relevantText.test(item)
          ) {
            return true;
          }

          if (item && typeof item === 'object') stack.push(item);
        }
      }

      return false;
    } catch (_) {
      return false;
    }
  }

  function parseText(text) {
    if (
      typeof text !== 'string' ||
      !text ||
      text.length > MAX_TEXT_LENGTH
    ) {
      return null;
    }

    const trimmed = text.trim();
    if (!trimmed) return null;

    try {
      return nativeJsonParse(trimmed);
    } catch (_) {
      return relevantText.test(trimmed)
        ? trimmed.slice(0, 30000)
        : null;
    }
  }

  // fetch
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = async function(...args) {
      const response = await nativeFetch.apply(this, args);

      try {
        const clone = response.clone();
        const contentType = clone.headers.get('content-type') || '';
        const url = clone.url || String(args[0] || '');

        if (/json|text|javascript/i.test(contentType) || !contentType) {
          clone.text()
            .then(text => {
              const parsed = parseText(text);
              if (parsed !== null && looksRelevant(parsed)) {
                emit('fetch', parsed, {
                  url,
                  status: clone.status,
                  contentType
                });
              }
            })
            .catch(() => {});
        }
      } catch (_) {}

      return response;
    };
  }

  // XMLHttpRequest
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__ihMeta = {
      method: String(method || ''),
      url: String(url || '')
    };
    return nativeOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener(
      'load',
      () => {
        try {
          let value = null;

          if (this.responseType === 'json') {
            value = this.response;
          } else if (
            !this.responseType ||
            this.responseType === 'text'
          ) {
            value = parseText(this.responseText);
          }

          if (value !== null && looksRelevant(value)) {
            emit('xhr', value, {
              ...(this.__ihMeta || {}),
              status: this.status,
              contentType:
                this.getResponseHeader('content-type') || ''
            });
          }
        } catch (_) {}
      },
      { once: true }
    );

    return nativeSend.apply(this, args);
  };

// WebSocket
const NativeWebSocket = window.WebSocket;

async function parseSocketPayload(data) {
  try {
    if (typeof data === 'string') {
      return {
        text: data,
        parsed: parseText(data)
      };
    }

    if (data instanceof Blob) {
      const text = await data.text();

      return {
        text,
        parsed: parseText(text)
      };
    }

    if (
      data instanceof ArrayBuffer ||
      ArrayBuffer.isView(data)
    ) {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(
              data.buffer,
              data.byteOffset,
              data.byteLength
            );

      const text =
        new TextDecoder().decode(bytes);

      return {
        text,
        parsed: parseText(text)
      };
    }
  } catch (_) {}

  return {
    text: '',
    parsed: null
  };
}

function inspectSocketPayload(
  source,
  data,
  meta
) {
  parseSocketPayload(data)
    .then(({ text, parsed }) => {
      if (
        parsed !== null &&
        looksRelevant(parsed) &&
        shouldEmitText(source, text)
      ) {
        emit(source, parsed, meta);
      }
    })
    .catch(() => {});
}

if (typeof NativeWebSocket === 'function') {
  function InfinityHelpWebSocket(...args) {
    const socket = new NativeWebSocket(...args);
    const url = String(args[0] || '');

    socket.addEventListener('message', event => {
      inspectSocketPayload(
        'websocket',
        event.data,
        { url }
      );
    });

    const nativeSocketSend =
      socket.send.bind(socket);

    socket.send = function(data) {
      inspectSocketPayload(
        'websocket-send',
        data,
        { url }
      );

      return nativeSocketSend(data);
    };

    return socket;
  }

  InfinityHelpWebSocket.prototype =
    NativeWebSocket.prototype;

  Object.setPrototypeOf(
    InfinityHelpWebSocket,
    NativeWebSocket
  );

  for (const key of [
    'CONNECTING',
    'OPEN',
    'CLOSING',
    'CLOSED'
  ]) {
    Object.defineProperty(
      InfinityHelpWebSocket,
      key,
      {
        value: NativeWebSocket[key]
      }
    );
  }

  window.WebSocket =
    InfinityHelpWebSocket;
}

// Fast storage/state capture.
function inspectStorage(
  store,
  source
) {
  try {
    const result = {};

    for (
      let i = 0;
      i < Math.min(store.length, 300);
      i++
    ) {
      const key = store.key(i);

      if (
        !key ||
        sensitiveStorageKeys.test(key)
      ) {
        continue;
      }

      const raw =
        store.getItem(key);

      const value =
        parseText(raw);

      if (
        value !== null &&
        looksRelevant(value)
      ) {
        result[key] = value;
      }
    }

    if (Object.keys(result).length) {
      let signature = '';

      try {
        signature =
          JSON.stringify(result);
      } catch (_) {
        signature =
          Object.keys(result).join('|');
      }

      if (
        shouldEmitText(
          source,
          signature,
          350
        )
      ) {
        emit(source, result, {
          immediate: true
        });
      }
    }
  } catch (_) {}
}

function inspectKnownGlobals() {
  try {
    const result = {};

    const directKeys = [
      'game',
      'gameState',
      'state',
      'store',
      'player',
      'party',
      'team',
      'battle',
      'pokemon',
      '__INITIAL_STATE__',
      '__GAME_STATE__',
      '__PLAYER_STATE__'
    ];

    const dynamicKeys =
      Object.keys(window)
        .filter(key =>
          /game|state|store|player|party|team|battle|pokemon/i
            .test(key)
        )
        .slice(0, 120);

    for (const key of [
      ...new Set([
        ...directKeys,
        ...dynamicKeys
      ])
    ]) {
      let value = null;

      try {
        value = window[key];
      } catch (_) {
        continue;
      }

      if (
        !value ||
        typeof value !== 'object' ||
        value === window ||
        value instanceof Node
      ) {
        continue;
      }

      if (looksRelevant(value)) {
        result[key] = value;
      }
    }

    if (Object.keys(result).length) {
      emit('window-state', result, {
        immediate: true
      });
    }
  } catch (_) {}
}

let storageScanTimer = null;

function runFastStateScan() {
  inspectStorage(
    window.localStorage,
    'localStorage'
  );

  inspectStorage(
    window.sessionStorage,
    'sessionStorage'
  );

  inspectKnownGlobals();
}

function scheduleFastStateScan(
  delay = 0
) {
  if (storageScanTimer) {
    clearTimeout(storageScanTimer);
  }

  storageScanTimer = setTimeout(() => {
    storageScanTimer = null;
    runFastStateScan();
  }, delay);
}

try {
  const nativeStorageSetItem =
    Storage.prototype.setItem;

  Storage.prototype.setItem =
    function(key, value) {
      const result =
        nativeStorageSetItem.call(
          this,
          key,
          value
        );

      scheduleFastStateScan(0);

      return result;
    };

  const nativeStorageRemoveItem =
    Storage.prototype.removeItem;

  Storage.prototype.removeItem =
    function(key) {
      const result =
        nativeStorageRemoveItem.call(
          this,
          key
        );

      scheduleFastStateScan(0);

      return result;
    };

  const nativeStorageClear =
    Storage.prototype.clear;

  Storage.prototype.clear =
    function() {
      const result =
        nativeStorageClear.call(this);

      scheduleFastStateScan(0);

      return result;
    };
} catch (_) {}

window.addEventListener(
  RESCAN_EVENT_NAME,
  () => {
    scheduleFastStateScan(0);
  }
);

// Capture state JSON parsed inside the game.
try {
  JSON.parse = function(...args) {
    const parsed =
      nativeJsonParse(...args);

    try {
      const text =
        typeof args[0] === 'string'
          ? args[0]
          : '';

      if (
        text &&
        /moves?|moveset|move.?slots?|attacks?|skills?|party|team|roster|pokemon/i
          .test(text) &&
        looksRelevant(parsed) &&
        shouldEmitText(
          'json-parse',
          text,
          800
        )
      ) {
        queueMicrotask(() => {
          emit('json-parse', parsed, {
            captured: true
          });
        });
      }
    } catch (_) {}

    return parsed;
  };
} catch (_) {}

for (const delay of [
  0,
  60,
  160,
  350,
  700,
  1200,
  2200,
  4000,
  7000
]) {
  setTimeout(
    runFastStateScan,
    delay
  );
}

setInterval(
  runFastStateScan,
  1500
);

  emit('hook', {
    status: 'ready',
    href: location.href
  });
})();
