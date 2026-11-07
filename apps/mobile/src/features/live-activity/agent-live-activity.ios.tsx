import { requireOptionalNativeModule } from "expo";
import type { AgentLiveActivityLoader } from "./agent-live-activity.types";

/**
 * `expo-widgets` requires its native module when it loads, and a build without the module, such
 * as Expo Go or an older development build, would crash. So the app loads it only when the module
 * exists, and has no Live Activities otherwise.
 */
export const agentLiveActivity: AgentLiveActivityLoader = () => {
  if (!requireOptionalNativeModule("ExpoWidgets")) return null;
  // The probe of the "stop agent" pilot. Metro inlines the variable, so a build without it has no probe.
  if (__DEV__ && process.env.EXPO_PUBLIC_PILOT_PING === "1") {
    const pilot: typeof import("./pilot-ping.ios") = require("./pilot-ping.ios");
    pilot.startPilotPing();
  }
  const widgets: typeof import("./agent-live-activity-widgets.ios") = require("./agent-live-activity-widgets.ios");
  return widgets.agentLiveActivity();
};
