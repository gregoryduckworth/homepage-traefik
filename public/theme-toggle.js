// The light and dark themes. The page follows the system setting until someone picks one with the toggle, which is
// remembered in this browser.
const toggle = document.getElementById('theme-toggle');

// Storage can throw when site data is blocked; the theme choice is a convenience, so fail quietly.
function storedTheme() {
  try { return localStorage.getItem('theme'); } catch { return null; }
}

const systemDark = matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  toggle.setAttribute('aria-pressed', String(theme === 'dark'));
}

applyTheme(storedTheme() || (systemDark.matches ? 'dark' : 'light'));
systemDark.addEventListener('change', event => {
  if (!storedTheme()) applyTheme(event.matches ? 'dark' : 'light');
});
toggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('theme', next); } catch {}
  applyTheme(next);
});
