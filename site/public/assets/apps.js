// In the installed app, a game opens in its own installed app.
//
// Each game is its own site (its own subdomain) and its own installable app.
// Followed in the same window, a link to one leaves the home page's app, so
// the browser shows its address bar. Opened as a new window instead, Chrome
// (on Android, and on computers with "Open supported links" on) hands the
// link to the game's app when it's installed, with no bar. In a browser tab,
// links stay as they are.
(function () {
  const installed = () => ['standalone', 'fullscreen', 'minimal-ui'].some(
    (mode) => window.matchMedia && window.matchMedia(`(display-mode: ${mode})`).matches,
  ) || window.navigator.standalone === true;

  // Another Cheetah Moon site: <game>.cheetahmoongames.com, or another port locally.
  function isGame(url) {
    if (url.origin === location.origin) return false;
    const home = location.hostname.replace(/^www\./, '');
    return url.hostname.endsWith('.' + home) || (url.hostname === location.hostname && url.port !== location.port);
  }

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target.closest && e.target.closest('a[href]');
    if (!link || link.target || !installed()) return;
    let url;
    try { url = new URL(link.href); } catch { return; }
    if (!isGame(url)) return;
    // The click goes on as normal, now opening a new window.
    link.target = '_blank';
    link.rel = 'noopener';
  }, true);
})();
