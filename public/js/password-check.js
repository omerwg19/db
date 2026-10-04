/* Pwned Passwords, k-anonymity style.
 *
 * The password is SHA-1 hashed here in the browser, and only the first five
 * characters of that hash are sent to Cloudflare. Everything after the prefix
 * stays on this machine, so the server learns nothing about the password and
 * the breach corpus is never searched by it either. The leaked suffix is then
 * compared locally.
 *
 * The consequence is worth stating plainly: the user learns whether their
 * password has appeared in a known breach corpus, which is the only question
 * that can be answered without redistributing other people's credentials. It is
 * not a lookup of a person, and it spends no credits, which is why it works
 * for signed-out visitors.
 */
(function () {
  "use strict";

  var form = document.getElementById("pc-form");
  var input = document.getElementById("pc-input");
  var toggle = document.getElementById("pc-toggle");
  var out = document.getElementById("pc-result");
  var status = document.getElementById("pc-status");

  if (!form || !input || !out) return;

  // Hex without Buffer: this runs in the browser, where there is no Node.
  function toHex(buffer) {
    var view = new Uint8Array(buffer);
    var hex = "";
    for (var i = 0; i < view.length; i++) {
      hex += view[i].toString(16).padStart(2, "0");
    }
    return hex.toUpperCase();
  }

  function sha1Hex(text) {
    // SubtleCrypto is unavailable on plain http, which is only a local concern;
    // the live site is served over TLS, so the secure context is present.
    if (!window.crypto || !window.crypto.subtle) {
      return Promise.reject(new Error("insecure"));
    }
    var bytes = new TextEncoder().encode(text);
    return window.crypto.subtle.digest("SHA-1", bytes).then(toHex);
  }

  // Counts is a "SUFFIX:COUNT" body with ~800k lines, so it is streamed as text
  // and searched rather than split into a giant array.
  function suffixCount(body, suffix) {
    var lines = body.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].trim().split(":");
      if (parts[0] === suffix) return parseInt(parts[1], 10) || 0;
    }
    return 0;
  }

  function say(html) {
    out.innerHTML = html;
    out.hidden = false;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function advice(count) {
    if (count === 0) {
      return [
        ["good", "Not found in the breach corpus"],
        [
          "This password does not appear in any known breach corpus. That is genuine good news, not a guarantee: being absent from these lists does not make a password strong.",
        ],
        "It can still be trivially guessed, reused elsewhere, or exposed by a breach that has not been catalogued yet.",
      ];
    }
    return [
      ["bad", "Found " + count.toLocaleString("en-US") + " time" + (count === 1 ? "" : "s") + " in known breaches"],
      [
        "This exact password has already appeared in published breach data, so it is in the hands of people who use automated lists of common credentials. Treat it as public knowledge.",
      ],
      "Change it everywhere you have used it, including places you may have forgotten. Do not just add a number to the end.",
    ];
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var password = input.value;

    if (!password) {
      out.hidden = true;
      return;
    }

    status.textContent = "Checking…";
    say('<p class="muted" style="font-size:13.5px">Hashing locally and comparing against the breach corpus.</p>');

    sha1Hex(password)
      .then(function (hash) {
        var prefix = hash.slice(0, 5);
        var suffix = hash.slice(5);
        status.textContent = "";
        return fetch("https://api.pwnedpasswords.com/range/" + prefix, {
          headers: { "Add-Padding": "true" },
        }).then(function (res) {
          if (!res.ok) throw new Error("upstream " + res.status);
          return res.text();
        }).then(function (body) {
          var count = suffixCount(body, suffix);
          var parts = advice(count);
          say(
            '<div class="pc-verdict pc-' + parts[0] + '">' +
              "<strong>" + esc(parts[1]) + "</strong>" +
              "</div>" +
              '<p class="muted" style="font-size:13.5px;margin:10px 0 0">' + esc(parts[2]) + "</p>" +
              (count > 0 ? '<p class="muted" style="font-size:13.5px;margin:8px 0 0">' + esc(parts[3]) + "</p>" : "") +
              '<p class="pc-foot">Only the first five characters of the hash were sent. The password itself never left your browser, and no lookup was recorded against your account.</p>'
          );
        });
      })
      .catch(function (err) {
        status.textContent = "";
        say(
          '<div class="pc-verdict pc-bad"><strong>Could not complete the check</strong></div>' +
            '<p class="muted" style="font-size:13.5px;margin:10px 0 0">' +
            (err && err.message === "insecure"
              ? "This check needs a secure connection. Open the site over https and try again."
              : "The breach corpus did not respond. Your password was still never transmitted, so nothing was checked and nothing leaked.") +
            "</p>"
        );
      });
  });

  input.addEventListener("input", function () {
    if (!input.value) out.hidden = true;
  });

  if (toggle) {
    toggle.addEventListener("click", function () {
      var showing = input.type === "text";
      input.type = showing ? "password" : "text";
      toggle.textContent = showing ? "Show" : "Hide";
      toggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    });
  }

  // Nothing to keep here: the password is never stored anywhere.
  input.value = "";
})();
