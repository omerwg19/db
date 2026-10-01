/* Runs synchronously in <head>, before the first paint, so the stored theme is
   already on <html> when the stylesheet applies. Deliberately external: the
   Content-Security-Policy is script-src 'self' with no unsafe-inline, so an
   inline snippet here would be blocked and every visitor would get a white
   flash before the real script ran. Keep this file dependency-free and small. */
(function () {
  "use strict";
  var root = document.documentElement;
  var theme = null;
  try {
    theme = localStorage.getItem("theme");
  } catch (e) {
    // Storage can throw in private modes; fall through to the media query.
  }
  if (theme !== "light" && theme !== "dark") {
    theme =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  }
  root.setAttribute("data-theme", theme);
})();