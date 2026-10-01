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

  /* ------------------------------------------------- per-field errors -- */
  /* Previously every problem surfaced in one alert above the form, which meant
     scrolling to find out which box was wrong. Each field now owns its message
     and aria-invalid, and focus moves to the first thing that needs attention. */
  function setErr(input, id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
      if (input) input.setAttribute("aria-invalid", "true");
    } else {
      el.textContent = "";
      el.hidden = true;
      if (input) input.removeAttribute("aria-invalid");
    }
  }

  function clearErrors() {
    setErr(email, "email-err");
    setErr(pw, "pw-err");
    setErr(confirm, "confirm-err");
    setErr(terms, "terms-err");
  }

  function pwChecks(v) {
    return {
      len: v.length >= MIN,
      case: /[a-z]/.test(v) && /[A-Z]/.test(v),
      num: /\d/.test(v),
      sym: /[^\w\s]/.test(v),
    };
  }

  function paintRequirements() {
    var c = pwChecks(pw.value);
    var items = document.querySelectorAll("#req-list li[data-req]");
    for (var i = 0; i < items.length; i++) {
      var key = items[i].getAttribute("data-req");
      if (c[key]) items[i].setAttribute("data-ok", "1");
      else items[i].removeAttribute("data-ok");
    }
  }
  paintRequirements();

  // Already signed in? This page is reached from the pricing page's upgrade
  // buttons, so an existing customer should go straight to where they were
  // heading rather than be asked to register an account they already have.
  fetch("/api/me", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.user) return;
      var params = new URLSearchParams(location.search);
      var plan = params.get("plan");
      var q = params.get("q");
      location.replace(
        plan === "pro"
          ? "/checkout.html"
          : "/dashboard.html" + (q ? "?q=" + encodeURIComponent(q) : "")
      );
    })
    .catch(function () {});

  function say(msg, kind) {
    alertText.textContent = msg;
    alertBox.className = "alert on alert-" + (kind || "error");
    if (kind === "ok") {
      alertBox.querySelector("svg").innerHTML =
        '<path d="M20 6 9 17l-5-5"/>';
    }
    // The alert sits above the form, but the submit button is at the bottom of
    // it. On a phone the message landed off-screen, so a failed sign-up looked
    // like the button had simply done nothing. Scroll it into view instead.
    alertBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function clear() { alertBox.className = "alert"; }

  /* A throttled sign-up gets a live countdown rather than a vague "later", so
     it is obvious the request was understood and when it is worth retrying. */
  var countdownTimer = null;

  function throttle(res) {
    var wait = Number(res.data.retryAfter) || Number(res.headers && res.headers.get("Retry-After")) || 0;
    var btnLabel = function (s) {
      var m = Math.floor(s / 60);
      return m > 0 ? "Try again in " + m + "m " + (s % 60) + "s" : "Try again in " + s + "s";
    };

    if (!wait) {
      say(res.data.error || "Could not create the account.", "error");
      submit.disabled = false;
      submit.textContent = "Create account";
      return;
    }

    var left = wait;
    submit.disabled = true;
    say(res.data.error || "Too many attempts. " + btnLabel(left), "error");
    submit.textContent = btnLabel(left);

    clearInterval(countdownTimer);
    countdownTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(countdownTimer);
        submit.disabled = false;
        submit.textContent = "Create account";
        return;
      }
      submit.textContent = btnLabel(left);
    }, 1000);
  }

  /* Validates everything, paints each field's own message, and reports the
     first offending input so focus can go there. */
  function validate() {
    clearErrors();
    var c = pwChecks(pw.value);
    var first = null;

    if (!EMAIL_RE.test(email.value.trim())) {
      setErr(email, "email-err", "Enter a valid email address, for example you@company.com.");
      if (!first) first = email;
    } else {
      setErr(email, "email-err");
    }

    var missing = [];
    if (!c.len) missing.push("10 or more characters");
    if (!c.case) missing.push("upper and lower case");
    if (!c.num) missing.push("a number");
    if (!c.sym) missing.push("a symbol");
    if (missing.length) {
      setErr(pw, "pw-err", "Password still needs: " + missing.join(", ") + ".");
      if (!first) first = pw;
    } else {
      setErr(pw, "pw-err");
    }

    if (!pw.value) {
      setErr(pw, "pw-err", "Choose a password.");
      if (!first) first = pw;
    } else if (pw.value !== confirm.value) {
      setErr(confirm, "confirm-err", "These passwords do not match.");
      if (!first) first = confirm;
    } else {
      setErr(confirm, "confirm-err");
    }

    if (!terms.checked) {
      setErr(terms, "terms-err", "Please accept the terms to continue.");
      if (!first) first = terms;
    } else {
      setErr(terms, "terms-err");
    }

    return first;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    clear();

    var bad = validate();
    if (bad) {
      say("Almost there — check the highlighted fields below.", "error");
      bad.focus();
      return;
    }

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
        return r.json().then(function (d) {
          return { ok: r.ok, status: r.status, data: d, headers: r.headers };
        });
      })
      .then(function (res) {
        if (res.data && res.data.error === "An account with that email already exists.") {
          // Sign in instead: this is almost always the same person who forgot
          // they already registered, and "that email already exists" with no
          // way forward reads like a dead end.
          say("That email already has an account. Try signing in instead.", "error");
          setTimeout(function () {
            location.href = "/login.html?next=" + encodeURIComponent(location.search);
          }, 1600);
          return;
        }
        if (!res.ok) {
          if (res.status === 429) return throttle(res);
          say(res.data.error || "Could not create the account.", "error");
          submit.disabled = false;
          submit.textContent = "Create account";
          return;
        }
        say("Account created. Taking you to your dashboard…", "ok");
        // Carry any query typed on the home page through to the dashboard.
        var params = new URLSearchParams(location.search);
        var q = params.get("q");
        var plan = params.get("plan");
        // Someone clicking "Upgrade to Pro" on pricing should land on checkout
        // after signing up, not have to hunt for the button again.
        var to = plan === "pro" ? "/checkout.html" : "/dashboard.html" + (q ? "?q=" + encodeURIComponent(q) : "");
        setTimeout(function () {
          location.href = to;
        }, 650);
      })
      .catch(function () {
        say("Network error. Check your connection and try again.", "error");
        submit.disabled = false;
        submit.textContent = "Create account";
      });
  });

  /* Live feedback while typing, but only after the field has been touched once —
   shouting "invalid email" at someone who has not finished typing the first
   character is the classic way to make a form feel hostile. */
  function touched(el) { return el.dataset.touched === "1"; }

  function revalidate(el) {
    if (!touched(el)) return;
    var v = el.value.trim();
    if (el === email) {
      setErr(email, "email-err", EMAIL_RE.test(v) ? "" : "Enter a valid email address, for example you@company.com.");
    } else if (el === pw) {
      var c = pwChecks(el.value);
      var missing = [];
      if (!c.len) missing.push("10 or more characters");
      if (!c.case) missing.push("upper and lower case");
      if (!c.num) missing.push("a number");
      if (!c.sym) missing.push("a symbol");
      setErr(pw, "pw-err", missing.length ? "Password still needs: " + missing.join(", ") + "." : "");
    } else if (el === confirm) {
      setErr(confirm, "confirm-err", el.value === pw.value ? "" : "These passwords do not match.");
    }
  }

  [email, pw, confirm].forEach(function (el) {
    el.addEventListener("input", function () {
      if (el === pw) {
        paintRequirements();
        revalidate(pw);
        // Editing the password can invalidate a confirmation already typed.
        if (touched(confirm)) revalidate(confirm);
      } else {
        revalidate(el);
      }
    });
    el.addEventListener("blur", function () {
      el.dataset.touched = "1";
      revalidate(el);
    });
  });

  terms.addEventListener("change", function () {
    if (touched(terms) || terms.checked) {
      setErr(terms, "terms-err", terms.checked ? "" : "Please accept the terms to continue.");
    }
  });
})();