# The West Peek OS Meet Add-on

The West Peek OS Meet Add-on: the live room beside the call (Phase Meet, tier 3; 19 Sep 2026).
Values agree with src/shared/meetings/meetAddon.ts — `npm run validate:meet-live` refuses drift.

## Register (once, in the firm's Google Cloud project; the service account cannot — probed 19 Sep 2026,
the Google Workspace Add-ons API is not enabled on west-peek-os and cloud-platform is not delegated):
  gcloud config set project west-peek-os
  gcloud services enable gsuiteaddons.googleapis.com
  gcloud workspace-add-ons deployments create west-peek-os-meet --deployment-file=deployment/meet-addon/deployment.json
  gcloud workspace-add-ons deployments install west-peek-os-meet     # installs for the signed-in account (hers)

Then in any Meet: Activities › West Peek OS. Org-wide install is a private Marketplace listing (Admin console › Apps › Google Workspace Marketplace apps), optional.


The side panel is behind Cloudflare Access on os.joinwestpeek.com and loads with HER session cookie: the Access
application sends it with SameSite=None (set 19 Sep 2026 via the API; HttpOnly kept). If that is ever reset, the panel loads as the login page.

`deployment.json` must stay pure manifest: `gcloud workspace-add-ons deployments create` rejects any
unknown key (a `_README` key inside it broke the register command on 19 Sep 2026 — "Unknown name
_README at 'deployment'"). Notes live here.

Registered 19 Sep 2026 as `west-peek-os-meet` in west-peek-os by the coordinator. The INSTALL
is per Google account and must run as the partner who opens the Meets:

    gcloud auth login sequoia@westpeek.ventures
    gcloud workspace-add-ons deployments install west-peek-os-meet --project west-peek-os

**The project must be inside the Workspace organization.** Google refuses an install with "Add-ons owned by
users outside of your organization may not be installed" when the add-on's Cloud project belongs to a
personal account (19 Sep 2026: registered first in gsc-automation-493801, under seq.taylor@gmail.com — refused
for sequoia@westpeek.ventures; re-registered in `west-peek-os` (project 239608247651, org westpeek.ventures
292925882444) and installed for her). The Meet Media API and the service account stay in gsc-automation; the
add-on is only a manifest pointing at os.joinwestpeek.com, so nothing else moves.

Firm-wide: the Google Workspace Marketplace SDK is enabled on `west-peek-os`; a PRIVATE listing there, then
Admin console › Apps › Google Workspace Marketplace apps › install for everyone, puts the panel in every
partner's Meet without gcloud.

**Firm-wide, done 19 Sep 2026 (evening).** Marketplace SDK on `west-peek-os`: App Configuration PRIVATE (locked
once saved), Individual + Admin install, Google Workspace add-on → HTTP deployment `west-peek-os-meet`, developer
West Peek Ventures / info@westpeek.ventures. Store listing published (private listings need no review):
https://workspace.google.com/marketplace/app/west_peek_os/239608247651 — then **Admin install** for the whole
organisation, accepted as info@westpeek.ventures. Nobody runs gcloud again; a new partner sees Activities › West
Peek OS in every Meet. To change the listing: the same SDK page, Store Listing, Save Draft, Publish.
