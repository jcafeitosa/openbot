import { Button, Text, VStack } from "@expo/ui/swift-ui";
import { File, Paths } from "expo-file-system";
import { addUserInteractionListener, LiveActivity, type LiveActivityLayout } from "expo-widgets";
import ExpoWidgetsModule from "expo-widgets/build/ExpoWidgets";
import { AppState } from "react-native";

/**
 * A probe for the "stop agent" pilot, step 1. It is not a product feature.
 *
 * It answers one question: does the JavaScript of the app get the event of a Live Activity button
 * when the app is in the foreground, in the background, suspended, or closed? The button has the
 * target `pilot-ping`. Each event is written to `pilot-ping.log` in the document folder, with the
 * state of the app, so a run can be read after a cold start.
 *
 * `startPilotPing` runs only in a development build that sets `EXPO_PUBLIC_PILOT_PING=1`.
 */
const ACTIVITY_NAME = "PilotPing";
const TARGET = "pilot-ping";
const LOG_FILE = "pilot-ping.log";

/** The widget extension runs this by itself, so it uses only its arguments and `@expo/ui`. */
function pilotPingLayout(props: { label: string }): LiveActivityLayout {
  "widget";
  const button = <Button label={props.label} target="pilot-ping" />;
  return {
    banner: (
      <VStack spacing={8}>
        <Text>{props.label}</Text>
        {button}
      </VStack>
    ),
    compactLeading: <Text>{"●"}</Text>,
    compactTrailing: <Text>{"●"}</Text>,
    minimal: <Text>{"●"}</Text>,
    expandedBottom: button,
  };
}

type PilotPingEntry =
  | { kind: "armed"; target: string; appState: string | null | undefined; at: number }
  | {
      kind: "event";
      source: string;
      target: string;
      appState: string | null | undefined;
      sentAt: number;
      receivedAt: number;
      delayMs: number;
    };

function appendLog(entry: PilotPingEntry): void {
  try {
    const file = new File(Paths.document, LOG_FILE);
    const before = file.exists ? file.textSync() : "";
    file.writeSync(`${before}${JSON.stringify(entry)}\n`);
  } catch {
    // A probe that cannot write its log has nothing to report; the console line below remains.
  }
  console.log("[pilot-ping]", JSON.stringify(entry));
}

/** The lines written so far, or an empty string. */
export function readPilotPingLog(): string {
  try {
    const file = new File(Paths.document, LOG_FILE);
    return file.exists ? file.textSync() : "";
  } catch {
    return "";
  }
}

let started: LiveActivity | null = null;

/** Starts one probe activity and logs each button event. Calling it again does nothing. */
export function startPilotPing(): void {
  if (started) return;
  // The listener is added first: a press that wakes the app must not find it missing.
  addUserInteractionListener((event) => {
    const receivedAt = Date.now();
    appendLog({
      kind: "event",
      source: event.source,
      target: event.target,
      appState: AppState.currentState,
      sentAt: event.timestamp,
      receivedAt,
      delayMs: receivedAt - event.timestamp,
    });
  });
  const factory = new ExpoWidgetsModule.LiveActivityFactory(ACTIVITY_NAME, `(${String(pilotPingLayout)})`);
  started = new LiveActivity(factory.start(JSON.stringify({ label: "Ping" })));
  appendLog({ kind: "armed", target: TARGET, appState: AppState.currentState, at: Date.now() });
}

/** Ends the probe activity. */
export async function stopPilotPing(): Promise<void> {
  const activity = started;
  started = null;
  if (activity) await activity.end("immediate");
}
