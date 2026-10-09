// Sets the theme before first paint to avoid a light flash for dark-mode users. It's a file of its own rather than
// inline, so the page's Content-Security-Policy doesn't have to allow inline script.
(function () {
  var theme = null;
  try { theme = localStorage.getItem('theme'); } catch (e) {}
  document.documentElement.dataset.theme = theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
})();
