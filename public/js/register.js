/* Registration: client-side validation, then POST /api/register. */
(function () {
  "use strict";

  var form = document.getElementById("form");
  var alertBox = document.getElementById("alert");
  var alertText = document.getElementById("alert-text");
  var submit = document.getElementById("submit");
  var email = document.getElementById("email");
  var pw = document.getElementById("pw");
  var confirm = document.getElementById("confirm");
  var terms = document.getElementById("terms");
  var name = document.getElementById("name");

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
  var MIN = 10;

  function say(msg, kind) {
    alertText.textContent = msg;
    alertBox.className = "alert on alert-" + (kind || "error");
    if (kind === "ok") {
      alertBox.querySelector("svg").innerHTML =
        '<path d="M20 6 9 17l-5-5"/>';
    }
  }

  function clear() { alertBox.className = "alert"; }

  function problems() {
    var v = pw.value;
    if (!EMAIL_RE.test(email.value.trim())) return "Enter a valid email address.";
    if (v.length < MIN) return "Password must be at least " + MIN + " characters.";
    if (!/[a-zA-Z]/.test(v) || !/\d/.test(v) || !/[^\w\s]/.test(v)) {
      return "Mix letters with at least one number and one symbol.";
    }
    if (confirm.value !== v) return "Passwords do not match.";
    if (!terms.checked) return "Please accept the terms and acceptable use policy.";
    return null;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    clear();

    var issue = problems();
    if (issue) { say(issue, "error"); return; }

    submit.disabled = true;
    submit.textContent = "Creating account…";

    fetch("/api/register", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.value.trim(),
        email: email.value.trim(),
        password: pw.value,
        confirmPassword: confirm.value,
      }),
    })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, data: d }; });
      })
      .then(function (res) {
        if (!res.ok) {
          say(res.data.error || "Could not create the account.", "error");
          submit.disabled = false;
          submit.textContent = "Create account";
          return;
        }
        say("Account created. Taking you to your dashboard…", "ok");
        // Carry any query typed on the home page through to the dashboard.
        var q = new URLSearchParams(location.search).get("q");
        setTimeout(function () {
          location.href = "/dashboard.html" + (q ? "?q=" + encodeURIComponent(q) : "");
        }, 650);
      })
      .catch(function () {
        say("Network error. Check your connection and try again.", "error");
        submit.disabled = false;
        submit.textContent = "Create account";
      });
  });

  [email, pw, confirm].forEach(function (el) {
    el.addEventListener("input", function () {
      el.removeAttribute("aria-invalid");
      clear();
    });
  });
})();