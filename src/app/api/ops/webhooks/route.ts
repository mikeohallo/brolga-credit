import { ok, fail } from "@/lib/api";
import { getZepto, withApiContext } from "@/lib/zepto";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const z = getZepto();
    const hooks = await withApiContext("operations · webhooks", () => z.webhooks());
    const deliveries = hooks.length ? await withApiContext("operations · webhook deliveries", () => z.webhookDeliveries(hooks[0].id, { per_page: "25" })) : [];
    return ok({ webhooks: hooks, deliveries });
  } catch (err) {
    return fail(err);
  }
}
