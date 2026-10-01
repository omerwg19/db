/* Login: POST /api/login, then bounce to the dashboard. */
(function () {
  "use strict";

  var form = document.getElementById("form");
  var alertBox = document.getElementById("alert");
  var alertText = document.getElementById("alert-text");
  var submit = document.getElementById("submit");
  var email = document.getElementById("email");
  var pw = document.getElementById("pw");

  function say(msg) {
    alertText.textContent = msg;
    alertBox.className = "alert on alert-error";
  }
  function clear() { alertBox.className = "alert"; }

  // Where to go after a successful sign-in. `next` is only honoured when it is
  // a plain same-origin path, so the param cannot be used as an open redirect.
  function destination() {
    var params = new URLSearchParams(location.search);
    var next = params.get("next");
    if (next && /^\/[A-Za-z0-9._~\-/?=&%]*(?!\/\/)/.test(next) && !next.startsWith("//")) {
      return next;
    }
    var q = params.get("q");
    return "/dashboard.html" + (q ? "?q=" + encodeURIComponent(q) : "");
  }

  // Already signed in? Skip the form.
  fetch("/api/me", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.user) location.replace(destination());
    })
    .catch(function () {});

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    clear();

    if (!email.value.trim() || !pw.value) {
      say("Email and password are required.");
      return;
    }

    submit.disabled = true;
    submit.textContent = "Signing in…";

    fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: email.value.trim(),
        password: pw.value,
        remember: document.getElementById("remember").checked,
      }),
    })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, data: d }; });
      })
      .then(function (res) {
        if (!res.ok) {
          say(res.data.error || "Could not sign in.");
          submit.disabled = false;
          submit.textContent = "Sign in";
          pw.select();
          return;
        }
        location.href = destination();
      })
      .catch(function () {
        say("Network error. Check your connection and try again.");
        submit.disabled = false;
        submit.textContent = "Sign in";
      });
  });

  [email, pw].forEach(function (el) {
    el.addEventListener("input", clear);
  });
})();