// Exits: rules both the server and the browser (extension, map window) apply to a place's exits. Pure.

/** The one place that decides whether an exit reveals where it leads: a hidden or obscured exit does not, until revealed. */
export const revealsDestination = exit => !(exit?.hidden || exit?.obscured) || !!exit?.revealed;
