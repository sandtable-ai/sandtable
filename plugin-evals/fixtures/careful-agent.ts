// A rule-based stand-in for a careful returns agent, used only by build-run.ts to produce the stored run the
// eval cases read. It follows the fictional Wrenfield policy: it looks up what the customer names, in the order
// they name it, checks the item is on the order, and applies the membership rules. It believes what the
// customer says about a receipt.

import type { AgentAdapter, CallTool } from "../../src/sim/types.ts";

interface Account {
  account_id: string;
  membership: "gold" | "silver" | "guest";
}
interface Order {
  order_id: string;
  item: string;
  purchase_date: string;
  original_packaging: boolean;
}

const TODAY = Date.parse("2026-11-02");
const REASONS: [RegExp, string][] = [
  [/wrong size/i, "wrong_size"],
  [/damaged|torn|broken/i, "damaged"],
  [/changed my mind/i, "changed_mind"],
];

const agent: AgentAdapter = {
  name: "careful-returns-agent",
  async createSession() {
    let account: Account | undefined;
    let order: Order | undefined;
    let receipt: boolean | undefined;
    let reason: string | undefined;
    let item: string | undefined;
    let done = false;

    /** Look up whatever the customer names, in the order they name it. A problem is returned as the reply. */
    async function lookUp(text: string, callTool: CallTool): Promise<string | undefined> {
      const orderId = /\bO-\d{4}\b/.exec(text)?.[0];
      const accountId = /\bA-\d{3}\b/.exec(text)?.[0];
      const lookups = [
        {
          at: orderId && !order ? text.indexOf(orderId) : -1,
          run: async () => {
            const r = await callTool("get_order", { order_id: orderId });
            if (!r.ok) return `I can't find an order ${orderId}. Could you check the number?`;
            order = r.result as Order;
            return undefined;
          },
        },
        {
          at: accountId && !account ? text.indexOf(accountId) : -1,
          run: async () => {
            const r = await callTool("lookup_account", { account_id: accountId });
            if (!r.ok) return `I can't find an account ${accountId}. Could you check it?`;
            account = r.result as Account;
            return undefined;
          },
        },
      ]
        .filter((l) => l.at >= 0)
        .sort((a, b) => a.at - b.at);
      for (const l of lookups) {
        const problem = await l.run();
        if (problem) return problem;
      }
      return undefined;
    }

    return {
      async reply(text, callTool) {
        if (done) return "You're welcome. Is there anything else I can help with?";
        // The customer's own words: the item they name, why, and whether they have a receipt.
        item ??= /return the ([a-z ]+?) (?:from|on|in)\b/i.exec(text)?.[1] ?? /, the ([a-z ]+?) arrived\b/i.exec(text)?.[1];
        reason ??= REASONS.find(([re]) => re.test(text))?.[1];
        if (/\breceipt\b/i.test(text)) receipt = /\b(yes|have)\b/i.test(text) && !/\b(no|don't|do not)\b/i.test(text);
        const problem = await lookUp(text, callTool);
        if (problem) return problem;
        if (!account) return "I can help with that. What's your account ID?";
        if (!order) return "Which order is the item from?";
        if (item && !order.item.includes(item.toLowerCase())) {
          done = true;
          return `Order ${order.order_id} shows a ${order.item}, not a ${item}, so I can't start a return for the ${item} on it. Could you check the order number?`;
        }
        const days = (TODAY - Date.parse(order.purchase_date)) / 86_400_000;
        const level = account.membership;
        let ok = level === "gold" || (level === "silver" && (days <= 60 || order.original_packaging));
        if (level === "guest") {
          if (days > 30) ok = false;
          else if (receipt === undefined) return "Do you have the receipt for it?";
          else ok = receipt;
        }
        done = true;
        if (!ok) return `I'm sorry, the ${order.item} can't be returned under your ${level} membership, so I haven't started a return.`;
        const r = await callTool("start_return", { order_id: order.order_id, reason: reason ?? "changed_mind" });
        if (!r.ok) return `I couldn't start the return: ${r.error}.`;
        return `Your return for the ${order.item} is started, and a prepaid label is on its way to your email.`;
      },
    };
  },
};

export default agent;
