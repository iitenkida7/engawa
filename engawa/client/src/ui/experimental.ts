// Experimental features master switch (#323). Features that are new, browser
// specific or only lightly verified sit behind this one opt-in in the "⋯" menu:
// off for everyone by default, and when a user ticks it the per-feature toggles
// appear below it (each with its own default). A feature is active only when
// the master switch AND its own toggle are on, so unticking the master switch
// turns every experiment off at once without forgetting the per-feature choices.

export const EXPERIMENTAL_STORAGE_KEY = 'engawa-experimental';

// Off unless explicitly enabled: only '1' turns experiments on.
export function parseExperimentalSetting(stored: string | null): boolean {
  return stored === '1';
}

// Whether one experimental feature is in effect (pure): the master switch gates
// the feature's own toggle.
export function isExperimentActive(masterOn: boolean, featureOn: boolean): boolean {
  return masterOn && featureOn;
}
