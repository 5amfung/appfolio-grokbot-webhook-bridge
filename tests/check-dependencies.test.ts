import { type RequestListener, type ServerResponse } from "node:http";
import { createServer } from "node:https";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { checkDependencies } from "../src/check-dependencies.js";
import {
  localhostTls,
  trustLocalhostCertificate,
} from "./fixtures/localhost-tls.js";

afterAll(trustLocalhostCertificate());

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

async function startServer(listener: RequestListener) {
  const server = createServer(localhostTls, listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  const origin = `https://127.0.0.1:${address.port}`;
  return {
    appfolioJwksUrl: new URL(`${origin}/jwks`),
    grokBotWebhookUrl: new URL(`${origin}/hook`),
    grokBotBearerToken: "crsr_local_probe",
  };
}

it("probes real HTTPS endpoints concurrently without sending a webhook or waiting for bodies", async () => {
  const requests: Array<{
    path: string | undefined;
    method: string | undefined;
    authorization: string | undefined;
    bodyBytes: number;
  }> = [];
  const responses: ServerResponse[] = [];
  let jwksResponseClosed = false;
  const config = await startServer((req, res) => {
    if (req.url === "/jwks") {
      res.on("close", () => {
        jwksResponseClosed = true;
      });
    }
    const observed = {
      path: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      bodyBytes: 0,
    };
    req.on("data", (chunk: Buffer) => {
      observed.bodyBytes += chunk.byteLength;
    });
    requests.push(observed);
    responses.push(res);
    // Neither probe receives headers until both requests reach the server.
    if (requests.length !== 2) return;
    for (let index = 0; index < responses.length; index += 1) {
      const response = responses[index];
      if (requests[index].path === "/jwks") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"keys":[');
        // Deliberately leave the body open; health needs only HTTP headers.
      } else {
        // A POST-only webhook can return 404 for HEAD.
        response.writeHead(404);
        response.end();
      }
    }
  });

  expect(await checkDependencies(config)).toEqual({
    appfolio_jwks: { ok: true, status: 200 },
    grok_bot: { ok: true, status: 404 },
  });
  expect(requests).toEqual(
    expect.arrayContaining([
      { path: "/jwks", method: "GET", authorization: undefined, bodyBytes: 0 },
      {
        path: "/hook",
        method: "HEAD",
        authorization: "Bearer crsr_local_probe",
        bodyBytes: 0,
      },
    ]),
  );
  expect(requests).toHaveLength(2);
  await vi.waitFor(() => expect(jwksResponseClosed).toBe(true));
});

it("reports real HTTP failures without following redirects", async () => {
  const paths: Array<string | undefined> = [];
  const config = await startServer((req, res) => {
    paths.push(req.url);
    if (req.url === "/jwks") {
      res.writeHead(302, { Location: "/redirected" });
    } else if (req.url === "/hook") {
      res.writeHead(503);
    } else {
      res.writeHead(200);
    }
    res.end();
  });

  expect(await checkDependencies(config)).toEqual({
    appfolio_jwks: { ok: false, reason: "http_error", status: 302 },
    grok_bot: { ok: false, reason: "http_error", status: 503 },
  });
  expect(paths.sort()).toEqual(["/hook", "/jwks"]);
});

it("reports real connection failures for both dependencies", async () => {
  const config = await startServer((req) => req.socket.destroy());
  expect(await checkDependencies(config)).toEqual({
    appfolio_jwks: { ok: false, reason: "network_error" },
    grok_bot: { ok: false, reason: "network_error" },
  });
});

it("aborts real requests when neither endpoint sends headers", async () => {
  let closedResponses = 0;
  const config = await startServer((_req, res) => {
    res.on("close", () => {
      closedResponses += 1;
    });
  });

  expect(await checkDependencies(config)).toEqual({
    appfolio_jwks: { ok: false, reason: "timeout" },
    grok_bot: { ok: false, reason: "timeout" },
  });
  await vi.waitFor(() => expect(closedResponses).toBe(2));
}, 10_000);
