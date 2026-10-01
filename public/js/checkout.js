/* Checkout: sign-in gate, live plan summary, then hand off to the payment
   processor. The server decides the amount; nothing here is trusted. */
(function () {
  "use strict";

  var PLAN = "pro";
  var pay = document.getElementById("pay");
  var alertBox = document.getElementById("alert");
  var alertText = document.getElementById("alert-text");
  var state = { csrf: null, busy: false };

  var $ = function (id) { return document.getElementById(id); };

  function say(msg, kind) {
    alertText.textContent = msg;
    alertBox.className = "alert on " + (kind === "ok" ? "alert-ok" : "alert-error");
  }
  function clear() { alertBox.className = "alert"; }

  function money(n) {
    return "$" + Number(n).toFixed(2);
  }

  function expiresIn(ts) {
    if (!ts) return "\u2014";
    var days = Math.ceil((ts - Date.now()) / 86400000);
    if (days <= 0) return "expired";
    return days === 1 ? "1 day left" : days + " days left";
  }

  // Sign-in gate. Done before rendering so an anonymous visitor is bounced
  // rather than shown a checkout page that cannot complete.
  fetch("/api/me", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.user) {
        location.replace("/login.html?next=" + encodeURIComponent(location.pathname + location.search));
        return;
      }
      state.csrf = d.csrf;
      if (window.VS && window.VS.showSession) {
        window.VS.showSession({ user: d.user, csrf: d.csrf, quotaUsed: d.quotaUsed });
      }
      return load();
    })
    .catch(function () { say("Could not reach the server. Try again shortly."); });

  function load() {
    return fetch("/api/billing/status", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var spec = (d.plans && d.plans[PLAN]) || { amountUsd: 10, periodDays: 30 };
        $("s-amount").textContent = money(spec.amountUsd);
        $("s-period").textContent = spec.periodDays + " days";
        $("s-quota").textContent = "500 queries";
        $("s-current").textContent = d.planLabel + " \u00b7 " + expiresIn(d.planExpiresAt);

        if (!d.provider || !d.provider.api) {
          // Refusing to pretend to take money when the processor is absent.
          pay.disabled = true;
          pay.textContent = "Payments unavailable";
          say("Card and crypto payments are not configured yet. No charge can be taken.", "err");
          return;
        }
        if (d.plan === PLAN && d.planExpiresAt > Date.now()) {
          pay.textContent = "Renew for another " + spec.periodDays + " days";
        } else {
          pay.textContent = "Pay " + money(spec.amountUsd) + " now";
        }
        // Reflects whether the provider lets the buyer choose the coin.
        var note = $("sub-note");
        if (note) {
          note.textContent = state.multi
            ? "You choose the coin on the next screen \u2014 BTC, ETH, SOL, USDT and others. We receive the same $10 either way."
            : "Access is granted automatically once the payment is confirmed.";
        }
        if (new URLSearchParams(location.search).get("paid")) {
          say("Payment received. Your Pro access is active.", "ok");
        }
      })
      .catch(function () { say("Could not load your billing details."); });
  }

  pay.addEventListener("click", function () {
    if (state.busy) return;
    clear();
    state.busy = true;
    pay.disabled = true;
    pay.textContent = "Creating invoice\u2026";

    fetch("/api/billing/checkout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrf },
      body: JSON.stringify({ plan: PLAN }),
    })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, data: d }; });
      })
      .then(function (res) {
        if (!res.ok) {
          // Provider failures now carry a detail string; show it rather than
          // making the customer guess.
          say((res.data.error || "Could not start checkout.") +
              (res.data.detail ? " (" + res.data.detail + ")" : ""));
          state.busy = false;
          pay.disabled = false;
          pay.textContent = "Try again";
          return;
        }
        state.multi = true;
        // Hosted checkout: the processor owns the payment UI from here.
        if (res.data.multiCurrency === false) state.multi = false;
        location.assign(res.data.paymentUrl);
      })
      .catch(function () {
        say("Network error. Check your connection and try again.");
        state.busy = false;
        pay.disabled = false;
        pay.textContent = "Try again";
      });
  });
})();