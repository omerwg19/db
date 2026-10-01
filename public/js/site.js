/* Shared UI behaviour: nav, reveal-on-scroll, password tooling, toast. */
(function () {
  "use strict";

  /* ------------------------------------------------------------ nav ---- */
  var burger = document.getElementById("burger");
  var navlinks = document.getElementById("navlinks");
  if (burger && navlinks) {
    burger.addEventListener("click", function () {
      var open = navlinks.classList.toggle("open");
      burger.setAttribute("aria-expanded", open ? "true" : "false");
    });
    navlinks.addEventListener("click", function (e) {
      if (e.target.closest("a")) {
        navlinks.classList.remove("open");
        burger.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* --------------------------------------------------------- reveal ---- */
  var revealables = document.querySelectorAll(".rv");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            en.target.classList.add("in");
            io.unobserve(en.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -40px 0px" }
    );
    revealables.forEach(function (el) { io.observe(el); });
  } else {
    revealables.forEach(function (el) { el.classList.add("in"); });
  }

  /* ------------------------------------------------- signed-in chrome -- */
  var AVATAR_FALLBACK = "/img/avatar-mira.png";

  function hydrateNav(user, quota) {
    var slot = document.getElementById("nav-user");
    if (!slot) return;
    if (!user) {
      slot.hidden = false;
      slot.innerHTML =
        '<a class="btn btn-ghost btn-sm" href="/login.html">Sign in</a>' +
        '<a class="btn btn-primary btn-sm" href="/register.html">Get access</a>';
      return;
    }
    var who = user.name || user.email.split("@")[0];
    var initial = who.charAt(0).toUpperCase();
    slot.hidden = false;
    slot.innerHTML =
      '<div class="nav-user">' +
        '<div class="who">' + escapeHtml(who) +
          '<span class="plan">' + escapeHtml(user.planLabel) + " plan</span>" +
        "</div>" +
        '<img class="avatar-sm" src="' + AVATAR_FALLBACK + '" alt="">' +
      "</div>" +
      '<a class="btn btn-primary btn-sm" href="/dashboard.html">Dashboard</a>' +
      '<button class="btn btn-quiet btn-sm" type="button" id="logout-btn">Sign out</button>';

    var out = document.getElementById("logout-btn");
    if (out) {
      out.addEventListener("click", function () {
        fetch("/api/logout", {
          method: "POST",
          credentials: "same-origin",
          headers: { "X-CSRF-Token": window.__csrf || "" },
        }).finally(function () {
          window.location.href = "/";
        });
      });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  window.VS = {
    escapeHtml: escapeHtml,
    showSession: function (session) {
      window.__csrf = session.csrf;
      hydrateNav(session.user, session.quotaUsed);
    },
    hydrateNav: hydrateNav,
  };

  /* --------------------------------------------------- password meter -- */
  function scorePassword(v) {
    if (!v) return 0;
    var s = 0;
    if (v.length >= 10) s++;
    if (v.length >= 14) s++;
    if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++;
    if (/\d/.test(v) && /[^\w\s]/.test(v)) s++;
    return Math.min(s, 4);
  }

  var pw = document.getElementById("pw");
  var meter = document.getElementById("pw-meter");
  if (pw && meter) {
    pw.addEventListener("input", function () {
      var s = scorePassword(pw.value);
      meter.dataset.score = String(s);
      var lbl = document.getElementById("pw-label");
      if (lbl) lbl.textContent = ["", "Weak", "Fair", "Good", "Strong"][s];
    });
  }

  var reveal = document.getElementById("reveal");
  if (reveal && pw) {
    reveal.addEventListener("click", function () {
      var toText = pw.type === "password";
      pw.type = toText ? "text" : "password";
      reveal.setAttribute("aria-label", toText ? "Hide password" : "Show password");
    });
  }

  /* ------------------------------------------------------------ toast -- */
  function toast(msg, kind) {
    var host = document.getElementById("toast");
    if (!host) {
      host = document.createElement("div");
      host.id = "toast";
      host.style.cssText =
        "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:400;" +
        "padding:12px 18px;border-radius:12px;font-size:14px;font-weight:600;" +
        "box-shadow:var(--shadow-pop);pointer-events:none;opacity:0;transition:opacity .2s,transform .2s";
      document.body.appendChild(host);
    }
    host.textContent = msg;
    host.style.background = kind === "error" ? "#a32b43" : "#141312";
    host.style.color = "#fff";
    requestAnimationFrame(function () {
      host.style.opacity = "1";
      host.style.transform = "translateX(-50%) translateY(0)";
    });
    setTimeout(function () {
      host.style.opacity = "0";
    }, 2600);
  }
  window.VS.toast = toast;

  /* --------------------------------------- anonymous vs signed-in gate -- */
  fetch("/api/me", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d.user) window.VS.showSession(d); })
    .catch(function () {});
})();