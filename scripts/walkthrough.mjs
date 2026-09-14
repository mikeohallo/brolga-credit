// End-to-end walkthrough of the Brolga demo against a running server (mock or sandbox).
// Usage: node scripts/walkthrough.mjs [baseUrl] [screenshotDir]
import { chromium } from "playwright";
import fs from "node:fs";

const base = process.argv[2] ?? "http://localhost:3123";
const shots = process.argv[3] ?? "./screenshots";
fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1380, height: 900 } });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE:", m.text()); });

const shot = async (name) => { await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); console.log("shot", name); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Reset
await fetch(`${base}/api/demo/reset`, { method: "POST" });

await page.goto(base);
await page.waitForSelector("text=Zepto connection");
await wait(1500);
await shot("01-overview-empty");

// Borrowers
await page.goto(`${base}/borrowers`);
await page.waitForSelector("text=Priya Nair");
await shot("02-borrowers");

// New loan wizard
await page.goto(`${base}/loans/new`);
await page.waitForSelector("text=Who is borrowing?");
await page.click("text=Priya Nair");
await page.click("button:has-text('Continue')");
await page.waitForSelector("text=Terms");
await page.fill("input[type=number] >> nth=0", "2500");
await page.fill("input[type=number] >> nth=1", "6");
await wait(600);
await shot("03-new-loan-terms");
await page.click("button:has-text('Continue')");
await page.waitForSelector("text=Confirm the account name");
await page.click("button:has-text('Run Confirmation of Payee')");
await page.waitForSelector("text=Risk score");
await shot("04-new-loan-cop");
await page.click("button:has-text('Create loan')");
await page.waitForURL(/\/loans\/LN-/);
const loanUrl = page.url();
console.log("loan", loanUrl);
await page.waitForSelector("text=Disburse the loan");
await shot("05-loan-created");

// Disburse
await page.click("button:has-text('Disburse $')");
await page.waitForSelector("text=Disbursement in flight");
await shot("06-disbursing");
await page.waitForSelector("text=Set up repayments with PayTo", { timeout: 40000 });
await shot("07-disbursed");

// Mandate
await page.click("button:has-text('Send PayTo agreement')");
await page.waitForSelector("text=Waiting for the borrower");
await shot("08-mandate-pending");
await page.waitForSelector("button:has-text('Collect now')", { timeout: 30000 });
await shot("09-mandate-active");

// Collect instalment 1 — insufficient funds, then retry
await page.selectOption("tr:has(button:has-text('Collect now')) select", "insufficient_funds");
await page.click("button:has-text('Collect now')");
await page.waitForSelector("text=AM04", { timeout: 30000 });
await shot("10-instalment-failed");
await page.selectOption("tr:has(button:has-text('Retry')) select", "auto_settle");
await page.click("button:has-text('Retry')");
await page.waitForSelector("tr:has-text('Settled')", { timeout: 30000 });
await wait(1500);
await shot("11-instalment-settled");

// Hardship: suspend, reactivate
await page.click("button:has-text('Suspend (hardship)')");
await page.waitForSelector("text=Agreement suspended", { timeout: 20000 });
await shot("12-suspended");
await page.click("button:has-text('Reactivate')");
await page.waitForSelector("button:has-text('Suspend (hardship)')", { timeout: 20000 });

// Restructure
await page.click("button:has-text('Restructure')");
await page.fill("input[placeholder]", "300");
await page.click("button:has-text('Send amendment')");
await page.waitForSelector("text=Pending amendment", { timeout: 20000 });
await page.waitForSelector("text=Borrower authorised the amendment", { timeout: 30000 });
await wait(1000);
await shot("13-amended");

// Operations + console
await page.goto(`${base}/operations`);
await page.waitForSelector("text=GET /transactions");
await wait(1500);
await shot("14-operations");
await page.click("button:has-text('PayTo payments')");
await wait(1200);
await shot("15-operations-payto");
await page.goto(`${base}/console`);
// The nav also carries an "API console" link, so anchor on the page heading.
await page.waitForSelector("h1:has-text('API console')");
await wait(1200);
await page.click("tr:has-text('POST') >> nth=0");
await wait(500);
await shot("16-console");

await page.goto(base);
await wait(1500);
await shot("17-overview-populated");

// Failure path: second loan with a returned disbursement
await page.goto(`${base}/loans/new`);
await page.click("text=Tom Whitlock");
await page.click("button:has-text('Continue')");
await page.click("button:has-text('Continue')");
await page.click("button:has-text('Run Confirmation of Payee')");
await page.waitForSelector("text=Risk score");
await page.click("button:has-text('Create loan')");
await page.waitForURL(/\/loans\/LN-/);
await page.click("button:has-text('Simulate a returned payment')");
await page.waitForSelector("text=Disbursement failed", { timeout: 40000 });
await wait(800);
await shot("18-disbursement-failed");

await browser.close();
console.log("done");
