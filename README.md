# Baton

Open-source lead router for builders. Paste one line into your AI tool, answer a few questions, and every form lead goes to the right rep.

```
Set up Baton for me: read https://raw.githubusercontent.com/rbdeforest/baton/main/SETUP.md and follow it.
```

- **Free on your computer.** Leads wait in a Google Sheet, and a background job routes them every few minutes.
- **Your rules.** Drop junk, split by any form answer, round robin (even or weighted), daily caps, away dates, a fallback.
- **Your tools.** Every result goes to a signed webhook. Zapier, n8n or your own agent writes it wherever you want.
- **Salesforce, if you use it.** Log in through a browser tab and leads go to whoever already owns the account, contact or lead, and rules can use account fields. Baton only reads; it never writes to Salesforce.
- **One file.** Everything lives in `baton.yaml` ([schema](schema/baton.schema.json)), so you can read it, edit it and keep it in git.

Coming: self-hosting with Docker, hosted Baton, and a calendar pop-up after the form.

## Commands

```
npx -y baton-router@latest help
```

## Develop

```
npm install
npm test
npm run build
```

Apache-2.0.
