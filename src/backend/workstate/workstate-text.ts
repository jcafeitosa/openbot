import { containsRegisteredSecret, redactText } from "@openbot/logging";

/** A text that the workstate stores is refused: it holds a registered secret, or it is empty or too long. */
export class WorkstateTextRefused extends Error {}

/**
 * The text as the workstate stores it. A text with a value that `registerSecretValue` registered is refused,
 * because the redaction only hides the known patterns. Any other text goes through `redactText`, and the
 * stored length is checked after redaction, since a redaction can change it.
 */
export function storedWorkstateText(value: string, limit: number, minimum: number, label: string): string {
  if (containsRegisteredSecret(value)) throw new WorkstateTextRefused(`${label} holds a secret and was not stored.`);
  const stored = redactText(value.trim());
  const length = Array.from(stored).length;
  if (length < minimum || length > limit)
    throw new WorkstateTextRefused(`${label} must be ${minimum} to ${limit} characters.`);
  return stored;
}
