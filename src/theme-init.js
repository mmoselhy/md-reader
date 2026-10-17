// Classic blocking script. Sets data-theme before CSS so the first paint is not white.
// Cannot import logic.js (that file is a module). Resolution matches resolveTheme there.
(function () {
  var KEY = 'mdread.theme';

  function mode() {
    try {
      var value = localStorage.getItem(KEY);
      if (value === 'light' || value === 'dark' || value === 'system') return value;
    } catch (e) {
      /* private mode or a blocked storage partition */
    }
    return 'system';
  }

  function systemDark() {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches === true;
    } catch (e) {
      return false;
    }
  }

  function apply() {
    var current = mode();
    var resolved = current === 'light' ? 'light' : current === 'dark' ? 'dark' : (systemDark() ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', resolved);
  }

  apply();

  try {
    var query = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      if (mode() === 'system') apply();
    };
    if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
    else if (typeof query.addListener === 'function') query.addListener(onChange);
  } catch (e) {
    /* matchMedia is unavailable; the attribute set above still stands */
  }
})();
