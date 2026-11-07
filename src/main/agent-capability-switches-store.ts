import { type AgentCapabilitySwitches, DEFAULT_AGENT_CAPABILITY_SWITCHES } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { PreferenceStore } from "./preference-file";

/**
 * The switches of the cross-provider check, the recurrence note and the plan verifier. The backend
 * reads them at each use. A missing file, or one that is not version 1, reads as all on; so does a
 * switch whose value is not a boolean.
 */
export type AgentCapabilitySwitchesStore = PreferenceStore<AgentCapabilitySwitches>;

export function createAgentCapabilitySwitchesStore(path: string): AgentCapabilitySwitchesStore {
  return new PreferenceStore({
    path,
    defaultValue: DEFAULT_AGENT_CAPABILITY_SWITCHES,
    decode: (parsed) => {
      if (!isDynamicRecord(parsed) || parsed.version !== 1) return null;
      const { crossProviderCheck, recurrenceNote, planVerifier } = DEFAULT_AGENT_CAPABILITY_SWITCHES;
      return {
        crossProviderCheck: isBoolean(parsed.crossProviderCheck) ? parsed.crossProviderCheck : crossProviderCheck,
        recurrenceNote: isBoolean(parsed.recurrenceNote) ? parsed.recurrenceNote : recurrenceNote,
        planVerifier: isBoolean(parsed.planVerifier) ? parsed.planVerifier : planVerifier,
      };
    },
  });
}
