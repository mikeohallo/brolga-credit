import { ok, fail } from "@/lib/api";
import { listResponse, NO_CASES_MESSAGE } from "@/lib/investigator/api";
import { loadStore } from "@/lib/investigator/store";

export const dynamic = "force-dynamic";

// The case list. Reads the investigator's own file; nothing else. The response
// says whether a key is configured, never what it is.
export async function GET() {
  try {
    const store = loadStore();
    if (!store) return fail(new Error(NO_CASES_MESSAGE), 404);
    return ok(listResponse(store));
  } catch (err) {
    return fail(err);
  }
}
