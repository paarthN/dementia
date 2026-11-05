const intents = new Set([
  "open_app",
  "open_website",
  "search_web",
  "set_reminder",
  "list_reminders",
  "cancel_reminder",
  "change_companion_visuals",
  "open_system_settings",
  "explain_screen",
  "guide_task",
  "press_control",
  "general_question",
  "unsupported",
]);

const modes = new Set(["execute", "guide", "explain", "answer"]);
const forbiddenKeys = new Set([
  "shell",
  "command",
  "argv",
  "exec",
  "cmd",
  "script",
  "tool",
  "x",
  "y",
  "coordinates",
]);
const shellValue = /^\s*(sudo|rm|curl|bash|sh|osascript|python|node)\b/i;

export function acceptPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (!intents.has(value.intent) || !modes.has(value.mode)) {
    return null;
  }
  if (
    !value.parameters ||
    typeof value.parameters !== "object" ||
    Array.isArray(value.parameters)
  ) {
    return null;
  }
  if (
    !Array.isArray(value.missingRequiredFields) ||
    typeof value.requiresScreenContext !== "boolean"
  ) {
    return null;
  }
  if (
    value.userFacingClarification !== undefined &&
    typeof value.userFacingClarification !== "string"
  ) {
    return null;
  }
  if (
    hasForbidden(value.parameters) ||
    hasForbidden(value.userFacingClarification)
  ) {
    return null;
  }
  return {
    intent: value.intent,
    mode: value.mode,
    parameters: value.parameters,
    missingRequiredFields: value.missingRequiredFields,
    requiresScreenContext: value.requiresScreenContext,
    ...(value.userFacingClarification
      ? { userFacingClarification: value.userFacingClarification }
      : {}),
  };
}

function hasForbidden(value) {
  if (typeof value === "string") {
    return shellValue.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasForbidden(item));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).some(
    ([key, entry]) =>
      forbiddenKeys.has(key.toLowerCase()) || hasForbidden(entry),
  );
}

export function readModelContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return null;
  }
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
