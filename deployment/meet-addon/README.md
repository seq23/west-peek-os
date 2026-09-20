# The West Peek OS Meet Add-on

The West Peek OS Meet Add-on: the live room beside the call (Phase Meet, tier 3; 19 Sep 2026).
Values agree with src/shared/meetings/meetAddon.ts — `npm run validate:meet-live` refuses drift.

## Register (once, in the firm's Google Cloud project; the service account cannot — probed 19 Sep 2026,
the Google Workspace Add-ons API is not enabled on gsc-automation-493801 and cloud-platform is not delegated):
  gcloud config set project gsc-automation-493801
  gcloud services enable gsuiteaddons.googleapis.com
  gcloud workspace-add-ons deployments create west-peek-os-meet --deployment-file=deployment/meet-addon/deployment.json
  gcloud workspace-add-ons deployments install west-peek-os-meet     # installs for the signed-in account (hers)

Then in any Meet: Activities › West Peek OS. Org-wide install is a private Marketplace listing (Admin console › Apps › Google Workspace Marketplace apps), optional.


The side panel is behind Cloudflare Access on os.joinwestpeek.com and loads with HER session cookie: the Access
application sends it with SameSite=None (set 19 Sep 2026 via the API; HttpOnly kept). If that is ever reset, the panel loads as the login page.

`deployment.json` must stay pure manifest: `gcloud workspace-add-ons deployments create` rejects any
unknown key (a `_README` key inside it broke the register command on 19 Sep 2026 — "Unknown name
_README at 'deployment'"). Notes live here.

Registered 19 Sep 2026 as `west-peek-os-meet` in gsc-automation-493801 by the coordinator. The INSTALL
is per Google account and must run as the partner who opens the Meets:

    gcloud auth login sequoia@westpeek.ventures
    gcloud workspace-add-ons deployments install west-peek-os-meet --project gsc-automation-493801
