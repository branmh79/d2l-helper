// Load
chrome.storage.sync.get({ tmEnableHover: true, tmCacheMinutes: 30 }, (store) => {
  document.getElementById('enableHover').checked = !!store.tmEnableHover;
  document.getElementById('cacheMinutes').value = Number(store.tmCacheMinutes) || 30;
});

// Save
function save() {
  const tmEnableHover = document.getElementById('enableHover').checked;
  const tmCacheMinutes = Number(document.getElementById('cacheMinutes').value) || 0;
  chrome.storage.sync.set({ tmEnableHover, tmCacheMinutes }, () => {
    const s = document.getElementById('status');
    s.textContent = 'Saved';
    setTimeout(() => s.textContent = '', 1200);
  });
}

document.getElementById('save').addEventListener('click', save);