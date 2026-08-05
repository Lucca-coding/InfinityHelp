const STORAGE_KEY = 'infinityHelpSettings';

const defaults = {
  enabled: true,
  diagnostic: false,
  collapsed: false,
  panelX: 8,
  panelY: 72,
  panelWidth: 330,
  panelHeight: null
};

const enabled =
  document.querySelector('#enabled');

const diagnostic =
  document.querySelector('#diagnostic');

const resetSize =
  document.querySelector('#resetSize');

chrome.storage.local.get(
  { [STORAGE_KEY]: defaults },
  result => {
    const settings = {
      ...defaults,
      ...(result[STORAGE_KEY] || {})
    };

    enabled.checked = settings.enabled;
    diagnostic.checked = settings.diagnostic;
  }
);

function update() {
  chrome.storage.local.get(
    { [STORAGE_KEY]: defaults },
    result => {
      const settings = {
        ...defaults,
        ...(result[STORAGE_KEY] || {}),
        enabled: enabled.checked,
        diagnostic: diagnostic.checked
      };

      chrome.storage.local.set({
        [STORAGE_KEY]: settings
      });
    }
  );
}

enabled.addEventListener('change', update);
diagnostic.addEventListener('change', update);

resetSize.addEventListener('click', () => {
  chrome.storage.local.get(
    { [STORAGE_KEY]: defaults },
    result => {
      const settings = {
        ...defaults,
        ...(result[STORAGE_KEY] || {}),
        panelX: defaults.panelX,
        panelY: defaults.panelY,
        panelWidth: defaults.panelWidth,
        panelHeight: defaults.panelHeight,
        collapsed: false
      };

      chrome.storage.local.set({
        [STORAGE_KEY]: settings
      });

      resetSize.textContent = 'Tamanho restaurado';

      setTimeout(() => {
        resetSize.textContent =
          'Restaurar tamanho e posição';
      }, 1200);
    }
  );
});
