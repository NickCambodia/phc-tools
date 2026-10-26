// Loads every top-level PHC Tools .html file in a real headless browser and
// fails if any of them throw a JS error or log a console error on load.
// CI-only tooling (see syntax-check.mjs for why this doesn't violate the
// repo's "no build step" rule).
//
// Two things this MUST do, non-negotiably:
//  1. Bypass the password gate via the same sessionStorage key the app
//     itself checks (`phc_agent_auth`) — done via page.addInitScript so it's
//     set before the page's own gate-check script runs on DOMContentLoaded.
//  2. Stub every request to the live Apps Script Web App and Google Fonts.
//     Several tools (Lead Tracker, Task Manager, ...) fetch the real
//     production Google Sheets CRM on load — CI must NEVER touch live
//     client data. This is the single most important thing this file does.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const files = globSync("*.html", { cwd: repoRoot }).sort();

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const filePath = path.join(repoRoot, decodeURIComponent(req.url.split("?")[0]));
      try {
        const body = readFileSync(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function mockExternalCalls(page) {
  // Apps Script Web App — the live production CRM backend. Never let CI hit it.
  await page.route(/script\.google\.com\/macros\/s\/.*\/exec.*/, (route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  // Google Fonts — allowed by the repo's own rules as the one external
  // resource, but CI shouldn't depend on network reachability to pass.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => {
    route.fulfill({ status: 200, contentType: "text/css", body: "" });
  });
  // PHC_Sales_Desk.html fetches live FX rates on load (open.er-api.com,
  // falling back to api.frankfurter.dev). route.abort() still surfaces as a
  // page console.error (Chromium logs the resource-load failure itself,
  // separate from the page's own try/catch), so fulfill with an empty-but-
  // valid response instead — the page just keeps its existing/manual rates.
  await page.route(/open\.er-api\.com\//, (route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: '{"rates":{}}' });
  });
  await page.route(/api\.frankfurter\.dev\//, (route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: '{"rates":{}}' });
  });
  // telegram-catalog.html loads the Telegram Mini App SDK and Unsplash
  // placeholder photos. Same reasoning as the FX-rate mocks above: CI
  // shouldn't depend on reaching telegram.org or unsplash.com to pass.
  await page.route(/telegram\.org\/js\//, (route) => {
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" });
  });
  await page.route(/images\.unsplash\.com\//, (route) => {
    route.fulfill({
      status: 200,
      contentType: "image/gif",
      body: Buffer.from("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "base64"),
    });
  });
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch();

  let failures = 0;

  for (const file of files) {
    const page = await browser.newPage();
    const errors = [];

    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });

    // Bypass the password gate before any page script runs.
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem("phc_agent_auth", "1");
      } catch {}
    });

    await mockExternalCalls(page);

    try {
      await page.goto(`http://127.0.0.1:${port}/${file}`, {
        waitUntil: "networkidle",
        timeout: 15000,
      });
      // Give any async render (e.g. loadLeads() -> render()) a moment to settle.
      await page.waitForTimeout(500);
    } catch (err) {
      errors.push(`navigation failed: ${err.message}`);
    }

    await page.close();

    if (errors.length > 0) {
      failures++;
      console.error(`\n✗ ${file}`);
      for (const e of errors) console.error(`    ${e}`);
    } else {
      console.log(`  ok  ${file}`);
    }
  }

  await browser.close();
  server.close();

  console.log(`\n${files.length} tools checked, ${failures} with errors.`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
