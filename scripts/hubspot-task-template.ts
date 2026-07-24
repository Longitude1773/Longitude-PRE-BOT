/**
 * Task subject + body for the HubSpot "send revenue evaluation email" reminder.
 *
 * The email COPY no longer lives here. It is a HubSpot Sales Template
 * ("New Listing PRE Delivery (New contact)" / "…(Existing contact)") that pulls
 * everything from the contact's personalization tokens, so messaging can be
 * edited in the HubSpot UI without a code change. The bot only creates a short
 * reminder task pointing Erik at the right template.
 *
 * The task flags whether the agent was new or existing in HubSpot so Erik knows
 * which template to insert at a glance.
 */

export type AgentStatus = "NEW" | "EXISTING";

/** e.g. "Send revenue evaluation email — 2100 Frostwood Boulevard 4163, Park City · NEW agent" */
export function renderTaskSubject(address: string, agentStatus: AgentStatus): string {
  return `Send revenue evaluation email — ${address} · ${agentStatus} agent`;
}

/** Plain-text reminder naming the HubSpot template that matches the agent status. */
export function renderTaskBody(agentStatus: AgentStatus): string {
  if (agentStatus === "NEW") {
    return (
      "This agent is NEW to HubSpot. Open the contact, insert the " +
      "'New Listing PRE Delivery (New contact)' template, review, and send. " +
      "Fields auto-fill from the contact's properties."
    );
  }
  return (
    "This agent is EXISTING. Open the contact, insert the " +
    "'New Listing PRE Delivery (Existing contact)' template, review, and send. " +
    "Fields auto-fill from the contact's properties."
  );
}
