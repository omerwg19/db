/* Dashboard: gated view, quota, search + history. */
(function () {
  "use strict";

  var el = function (id) { return document.getElementById(id); };

  var state = { user: null, csrf: null, used: 0, history: [] };

  /* ----------------------------------------------------------- guard ---- */
  fetch("/api/me", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.user) {
        location.replace("/login.html?next=" + encodeURIComponent(location.pathname + location.search));
        return;
      }
      state.user = d.user;
      state.csrf = d.csrf;
      state.used = d.quotaUsed ?? 0;
      window.VS.showSession({ user: d.user, csrf: d.csrf, quotaUsed: d.quotaUsed });
      render();
      renderHistory();
      renderSubscription();
      consumePending();
    })
    .catch(function () { location.replace("/login.html"); });

  var historyClear = el("history-clear");
  if (historyClear) {
    historyClear.addEventListener("click", function () {
      try { localStorage.removeItem(historyKey()); } catch (e) {}
      renderHistory();
    });
  }

  /* ------------------------------------------------------- subscription -- */
  function renderSubscription() {
    var plan = el("sub-plan");
    if (!plan) return;

    fetch("/api/billing/status", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        plan.textContent = d.planLabel;
        plan.className = "plan-pill";

        if (d.plan === "pro" && d.planExpiresAt) {
          var end = new Date(d.planExpiresAt);
          var days = Math.ceil((d.planExpiresAt - Date.now()) / 86400000);
          el("sub-access").textContent =
            days > 0 ? days + (days === 1 ? " day left" : " days left") : "expired";
          el("sub-renewal").textContent =
            days > 0
              ? "expires " + end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
              : "lapsed";
          if (days <= 0) plan.className = "plan-pill lapsed";
          el("sub-cta").textContent = "Renew Pro";
          el("sub-note").textContent = days <= 0
            ? "Your paid period ended, so the Free quota applies again. Renew to restore Pro."
            : "Renews when you pay again. Nothing is charged automatically.";
        } else {
          el("sub-access").textContent = "Free quota \u00b7 " + d.dailyQuota + " queries/day";
          el("sub-renewal").textContent = "\u2014";
          el("sub-cta").textContent = "Upgrade to Pro";
          el("sub-note").textContent = "One payment of $10 buys 30 days of Pro: 500 queries a day and every source.";
        }

        // Provider offline: do not present a button that cannot work.
        if (d.provider && !d.provider.api) {
          el("sub-cta").textContent = "Payments unavailable";
          el("sub-cta").removeAttribute("href");
          el("sub-cta").className = "btn btn-ghost btn-block";
          el("sub-note").textContent = "Checkout is not configured yet, so no payment can be taken.";
        }
      })
      .catch(function () {});
  }

  function render() {
    var who = state.user.name || state.user.email.split("@")[0];
    el("greet").textContent = "Welcome back, " + who;
    el("plan-name").textContent = state.user.planLabel + " plan";
    el("plan-name-2").textContent = state.user.planLabel;
    el("quota-used").textContent = state.used;
    el("quota-limit").textContent = state.user.dailyQuota;
    el("member-since").textContent = (state.user.createdAt || "").slice(0, 10) || "—";
    el("account-email").textContent = state.user.email;

    var pct = Math.min(100, (state.used / state.user.dailyQuota) * 100);
    el("quota-fill").style.width = pct + "%";
  }

  /* Runs the search handed over from the homepage exactly once, then drops
     the query from the URL so refreshes do not burn quota again. */
  function consumePending() {
    var params = new URLSearchParams(location.search);
    var pending = params.get("q");
    if (!pending) return;
    params.delete("q");
    var clean = location.pathname + (params.toString() ? "?" + params : "");
    history.replaceState(null, "", clean);
    el("q").value = pending;
    doSearch(pending);
  }

  /* -------------------------------------------------------- detection --- */
  var input = el("q");
  var out = el("detected");
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

  var samples = el("samples");
  if (samples) {
    samples.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      input.value = b.textContent.trim();
      detect();
      input.focus();
    });
  }

  /* ----------------------------------------------------------- search --- */
  var form = el("search-form");
  var banner = el("banner");
  var results = el("results");

  function notice(msg, kind) {
    banner.className = "alert on alert-" + (kind || "info");
    el("banner-text").textContent = msg;
  }

  function doSearch(value) {
    value = (value || input.value).trim();
    if (!value) { notice("Enter an identifier to search for.", "error"); return; }

    results.innerHTML =
      '<div class="empty"><p>Querying sources…</p></div>';

    fetch("/api/search", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrf },
      body: JSON.stringify({ input: value }),
    })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, data: d }; });
      })
      .then(function (res) {
        if (!res.ok) {
          results.innerHTML = "";
          notice(res.data.error || "Search failed.", "error");
          return;
        }
        state.used = res.data.quota.used;
        render();
        remember(value);
        notice(
          res.data.hits.length +
            (res.data.hits.length === 1 ? " record" : " records") +
            (res.data.total > res.data.hits.length
              ? " of " + res.data.total + " total"
              : "") +
            ". " +
            (res.data.attribution || ""),
          "info"
        );
        renderResults(res.data);
      })
      .catch(function () {
        results.innerHTML = "";
        notice("Network error during search.", "error");
      });
  }

  /* Recent searches live only in this browser. The list is never sent to or
     kept on the server -- what the server keeps is a one-way hash so a search
     can be counted and rate limited, not the identifier itself. Note the
     identifier does leave the server: the lookup is answered by our provider.
     See the privacy policy. */
  function historyKey() {
    return "vs.history." + (state.user ? state.user.id : "anon");
  }

  function loadHistory() {
    try {
      var raw = JSON.parse(localStorage.getItem(historyKey()) || "[]");
      return Array.isArray(raw) ? raw.filter(function (v) { return typeof v === "string"; }) : [];
    } catch (e) {
      return [];
    }
  }

  function remember(value) {
    var list = loadHistory().filter(function (v) { return v.toLowerCase() !== value.toLowerCase(); });
    list.unshift(value);
    try { localStorage.setItem(historyKey(), JSON.stringify(list.slice(0, 8))); } catch (e) {}
    renderHistory();
  }

  function renderHistory() {
    var wrap = el("history"), chips = el("history-chips");
    if (!wrap || !chips) return;
    var list = loadHistory();
    if (!list.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    chips.innerHTML = "";
    list.forEach(function (v) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = v;
      b.addEventListener("click", function () { doSearch(v); });
      chips.appendChild(b);
    });
  }

  function renderResults(data) {
    var esc = window.VS.escapeHtml;

    if (!data.hits.length) {
      results.innerHTML =
        '<div class="empty">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>' +
          "<p>No records for this identifier in the current source set.</p>" +
        "</div>";
      return;
    }

    // Correlation panel: which values travel together across breaches. This is
    // the part that answers "what is this connected to" -- the password value
    // itself is never in the data, but its presence is, and that is the risk.
    var cor = data.correlation;
    var corHtml = "";
    if (cor && cor.exposure && cor.exposure.breaches > 0) {
      var ex = cor.exposure;
      var credNote = ex.withCredential > 0
        ? '<p class="muted" style="font-size:13px;margin:8px 0 0">' +
          ex.withCredential + " of " + ex.breaches + " record" + (ex.breaches === 1 ? "" : "s") +
          " carried a " + (ex.credentialType === "hash" ? "password hash" : "recovered password") +
          (ex.reused ? ", reused across every one of them" : "") +
          ". The value is withheld; the fact that it was exposed is not.</p>"
        : '<p class="muted" style="font-size:13px;margin:8px 0 0">No credential in this result set.</p>';

      var nodes = (cor.nodes || [])
        .map(function (n) {
          return (
            '<div class="cor-row">' +
              '<div class="cor-val"><span class="cor-lbl">' + esc(n.label) + '</span>' +
              '<span class="mono">' + esc(n.value) + "</span></div>" +
              '<div class="cor-srcs">' +
                n.sources.map(function (s) { return "<span>" + esc(s) + "</span>"; }).join("") +
              "</div>" +
            "</div>"
          );
        })
        .join("");

      corHtml =
        '<div class="cor-block">' +
          '<h3 class="cor-h">What this is connected to</h3>' +
          '<p class="muted" style="font-size:13px;margin:0 0 10px">' +
            ex.breaches + " record" + (ex.breaches === 1 ? "" : "s") + " across " +
            ex.sourceCount + " source" + (ex.sourceCount === 1 ? "" : "s") + "." +
            (nodes ? " Values below appear in more than one breach, which is what links them to the same person." : "") +
          "</p>" +
          credNote +
          (nodes ? '<div class="cor-list">' + nodes + "</div>" : "") +
        "</div>";
    }

    results.innerHTML = corHtml + data.hits.map(function (h) {
      var conf = h.confidence === "high" ? "high" : h.confidence === "medium" ? "medium" : "low";

      // Real values from the leaked record, so the finding is actionable rather
      // than a list of column names.
      var rows = (h.details || [])
        .map(function (d) {
          return (
            '<div class="kv"><span class="k">' + esc(d.label) + '</span>' +
            '<span class="v mono">' + esc(d.value) + "</span></div>"
          );
        })
        .join("");

      var cred = h.credential || {};
      var credLine = cred.present
        ? '<div class="kv"><span class="k">Password</span>' +
          '<span class="v withheld">' +
          (cred.type === "plaintext" ? "recovered, " : "hashed, ") +
          esc(String(cred.length)) +
          " chars &middot; not shown" +
          "</span></div>"
        : "";

      return (
        '<div class="result">' +
          '<div class="result-top">' +
            '<span class="result-input">' + esc(h.source) + "</span>" +
            '<span class="conf ' + conf + '"><i></i>' + esc(h.confidence) + " confidence</span>" +
          "</div>" +
          '<div class="muted" style="font-size:13px">Breached ' + esc(h.breached) + " &middot; " + esc(h.kind) + " record</div>" +
          '<div class="kvlist">' + rows + credLine + "</div>" +
        "</div>"
      );
    }).join("");
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    doSearch();
  });

  /* --------------------------------------------------------- settings -- */
  var pwForm = el("pw-form");
  if (pwForm) {
    pwForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var next = el("new-pw").value;
      if (next !== el("confirm-new-pw").value) {
        notice("New passwords do not match.", "error");
        return;
      }
      fetch("/api/password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrf },
        body: JSON.stringify({
          currentPassword: el("current-pw").value,
          newPassword: next,
        }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (!res.ok) { notice(res.data.error || "Could not update password.", "error"); return; }
          notice("Password updated. Other sessions were signed out.", "ok");
          pwForm.reset();
        });
    });
  }
})();