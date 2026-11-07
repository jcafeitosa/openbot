/**
 * Three agent capabilities that a setting can switch off. The backend reads each switch at the point
 * of use, so a change applies from the next turn. A switch that is off makes its trigger do nothing:
 * no second-provider call, no recurrence note in the prompt, no verifier turn.
 */
export interface AgentCapabilitySwitches {
  /** A second opinion from another provider on a final answer that its request flags. */
  crossProviderCheck: boolean;
  /** The note that a recurring failure adds to the next prompt of the agent. */
  recurrenceNote: boolean;
  /** The check that the done steps of a plan are really done before the request ends. */
  planVerifier: boolean;
}

/** Every capability on, which is what every agent had before the switches existed. */
export const DEFAULT_AGENT_CAPABILITY_SWITCHES: AgentCapabilitySwitches = {
  crossProviderCheck: true,
  recurrenceNote: true,
  planVerifier: true,
};
