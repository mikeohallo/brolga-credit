import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// The hosted build: the Next app as one Worker. Brolga keeps its own state (the loans,
// the mock provider, the investigator's cases) in a Durable Object, not in the
// framework's incremental cache, so the defaults here are the plain ones.
export default defineCloudflareConfig();
