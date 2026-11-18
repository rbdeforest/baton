// `baton-router connect salesforce`: opens a browser tab, the person logs in to
// Salesforce and clicks Allow, and Salesforce sends the browser back to a tiny
// server on this computer that finishes the login.

import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { platform } from "node:os";
import { CALLBACK_PORT, authorizeUrl, exchangeCode, pkcePair, type SalesforceCredentials } from "../adapters/salesforce.ts";

function openBrowser(url: string): void {
  const os = platform();
  const [cmd, args] = os === "darwin" ? ["open", [url]] : os === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(cmd, args as string[], () => {});
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5"><h2>${title}</h2><p>${body}</p></body>`;

export async function connectSalesforce(loginUrl: string, clientId: string): Promise<SalesforceCredentials> {
  const { verifier, challenge } = await pkcePair();
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const url = authorizeUrl(loginUrl, clientId, challenge, state);

  const servers: Server[] = [];
  const result = new Promise<SalesforceCredentials>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no login within 5 minutes; run connect again")), 5 * 60_000);
    const handler: Parameters<typeof createServer>[1] = (req, res) => {
      const u = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = u.searchParams.get("error_description") ?? u.searchParams.get("error");
      if (error || u.searchParams.get("state") !== state || !u.searchParams.get("code")) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(PAGE("Salesforce login didn't finish", error ?? "Something didn't match. Run the connect command again."));
        clearTimeout(timer);
        reject(new Error(error ?? "login response didn't match; run connect again"));
        return;
      }
      exchangeCode(loginUrl, clientId, u.searchParams.get("code")!, verifier).then(
        (creds) => {
          res.writeHead(200, { "Content-Type": "text/html" }).end(PAGE("Baton is connected to Salesforce", "You can close this tab."));
          clearTimeout(timer);
          resolve(creds);
        },
        (e: Error) => {
          res.writeHead(500, { "Content-Type": "text/html" }).end(PAGE("Salesforce login failed", e.message));
          clearTimeout(timer);
          reject(e);
        },
      );
    };
    // "localhost" can mean either address family depending on the browser, so listen on both.
    for (const host of ["127.0.0.1", "::1"]) {
      const s = createServer(handler);
      s.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE") reject(new Error(`port ${CALLBACK_PORT} is busy; close whatever is using it and try again`));
        // No IPv6 on this machine is fine.
      });
      s.listen(CALLBACK_PORT, host);
      servers.push(s);
    }
  });

  console.log(`Opening Salesforce in your browser. Log in and click Allow.\nIf no tab opens, go to:\n${url}\n`);
  openBrowser(url);
  try {
    return await result;
  } finally {
    for (const s of servers) s.close();
  }
}
