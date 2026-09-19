/**
 * The Meet Add-on, named once (Phase Meet, tier 3; 19 Sep 2026).
 *
 * The side panel (`src/client/pages/MeetPanel.tsx`) and the deployment file
 * (`deployment/meet-addon/deployment.json`, which `validate:meet-addon` checks against this)
 * agree on these — the origin the add-on may load, the route it opens, the Cloud project number
 * the SDK is initialised with, and the SDK it loads. Not secrets: a project number and public URLs.
 */
export const MEET_ADDON = {
  /** The firm's Google Cloud project number (gsc-automation-493801). The SDK needs the NUMBER, not the id. */
  cloudProjectNumber: "156361797325",
  /** Where the add-on is hosted. Two URLs share an origin when scheme, host and port match. */
  origin: "https://os.joinwestpeek.com",
  /** The side panel route. Meet loads it in an iframe; the panel resolves the call to a meeting itself. */
  sidePanelPath: "/#/meet-panel",
  /** The Meet Add-ons SDK, loaded from Google's CDN inside the panel only. */
  sdkUrl: "https://www.gstatic.com/meetjs/addons/1.1.0/meet.addons.js",
  /** The add-on's name in Meet's "Activities" panel. */
  name: "West Peek OS",
} as const;
