/*
 * Baton form snippet, for every <form data-baton> on the page.
 * `baton-router snippet` prints this with your Baton address filled in.
 *
 * Laptop version: sends the fields to your Google Sheet and never touches the form.
 * Server version: holds the form's submit for up to 3 seconds while Baton routes
 * the lead. If Baton answers with the rep's booking page, it opens in a pop-up;
 * when the visitor books or closes it, the form carries on exactly as before.
 * If Baton is slow or down, the form carries on with no pop-up.
 */
(function () {
  var INBOX = "__BATON_INBOX__";
  var MODE = "__BATON_MODE__";
  var WAIT_MS = 3000;
  var SKIP = /pass(word)?|card|cvc|cvv|ssn/i;
  // Booked messages the booking pages post to their parent window.
  var BOOKED = /calendly\.event_scheduled|meetingBookSucceeded|bookingSuccessful|booking_successful/;

  function submissionId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function readFields(form) {
    var fields = {};
    new FormData(form).forEach(function (value, key) {
      if (typeof value !== "string" || SKIP.test(key)) return;
      fields[key] = key in fields ? fields[key] + ", " + value : value;
    });
    return fields;
  }

  function send(form, mode) {
    return fetch(INBOX, {
      method: "POST",
      mode: mode,
      keepalive: true,
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ fields: readFields(form), submission_id: submissionId() }),
    });
  }

  // Let the form submit as if Baton weren't here (its own handlers, thank-you page and all).
  function carryOn(form) {
    form.__batonDone = true;
    if (form.requestSubmit) form.requestSubmit();
    else form.submit();
  }

  function popup(url, done) {
    var overlay = document.createElement("div");
    overlay.setAttribute("style", "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px");
    var box = document.createElement("div");
    box.setAttribute("style", "position:relative;width:100%;max-width:1000px;height:100%;max-height:760px;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.3)");
    var frame = document.createElement("iframe");
    frame.src = url;
    frame.title = "Book a meeting";
    frame.setAttribute("style", "width:100%;height:100%;border:0");
    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.setAttribute("style", "position:absolute;top:8px;right:12px;font:28px/1 sans-serif;background:none;border:0;cursor:pointer;color:#333");
    var newTab = document.createElement("a");
    newTab.href = url;
    newTab.target = "_blank";
    newTab.rel = "noopener";
    newTab.textContent = "Open in a new tab";
    newTab.setAttribute("style", "position:absolute;bottom:8px;right:12px;font:13px sans-serif;color:#555");
    box.appendChild(frame);
    box.appendChild(close);
    box.appendChild(newTab);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      window.removeEventListener("message", onMessage);
      overlay.remove();
      done();
    }
    function onMessage(e) {
      var data = typeof e.data === "string" ? e.data : JSON.stringify(e.data || "");
      if (BOOKED.test(data)) setTimeout(finish, 1500);
    }
    window.addEventListener("message", onMessage);
    close.addEventListener("click", finish);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) finish();
    });
  }

  window.addEventListener(
    "submit",
    function (e) {
      var form = e.target;
      if (!form || !form.matches || !form.matches("form[data-baton]")) return;
      if (form.__batonDone) {
        form.__batonDone = false;
        return;
      }
      if (MODE !== "server") {
        try {
          send(form, "no-cors");
        } catch (err) {
          // Never break the form.
        }
        return;
      }
      // Hold the submit (and the form's own handlers) until Baton answers.
      e.preventDefault();
      e.stopImmediatePropagation();
      var settled = false;
      var timer = setTimeout(function () {
        settled = true;
        carryOn(form);
      }, WAIT_MS);
      send(form, "cors")
        .then(function (res) {
          return res.json();
        })
        .then(function (answer) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (answer && answer.booking && answer.booking.url) {
            popup(answer.booking.url, function () {
              carryOn(form);
            });
          } else carryOn(form);
        })
        .catch(function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          carryOn(form);
        });
    },
    true
  );
})();
