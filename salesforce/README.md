# Baton's Salesforce app

The `Baton` External Client App that lets anyone log in to their own Salesforce org from Baton
(`baton-router connect salesforce`). It ships to customer orgs as an **unlocked package**.

- `baton-app/`: what's in the package (the app and its OAuth settings).
- `devhub-only/`: deployed to the Dev Hub only, never packaged: the global OAuth settings
  (callback `http://localhost:8749/callback`, PKCE required, no secret) and the default policies.
- `config/customer-test.json`: a throwaway scratch org to test installs.

New version: `sf package version create --package Baton --installation-key-bypass --wait 30`,
run from this folder with the Dev Hub as `target-dev-hub`.
