/**
 * Names and labels that people type (a download job, a recording, a webhook label) are shown in terminals, logs and
 * tables. A control character in one (an escape sequence, a bell, a newline) can rewrite what the terminal shows, so
 * such a name is refused when it is saved.
 */
// eslint-disable-next-line no-control-regex
export const NO_CONTROL = /^[^\u0000-\u001f\u007f-\u009f]*$/;
export const NO_CONTROL_MESSAGE = "must not contain control characters (such as escape sequences or new lines)";
