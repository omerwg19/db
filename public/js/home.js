/* Home page: type detection on the hero search + sample chips. */
(function () {
  "use strict";

  var input = document.getElementById("hero-input");
  var out = document.getElementById("hero-detected");
  if (!input || !out) return;

  var RULES = [
    ["Email address", function (v) { return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v); }],
    ["Domain", function (v) { return /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i.test(v); }],
    ["IP address", function (v) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(v); }],
    ["Discord ID", function (v) { return /^\d{17,20}$/.test(v); }],
    ["Phone number", function (v) { return /^\+?[\d\s().-]{7,20}$/.test(v) && /\d/.test(v); }],
    ["Username or name", function (v) { return /^[a-z0-9_.\- ]{2,40}$/i.test(v); }],
  ];

  function detect() {
    var v = input.value.trim();
    if (!v) { out.classList.remove("on"); return; }
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i][1](v)) {
        out.innerHTML = "Detected: <code>" + RULES[i][0] + "</code>";
        out.classList.add("on");
        return;
      }
    }
    out.classList.remove("on");
  }

  input.addEventListener("input", detect);

  var samples = document.getElementById("hero-samples");
  if (samples) {
    samples.addEventListener("click", function (e) {
      var btn = e.target.closest("button");
      if (!btn) return;
      input.value = btn.textContent.trim();
      detect();
      input.focus();
    });
  }

  // Carry the typed value through to the dashboard so it is not lost on signup.
  // Cache the base href first: mutating href would break a plain selector on
  // the second click.
  var searchLink = document.querySelector(".search-row a");
  if (searchLink) {
    var baseHref = searchLink.getAttribute("href");
    searchLink.addEventListener("click", function () {
      var v = input.value.trim();
      searchLink.setAttribute("href", v ? baseHref + "?q=" + encodeURIComponent(v) : baseHref);
    });
  }
})();