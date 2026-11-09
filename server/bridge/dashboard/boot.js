// API Bridge dashboard: the first-paint step. A tiny classic script (no imports) that runs before the page is drawn,
// so the sign-in screen and the chosen theme are on screen while the app's modules still load. app.js takes over
// (it removes data-early) and replays anything done in the gap. Pure DOM and storage reads; never throws.
(function () {
  var root = document.documentElement;
  var read = function (store, key) {
    try {
      return window[store].getItem(key);
    } catch (e) {
      return null;
    }
  };
  // The chosen appearance (light or dark) before the first paint, so the screen never flashes the other one.
  var theme = read("localStorage", "mcb.dashboard.theme");
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  // No key in this tab and no one-time sign-in link in the address: the sign-in screen is the first thing to show.
  if (!read("sessionStorage", "mcb.dashboard.key") && !/^#\/?signin=/.test(location.hash)) {
    root.setAttribute("data-early", "login");
    // Whether the last visit found a demo Bridge: reserves the demo notice's room so nothing moves when health answers.
    if (read("localStorage", "mcb.dashboard.demo") === "1") root.setAttribute("data-demo-hint", "");
  }
  // The modules the pages need (views.js and what it loads) are fetched in parallel, at low priority. A tab that goes
  // straight to the app asks for them now; a tab that shows the sign-in screen asks once that screen has been drawn,
  // so they never delay its first paint (their parsing would).
  var later = document.getElementById("views-preload");
  var preload = function () {
    if (!later) return;
    var template = later;
    later = null;
    document.head.appendChild(template.content);
  };
  if (root.getAttribute("data-early") === "login") {
    addEventListener("load", function () {
      if (window.requestIdleCallback) window.requestIdleCallback(preload, { timeout: 2000 });
      else setTimeout(preload, 100);
    });
  } else preload();
  // A key typed and submitted before app.js is ready must not fall through to a native form submit: hold it for app.js.
  document.addEventListener(
    "submit",
    function (e) {
      if (window.__abReady || !e.target || e.target.id !== "login-form") return;
      e.preventDefault();
      window.__abHeldSubmit = true;
    },
    true,
  );
})();
