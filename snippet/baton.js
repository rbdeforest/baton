/*
 * Baton form snippet. Sends every field of each <form data-baton> on the page
 * to your Baton inbox when it's submitted. It never blocks or changes the form.
 * `baton-router snippet` prints this with your inbox URL filled in.
 */
(function () {
  var INBOX = "__BATON_INBOX__";
  var SKIP = /pass(word)?|card|cvc|cvv|ssn/i;
  // Lets Baton ignore the same submission sent twice.
  function submissionId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
  document.addEventListener(
    "submit",
    function (e) {
      var form = e.target;
      if (!form || !form.matches || !form.matches("form[data-baton]")) return;
      var fields = {};
      var data = new FormData(form);
      data.forEach(function (value, key) {
        if (typeof value !== "string" || SKIP.test(key)) return;
        fields[key] = key in fields ? fields[key] + ", " + value : value;
      });
      try {
        fetch(INBOX, {
          method: "POST",
          mode: "no-cors",
          keepalive: true,
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({ fields: fields, submission_id: submissionId() }),
        });
      } catch (err) {
        // Never break the customer's form.
      }
    },
    true
  );
})();
