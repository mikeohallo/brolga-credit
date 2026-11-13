import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// The hosted build: the Next app as one Worker. Brolga keeps its own state (the loans,
// the mock provider, the investigator's cases) in a Durable Object, not in the
// framework's incremental cache, so the defaults here are the plain ones.
//
// The one override: Next is built by Node running Next's own file. The adapter's default is
// `npm run build`, which would start the `npm` command and the machine's own npm settings
// (the deploy rules in CLAUDE.md run every tool by its own file for that reason).
const config = {
  ...defineCloudflareConfig(),
  buildCommand: "node node_modules/next/dist/bin/next build",
};

export default config;
