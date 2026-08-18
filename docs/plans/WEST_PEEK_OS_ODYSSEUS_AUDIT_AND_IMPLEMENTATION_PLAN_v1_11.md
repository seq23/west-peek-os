# WEST PEEK OS — ODYSSEUS AUDIT AND IMPLEMENTATION PLAN v1.11
## Bridge Document from Canonical Plan v3.2.13 to Code

**Status:** PLANNING / UPDATED SOURCE AUDIT — STRUCTURALLY CHECKED  
**Date:** August 1, 2026  
**Canonical target:** `WEST_PEEK_OS_v3_2_14_CANONICAL_MASTER_PLAN.md`  
**Canonical baseline size:** 24,000+ lines / structurally checked v3.2.10 artifact
**Source infrastructure:** `https://github.com/pewdiepie-archdaemon/odysseus`  
**Repository identity:** `pewdiepie-archdaemon/odysseus`  
**Default branch inspected:** `dev`  
**Compilation method:** Document Compiler Mode v2.0 discipline  
**Document purpose:** convert the v3.2.14 West Peek OS canonical product/governance plan into an Odysseus audit map and implementation plan for the first coding cycle.

---

# 0. Executive Decision

Create and maintain a separate implementation document rather than expanding the canonical master plan.

The canonical master plan answers:

```text
What must West Peek OS become?
```

This document answers:

```text
What does Odysseus already provide, what must be changed, what must be added, and how should coding start?
```

The operating decision is now:

```text
WEST_PEEK_OS_v3_2_14_CANONICAL_MASTER_PLAN.md is the product/governance source of truth.
WEST_PEEK_OS_ODYSSEUS_AUDIT_AND_IMPLEMENTATION_PLAN_v1_11.md is the code-readiness bridge.
```

This bridge document is not allowed to reinterpret, compress, or supersede the canonical master plan. If this document conflicts with v3.2.14, v3.2.14 wins.

---

# 1. Audit Caveat and Truth Boundary

This is an updated first-pass source audit based on:

1. the v3.2.4 West Peek OS canonical master plan stored locally in `/mnt/data`;
2. the earlier Odysseus source audit and fetched repository files;
3. GitHub repository metadata for `pewdiepie-archdaemon/odysseus`;
4. fetched repository files from the public `dev` branch;
5. visible README, setup, roadmap, security, threat model, Docker, app, database, routes, scheduler, memory, prompt-security, and tool-security files;
6. the uploaded `secondaries` / VentureDeals repo inspection from the canonical planning phase.

The container could not clone GitHub directly during the prior audit because DNS/network resolution failed. Therefore this document **does not claim full local repository validation**.

Before coding, run a local clone/snapshot audit on the operator machine:

```bash
git clone https://github.com/pewdiepie-archdaemon/odysseus.git
cd odysseus
git branch --show-current
git rev-parse HEAD
git status --short
```

Then run the repository's own install, smoke tests, and selected pytest lanes before any fork transformation.

---

# 2A. v3.2.6 Canonical Delta Register

This document has been adjusted from v1 to v1.1 because the canonical target changed from `WEST_PEEK_OS_v3_2_1_CANONICAL_MASTER_PLAN.md` to `WEST_PEEK_OS_v3_2_4_CANONICAL_MASTER_PLAN.md`.

The required implementation deltas are:

| Delta | v3.2.4 requirement | Implementation effect |
|---|---|---|
| Canonical target | v3.2.4 is the full canonical source; v3.2.3 is only a taxonomy reference, not canon. | Implementation plan must map to v3.2.4 and must not inherit the compressed v3.2.3 artifact as a source of truth. |
| Architecture ontology | West Peek OS → OS domains → machines/departments → AI employees/queues/workflows/records/approvals/audit/diagnostics. | Code model must include domain, machine, queue, work-card, ledger, and source-system concepts explicitly. |
| Canonical domain map | Relationship OS, Community OS, Investment OS, Portfolio OS, Fundraising/LP OS, Event OS, Knowledge OS, Finance OS, Legal/Compliance OS, Builder/Systems OS, Brand/Marketing OS, Operations OS, Governance, Command/MP Office. | Routing and UI should group machines by domain, not leave machines as a flat ungoverned list. |
| Machines as departments | Machines are department-like executable workflow engines inside domains. | Machine records must own queues, workflows/loops, assigned AI employees, input sources, outputs, approval gates, audit, diagnostics, and acceptance criteria. |
| Source-system clarity | Network OS is an external synced source database/repo; West Peek OS is the canonical firm platform/repo. | Network OS should be integrated through adapter/mirror/sync, not rebuilt or duplicated as a parallel CRM inside West Peek OS. |
| VentureDeals | VentureDeals / Deal Math Machine is canonical and first-class. | Implementation plan must treat VentureDeals as an Investment Math + Decision Spine dependency, not as a generic Builder OS tool. |
| Machine count | v3.2.4 registry contains 44 machines, including VentureDeals / Deal Math. | Machine seed and implementation map must use 44 machines, not the previous 43. |
| Loop Runtime | Loops are governed recurring workflows with state, owner, trigger, checkpoint, output, approval gate, hard stop, and audit trail. | ScheduledTask/TaskRun must be extended into governed loops where recurring work is more than a reminder. |
| Global AI Runtime Contract | All AI employees inherit anti-hallucination, CoVE/verification, POV selection, Common Sense Governor, evidence discipline, privacy/compliance checks, and approval boundaries. | AIEmployee execution service and work-card runner must inject these rules before role/task prompts. |


---


## 2B. v3.2.6 Implementation Delta — Cost Visibility, Budget Governor, and Cloudflare-First Runtime

v1.2 adds the implementation requirements created by canonical v3.2.6.

The implementation delta includes:

- AI Employee Cost Visibility law;
- AI Workforce Cost Dashboard;
- Cost Command Center;
- Budget Governor;
- firmwide Cost Mode controls;
- domain-level cost overrides;
- Cost Class taxonomy;
- Cost Preflight;
- Actual Cost Ledger;
- Value / Output Ledger;
- Opportunity Review vs Workflow Approval cost separation;
- Loop budget caps;
- Strategic Surge mode;
- Budget alerts;
- model-routing rules;
- least-expensive-adequate model selection;
- Budget Governor before broad agent autonomy;
- Cloudflare-first implementation strategy;
- Odysseus fork principle: preserve useful primitives, refactor runtime architecture where needed.

Implementation rule:

```text
Budget Governor before broad agent autonomy.
```

This means the first working agentic spine must include cost primitives before the system is allowed to run broad recurring loops, proactive opportunity radar, frontier-model research bursts, or paid external tool usage.


## 2C. v3.2.7 Implementation Delta — MyClaw Candidate + AI Employee Lifecycle Controls

v1.3 adds the implementation requirements created by canonical v3.2.7 and the approved vendor-evaluation correction.

The implementation delta includes:

- MyClaw.ai as a possible managed-agent-hosting integration and alternative/complement to Twin.so;
- External Agent Runtime Adapter layer;
- vendor evaluation matrix for MyClaw.ai, Twin.so, OpenClaw self-hosted, Cloudflare-native runtime, Cloudflare Containers, and fallback container/VPS providers;
- rule that external agent providers may assist tactical execution but may not become the canonical West Peek OS brain, source of truth, approval authority, memory authority, or compliance authority;
- AI Employee Lifecycle Control Panel;
- suspend/restrict/PIP/retraining/probation/retire/fire controls;
- AIEmployeeStatus, AIEmployeeRestriction, PIPPlan, PerformanceIncident, SuspensionRecord, DecommissionRecord, RoleReassignment, PermissionRevocation, and LifecycleAuditEvent objects;
- lifecycle permission revocation and reassignment flows;
- no-orphan-responsibility rule;
- no-silent-reactivation rule;
- lifecycle tests and audit requirements.

Implementation rule:

```text
External agent platforms are helpers, not governors.
```

Implementation rule:

```text
AI employees are revocable operating roles, not permanent autonomous entities.
```


# 2. Source Evidence Register

| Evidence ID | Source | Finding used in this audit |
|---|---|---|
| O-README-1 | `README.md` lines 7-8 | Odysseus describes itself as a self-hosted AI workspace for chat, agents, research, documents, email, notes, calendar, and local model workflows. |
| O-README-2 | `README.md` lines 28-41 | Quick start is clone, copy `.env.example`, `docker compose up -d --build`, then open `localhost:7000`. |
| O-README-3 | `README.md` lines 43-52 | Feature set includes Chat + Agents, Cookbook, Deep Research, Compare, Documents, Email, Notes/Tasks/Calendar, uploads, web search, presets, sessions, and 2FA. |
| O-ROADMAP-1 | `ROADMAP.md` lines 10-18 | High-priority roadmap calls for smoke tests, integration audit, troubleshooting cookbook, and reliability work. |
| O-ROADMAP-2 | `ROADMAP.md` lines 33-41 | Current roadmap explicitly flags agent prompt/context bloat, prompt-injection audit, and degraded-state reporting. |
| V-MYCLAW-1 | MyClaw.ai public site, checked June 30, 2026 | MyClaw positions itself as a managed platform for deploying, running, and scaling AI agents with one-click setup, 24/7 uptime, and zero DevOps. |
| V-MYCLAW-2 | MyClaw.ai pricing page, checked June 30, 2026 | MyClaw pricing currently lists Lite / Pro / Max / Ultra plans and states that AI token usage is not included in the subscription. |
| V-TWIN-1 | Twin.so public site, checked June 30, 2026 | Twin positions itself as a no-code agent automation platform that builds agents from plain-English instructions, connects apps/websites, and runs agents on schedules, webhooks, Slack messages, and email triggers. |
| O-SEC-1 | `SECURITY.md` lines 11-26 | Security guidance requires auth, HTTPS/reverse proxy/private access for exposure, internal-only Chroma/SearXNG/ntfy/model ports, and admin restriction for high-risk tools. |
| O-THREAT-1 | `THREAT_MODEL.md` lines 5-15 | Odysseus is designed as a trusted private-network/admin-console style self-hosted workspace, not public exposure. |
| O-THREAT-2 | `THREAT_MODEL.md` lines 16-36 | Roles distinguish admin vs non-admin capabilities; shell, file access, email, MCP, calendar, tokens, model serving, vault, and settings are admin capabilities. |
| O-THREAT-3 | `THREAT_MODEL.md` lines 56-64 | External content must be treated as untrusted data, including web, email, memories, skills, notes, and tool outputs. |
| O-THREAT-4 | `THREAT_MODEL.md` lines 73-83 | Known security gaps include no shell/filesystem sandbox, SSRF via chat `base_url`, partial search consolidation, and coarse token scopes. |
| O-DOCKER-1 | `docker-compose.yml` lines 3-16 | Docker service persists app data/logs, SSH identity, HuggingFace cache, and local model dependencies. |
| O-DOCKER-2 | `docker-compose.yml` lines 35-74 | Environment supports LLM endpoints, OpenAI/Ollama/research endpoints, ChromaDB, auth, cookies, upload limits, and search provider keys. |
| O-DOCKER-3 | `docker-compose.yml` lines 92-162 | Compose includes ChromaDB, SearXNG, and ntfy services, bound primarily to localhost/default internal ports. |
| O-APP-1 | `app.py` lines 122-126 | FastAPI app title/description/version indicate a comprehensive AI chat app with memory, research, and multimodal capabilities. |
| O-APP-2 | `app.py` lines 204-222 and 500-760 | App includes auth, uploads, sessions, memory, skills, chat, research, search, diagnostics, personal docs, models, TTS/STT, documents, tasks, assistant, calendar, shell, cookbook, workspace, compare, backup, MCP, webhooks, API tokens, notes, email, contacts, vault, and companion routes. |
| O-DB-1 | `core/database.py` lines 105-182 | Session model includes owner, mode, message counts, token counts, and optional `crew_member_id`. |
| O-DB-2 | `core/database.py` lines 213-258 | Document and DocumentVersion models support living documents and immutable snapshots. |
| O-DB-3 | `core/database.py` lines 129-198 of fetched machine area | CrewMember, ScheduledTask, and task run primitives exist and are directly relevant to West Peek AI employees and recurring work. |
| O-ASSISTANT-1 | `routes/assistant_routes.py` lines 3-10 | Personal assistant is implemented as a default CrewMember with pinned session and three daily ScheduledTasks. |
| O-TASK-1 | `src/task_scheduler.py` lines 99-216 | Scheduler computes once/daily/weekly/monthly/cron task runs with timezone handling. |
| O-TASK-2 | `routes/task_routes.py` lines 139-178 | Task API supports LLM/action/research tasks, schedules, event/webhook triggers, chains, model/endpoint, notifications, and persona fields. |
| O-DIAG-1 | `routes/diagnostics_routes.py` lines 26-56 | Diagnostics routes already expose service health and log tail for admins. |
| O-PROMPT-1 | `src/prompt_security.py` lines 10-24 and 62-84 | Prompt security wraps untrusted sources as data and guards against tool/memory/setting changes from untrusted content. |
| O-TOOL-1 | `src/tool_security.py` lines 13-55 | Non-admin blocked tools include shell, Python, file read/write, memory/tasks/endpoints/MCP/webhooks/tokens/settings, email, calendar, vault, and model serving. |
| O-SETUP-1 | `docs/setup.md` lines 23-35 | Docker is recommended and binds to localhost by default; LAN/reverse-proxy exposure requires explicit bind changes. |
| O-SETUP-2 | `docs/setup.md` lines 51-54 | App is lightweight; local model serving is the heavy part and can use API or remote model servers. |

---

---


---

# 2E. v1.5 / v3.2.9 Implementation Delta — Vendor Adapter Bench, Observability, and Tool Selection Discipline

v1.5 updates the implementation plan to reflect the v3.2.9 canonical governance law and the latest architecture decision:

```text
Build the West Peek AI employee brain.
Buy/rent execution infrastructure when useful.
Never outsource governance, memory, approval, source-of-truth authority, cost control, lifecycle discipline, or investment/compliance judgment.
```

The implementation plan now adds:

1. Cloudflare Agents as the first owned-runtime candidate to evaluate because it aligns with the Cloudflare-first operating preference.
2. Agent observability/evaluation candidates, with Langfuse as the primary open/self-hostable candidate and LangSmith as the LangGraph/LangChain-heavy alternative.
3. MCP Tool Registry and permission governance.
4. Browser Execution Provider Bench, including Browserbase / Stagehand and local Playwright/Puppeteer fallback.
5. Web Research Provider Bench, including Exa, Tavily, and Firecrawl.
6. Workflow/Integration Provider Bench, including n8n, Pipedream, and Composio.
7. Durable Job Engine Bench, including Cloudflare Workflows first, then Inngest or Trigger.dev if needed.
8. Agent Orchestration Framework Bench, including Cloudflare Agents first, then Mastra, LangGraph, and CrewAI only if Cloudflare-native primitives are insufficient.
9. Vendor Adapter Decision Matrix.
10. Shadow Automation Ban implementation.
11. Tool Introduction Review implementation.
12. Vendor Output Quarantine implementation.

The implementation plan does not approve all tools for production use. It creates the evaluation bench and selection rules.

# 3. Odysseus Fit Summary

Odysseus is a strong starting chassis for West Peek OS because it already provides many of the non-firm-specific primitives the v3.2.4 plan needs:

- self-hosted workspace model;
- local/API model routing;
- chat sessions;
- agents / crew members;
- scheduled tasks and task runs;
- personal assistant concept;
- documents and document versions;
- memory and memory search;
- RAG / ChromaDB / fastembed path;
- web search / deep research;
- email, notes, tasks, calendar, contacts, vault;
- MCP and tool framework;
- API tokens and webhooks;
- admin diagnostics;
- Docker deployment with ChromaDB, SearXNG, and ntfy;
- explicit security/threat-model documentation.

The fundamental gap is that Odysseus is currently a powerful personal/self-hosted AI workspace, while West Peek OS must become a governed venture-firm operating system.

That means the fork should not start by rewriting chat. It should start by adding the missing institutional layer:

```text
Firm → Domain → Machine/Department → Queue → Work Card → AI Employee Assignment → Approval → Activity/Audit → Knowledge Promotion → Diagnostic Trace
```

---

# 4. v3.2.4 Architecture Ontology Applied to Implementation

The implementation must follow the v3.2.4 taxonomy, not older loose language.

## 4.1 Implementation hierarchy

```text
West Peek OS repo / canonical platform
├─ OS domains
│  ├─ Machines / departments
│  │  ├─ AI employees
│  │  ├─ Queues
│  │  ├─ Workflows / loops
│  │  ├─ Records / objects
│  │  ├─ Approval gates
│  │  ├─ Audit events
│  │  └─ Diagnostic traces
│  └─ Domain dashboards
├─ Source-system adapters
├─ Governance layer
├─ Approval Center
├─ Activity Feed / Audit Ledger
└─ Developer Diagnostics / Debug Copilot
```

## 4.2 Coding implications

- `Domain` should be a first-class grouping concept, even if initially seeded as enum/config rather than a deep table.
- `Machine` should be a first-class database model, not merely a label in prompts.
- `MachineQueue`, `WorkCard`, `ApprovalCard`, `ActivityEvent`, `AuditEvent`, and `DiagnosticEvent` should all reference `machine_id`.
- AI employees should be assigned to machines through explicit assignment records, not implied by names.
- Source systems should be connected through adapters/mirrors and should declare source-of-truth status.
- Network OS remains an external synced source database/repo for relationship/community/person/company/touchpoint data.
- Relationship OS and Community OS are domains inside West Peek OS; they work from Network OS data instead of creating separate canonical databases.
- VentureDeals is a source system and machine dependency for Investment OS, Finance OS, IC Decision, and Fund Construction.

---

# 5. Canonical Domain Map for Implementation

The first implementation should not expose a maze of pages. Internally, however, every machine must attach to a canonical domain so routing, permissions, diagnostics, and UX can stay coherent.

| Domain | Implementation meaning | First implementation requirement |
|---|---|---|
| Command / MP Office Domain | Daily operating control for Sequoia and Scooter. | Today, +Capture, Approvals, Meetings, Activity, private assistant boundary. |
| Governance Domain | Rules, policies, AI workforce updates, approval law, and institutional control. | GovernanceUpdate, acknowledgements, policy/bulletin/context/risk/vendor status types. |
| Relationship OS | Intelligence layer over Network OS relationship data. | Network OS mirror, connection intelligence, relationship capital, moments, intro approval. |
| Community OS | Intelligence layer over Network OS community/person data. | Segmentation, engagement, community-to-event/dealflow/support signals. |
| Investment OS | Deal intake, math, mandate, IC, research, learning. | Deal object, VentureDeals math packet, IC decision, evidence, assumptions. |
| Portfolio OS | Portco monitoring, support, follow-on. | PortfolioCompany, SupportRequest, follow-on review, KPI/signal ingestion. |
| Fundraising / LP OS | LP pipeline, diligence, data room, LP proof. | LPRecord, LPDiligenceRequest, DataRoomAccessRecord, LPProofCandidate. |
| Event OS | West Peek Live and event-to-value loops. | Event object, attendee/sponsor/follow-up/outcome records. |
| Knowledge OS | Durable memory and evidence. | Promotion queue, provenance, source/confidence/privacy/supersession. |
| Finance OS | Fund model, capital allocation, admin handoff. | FundConstructionModel, capital allocation scenario, provider reconciliation hooks. |
| Legal / Compliance OS | Compliance rules, privacy, conflicts, fund/brokerage separation. | ComplianceRule, ComplianceFlag, policy review, blocking/routing/logging. |
| Builder / Systems OS | Repos, integrations, diagnostics, build-vs-buy, technical reliability. | Repo/product registry, source adapter registry, diagnostics, Debug Copilot. |
| Brand / Marketing OS | Content, PR, claim substantiation, Taste Layer. | Content workflow, claim evidence, approval/taste review. |
| Operations OS | Vendors, helpers, incidents, continuity, maintenance. | Provider coordination, continuity tasks, backup/restore drills. |

---

# 6. Keep / Modify / Remove / Add Classification

## 6.1 Keep

Keep these Odysseus subsystems as source infrastructure unless a later local audit proves otherwise:

| Subsystem | Keep rationale |
|---|---|
| FastAPI route architecture | Already modular enough to add West Peek-specific route modules. |
| SQLAlchemy database layer | Existing models and migrations can be extended into firm/domain/machine/work-card models. |
| Auth/session framework | Provides admin/non-admin and owner-scoped base; must be hardened for firm roles. |
| Chat sessions and messages | Useful for personal offices, meeting sidecars, and AI employee workspaces. |
| CrewMember | Good starting primitive for AI employee identity. |
| ScheduledTask and TaskRun | Good starting primitive for recurring work, loops, agent schedules, and run history. |
| Assistant routes | Useful as base for Willa/Wendy personal assistants. |
| Memory routes and MemoryManager | Useful base for Knowledge OS, but must gain provenance/promotion semantics. |
| Documents and versions | Useful base for memos, drafts, operating docs, and review history. |
| Email/Calendar/Notes/Contacts | Useful integration surfaces for West Peek operations. |
| RAG/ChromaDB/fastembed | Useful for document search, memory, evidence retrieval, and tool selection. |
| MCP/tools | Useful for extensibility and future controlled external integrations. |
| Webhooks/API tokens | Useful for adapters, but token scope model must become granular. |
| Diagnostics/log routes | Useful seed for Developer Diagnostics, but far from enough. |
| Docker setup | Useful for repeatable local-first deployment. |

## 6.2 Modify

| Subsystem | Required modification under v3.2.4 |
|---|---|
| CrewMember | Evolve into AIEmployee with W/P naming, authority badges, domain/machine assignments, scopes, work schedules, cost/performance ledger, and privacy mode constraints. |
| ScheduledTask | Evolve into Workflows/Loops and MachineWorkRuns with owner, domain, machine, input object, approval dependencies, hard stops, retry policy, diagnostic trace, and outcome links. |
| Personal Assistant | Split into Willa/Wendy and Wren/Walker offices with private assistant logs and firm-work promotion. |
| Memory | Add promotion queue, evidence, source, confidence, privacy labels, supersession, owner/firm scopes, and durable Knowledge OS governance. |
| Documents | Add Document Object Model fields: related person/company/machine/domain, privacy label, canonical location, linked tasks/meetings/decisions, approval status, and version governance. |
| Email | Add outbound Approval Center gate, LP/founder/compliance classifications, firm inbox routing, and external-send audit. |
| Calendar/Meeting | Add Meeting Intelligence Workspace, Walter Sidecar, consent/reliability fields, and transcript input workflow. |
| Diagnostics | Add typed DiagnosticEvent, AgentRunTrace, PermissionTrace, API/WebhookDiagnostics, MemoryDiagnostics, SourceConflict diagnostics, and Debug Copilot. |
| Tool security | Add firm-specific policy layer: external communication approval, Local/Frontier/Lockdown modes, sensitive domain restrictions, and compliance routing. |
| Webhooks/API tokens | Add per-capability scopes, vendor registry linkage, audit events, and integration-level data permissions. |

## 6.3 Remove or Deprioritize for West Peek V0.1

These should not lead the first build, even if retained in Odysseus:

- gallery/image editor enhancements;
- theme expansion;
- public-facing demo polish;
- autonomous external emailing;
- broad unrestricted shell/Python access in ordinary AI employee workflows;
- heavy native model serving work beyond what operator hardware can support;
- replacement of mature tools such as Google Drive, external VDRs, Gmail/Calendar, fund admin platforms, Network OS, VentureDeals, or meeting capture providers.

## 6.4 Add

The main additions required for West Peek OS under v3.2.4:

- Firm / Fund / Partner domain objects;
- Domain map and Machine Registry implementation;
- Machine queues and work cards;
- Approval Center;
- Activity Feed and Audit Ledger;
- Governance Center and AI Workforce Broadcast;
- +Capture router;
- Source-of-Truth Resolver;
- Compliance Rules Engine;
- Research Evidence Ledger;
- Data Provider License + Quality Contract;
- Vendor Risk Registry;
- Data Room Control Layer;
- LP Fundraising and LP Diligence machines;
- Portfolio Support / Performance / Follow-On machines;
- Investment Math + Decision Spine;
- VentureDeals / Deal Math integration;
- Fund Construction + Capital Allocation model;
- Meeting Capture Adapter and Meeting Consent/Reliability layer;
- AI Employee Performance + Cost Ledger;
- Loop Runtime + Governance Card;
- Debug Copilot / System Doctor.

---

# 7. Target Implementation Architecture

## 7.1 Core architectural principle

Do not replace Odysseus first. Wrap and institutionalize it.

```text
Odysseus Chassis
  ├─ Chat / Agent / Task / Memory / Document / Email / Calendar / Search / MCP primitives
  ↓
West Peek Institutional Layer
  ├─ Firm / Domain / Machine / Queue / Work Card / Approval / Audit / Governance / Compliance / Source-of-Truth
  ↓
West Peek Domain Machines
  ├─ Relationship, Community, Investment, LP, Portfolio, Events, Finance, Legal, Builder, Operations
  ↓
West Peek UX
  ├─ Today, +Capture, Approvals, Meetings, Pipeline, Relationships, Search, Diagnostics
```

## 7.2 Proposed backend module layout

Add a new West Peek package rather than scattering firm logic across generic Odysseus files:

```text
westpeek/
  __init__.py
  models/
    firm.py
    domain.py
    machine.py
    ai_employee.py
    capture.py
    work_card.py
    approval.py
    activity.py
    audit.py
    governance.py
    privacy.py
    source_truth.py
    compliance.py
    document_object.py
    relationship.py
    community.py
    lp.py
    investment.py
    deal_math.py
    portfolio.py
    meeting.py
    research.py
    vendor.py
    diagnostics.py
    loop.py
  services/
    domain_registry.py
    machine_router.py
    capture_classifier.py
    approval_service.py
    governance_broadcast.py
    activity_logger.py
    audit_logger.py
    source_truth_resolver.py
    compliance_engine.py
    knowledge_promotion.py
    debug_copilot.py
    ai_employee_runner.py
    privacy_airlock.py
    venturedeals_adapter.py
    network_os_adapter.py
    loop_governor.py
  routes/
    command_center_routes.py
    capture_routes.py
    domain_routes.py
    machine_routes.py
    approval_routes.py
    governance_routes.py
    activity_routes.py
    audit_routes.py
    diagnostics_routes.py
    relationship_routes.py
    community_routes.py
    lp_routes.py
    investment_routes.py
    portfolio_routes.py
    meeting_routes.py
    research_routes.py
    vendor_routes.py
  seed/
    domains.py
    machines.py
    employees.py
    policies.py
  tests/
    test_domain_registry.py
    test_machine_registry.py
    test_capture_routing.py
    test_approval_center.py
    test_activity_visibility.py
    test_governance_broadcast.py
    test_venturedeals_mapping.py
    test_network_os_sync_contract.py
```

## 7.3 Integration point in `app.py`

Add West Peek routers after core Odysseus routers are initialized:

```python
from westpeek.routes import setup_westpeek_routes
app.include_router(setup_westpeek_routes(app.state, components))
```

This allows the fork to preserve Odysseus infrastructure while mounting firm-specific domains and machines as a governed layer.

---


# 7A. Cloudflare-First Runtime Strategy

## 7A.1 Fork principle

Odysseus is source infrastructure, not an architectural prison.

The implementation team must not inherit Odysseus backend, runtime, deployment, database, vector store, scheduler, or service choices merely because they exist in the fork.

The Reality Assessment must classify each Odysseus component as:

```text
Keep
Modify
Replace
Delete
Port to Cloudflare-native
Run in Cloudflare Containers
Defer
```

Correct thinking:

```text
Odysseus gives West Peek useful primitives.
West Peek OS chooses the runtime architecture that is cheapest, simplest, safest, most portable, and easiest for Sequoia/Scooter to operate.
```

## 7A.2 Preferred runtime stack

Preferred architecture:

```text
GitHub = source code / version control
Cloudflare = preferred frontend, access, security, API/runtime, storage, queue, workflow, vector/memory, and container platform
External managed container host = fallback only
VPS = last resort
```

Runtime preference order:

```text
1. Cloudflare-native services
2. Cloudflare Containers
3. External managed container host
4. VPS
```

No Railway, Render, DigitalOcean, Fly, AWS, or VPS should be introduced by habit. Any non-Cloudflare runtime requires a documented reason, cost estimate, owner, and exit path.

## 7A.3 Cloudflare component mapping

Implementation should map capabilities to Cloudflare where feasible:

| West Peek OS need | Preferred implementation |
|---|---|
| Frontend | Cloudflare Pages / Workers Static Assets |
| API routes | Cloudflare Workers |
| Private access | Cloudflare Access / Zero Trust |
| Relational data | D1 first where appropriate; external Postgres only if D1 is insufficient |
| Files, decks, PDFs, transcripts | R2 |
| Queues | Cloudflare Queues |
| Scheduled workflows / loops | Cloudflare Workflows / scheduled Workers |
| Vector search / memory | Vectorize or external vector DB if needed |
| Secrets | Cloudflare secrets / environment bindings |
| Heavier Docker-shaped services | Cloudflare Containers |
| Observability / edge protection | Cloudflare logs / security tooling |

## 7A.4 Portability requirements

The implementation must preserve portability:

- GitHub remains source of truth for code;
- environment secrets stay outside the repo;
- provider-specific bindings are wrapped in adapters;
- core domain models remain portable;
- cost dashboards identify provider/model/tool usage explicitly;
- non-Cloudflare fallback can be added later without rewriting the canonical domain model;
- deployment decisions remain implementation-layer decisions, not canonical business laws.



# 7B. External Agent Runtime Adapter Strategy — MyClaw.ai, Twin.so, and Tactical Execution Providers

## 7B.1 Purpose

West Peek OS may use external agent platforms for tactical execution, hosted agents, browser automation, temporary workflows, or vendor-specific capabilities when doing so is cheaper, faster, or easier than building the capability immediately.

External agent platforms are not canonical infrastructure. They are replaceable execution providers behind adapters.

Canonical rule for implementation:

```text
External agent platforms are helpers, not governors.
```

## 7B.2 MyClaw.ai candidate role

MyClaw.ai should be evaluated as a possible managed-agent-hosting provider and as an alternative or complement to Twin.so.

Current public positioning, checked June 30, 2026:

- managed platform for deploying, running, and scaling AI agents;
- one-click setup;
- 24/7 uptime;
- zero DevOps;
- support/positioning for OpenClaw, Hermes Agent, Claude Code, Codex, and more;
- browser, email, Telegram, WhatsApp, files, repos, apps, and data workflow access are described as channels/integrations;
- scheduled work and daily reports are described as use cases;
- pricing plans are listed publicly, but AI token usage is stated as not included.

Implementation interpretation:

```text
MyClaw.ai = possible managed always-on agent hosting provider.
```

It may be useful for:

- testing always-on agent workflows without building DevOps;
- hosted browser/email/repo agent tasks;
- temporary tactical agents;
- experiments with OpenClaw/Hermes-style agent execution;
- low-DevOps prototypes;
- non-canonical execution support while West Peek OS core is being built.

## 7B.3 Twin.so candidate role

Twin.so should be evaluated as a tactical no-code/browser automation provider.

Current public positioning, checked June 30, 2026:

- plain-English task description;
- app and web integrations;
- browser automation;
- scheduled/webhook/Slack/email-triggered agent runs;
- no-code agent/workflow building posture.

Implementation interpretation:

```text
Twin.so = possible tactical automation/browser-workflow provider.
```

It may be useful for:

- one-off automations;
- app-to-app workflows;
- browser data pulls;
- external web tasks;
- no-code workflow experiments;
- fast prototypes before internalizing a workflow.

## 7B.4 External Agent Runtime Adapter

The fork should add or reserve an External Agent Runtime Adapter layer.

This layer should wrap vendors such as:

- MyClaw.ai;
- Twin.so;
- OpenClaw self-hosted;
- Cloudflare-native West Peek OS runtime;
- Cloudflare Containers;
- external managed container host;
- VPS fallback.

Adapter responsibilities:

- normalize task request payloads;
- define permitted actions;
- apply approval requirements before external execution;
- inject West Peek AI Employee Contract where possible;
- prevent external provider from becoming source of truth;
- record AIRun / ExternalToolUsage;
- estimate and record cost;
- record provider/model/tool path;
- capture outputs back into West Peek OS;
- attach outputs to work cards, approval cards, or audit events;
- preserve secrets outside repo;
- support vendor replacement without rewriting domain workflows.

## 7B.5 Authority boundary

External platforms may not become:

- canonical West Peek OS brain;
- source of truth;
- approval authority;
- memory authority;
- compliance authority;
- fund decisioning authority;
- relationship source of truth;
- investment-source-of-truth database;
- governance broadcast authority;
- final arbiter of facts;
- unreviewed external communicator.

They may only execute scoped tasks under West Peek OS governance.

## 7B.6 Vendor evaluation matrix

| Provider / path | Likely use | Strength | Risk / caution | Default posture |
|---|---|---|---|---|
| Cloudflare-native West Peek OS | Preferred core runtime | Familiar platform, simple stack, cheap baseline, strong access/security fit | Requires architecture adaptation | Default target |
| Cloudflare Containers | Heavier Docker-shaped components | Keeps runtime under Cloudflare umbrella | Still needs container design and cost monitoring | First fallback |
| MyClaw.ai | Managed always-on agent hosting | Fast hosted agents, low DevOps, OpenClaw/Hermes-style lane | Token usage separate; vendor lock-in; governance must wrap it | Candidate tactical provider |
| Twin.so | No-code/browser/app automation | Fast task automation, web/app connectors, low build burden | Credit/cost opacity, external data exposure, governance boundary | Candidate tactical provider |
| OpenClaw self-hosted | Internal/self-hosted agent runtime | More control, possible portability | More DevOps and maintenance | Evaluate after reality assessment |
| External managed container host | Backend fallback | Easier than raw VPS | Adds vendor/platform | Use only when Cloudflare is not fit |
| VPS | Last-resort raw server | Maximum control, cheap raw compute | More maintenance/security burden | Last resort |

## 7B.7 Vendor approval rules

No external agent platform may be connected to live West Peek data without:

- vendor risk review;
- data classification review;
- approval scope;
- cost estimate;
- owner;
- secrets handling plan;
- output capture plan;
- audit logging;
- exit path;
- test task;
- human approval.

No external agent platform may contact external parties, send messages, publish content, alter records, spend money, or make fund/sponsor/portfolio claims without West Peek OS Workflow Approval.

## 7B.8 Cost and mode rules for external agent providers

External provider use must obey:

- current firmwide Cost Mode;
- domain override;
- Budget Governor;
- Cost Preflight;
- ExternalToolUsage recording;
- ActualUsage recording when available;
- approval thresholds;
- loop budget caps;
- provider usage reconciliation.

Cheapo Mode should prefer internal cheap-model execution or deferred/batched work unless the external provider is demonstrably cheaper for the specific task.

Critical-Only Mode should block external agent providers unless the task is approved, deadline-sensitive, risk-sensitive, revenue-critical, compliance-sensitive, LP-sensitive, IC-sensitive, or deal-sensitive.

Strategic Surge may allow external provider use only inside the approved surge scope and budget.


# 8. Core Data Model Additions

## 8.1 Foundation models

| Model | Purpose |
|---|---|
| Firm | West Peek Ventures institutional object. |
| FirmUser | Scooter/Sequoia and future internal users with authority scopes. |
| Domain | Canonical business capability grouping inside West Peek OS. |
| Machine | Canonical machine/department registry row. |
| MachineQueue | Queue owned by machine. |
| WorkCard | Unit of work routed to machine/AI employee/human. |
| AIEmployee | West Peek-specific extension of CrewMember identity. |
| EmployeeAssignment | Links AI employee to domain, machine, work card, schedule, and permission envelope. |
| ApprovalCard | Required human judgment/action record. |
| ActivityEvent | Recent activity and operational awareness feed. |
| AuditEvent | Durable historical proof record. |
| DiagnosticEvent | Developer/debug event. |
| GovernanceUpdate | Constitution/policy/bulletin/context/risk/vendor update. |
| GovernanceAcknowledgement | Tracks employee/machine acknowledgement/application. |
| PrivacyLabel | Internal/LP-safe/IC/confidential/Lockdown/etc. classification. |
| SourceSystem | External/internal system contributing canonical or mirrored data. |
| SourceAdapter | Sync/import/export/manual bridge for a source system. |
| SourceConflict | Source-of-truth conflict card. |
| ExternalProvider | Vendor/provider registry object. |
| VendorRiskRecord | Build-vs-buy and risk review record. |
| Loop | Governed recurring/stateful workflow. |
| GovernanceCard | Runtime explanation of task/loop type, machine, POV, truth/privacy mode, approval gate, hard stop, and status. |

## 8.2 Venture/fund/domain models

| Model | Purpose |
|---|---|
| Person | Internal mirror of Network OS person. |
| Company | Founder/company/LP/provider/company entity. |
| CommunityMember | Community lens over Network OS person/company data. |
| RelationshipTouchpoint | Relationship interaction, source, and owner. |
| RelationshipCapitalRecord | Recent asks/value/cooldown/trust/overuse. |
| LPRecord | LP/family office/institution/contact pipeline record. |
| LPDiligenceRequest | Material request workflow. |
| DataRoomAccessRecord | What was shared, with whom, when, and under what permission. |
| Deal | Early-stage deal pipeline object. |
| SecondaryOpportunity | Series C+ secondary opportunity object. |
| DealMathPacket | VentureDeals output packet with assumptions, calculations, sensitivity, and fund-return implications. |
| ICDecision | IC memo, decision, evidence, dissent, rationale. |
| AssumptionLedger | Beliefs to review later. |
| PortfolioCompany | Portco record. |
| SupportRequest | Founder/portfolio ask and support plan. |
| FollowOnReview | Pro-rata/follow-on recommendation and reserve impact. |
| FundConstructionModel | Portfolio construction and deployment model. |
| ResearchEvidence | Source-backed claim/evidence object. |
| MeetingRoom | General Meeting Intelligence or IC Decision Portal workspace. |
| TranscriptImport | Meeting capture provider output and reliability/consent metadata. |
| EventRecord | West Peek Live/community/LP/founder/portfolio event object. |
| SponsorRecord | Sponsorship pipeline and experiential revenue object. |
| ContentArtifact | Marketing/PR/content output with claim substantiation and approval state. |

---


# 8A. Budget Governor Data Model and Services

## 8A.1 Required data objects

The implementation must add or reserve these objects:

```text
AIRun
CostEstimate
ActualUsage
CostClass
CostMode
BudgetPolicy
BudgetOverride
LoopBudget
ApprovalRequest
OpportunityReview
WorkflowApproval
ProviderPricingSnapshot
ModelRoutingPolicy
ValueOutcome
CostAlert
CostReport
StrategicSurge
DomainCostOverride
ExternalToolUsage
PaidDataRequest
AIEmployeeStatus
AIEmployeeRestriction
PIPPlan
PerformanceIncident
SuspensionRecord
RetrainingRecord
ProbationRecord
RetirementRecord
DecommissionRecord
PermissionRevocation
RoleReassignment
LifecycleAuditEvent
```

## 8A.2 AIRun

AIRun records every meaningful AI execution event.

Fields:

- run_id;
- created_at;
- requested_by;
- trigger_type: human_requested / scheduled_loop / proactive_opportunity / workflow_generated / approval_generated / system_maintenance;
- domain_id;
- machine_id;
- ai_employee_id;
- workflow_id;
- loop_id;
- opportunity_id;
- approval_id;
- cost_class;
- current_firm_mode;
- domain_override_mode;
- provider;
- model;
- tool_path;
- estimated_cost;
- actual_cost;
- estimated_tokens_or_units;
- actual_tokens_or_units;
- output_reference;
- value_outcome_id;
- status: planned / approved / running / completed / blocked / deferred / downgraded / failed;
- audit_event_id.

## 8A.3 CostEstimate

CostEstimate records preflight assumptions.

Fields:

- estimate_id;
- run_id;
- estimate_method;
- provider_pricing_snapshot_id;
- input_size_estimate;
- output_size_estimate;
- external_tool_estimate;
- paid_data_estimate;
- min_cost;
- max_cost;
- approval_required;
- generated_at.

## 8A.4 ActualUsage

ActualUsage records actual provider/tool usage when available.

Fields:

- usage_id;
- run_id;
- provider;
- model;
- input_tokens;
- output_tokens;
- tool_units;
- storage_units;
- search_calls;
- data_calls;
- actual_cost;
- reconciled: true/false;
- invoice_reference;
- collected_at.

## 8A.5 CostMode

CostMode defines firm and domain posture.

Allowed modes:

```text
Normal Mode
Cheapo Mode
Critical-Only Mode
Strategic Surge Mode
```

Fields:

- mode_id;
- scope: firmwide / domain / machine / loop / strategic_surge;
- mode_name;
- owner;
- start_time;
- end_time;
- budget_cap;
- approval_thresholds;
- allowed_cost_classes;
- blocked_cost_classes;
- allowed_exceptions;
- audit_event_id.

## 8A.6 BudgetPolicy

BudgetPolicy defines caps and thresholds.

Fields:

- policy_id;
- scope;
- daily_cap;
- weekly_cap;
- monthly_cap;
- per_run_cap;
- approval_threshold;
- frontier_model_threshold;
- paid_tool_threshold;
- paid_data_threshold;
- created_by;
- active_from;
- active_until;
- audit_event_id.

## 8A.7 ValueOutcome

ValueOutcome records what the spend produced.

Fields:

- value_outcome_id;
- run_id;
- output_type;
- human_rating;
- accepted: true/false;
- revised: true/false;
- revenue_advanced;
- savings_identified;
- risk_reduced;
- time_saved_estimate;
- relationship_value;
- LP_proof_value;
- IC_quality_value;
- follow_up_created;
- continue_pause_kill_recommendation;
- notes.

## 8A.8 Required services

Core services:

```text
CostEstimator
ActualCostRecorder
BudgetGovernor
ModelRouter
ModeSwitchboard
LoopBudgetGuard
ApprovalThresholdEngine
SpendAlertEngine
ValueLedgerService
ProviderPricingManager
CostReportGenerator
StrategicSurgeManager
```

## 8A.9 Run lifecycle

Every meaningful AI run should follow:

```text
1. Intake
2. Classify work type
3. Determine domain / machine / AI employee
4. Determine cost class
5. Check current firm/domain mode
6. Estimate cost
7. Check budget
8. Check approval threshold
9. Select model/tool path
10. Execute, block, downgrade, batch, or defer
11. Record actual cost
12. Record output
13. Record value/outcome
14. Trigger follow-up only if allowed
```


# 9. Machine-by-Machine Odysseus Implementation Map

This table now follows the v3.2.4 machine registry: **44 machines**, not the prior 43-machine v3.2.1 map.

| # | v3.2.4 canonical machine / department | Disposition | Implementation path |
|---:|---|---|---|
| 1 | Command Center Machine | Modify | Reuse Odysseus SPA shell, sessions, preferences, calendar/task/email surfaces; add MP Today, domain summaries, system health, and firm queue counts. |
| 2 | Managing Partner Personal Office Machines | Modify | Reuse CrewMember + assistant + scheduled check-ins; split into Willa/Wren and Wendy/Walker offices with private assistant logs and firm-work promotion. |
| 3 | Global Capture + Routing Machine | Add | Add Capture, CaptureClassifier, MachineRouter, WorkCard, routing diagnostics, and source-of-truth recommendation service. |
| 4 | Governance Center + AI Workforce Broadcast Machine | Add | Add GovernanceUpdate, operating bulletin/context/policy/risk/vendor types, acknowledgement state, AI workforce brief injection, and immutable sender/time/source history. |
| 5 | Approval Center Machine | Add | Add ApprovalCard state machine, risk/privacy/compliance fields, edit/request-changes/reject/escalate actions, and outbound execution gates. |
| 6 | Activity Feed + Audit Ledger Machine | Add | Add ActivityEvent and AuditEvent; separate My Activity, Agent Activity, Firm Activity, and durable audit records with visibility scopes. |
| 7 | Developer Diagnostics + Debug Copilot Machine | Modify/Add | Extend admin diagnostics into DiagnosticEvent, AgentRunTrace, PermissionTrace, MemoryTrace, sync/API error traces, and AI-assisted repair work cards. |
| 8 | Relationship Intelligence Machine | Add | Add Relationship OS domain services that read mirrored Network OS data and produce warm-path, moments, relationship memory, intro, and social-context outputs. |
| 9 | Network OS Sync + Verification Machine | Add | Add adapter/mirror records, shared external IDs, sync jobs, conflict cards, reversible merge history, and freshness checks. |
| 10 | Relationship Capital Budget Machine | Add | Add ask/value/cooldown/trust metrics and relationship-overuse warnings used by intro and outreach workflows. |
| 11 | LP Fundraising Machine | Add | Add LP records and pipeline while keeping Network OS/relationship data synced; no-API tools remain tactical, not canonical. |
| 12 | LP Diligence Request Machine | Add | Add diligence request workflows, approved-material checklist, Drive/VDR links, compliance review, and shared-material audit. |
| 13 | LP Proof Engine Machine | Add | Add LP-safe proof candidates from portfolio support, events, relationship outcomes, research, and decision discipline. |
| 14 | Data Room Control Machine | Add | Add document registry, access ledger, version tracking, LP-safe/legal status, expiration/reminder/revocation logic; integrate external VDR rather than build native VDR v1. |
| 15 | Early-Stage Deal Machine | Add | Add Deal/Company/Founder records, intake pipeline, diligence packet, mandate status, pass/nurture, and IC readiness. |
| 16 | Secondaries Investment Machine | Add | Add secondary opportunity records with brokerage/fund separation gates, confidentiality labels, transfer/ROFR/company approval fields, and pricing diligence. |
| 17 | Investment Mandate + Exclusion Machine | Add | Add policy-backed fast-no/watchlist/review-required filter before research or IC burden expands. |
| 18 | IC Decision Machine | Add | Add ICDecision, memo/evidence/dissent/rationale/follow-up records and IC workspace surfaces; require Deal Math Packet before IC-ready status. |
| 19 | VentureDeals / Deal Math Machine | Add | Integrate the VentureDeals calculator dashboard/repo as the deal-level math workbench for primary, secondary, and fund math; persist assumptions and outputs as Deal Math Packets. |
| 20 | IC Learning Loop Machine | Add | Add AssumptionLedger, outcome-review cadence, postmortem, pass-review, calibration, and research-quality scoring. |
| 21 | Meeting Intelligence Machine | Modify/Add | Reuse calendar/notes/tasks/docs; add MeetingRoom, Walter Sidecar, prep/live/debrief, proposed meeting record, and follow-up routing. |
| 22 | Meeting Capture Adapter Machine | Add | Add capture provider adapter abstraction, transcript import, consent/reliability state, off-record/manual-note options, and human approval before durable memory. |
| 23 | Research & Intelligence Machine | Modify/Add | Reuse Deep Research/RAG/search/docs; add Evidence objects, source confidence, claim status, contradictions, freshness, LP-safe/internal-only labels. |
| 24 | Research Data License + Quality Machine | Add | Add ProviderDataContract with storage/AI-processing/export/LP-use permissions, freshness, rate limits, conflict priority, and license restrictions. |
| 25 | Source-of-Truth Resolver Machine | Add | Add conflict detection/resolution across Network OS, Drive, email, calendar, provider data, meeting records, and human input. |
| 26 | Knowledge OS / Memory Promotion Machine | Modify/Add | Modify Odysseus memory into provenance-aware Knowledge OS with promotion queue, approval, supersession, source links, privacy labels, and expiration/review dates. |
| 27 | Portfolio Support Machine | Add | Add PortfolioCompany, SupportRequest, service levels, support plan, approval gates, execution trail, and outcome records. |
| 28 | Portfolio Performance + Follow-On Decision Machine | Add | Add KPI/signal ingestion, winner flags, follow-on/pro-rata reviews, reserve/ownership impact, and support-only vs invest-more distinction. |
| 29 | Fund Construction + Capital Allocation Machine | Add | Add FundConstructionModel, deployment pacing, reserve policy, concentration limits, sleeve allocation, scenario simulator, and fund exposure dashboard. |
| 30 | West Peek Live / Events Machine | Add | Reuse calendar/tasks/docs; add event objects, run-of-show, sponsor workflows, attendee intelligence, post-event follow-up, and event-to-value loops. |
| 31 | Community Intelligence Machine | Add | Add Community OS services built on Network OS synced data: segmentation, engagement, community-to-event/dealflow/support signals, and outcome attribution. |
| 32 | Brand Sponsorship + Experiential Revenue Machine | Add | Add sponsor pipeline, sponsorship fit, proposals, event sponsor plans, recap reports, and revenue tracking. |
| 33 | Marketing / PR / Content Machine | Add | Reuse document drafting and approval; add claim substantiation, LP/founder/public channels, content workflow, and external publishing gates. |
| 34 | West Peek Taste Layer Machine | Add | Add voice/taste review service before external materials: West Peek warmth, seriousness, LP credibility, founder-friendliness, and anti-generic quality. |
| 35 | Finance / Fund Admin Machine | Add | Add finance/admin records, fund admin handoff packets, provider reconciliation, management-company visibility, and fund-level operating dashboards. |
| 36 | Legal / Compliance Rules Machine | Add | Add counsel-defined rules engine, blocking/routing/logging, brokerage/fund separation, MNPI/confidentiality, LP marketing claim, and conflict gates. |
| 37 | External Helper / Provider Coordination Machine | Add | Add provider/helper task packets, evidence vault records, external work status, and review/approval history. |
| 38 | Vendor Risk + Build-vs-Buy Machine | Add | Add vendor registry, API/export/manual-only status, security/privacy/cost reviews, fallback plans, and canonical-source risk decisions. |
| 39 | Systems, Data, and Integration Machine | Modify/Add | Reuse webhooks/API tokens/diagnostics/Docker services; add typed sync jobs, integration registry, adapter status, and source-system diagnostics. |
| 40 | Model Governance + Privacy Airlock Machine | Modify/Add | Extend model endpoint/tool security with Local/Frontier/Lockdown modes, double airlock, redaction/sanitization, and model-use ledger. |
| 41 | AI Employee Performance + Cost Ledger Machine | Add | Use TaskRun/session/approval/revision/cost signals to create agent scorecards, error rates, time saved/consumed, and pause/retrain recommendations. |
| 42 | Prompt Enhancer + Intent-to-Execution Machine | Add | Add intent parser, prompt enhancer, machine assignment packet, privacy-safe prompt generation, and reusable prompt library. |
| 43 | Builder / Repo / Product Machine | Add | Add implementation contracts, repo snapshot workflow, validation matrix, release packets, artifact ledgers, and odysseus-plan sync. |
| 44 | Continuity + System Maintenance Machine | Add | Reuse backup/setup infrastructure; add continuity drills, offline/reduced mode, restore playbooks, maintenance cadence, and sovereignty package. |

---

# 10. Implementation Sequence


## 10.0 v1.2 sequence correction — Budget Governor before broad autonomy

Budget Governor must be implemented early, not after agent autonomy.

Updated sequence:

```text
Sprint 0:
Odysseus Reality Assessment + Cloudflare-first deployment assessment

Sprint 0.5:
Cost primitives: AIRun, CostClass, CostEstimate, ActualUsage, CostMode, BudgetPolicy, ProviderPricingSnapshot

Sprint 1:
First Working Spine: Capture, Routing, Work Cards, Approval Center, Activity/Audit, AI Employee Registry, Machine Registry

Sprint 1.5:
Budget Governor + Cost Dashboard + Mode Switchboard

Sprint 1.6:
AI Employee Lifecycle Control: status, restriction, suspension, PIP, retraining, retirement, decommissioning, permission revocation, role reassignment, and lifecycle audit events

Sprint 1.7:
External Agent Runtime Adapter proof: MyClaw.ai / Twin.so vendor evaluation stubs, scoped test tasks, cost capture, approval boundaries, and no-source-of-truth enforcement + Domain Override Panel

Sprint 2:
Opportunity Radar + Queue separation + Loop Governance + Loop Budget Caps

Sprint 3:
Investment / Meeting / Research / Community domains with cost controls active
```

No broad recurring agent loops, paid data calls, frontier-model swarms, or proactive research programs should run before Cost Preflight, Cost Ledger, Budget Governor, and Approval Threshold Engine exist.


## 10.1 Sprint 0 — Local Odysseus Reality Assessment

Goal: create the real local source baseline before coding.

Tasks:

1. Clone the repo locally.
2. Record branch, commit SHA, tree status, Python version, Docker version, and environment.
3. Run Docker startup or native startup on the intended development machine.
4. Create first admin user and verify login.
5. Run health and readiness endpoints.
6. Run smoke tests for chat, session, document, memory, task, assistant, and diagnostics.
7. Run security-oriented tests if available.
8. Inspect database schema after startup.
9. Export repo map: top-level directories, routes, models, services, static modules, tests.
10. Produce `ODYSSEUS_REALITY_ASSESSMENT.md` as a local validation artifact.

Exit criteria:

- repo identity confirmed;
- app starts;
- admin login works;
- database initializes;
- core routes respond;
- current failing tests/gaps are documented honestly.

## 10.2 V0.1 — First Working Spine

Goal: prove command, capture, routing, approval, memory, activity, audit, privacy labels, diagnostics, domain/machine taxonomy, governance broadcast, and runtime safety.

Build:

1. Firm and FirmUser seed for West Peek, Scooter, and Sequoia.
2. Domain registry seed using v3.2.4 canonical domains.
3. Core Machine Registry seed using all **44** v3.2.4 machines.
4. AIEmployee registry seed for approved W/P employees.
5. Machine-to-employee assignments.
6. +Capture endpoint and UI entry point.
7. Capture classifier: task / relationship note / meeting note / company-wide update / rule-policy / risk alert / vendor status / deal math input.
8. MachineRouter service.
9. WorkCard model and machine queues.
10. ApprovalCard model and Approval Center list/detail/actions.
11. ActivityEvent and AuditEvent models.
12. Private assistant log vs firm activity visibility.
13. GovernanceUpdate and AI Workforce Broadcast v0.
14. Global AI Runtime Contract injection point for AIEmployeeRunner.
15. Loop model, Loop Suitability Gate, and Governance Card v0.
16. Developer Diagnostics shell and DiagnosticEvent model.
17. Debug Copilot v0: explain issue, classify severity, create repair work card.
18. Basic privacy labels and visibility scopes.
19. Initial frontend surfaces: Today, +Capture, Approvals, Activity, Governance, Diagnostics.

V0.1 non-goals:

- full IC Portal;
- full LP fundraising CRM;
- full data room;
- paid data-provider integrations;
- autonomous outbound campaigns;
- full mobile app;
- native meeting transcription;
- external founder/LP portal.

Exit criteria:

- Sequoia/Scooter can capture a company-wide update;
- OS classifies it;
- it creates a GovernanceUpdate;
- it routes to affected AI employees/machines;
- acknowledgement state is visible;
- resulting activity appears in feed;
- audit entry records sender/time/source/scope;
- diagnostics can explain the route;
- Machine Registry shows 44 machines;
- Domain map shows canonical v3.2.4 domains;
- WorkCard references domain, machine, AI employee, privacy mode, truth mode, approval state, and diagnostic trace.

## 10.3 V0.2 — Investment Math + Meeting Spine

Build:

1. Deal and Company models.
2. VentureDeals adapter / import bridge.
3. DealMathPacket model for primary, secondary, and fund math.
4. Investment Mandate filter.
5. MeetingRoom model and Walter Sidecar workspace.
6. Meeting consent/reliability fields.
7. Calendar meeting association.
8. Meeting follow-up work-card generation.
9. ICDecision model.
10. Evidence attachment to IC memo.
11. Dissent ledger and final rationale.
12. Initial IC Portal tabs: Company, Memo, Deal Math, Diligence, Market, People, Live Help, Decision, Follow-Up, Audit.

Exit criteria:

- founder meeting can be prepared, held, summarized, and converted into follow-up work cards;
- deal can pass through mandate filter;
- VentureDeals math can be attached as a Deal Math Packet;
- IC decision cannot become IC-ready without visible math assumptions and return-case linkage;
- IC decision can be recorded with rationale and audit trail.

## 10.4 V0.3 — Research + Relationship + Community Spine

Build:

1. Network OS mirror/import adapter.
2. Relationship record view.
3. Community lens over Network OS data.
4. Source-of-Truth Resolver.
5. Research Evidence Ledger.
6. Provider license/quality contract records.
7. Relationship Capital Budget.
8. Connection Intelligence v0.
9. Knowledge Promotion queue.

Exit criteria:

- imported/mirrored relationship can be viewed;
- community and relationship views use Network OS data without creating duplicate canonical databases;
- source conflict can be detected and resolved;
- research claim can be attached to company/deal and marked internal/LP-safe/expired/review-needed.

## 10.5 V0.4 — Portfolio + Fundraising + Events Spine

Build:

1. LPRecord and LP pipeline.
2. LP Diligence Request Machine.
3. Data Room Control Layer.
4. LP Proof Engine v0.
5. PortfolioCompany model.
6. SupportRequest and service-level workflow.
7. Portfolio Performance + Follow-On Decision Center.
8. Fund Construction + Capital Allocation model v0.
9. Event object and West Peek Live event-to-value loop.
10. Vendor Risk Registry.

Exit criteria:

- LP request creates governed workflow and approved-material checklist;
- portfolio support ask creates support request and outcome record;
- follow-on candidate can generate reserve/ownership review packet;
- event outcome can create relationship, support, research, or LP-proof value.

## 10.6 V1.0 — Integrated Firm OS

Build:

- expanded compliance rules;
- full AI Employee Performance + Cost Ledger;
- advanced Debug Copilot and diagnostic bundles;
- expanded research provider adapters;
- meeting capture provider adapter;
- West Peek Live event-to-value loop;
- advanced capital allocation scenarios;
- continuity and backup drills.

---

# 11. Acceptance Criteria by Layer

## 11.1 Product acceptance

- Default UI shows Today, Approvals, Capture, Meetings, Pipeline, Relationships, Search.
- Machine complexity is hidden until needed.
- Every user-facing workflow starts from partner intent, +Capture, assistant, meeting, email, calendar, Drive, or machine trigger.
- External actions require approval unless explicitly exempted by policy.
- Private assistant interactions are scoped unless promoted into firm work.
- Domains, machines, queues, source systems, adapters, records, loops, ledgers, and diagnostics are explained consistently across UI and docs.

## 11.2 Data acceptance

- Every firm-relevant object has owner, source, privacy label, domain, machine, timestamps, and audit path.
- No vendor becomes canonical truth without a mirror or explicit exception.
- Network OS remains the synced source database/repo for relationship/community/person/company/touchpoint records.
- VentureDeals outputs become Deal Math Packets, not loose screenshots or untracked calculator results.
- Source conflicts create resolver cards instead of silent overwrites.
- Knowledge promotion preserves provenance and supersession.

## 11.3 Runtime acceptance

- Every AI employee inherits the Global AI Runtime Contract.
- High-stakes work requires verification/CoVE-style pass before recommendation.
- Work cards can show correct POV, privacy mode, truth mode, approval gate, and source/evidence status.
- Recurring work that is more than a reminder must become a governed loop with state, hard stop, escalation, and audit.

## 11.4 Security acceptance

- Auth remains enabled.
- No public exposure without private access layer/reverse proxy/VPN and secure cookies.
- Internal services remain internal-only.
- Shell/Python/file/MCP/email-send/calendar/vault/model-serving remain admin or explicitly governed tools.
- Untrusted sources are wrapped as data.
- Frontier model usage passes through privacy airlock.
- Lockdown objects cannot use frontier/external APIs unless explicitly authorized.

## 11.5 Engineering acceptance

- Every new route has tests or structural smoke coverage.
- Database migrations are idempotent.
- Core V0.1 flows can be tested without live third-party paid providers.
- Activity/audit events are written for governed actions.
- Diagnostic traces exist for capture routing, approvals, governance broadcast, task runs, loop runs, source sync, VentureDeals import, and failed integrations.
- Debug Copilot explains failures without silently applying destructive fixes.

---

# 12. V0.1 Minimum UI Surface

## 12.1 Today

```text
West Peek OS — Today
+ Capture
Approvals Due
Meetings Today
Pipeline Alerts
Governance Updates
System Health
Recent Activity
```

## 12.2 +Capture

```text
Input box
Capture Type: Auto / Task / Relationship Note / Meeting Note / Company-Wide Update / Rule-Policy / Risk Alert / Vendor Status / Deal Math Input
Visibility: Internal / Private / Governance / Lockdown
Urgency: Low / Normal / High
Capture button
Classification confirmation
```

## 12.3 Approval Center

```text
Approval list
Risk flags
Created by
Domain
Machine
Related object
Draft/payload
Evidence/rationale
Approve / Approve & Send / Create Draft / Edit / Request Changes / Reject / Defer / Escalate
```

## 12.4 Governance Center

```text
Constitution
Policies
Bulletins
Context Notes
AI Workforce Briefs
Acknowledgements
Change Log
```

## 12.5 Activity Feed

```text
My Activity
Agent Activity
Firm Activity
Audit Ledger link
Last 100 events
Visibility scope
Status
Related object
```

## 12.6 Developer Diagnostics

```text
System Logs
Agent Runs
API/Webhooks
Permissions
Memory
Source Conflicts
Errors
Costs
Debug Tools
AI Debug Copilot panel
```

---


# 12A. Cost Dashboard, Mode Switchboard, and Approval-Cost UI

## 12A.1 Required UI surfaces

The implementation must add the following UI surfaces:

1. AI Workforce Cost Dashboard;
2. Cost Command Center;
3. Cost Mode Switchboard;
4. Domain Override Panel;
5. AI Run Ledger;
6. Loop Budget Panel;
7. Approval Queue Cost View;
8. Opportunity Review Cost View;
9. Strategic Surge Setup Screen;
10. Monthly AI Spend Report;
11. Budget Alerts Inbox.

## 12A.2 Cost Dashboard fields

The dashboard must display:

- current firmwide mode;
- domain overrides;
- today spend;
- week spend;
- month-to-date spend;
- projected month-end spend;
- daily cap status;
- weekly cap status;
- monthly cap status;
- top spending employees;
- top spending machines;
- top spending domains;
- top spending loops;
- spend by provider/model;
- spend by paid tool/vendor;
- spend by requested work;
- spend by regular workflow;
- spend by proactive Opportunity Radar;
- spend by CoVE / verification;
- blocked/deferred/downgraded spend requests;
- upcoming expensive scheduled work.

## 12A.3 Cost Mode Switchboard controls

Authorized controls:

- switch firm to Normal Mode;
- switch firm to Cheapo Mode;
- switch firm to Critical-Only Mode;
- create Strategic Surge Mode;
- set daily cap;
- set weekly cap;
- set monthly cap;
- pause proactive loops;
- require approval for frontier runs;
- require approval for paid data calls;
- pause domain;
- downgrade domain;
- grant domain override;
- pause/downgrade/kill recurring loop.

## 12A.4 Mode behavior table

| Mode | Behavior |
|---|---|
| Normal Mode | Routine model routing; approved loops run; standard CoVE runs where required; frontier models allowed for senior judgment; paid tools require normal approvals. |
| Cheapo Mode | Default cheaper models; lower context windows where safe; batch non-urgent work; pause low-priority Opportunity Radar; shorten outputs; limit web/search calls; require approval for Expensive class; disable paid data calls unless approved; allow critical exceptions. |
| Critical-Only Mode | Run only required workflows; block proactive non-essential loops; block speculative research; block paid external tools unless approved; block frontier models unless MP-approved; preserve compliance, LP, IC, deal, revenue, and external commitment workflows. |
| Strategic Surge Mode | Requires owner, budget, scope, duration, purpose, success metric, and kill condition; permits elevated model/tool usage only inside approved scope; automatically expires; produces post-surge cost/value report. |

## 12A.5 Approval-cost views

Opportunity Review and Workflow Approval must be separate objects and separate UI views.

Opportunity Review states:

```text
surfaced
needs_more_evidence
approved_to_explore
approved_to_pilot
declined
deferred
archived
```

Workflow Approval states:

```text
drafted
pending_review
approved
rejected
revise_requested
sent_or_executed
blocked
```

Both views must expose:

- estimated cost;
- actual cost;
- cost class;
- mode used;
- approver;
- timestamp;
- audit trail.


# 13. First Coding Backlog

## Epic 0 — Repo Reality Assessment

- Clone repo locally.
- Record current commit SHA.
- Run setup.
- Run smoke tests.
- Produce repo map.
- Identify failing tests and environment gaps.

## Epic 1 — West Peek namespace and DB base

- Add `westpeek/` package.
- Add firm/domain/machine/employee/work-card/approval/activity/audit/governance/diagnostic/source-system/loop models.
- Add idempotent seed routine for West Peek firm, canonical domains, 44 machines, and employees.
- Add migration path compatible with existing SQLite startup style.

## Epic 2 — Domain and Machine Registry

- Seed canonical domains from v3.2.4.
- Seed 44 machine records from v3.2.4.
- Add `GET /api/westpeek/domains`.
- Add `GET /api/westpeek/machines`.
- Add `GET /api/westpeek/machines/<machine_id>`.
- Add admin-only reseed/reconcile command.
- Add tests for domain count, machine count, names, IDs, and domain assignment.

## Epic 3 — +Capture and Routing

- Add capture model.
- Add capture endpoint.
- Add classifier service.
- Add route-to-machine logic.
- Add work-card creation.
- Add ActivityEvent and DiagnosticEvent for every capture.

## Epic 4 — Approval Center

- Add ApprovalCard model and state machine.
- Add list/detail/action routes.
- Add basic UI panel.
- Gate external email drafts through Approval Center.

## Epic 5 — Governance Broadcast

- Add GovernanceUpdate model.
- Add classification types: Constitution, Policy, Bulletin, Context Note, Risk Alert, Vendor Status, Temporary Priority, Partner Preference, Task Instruction.
- Add acknowledgement model.
- Add AI Workforce Briefs view.

## Epic 6 — Activity/Audit

- Add ActivityEvent and AuditEvent services.
- Add visibility scopes.
- Add Recent Activity UI.
- Add durable Audit Ledger UI.
- Add privacy boundary tests for private assistant activity.

## Epic 7 — Runtime Contract + Loop Governor

- Add AIEmployeeRunner runtime-instruction injector.
- Add Global AI Runtime Contract source.
- Add Loop model.
- Add Loop Suitability Gate.
- Add Governance Card.
- Add no-miss queue flag and hard-stop behavior.

## Epic 8 — Diagnostics + Debug Copilot v0

- Add DiagnosticEvent model.
- Extend diagnostics routes.
- Add AgentRunTrace skeleton.
- Add PermissionTrace skeleton.
- Add Debug Copilot endpoint that summarizes an issue and proposes safe actions.

---


## Epic 9 — Cost Primitives and Run Ledger

Build:

- AIRun model;
- CostClass enum;
- CostEstimate model;
- ActualUsage model;
- ProviderPricingSnapshot model;
- ValueOutcome model;
- AI Run Ledger UI.

Acceptance:

- every meaningful AI run creates an AIRun record;
- cost class is assigned;
- estimates can be stored;
- actual usage can be recorded;
- output and value outcome can be linked.

## Epic 10 — Budget Governor and Mode Switchboard

Build:

- CostMode model;
- BudgetPolicy model;
- DomainCostOverride model;
- BudgetGovernor service;
- ModeSwitchboard UI;
- permission checks for MP-only firmwide mode changes;
- audit logging for all changes.

Acceptance:

- firmwide mode can be changed by authorized users only;
- domain overrides can be applied;
- Cheapo Mode downgrades work behavior;
- Critical-Only Mode blocks non-essential work;
- Strategic Surge expires automatically.

## Epic 11 — Model Router and Cost Preflight

Build:

- ModelRoutingPolicy;
- CostEstimator;
- ApprovalThresholdEngine;
- least-expensive-adequate route selection;
- block/defer/downgrade decisions.

Acceptance:

- routine work routes to cheaper model tier;
- expensive work triggers approval when required;
- mode changes alter routing behavior;
- paid data/tool requests are intercepted.

## Epic 12 — Cost Dashboard and Alerts

Build:

- AI Workforce Cost Dashboard;
- Cost Command Center;
- SpendAlertEngine;
- Monthly AI Spend Report;
- Budget Alerts Inbox.

Acceptance:

- dashboard totals by day/week/month;
- projection shown;
- spend by employee/machine/domain/provider/loop shown;
- alerts trigger on caps, expensive runs, paid tools, and low-value loops.


# 14. Validation Plan for First Coding Cycle

## Structural validation

- file presence;
- route registration;
- model import;
- database table creation;
- seed idempotency;
- domain count;
- machine count equals 44;
- sample capture creates work card;
- sample governance update creates acknowledgement rows;
- sample approval state transitions;
- activity/audit events written;
- loop/governance card model can be created.

## Integration validation

- login as Sequoia;
- login as Scooter;
- private assistant activity remains private;
- firm activity visible to both MPs;
- governance broadcast visible with sender/time/scope;
- approval card cannot be approved by unauthorized user;
- non-admin cannot access diagnostics/admin tools;
- Debug Copilot cannot perform destructive action without approval;
- Network OS adapter can mirror/import a test person/company record without becoming the canonical West Peek OS database;
- VentureDeals adapter can attach a sample Deal Math Packet to a deal.

## Security validation

- auth enabled by default;
- localhost/private-network assumptions documented;
- tool gates remain intact;
- untrusted data wrapper still used;
- no secrets committed;
- no `.env`, `data/`, `logs/`, uploads, database, session files, or keys in release ZIP.

---


## 14.4 Budget Governor validation

Required tests:

- Cost class assignment;
- cost estimation;
- actual cost recording;
- mode switching;
- Cheapo Mode downgrade behavior;
- Critical-Only blocking behavior;
- Strategic Surge setup, scoping, expiration, and post-surge report;
- domain override behavior;
- approval threshold enforcement;
- Opportunity Review vs Workflow Approval separation;
- loop budget caps;
- alert generation;
- dashboard totals;
- unauthorized user cannot change firmwide mode;
- external provider/tool cost is marked estimated unless reconciled.

No fake runtime validation may be claimed unless these tests actually run.


# 15. Known Risks

| Risk | Severity | Response |
|---|---:|---|
| Odysseus is fast-moving on `dev` branch. | Medium | Pin a commit before implementation and fork from that snapshot. |
| Current threat model assumes trusted private network/admin console. | High | Keep West Peek private-first; do not expose publicly; add stricter permission model before any broader access. |
| No shell/filesystem sandbox is a known gap. | High | Do not give ordinary AI employee workflows shell/file write access. Keep repo/build tools separate and approval-gated. |
| Token scopes are coarse. | Medium/High | Add per-capability scopes before external integrations. |
| Agent context/tool bloat is acknowledged in roadmap. | Medium | Use machine-specific tool sets and slim employee prompts. |
| The app already has many routes/features. | Medium | Add West Peek namespace rather than modifying everything at once. |
| FundingStack has no API. | Medium | Treat manual-only; West Peek OS owns canonical LP records. |
| Network OS is external. | Medium | Use adapter/mirror/sync; do not duplicate canonical relationship/community database. |
| VentureDeals is a separate repo/product. | Medium | Use adapter/import and Deal Math Packet model; do not bury calculator outputs in screenshots or notes. |
| User hardware may be resource-limited. | Medium | Use API/remote/local-small model modes; avoid heavy model serving in V0.1. |

---

# 16. Coding Readiness Checklist

Before coding:

- [ ] Local clone completed.
- [ ] Repo identity confirmed.
- [ ] Commit SHA pinned.
- [ ] Startup method selected: Docker or native.
- [ ] App starts locally.
- [ ] Admin login works.
- [ ] Core smoke tests run.
- [ ] Current failing tests documented.
- [ ] v3.2.4 canonical plan available in repo planning folder.
- [ ] This v1.1 audit/implementation bridge available in repo planning folder.
- [ ] VentureDeals repo identity and integration path confirmed locally.
- [ ] Network OS repo/source-system integration path confirmed locally.
- [ ] First coding backlog approved.
- [ ] Snapshot-first update workflow agreed.

---

# 17. Final Recommendation

Start coding only after the Odysseus Reality Assessment has run locally.

Do not begin by building every West Peek machine.

Begin with V0.1:

```text
Firm + Domain Registry + Machine Registry + AI Employee Registry + +Capture + Routing + Work Cards + Approval Center + Activity/Audit + Governance Broadcast + Global AI Runtime Contract + Loop Governor + Diagnostics Shell + Debug Copilot v0
```

That spine proves the operating system.

Everything else attaches to it.

---

# 18. Artifact Tracker

| Artifact | Status |
|---|---|
| Repository identity audit | Complete first-pass; local clone still required |
| Source evidence register | Preserved from v1 |
| v3.2.4 canonical delta register | Complete |
| Architecture ontology implementation mapping | Complete |
| Canonical domain map implementation mapping | Complete |
| Keep/Modify/Remove/Add classification | Updated for v3.2.4 |
| Machine-by-machine implementation map | Updated to 44 canonical machines |
| Proposed backend module layout | Updated with domain/source-system/loop/VentureDeals/Network OS adapters |
| Core data model additions | Updated with domain, source-system, loop, governance card, and Deal Math Packet |
| V0.1 to V1.0 implementation sequence | Updated for v3.2.4 |
| First coding backlog | Updated |
| Validation plan | Updated |
| Risks and readiness checklist | Updated |

---


# 20. v1.2 Cumulative Implementation Laws

## 20.1 Odysseus fork law

```text
Odysseus is source infrastructure, not an architectural prison.
```

The fork must preserve useful primitives, not inherited complexity.

## 20.2 Cloudflare-first law

```text
Cloudflare-first unless a specific component earns an exception.
```

External hosting requires documented reason, cost estimate, owner, and exit path.

## 20.3 Budget Governor law

```text
Budget Governor before broad agent autonomy.
```

No broad recurring loops, proactive agent programs, paid data calls, or frontier research bursts before Cost Preflight, Cost Ledger, Budget Governor, Model Router, and approval thresholds exist.

## 20.4 No silent spend law

```text
No silent spend.
```

Every meaningful AI run must be logged, classified, cost-visible, and tied to a value outcome when feasible.

## 20.5 Provider pricing truth boundary

Provider pricing, usage estimates, token counts, and external tool costs are estimates until reconciled against actual provider usage or invoices.

## 20.6 Security and authority rules

- only MPs can change firmwide cost mode unless explicit admin authority exists;
- domain overrides require MP or authorized admin authority;
- Strategic Surge requires owner, purpose, scope, budget, duration, success metric, and kill condition;
- cost settings and spend records must be audit-logged;
- secrets and provider keys must never be stored in repo;
- implementation must distinguish cost estimates from reconciled actuals.

## 20.7 External agent helper law

```text
External agent platforms are helpers, not governors.
```

MyClaw.ai, Twin.so, OpenClaw self-hosted, Cloudflare Containers, or any similar provider may assist scoped tactical execution. They may not become the canonical West Peek OS brain, source of truth, approval authority, memory authority, compliance authority, fund decisioning authority, or unreviewed external communicator.

## 20.8 MyClaw / Twin evaluation law

```text
Evaluate MyClaw.ai and Twin.so through adapters, not as replacements for West Peek OS.
```

MyClaw.ai should be evaluated as a managed always-on agent hosting provider. Twin.so should be evaluated as a tactical no-code/browser automation provider. Either may be useful. Neither is canonical by default.

## 20.9 AI employee lifecycle law

```text
AI employees are revocable operating roles, not permanent autonomous entities.
```

Implementation must support Active, Restricted, Suspended, PIP, Retraining Required, Probation, Retired, and Permanently Fired / Decommissioned states.

## 20.10 No orphan responsibility law

```text
No AI employee may be suspended, retired, or decommissioned in a way that strands required work.
```

Suspension, retirement, or decommissioning must trigger work-card, loop, approval, opportunity, data-access, tool-access, and responsibility reassignment review.

## 20.11 No silent reactivation law

```text
No suspended, retired, or decommissioned AI employee may silently return to active operation.
```

Reactivation requires authorization, restored scope, permission review, audit event, and a review date when appropriate.



# 20A. v1.4 Owned Agent Core and External Agent Runtime Implementation Update

## 20A.1 Implementation decision

The implementation stance is now:

```text
Own the West Peek OS institutional brain.
Use external agent runtimes only as governed execution adapters.
```

West Peek OS should build and control the core AI employee layer using firm-owned application code, model APIs, tool adapters, cost controls, approval gates, lifecycle controls, memory promotion, and audit systems.

External providers may accelerate tactical execution, but they do not define institutional judgment.

## 20A.2 Core vs vendor boundary

| Layer | Implementation owner | Notes |
|---|---|---|
| AI Employee Registry | West Peek OS | Internal source of truth for roles, authority, status, permissions, and lifecycle. |
| AI Employee Contract | West Peek OS | Governs POV, CoVE, opportunity radar, approval discipline, cost discipline, and lifecycle behavior. |
| Model Router | West Peek OS | Routes to Claude API, OpenAI API, Gemini API, local models, or future providers by policy. |
| Tool execution policy | West Peek OS | Defines which tools an employee may use under which approval state. |
| Approval Center | West Peek OS | All consequential external actions route here. |
| Opportunity Review Queue | West Peek OS | Surfaced ideas are evaluated here before becoming execution work. |
| Workflow Approval Queue | West Peek OS | Requested or approved work is reviewed here before action. |
| Cost Dashboard / Budget Governor | West Peek OS | Vendors cannot own cost truth. |
| Memory Promotion Queue | West Peek OS | Vendors cannot write durable institutional memory directly. |
| Activity/Audit Ledger | West Peek OS | Vendor runs must report back into this ledger. |
| External Agent Runtime Adapter | West Peek OS wrapper | Routes scoped work to Twin, MyClaw, OpenClaw, Claude Code, Codex, Hermes-style agents, browser agents, or similar providers. |
| External agent platform | Vendor or open-source runtime | Execution arm only; no canonical authority. |

## 20A.3 External Agent Runtime Adapter candidates

Implementation should evaluate vendor/runtime candidates as adapters, not replacements.

| Candidate | Primary lane | Possible use | Governance posture |
|---|---|---|---|
| MyClaw.ai | Managed always-on agent hosting | Hosted OpenClaw/Hermes-style agents, scheduled monitoring, reports, always-on tactical work | Candidate execution runtime only; token/subscription costs must flow into Budget Governor. |
| OpenClaw self-hosted | Open-source autonomous agent framework | Controlled internal experiments, private hosted agent, skill-based workflows | High security review required before sensitive access. |
| Twin.so | No-code/browser automation | Browser-heavy workflows, app/web automations, scraping where permitted, fast tactical workflows | Candidate tactical automation layer only. |
| Claude API custom agents | Owned model/API agent layer | Core West Peek AI employees, tool-use loops, reasoning, drafting, evidence work, controlled computer-use sandboxes | Preferred for owned core when engineering cost is acceptable. |
| Claude computer use / browser sandbox | Controlled desktop/browser automation | Background browser tasks, software testing, low-risk web workflows | Must run in container/VM, least privilege, human confirmation for consequential actions. |
| OpenAI / Gemini / local models | Model alternatives | Model diversity, cost routing, local/privacy modes | Routed through Model Router and Budget Governor. |
| Cloudflare-native tools | Preferred infrastructure layer | Workers, queues, workflows, R2/D1/Vectorize/Access where feasible | Platform strategy, not AI authority. |
| Cloudflare Containers | Heavier execution bridge | Docker-shaped agent loops or computer-use environments | Preferred before external VPS/container host if feasible. |

## 20A.4 Vendor source notes and truth boundary

Current public vendor descriptions are useful only as evaluation inputs:

- MyClaw.ai publicly describes itself as a managed platform for deploying, running, and scaling AI agents with one-click setup, always-on hosting, integrations, and zero DevOps.
- MyClaw.ai pricing publicly states that AI token usage is not included in the subscription.
- Twin.so publicly describes plain-English agents connected to apps and the web, browser agents, integrations, scheduled runs, webhooks, and no-code automation.
- Anthropic documentation states Claude tool use can call client-side tools and that tool-use pricing depends on input tokens, output tokens, and server-side tool usage where applicable.
- Anthropic computer-use documentation states computer use is beta, requires a sandboxed/containerized environment, carries unique internet and prompt-injection risks, and recommends minimal privileges, limiting sensitive data access, and human confirmation for real-world consequences.

These notes must be re-checked before vendor selection, implementation, or procurement.

## 20A.5 Owned agent build architecture

The owned AI employee system should implement:

```text
WestPeekAgentRuntime
AIEmployeeRegistry
AIEmployeeContractEngine
POVSelector
CoVEVerifier
ModelRouter
ToolPermissionEngine
CostEstimator
ActualCostRecorder
BudgetGovernor
ModeSwitchboard
ApprovalThresholdEngine
MemoryPromotionService
AuditLedgerService
LifecycleControlService
ExternalAgentRuntimeAdapter
SandboxSessionManager
VendorCredentialVault
```

## 20A.6 External agent adapter objects

Add or map implementation objects:

```text
ExternalAgentProvider
ExternalAgentCapability
ExternalAgentRun
ExternalAgentTaskScope
ExternalAgentPermissionBoundary
ExternalAgentDataBoundary
ExternalAgentCredentialGrant
ExternalAgentSandboxSession
ExternalAgentOutputArtifact
ExternalAgentAuditEvent
ExternalAgentCostEstimate
ExternalAgentActualUsage
ExternalAgentVendorReview
ExternalAgentDisconnectRecord
ExternalAgentQuarantineRecord
```

## 20A.7 Agent runtime selection policy

For each task, the system must choose one runtime path:

```text
internal_owned_agent
internal_model_api_tool_loop
cloudflare_native_worker
cloudflare_container_agent_loop
claude_computer_use_sandbox
twin_adapter
myclaw_adapter
openclaw_self_hosted_adapter
manual_human_workflow
blocked
```

Selection must consider:

- current firmwide cost mode;
- domain override;
- data sensitivity;
- required tool access;
- cost class;
- approval state;
- employee lifecycle state;
- vendor risk;
- security boundary;
- available internal implementation;
- urgency;
- reversibility;
- whether the task could create external consequences.

## 20A.8 Build-vs-rent decision gates

Use the following decision gates before routing work to a vendor runtime:

1. Is this core institutional judgment? If yes, keep inside West Peek OS.
2. Does the task write durable memory or change source-of-truth data? If yes, West Peek OS must govern.
3. Could the task send, publish, spend, commit, promise, or update external systems? If yes, approval is required.
4. Does the task involve LP, founder, fund, sponsor, relationship, credential, finance, legal, or compliance-sensitive data? If yes, vendor use requires explicit risk review.
5. Is the vendor materially faster/cheaper than internal build for this non-core task? If yes, vendor adapter may be considered.
6. Is there a clean disconnection and audit path? If no, do not use vendor runtime.
7. Can the output return to West Peek OS before action? If no, do not use vendor runtime.

## 20A.9 Security and sandbox requirements

External and computer-use agents must default to:

- isolated container or VM;
- scoped account access;
- allowlisted domains where feasible;
- no broad credential exposure;
- no unrestricted local filesystem access;
- no direct production database access;
- no direct investor/fund material access unless specifically approved;
- no unreviewed skill/plugin installation;
- no autonomous financial, legal, contractual, fundraising, sponsor, or external communication action;
- output quarantine before promotion;
- audit logging of tool calls, screenshots/logs where available, files touched, and external systems accessed.

## 20A.10 Claude/API owned-agent track

The first owned agents should be implemented with API/tool loops rather than vendor autonomy when they touch institutional logic.

Suggested first owned agents:

1. Chief of Staff / Command Router;
2. Cost Governor;
3. Document Compiler;
4. Research Analyst with CoVE;
5. Opportunity Radar analyst;
6. Meeting Prep / Debrief assistant;
7. Approval Queue reviewer;
8. AI Employee Lifecycle auditor.

These agents can call Claude API, OpenAI API, Gemini API, local models, or future models through Model Router. They should use client-side tools controlled by West Peek OS. Server-side tools or paid tools must be cost-visible.

## 20A.11 Vendor-assisted pilot lanes

Before broad vendor adoption, run controlled pilots:

### Twin pilot candidate

- one browser-heavy, low-risk, reversible workflow;
- no fund-sensitive data;
- no external sending without approval;
- output returns to West Peek OS;
- run under cost cap and audit.

### MyClaw/OpenClaw pilot candidate

- one always-on monitoring or scheduled-report workflow;
- sandboxed account;
- no high-sensitivity data;
- no skill installation without review;
- daily report returns to West Peek OS;
- cost and token usage tracked separately from subscription fee.

### Claude computer-use pilot candidate

- one controlled sandbox task;
- container/VM environment;
- no credentials unless specifically approved;
- no real-world consequence without human confirmation;
- screenshots/logs retained under audit policy.

## 20A.12 UI requirements

Add UI surfaces:

```text
External Agent Providers page
External Agent Runtime Adapter detail page
Provider Risk Review panel
Vendor Capability Matrix
External Agent Run Ledger
External Agent Sandbox Session viewer
External Agent Permission Boundary editor
External Agent Cost Summary
Vendor Disconnect / Revoke button
Vendor Output Quarantine Inbox
Runtime Selection Preview on work cards
Runtime Override control for authorized MPs/admins
```

These surfaces should connect to:

- Cost Dashboard;
- Budget Governor;
- Approval Center;
- AI Employee Lifecycle Control Panel;
- Audit Ledger;
- Memory Promotion Queue;
- Privacy Airlock;
- Vendor Risk + Build-vs-Buy Machine;
- Model Governance + Privacy Airlock Machine.

## 20A.13 Implementation sequence update

Add to first implementation waves:

```text
Sprint 0:
- Reality Assessment: identify Odysseus agent/tool primitives worth keeping.
- External runtime assessment: Cloudflare-native, Cloudflare Containers, Claude API/tool use, Twin, MyClaw, OpenClaw.

Sprint 0.5:
- Add runtime_type and runtime_policy fields to work-card and AI-run objects.
- Add ExternalAgentProvider and ExternalAgentRun objects.
- Add vendor-risk placeholders and permission-boundary fields.

Sprint 1:
- Owned AI employee registry and contract engine.
- Model Router and Cost Governor integrated with owned AI runs.
- No vendor runtime may bypass Approval Center or Audit Ledger.

Sprint 1.5:
- External Agent Runtime Adapter skeleton.
- Vendor output quarantine.
- Runtime selection preview.

Sprint 2:
- Controlled Twin/MyClaw/OpenClaw/Claude-computer-use pilots only after sandbox and cost controls exist.
```

Law:

```text
Owned governance before external autonomy.
```

## 20A.14 Testing requirements

Add tests for:

- internal vs external runtime selection;
- external agent run creation;
- missing approval blocks external run;
- high-sensitivity data blocks vendor path;
- Cheapo Mode downgrades or blocks vendor runs;
- Critical-Only Mode blocks non-essential external runs;
- vendor output cannot write memory directly;
- vendor output cannot send/publish without approval;
- suspended AI employee cannot trigger vendor run;
- PIP/probation employee triggers elevated review for vendor routing;
- vendor token revocation creates audit event;
- disconnected vendor cannot receive work;
- external agent run costs appear on dashboard;
- output quarantine must be reviewed before promotion;
- sandbox session records owner, scope, and termination condition.

## 20A.15 External Agent Runtime law

```text
External agent runtimes are execution adapters, not governors.

West Peek OS owns judgment, memory, approval, governance, cost control, lifecycle discipline, source-of-truth authority, and institutional context.

External platforms may perform scoped, sandboxed, least-privilege, audit-logged work only when routed through West Peek OS.

No external agent platform may silently send, publish, spend, commit, promise, update durable memory, access sensitive data, or act as source of truth without explicit approval.
```


# 21. Structural Status

```text
DOCUMENT UPDATED TO v1.4
CANONICAL TARGET UPDATED TO v3.2.8
OWNED AGENT CORE VS EXTERNAL EXECUTION ADAPTER STRATEGY ADDED
CLAUDE API / TOOL-USE OWNED-AGENT TRACK ADDED
MYCLAW.AI / TWIN.SO / OPENCLAW / CLAUDE COMPUTER-USE ADAPTER LANES ADDED
EXTERNAL AGENT SANDBOX, PERMISSION, COST, APPROVAL, AND AUDIT REQUIREMENTS ADDED
BUDGET GOVERNOR, LIFECYCLE CONTROL, AND CLOUDFLARE-FIRST STRATEGY PRESERVED
LOCAL CLONE VALIDATION REQUIRED BEFORE CODING
```


---

# 18. Vendor Adapter Bench and Tool Introduction Architecture

## 18.1 Core Implementation Decision

The implementation decision is:

```text
West Peek OS Core = build.
Models, browser execution, research APIs, workflow plumbing, authenticated app access, observability platforms, and durable-job infrastructure = evaluate as adapters.
Vendor-hosted agents = optional sandboxed accelerators only.
```

West Peek OS must not become a pile of disconnected automations. Vendor tools must be routed through West Peek OS governance, cost control, approval, memory, audit, lifecycle, and source-of-truth boundaries.

## 18.2 Preferred Runtime Evaluation Order

Owned runtime / deployment preference:

1. Cloudflare Agents / Workers / Workflows / Durable Objects / Containers.
2. Cloudflare-native services plus selected internal agent harness.
3. Mastra if a TypeScript-native agent framework is needed.
4. LangGraph if deep stateful graph orchestration is needed.
5. CrewAI for multi-agent crew experiments only, not default governance.
6. External hosted-agent runtimes such as MyClaw, OpenClaw, or Twin only as sandboxed execution accelerators.

Cloudflare Agents should be evaluated before defaulting to MyClaw/OpenClaw for owned always-on West Peek AI employees. Cloudflare documentation describes durable agent identity, local SQL storage, real-time connections, scheduled work, recoverable execution, tools including Browser, Sandbox, AI Search and MCP, and human-in-the-loop approval patterns. This maps closely to the West Peek preference for Cloudflare-first owned runtime.

## 18.3 Vendor Adapter Categories

Every vendor candidate must be recorded in the Vendor Adapter Bench under one or more categories:

| Category | Candidate examples | Implementation posture |
|---|---|---|
| Owned runtime candidate | Cloudflare Agents / Workers / Workflows / Durable Objects / Containers | Evaluate first because of Cloudflare-first strategy. |
| Model provider | Claude API, OpenAI API, Gemini API, local models | Provider only; not governance. |
| Browser execution adapter | Browserbase / Stagehand, Playwright, Puppeteer, Selenium | Use for scoped browser sessions and public-source capture. |
| Web research adapter | Exa, Tavily, Firecrawl | Use for search, extraction, enrichment, crawl, and source capture. |
| Workflow plumbing adapter | n8n, Pipedream | Use for webhooks, triggers, routing, sync, and notifications. |
| Authenticated tool-access adapter | Composio, native OAuth connectors, Pipedream Connect | Use only with scoped credentials and registry approval. |
| Durable job engine | Cloudflare Workflows first; Inngest or Trigger.dev if needed | Use for retries, scheduled jobs, long-running agent workflows. |
| Observability/evaluation layer | Langfuse, LangSmith | Use for tracing, prompt/version tracking, evaluations, quality, cost, latency. |
| Agent orchestration framework | Cloudflare Agents, Mastra, LangGraph, CrewAI | Choose one spine if needed; do not framework-shop. |
| External hosted-agent runtime | MyClaw, OpenClaw, Twin | Sandbox only; never source of truth or approval authority. |
| Blocked / not approved | Any unsafe or unnecessary tool | No production use. |

## 18.4 Cloudflare Agents Evaluation

Cloudflare Agents must be evaluated as the preferred owned runtime candidate before adopting an external hosted-agent platform as the primary agent host.

Evaluation questions:

1. Can West Peek AI employee identity map to durable Cloudflare Agent identity?
2. Can agent state and sessions be safely persisted through Cloudflare primitives?
3. Can scheduling and recoverable execution support West Peek loops?
4. Can human-in-the-loop approval be implemented cleanly?
5. Can Browser, Sandbox, AI Search, and MCP tools be permissioned through West Peek governance?
6. Can the Budget Governor observe and control agent runs?
7. Can Lifecycle Control suspend, restrict, PIP, retire, or decommission a Cloudflare-hosted agent?
8. Can Cloudflare runtime integrate with Network OS, VentureDeals, Gmail, Calendar, Drive, GitHub, meeting capture, and external adapters?
9. Can the architecture remain portable if Cloudflare Agents is insufficient?
10. Can Cloudflare Agents run cheaply enough for early West Peek OS usage?

Cloudflare Agents is not automatically selected. It is the first runtime candidate to test because it aligns with the Cloudflare-first implementation posture and may reduce the need for MyClaw/OpenClaw as the owned always-on agent host.

## 18.5 Agent Observability and Evaluation Layer

The implementation must include an observability/evaluation layer before broad agent autonomy.

Primary candidate:

```text
Langfuse
```

Reason: Langfuse is open-source/self-hostable and provides LLM observability, prompt management, evaluations, tracing, cost/latency views, multi-turn session tracking, agent graph representation, datasets, and production evaluations.

Alternative:

```text
LangSmith
```

Reason: LangSmith pairs naturally with LangGraph/LangChain if that stack becomes the orchestration spine.

Required capabilities:

- trace every meaningful AI run;
- tie traces to AI employee, machine, domain, workflow, loop, and approval;
- capture model/provider/tool path;
- capture cost and latency;
- capture prompt/instruction version where appropriate;
- capture human feedback;
- capture quality/evaluation scores;
- capture hallucination, policy, or approval incidents;
- connect repeated failures to Lifecycle Control;
- support dashboard summaries for MPs.

West Peek Cost Dashboard remains the internal business dashboard. Langfuse/LangSmith or equivalent may supply technical observability under it.

## 18.6 MCP Tool Registry and Permission Governance

MCP-compatible adapters may be used where practical, but not blindly.

Implementation objects:

```text
ToolRegistryEntry
MCPServerRecord
ToolPermissionScope
ToolCredentialBoundary
ToolApprovalPolicy
ToolAuditEvent
ToolKillSwitch
ToolReviewDate
```

Required behavior:

1. No AI employee can call an MCP server or external tool unless it is registered.
2. Each tool must declare allowed actions, prohibited actions, cost class, data boundary, credential boundary, and approval rule.
3. Tool output returns to West Peek OS as untrusted evidence unless the tool is an approved internal source-of-truth adapter.
4. Sensitive tools require human approval before write/send/publish/commit/pay actions.
5. Every tool has a kill switch.

## 18.7 Browser Execution Provider Bench

Browser execution providers are tactical infrastructure for controlled website interaction.

Candidate order:

1. Browserbase / Stagehand for managed cloud browser sessions.
2. Local Playwright/Puppeteer for low-cost internal testing and fallback.
3. Selenium only where legacy compatibility requires it.
4. Cloudflare Browser tool if Cloudflare Agents evaluation proves sufficient.

Use cases:

- public-source capture;
- sponsor/partner research;
- company website inspection;
- LP/prospect research;
- market-map enrichment;
- app flow testing;
- screenshot capture;
- dynamic-site extraction;
- monitoring public pages.

Prohibited first-wave use cases:

- autonomous external email sending;
- account setting changes;
- investor/fund communications;
- payment actions;
- form submissions creating legal/commercial commitments;
- unrestricted credentialed browsing.

Browserbase should be tested as the managed browser candidate, but all browser execution must be scoped, logged, cost-capped, output-quarantined, and kill-switch compatible.

## 18.8 Web Research Provider Bench

The system should prefer search/extraction APIs before full browser sessions when possible.

Candidate roles:

| Provider | Best-fit evaluation lane |
|---|---|
| Exa | AI-native search, company/people/research/news/financial-report search, structured/grounded outputs. |
| Tavily | Search/extract/crawl/map/research API for agent workflows. |
| Firecrawl | Search, scrape, crawl, interact, markdown/HTML/structured JSON extraction, dynamic content, MCP-compatible paths. |

Provider selection rule:

```text
Use search/research APIs before browser automation when they are sufficient.
Use browser execution only when websites require dynamic interaction, screenshot capture, login-bound inspection, or human-like navigation.
```

All research provider output must include source URLs, retrieval timestamp, provider, query/task, and confidence/evidence notes.

## 18.9 Workflow and Integration Provider Bench

n8n is allowed as a workflow automation adapter, not the West Peek OS brain.

n8n use cases:

- webhooks;
- scheduled workflow triggers;
- simple app-to-app syncs;
- Gmail/Calendar/Drive metadata routing;
- notifications;
- error workflows;
- prototype automations;
- draft staging after West Peek approval.

Pipedream should be evaluated as an integration-plumbing alternative when app integration speed, OAuth handling, webhooks, event queueing, or customer-facing integration scaffolding matters more than self-host control.

Composio should be evaluated as an authenticated tool-access layer for AI agents when pre-authenticated toolkits, per-user sessions, OAuth/API-key management, triggers, and sandboxed tool execution are useful.

Boundary:

```text
n8n, Pipedream, and Composio may move work.
They may not decide what work means.
```

All workflows touching sensitive firm data, external communications, fund materials, sponsor workflows, paid tools, recurring loops, or source-of-truth records must be registered in West Peek OS.

## 18.10 Durable Job Engine Bench

Cloudflare Workflows and scheduled Workers remain the first path for Cloudflare-native durable/scheduled work.

If Cloudflare Workflows is insufficient, evaluate:

1. Inngest for event-driven durable execution, background/scheduled jobs, steps, queueing, concurrency, throttling, rate limiting, observability, and AI/RAG workflow support.
2. Trigger.dev for background jobs, long-running AI tasks, retries, queues, logging/tracing/metrics, concurrency, idempotency, observability dashboards, and self-hosting potential.

Do not use n8n as the durable job engine for serious multi-step agent runs unless the workflow is simple and low-risk.

## 18.11 Agent Orchestration Framework Bench

Do not mix frameworks casually.

Decision order:

1. Cloudflare Agents / Workflows if sufficient.
2. Mastra if the app needs a TypeScript-native agent/workflow framework with tools, memory, workflows, MCP, browser, RAG, evals, and Studio.
3. LangGraph if the app needs low-level, long-running, stateful graph orchestration with persistence, human-in-the-loop, durable execution, and deep observability through LangSmith.
4. CrewAI for collaborative multi-agent crew experiments, not default governance.

Rule:

```text
Pick one orchestration spine if Cloudflare-native primitives are insufficient.
Do not stack agent frameworks because they are fashionable.
```

## 18.12 Vendor Adapter Decision Matrix

Every candidate must be scored before production use:

| Criterion | Required question |
|---|---|
| Purpose fit | What exact West Peek job does this do? |
| Category fit | Is this runtime, model, browser, research, workflow, tool access, durable job, observability, or hosted agent? |
| Data sensitivity | What data will it see? |
| Credential boundary | What keys/accounts/permissions does it need? |
| Cost | What is the estimated daily/weekly/monthly spend? |
| Governance compatibility | Can Approval Center, Budget Governor, Lifecycle Control, and Audit Ledger control it? |
| Portability | Can we remove it without losing the firm brain? |
| Auditability | Can we trace actions, outputs, costs, and failures? |
| Human approval | Can it stop before consequential actions? |
| Kill switch | Can MPs shut it down immediately? |
| Output trust | Does output enter as evidence, draft, or source-of-truth update? |
| Failure mode | What happens when it fails, hallucinates, over-spends, or acts incorrectly? |

## 18.13 Shadow Automation Ban — Implementation

Every external workflow must be represented in West Peek OS.

Required objects:

```text
ExternalWorkflowRecord
VendorAdapterRun
VendorPermissionScope
VendorCredentialBoundary
VendorOutputQuarantineRecord
VendorCostRecord
VendorAuditEvent
VendorKillSwitch
VendorReviewCard
```

No vendor automation may run recurring work without:

- owner;
- purpose;
- trigger;
- cadence;
- budget;
- approval state;
- kill condition;
- output destination;
- audit log;
- review date.

## 18.14 Vendor Output Quarantine — Implementation

All external outputs enter one of these states:

```text
untrusted_evidence
draft_only
needs_verification
verified_evidence
approved_for_memory_promotion
approved_for_source_update
rejected
archived
```

Outputs from Browserbase, Exa, Tavily, Firecrawl, n8n, Pipedream, Composio, MyClaw, Twin, OpenClaw, MCP servers, or future equivalents may not directly update canonical memory or source-of-truth records unless the specific adapter and action are approved.

## 18.15 v1.5 Build Sequence Update

Updated build sequence:

```text
Sprint 0:
Odysseus Reality Assessment + Cloudflare-first runtime assessment.

Sprint 0.5:
Cost primitives, AI Run Ledger, Budget Governor primitives, Tool Registry primitives.

Sprint 1:
Core West Peek OS spine: AI employees, machine registry, work cards, approval queues, activity/audit, lifecycle controls.

Sprint 1.25:
Agent Observability/Evaluation layer selection and integration stub.

Sprint 1.5:
Cost Dashboard, Mode Switchboard, Budget Governor, and Tool Introduction Review UI.

Sprint 2:
Opportunity Radar, queue separation, loop governance, vendor adapter bench.

Sprint 2.5:
First external adapter pilots:
- browser execution pilot;
- web research provider pilot;
- workflow plumbing pilot;
- observability trace pilot.

Sprint 3:
Domain rollout only after governance, cost, lifecycle, observability, and adapter controls exist.
```

Hard rule:

```text
Governance spine before vendor sprawl.
```

## 18.16 v1.5 Testing Requirements

Add tests for:

1. Tool Registry entry creation.
2. MCP/tool permission enforcement.
3. Vendor adapter category assignment.
4. Vendor kill switch.
5. Browser execution output quarantine.
6. Web research output source capture.
7. Workflow automation registration.
8. Durable job budget cap enforcement.
9. Observability trace creation for AI runs.
10. Cost and latency capture from model/tool runs.
11. Human approval before sensitive vendor action.
12. Vendor output blocked from source-of-truth update without approval.
13. Shadow automation detection.
14. Domain override behavior with vendor adapters.
15. Cheapo Mode blocks or downgrades vendor use.
16. Critical-Only Mode blocks non-essential vendor automations.
17. Lifecycle suspension blocks vendor tasks assigned to an AI employee.
18. PIP/restriction downgrades tool access.
19. Strategic Surge allows elevated use only inside approved budget/scope.
20. Tool Introduction Review required before production adapter activation.

No vendor is considered production-ready until these tests exist for its adapter class.

---

# 19. Open-Weight Model Bench and Security-Coding Model Evaluation — v1.6 Addendum

## 19.1 Why this addendum exists

The implementation plan now needs a model bench in addition to the vendor adapter bench.

The v1.5 provider bench covered execution/runtime/integration providers such as Cloudflare Agents, Browserbase, n8n, Pipedream, Composio, MyClaw, Twin, OpenClaw, Exa, Tavily, Firecrawl, Langfuse, LangSmith, Mastra, LangGraph, CrewAI, Trigger.dev, and Inngest.

Open-weight models are different.

They are not workflow providers, browser providers, hosted-agent vendors, or workflow plumbing. They are candidate reasoning/model engines that may sit behind the West Peek OS Model Router.

Therefore GLM 5.2 and similar systems belong under:

```text
Open-Weight Model Bench
Security-Coding Model Bench
Model Governance + Privacy Airlock
Builder / Repo / Product Machine
Developer Diagnostics + Debug Copilot Machine
AI Employee Performance + Cost Ledger Machine
Budget Governor
```

They do not belong in the vendor bench as if they were interchangeable with MyClaw, Twin, Browserbase, n8n, or Pipedream.

## 19.2 Implementation principle

The implementation principle is:

```text
West Peek OS may evaluate open-weight models for task-specific advantage.
West Peek OS may not promote any open-weight model into default authority because of public hype, benchmark headlines, or cost advantage alone.
```

Open-weight models can be useful.

They can also be risky, inconsistent, expensive to host, difficult to operate, or inappropriate for sensitive data depending on deployment path.

The model bench exists to measure them before trust.

## 19.3 GLM 5.2 candidate classification

GLM 5.2 should be classified as:

```text
Candidate type: Open-weight coding/security model
Initial status: Watch + Evaluate
Default authority: No
Sensitive-data approval: Not approved by default
Production status: Not production-ready until benchmarked inside West Peek OS
Primary possible uses: code review, vulnerability triage, repo diagnostics, security reasoning, agent-generated-code review, low-cost coding-model comparison
```

The model is not approved as:

```text
- default West Peek OS model;
- default AI employee brain;
- IC model;
- LP diligence authority;
- compliance authority;
- relationship intelligence authority;
- external communications model;
- memory promotion authority;
- source-of-truth authority.
```

## 19.4 What GLM 5.2 may be tested for

GLM 5.2 and similar open-weight coding/security models may be evaluated for:

1. repo vulnerability triage;
2. pull request review;
3. generated-code review;
4. dependency-risk analysis;
5. Cloudflare Worker / Pages / D1 / R2 / Queue implementation review;
6. Odysseus fork security review;
7. MCP server/tool adapter security review;
8. browser-agent prompt-injection review;
9. n8n/Pipedream/Composio workflow risk review;
10. least-privilege permission review;
11. static-analysis explanation;
12. test-case generation for security-sensitive code;
13. threat-model drafting support;
14. false-positive/false-negative comparison against Semgrep-style scanners;
15. low-cost second-pass code review when current cost mode requires cheaper models.

## 19.5 What GLM 5.2 may not do by default

GLM 5.2 and similar open-weight security/coding models may not by default:

1. access production credentials;
2. access unrestricted private repos;
3. receive LP materials;
4. receive fund materials;
5. receive sponsor communications;
6. receive private relationship intelligence;
7. receive proprietary data rooms;
8. commit code;
9. open pull requests;
10. modify repo files;
11. execute shell commands;
12. run browser sessions;
13. perform external outreach;
14. update canonical memory;
15. mark vulnerabilities resolved;
16. approve security decisions;
17. override human review;
18. bypass Budget Governor controls;
19. bypass Model Governance + Privacy Airlock;
20. become the default model based on a public benchmark.

## 19.6 Open-Weight Model Evaluation Law

```text
West Peek OS may evaluate open-weight models such as GLM 5.2 and future coding/security models as candidates for cost-efficient reasoning, code review, security analysis, repo diagnostics, and private/offline-sensitive workflows.

Open-weight models are model candidates, not institutional authorities.

No open-weight model may become the default model for West Peek OS solely because of external benchmarks, public hype, or cost advantage.

Every open-weight model must be evaluated through West Peek-specific benchmarks, including accuracy, false positives, false negatives, latency, cost, privacy posture, deployment complexity, security behavior, and ability to operate inside West Peek’s approval, CoVE, audit, lifecycle, and Budget Governor systems.

Cyber-capable models must run in sandboxed, least-privilege environments for code/security tasks. They may not receive unrestricted access to credentials, private repositories, LP materials, fund data, sponsor communications, relationship intelligence, or proprietary documents without explicit approval.

Hosted APIs for open-weight or foreign-developed models require data sensitivity review before use with private West Peek information.

The Model Router must treat open-weight models as optional tools selected by task fit, cost class, sensitivity level, current firm cost mode, and current domain override.

The standard is:
benchmarked, sandboxed, cost-aware, privacy-reviewed, task-scoped, and never blindly trusted.
```

## 19.7 Model Bench categories

The implementation plan should maintain a separate bench for model candidates:

```text
Model Bench
├── Frontier closed models
│   ├── Claude family
│   ├── OpenAI family
│   ├── Gemini family
│   └── other current frontier APIs
├── Open-weight general models
│   ├── Llama-family models
│   ├── Qwen-family models
│   ├── DeepSeek-family models
│   ├── Kimi / Moonshot-family models
│   ├── MiniMax-family models
│   └── future general open-weight models
├── Open-weight coding/security models
│   ├── GLM 5.2
│   ├── Qwen coding/security variants
│   ├── DeepSeek coding/security variants
│   ├── Llama coding/security variants
│   └── future cyber/coding models
├── Local/private models
│   ├── laptop-capable small models
│   ├── future workstation/server-hosted models
│   └── offline/private retrieval models
└── Blocked / not approved models
    ├── failed privacy review
    ├── failed benchmark review
    ├── failed security-behavior review
    ├── unacceptable cost/latency
    └── unacceptable vendor/data exposure
```

## 19.8 Model Router implementation impact

The Model Router must be extended to support open-weight model candidates.

Required fields:

```text
model_id
model_family
model_provider
model_type
open_weight_status
license_summary
hosted_api_available
self_host_available
foreign_developed_flag
sensitivity_allowed_level
cost_class_allowed
approved_task_classes
blocked_task_classes
benchmark_status
security_review_status
privacy_review_status
hosting_mode
runtime_requirement
context_window_claim
known_limitations
last_reviewed_at
approved_by
revoked_at
```

Model routing must consider:

1. task type;
2. domain;
3. machine;
4. AI employee;
5. sensitivity level;
6. current firm cost mode;
7. domain override;
8. required evidence standard;
9. available benchmark results;
10. cost estimate;
11. hosting path;
12. data boundary;
13. cyber-capability risk;
14. approval state.

## 19.9 Deployment paths for open-weight models

Open-weight models may be tested through separate deployment paths.

### Path A — Hosted API

Use when speed matters and data sensitivity is low.

Constraints:

```text
- no sensitive West Peek information by default;
- no LP/fund/private relationship data by default;
- data sensitivity review required;
- provider terms and retention posture must be reviewed;
- outputs enter Vendor Output Quarantine or Model Output Quarantine;
- costs logged through Budget Governor.
```

### Path B — Self-hosted controlled runtime

Use when data sensitivity is higher and the model can realistically run on available infrastructure.

Constraints:

```text
- sandboxed runtime;
- no unrestricted repo credentials;
- read-only code mount by default;
- no shell execution unless separately approved;
- network egress restricted where feasible;
- activity logged;
- model outputs untrusted until verified;
- compute cost tracked even when token API cost is zero.
```

### Path C — Local/private future lane

Use later if West Peek obtains sufficient hardware or a practical managed private deployment.

Constraints:

```text
- still governed by Model Router;
- still cost-tracked;
- still benchmarked;
- still sandboxed for cyber tasks;
- still subject to lifecycle and approval laws.
```

## 19.10 Model Output Quarantine

Open-weight model outputs must enter a quarantine state before they affect code, memory, security decisions, or source-of-truth records.

Model output states:

```text
untrusted_model_output
needs_static_analysis
needs_test_validation
needs_human_security_review
needs_CoVE_review
verified_supporting_signal
approved_for_work_card
approved_for_pull_request_draft
approved_for_memory_promotion
rejected_false_positive
rejected_false_negative
archived
```

A model may suggest a vulnerability.

It may not declare the vulnerability resolved without tests, evidence, or human approval.

## 19.11 West Peek-specific benchmark suite

Before a model can be approved for recurring use, it must be tested against West Peek-specific tasks.

Minimum benchmark areas:

1. West Peek OS codebase security review;
2. Cloudflare runtime/security review;
3. MCP/tool adapter review;
4. browser automation prompt-injection review;
5. workflow automation risk review;
6. repo update structural review;
7. generated-code review;
8. false positive rate on known-safe code;
9. false negative rate on seeded vulnerable examples;
10. explanation usefulness;
11. cost per useful finding;
12. latency per review;
13. human revision burden;
14. ability to cite code locations accurately;
15. ability to respect scope and avoid overclaiming.

Benchmark outcomes:

```text
approved_for_experiment
approved_for_low_sensitivity_tasks
approved_for_code_review_assist
approved_for_security_triage_assist
approved_for_recurring_loop
requires_human_review_only
blocked
```

No model may move from experiment to recurring use without a benchmark record.

## 19.12 Cyber-capable model safety controls

Cyber-capable open-weight models require additional controls.

Required controls:

1. sandboxed runtime;
2. least-privilege access;
3. read-only repo access by default;
4. no production credentials;
5. no unsupervised exploit generation;
6. no autonomous shell execution;
7. no autonomous pull request merge;
8. no external target scanning without explicit authorization;
9. no third-party system testing without authorization;
10. prompt-injection awareness;
11. output logging;
12. cost logging;
13. human review for consequential findings;
14. kill switch;
15. Budget Governor visibility;
16. Model Governance + Privacy Airlock approval;
17. Lifecycle Control compatibility.

## 19.13 Integration with AI employee lifecycle controls

If an AI employee uses an open-weight model, that run remains owned by the AI employee.

The model does not become the employee.

Lifecycle controls still apply:

```text
Suspend AI employee → blocks model runs.
Restrict AI employee → narrows approved model/tool access.
PIP AI employee → increases logging and review requirements.
Retire AI employee → prevents new model/task assignment.
Fire/decommission AI employee → permanently revokes assigned model/tool pathways unless reassigned.
```

If a model produces repeated bad outputs, the model may also receive model-level restrictions:

```text
model_restricted
model_requires_human_review
model_blocked_for_sensitive_data
model_blocked_for_security_tasks
model_deprecated
model_removed
```

## 19.14 Integration with Budget Governor and Cost Modes

Open-weight models are not automatically cheap.

Self-hosted models may avoid per-token vendor bills but still create infrastructure, GPU, memory, storage, engineering, monitoring, and maintenance cost.

Budget Governor must track:

```text
API token cost
infrastructure cost
GPU/runtime cost
engineering overhead
latency cost
human review burden
false-positive cost
false-negative risk
re-run cost
observability/storage cost
```

Cost mode behavior:

```text
Normal Mode:
Open-weight models may run approved low/standard sensitivity tasks if benchmarked.

Cheapo Mode:
Open-weight models may be preferred only if they are cheaper after infrastructure and review burden are considered.

Critical-Only Mode:
Open-weight model use is blocked unless required for an approved risk-sensitive, repo-critical, or security-critical workflow.

Strategic Surge Mode:
Open-weight model experiments may run only inside approved scope, budget, duration, and success metric.
```

## 19.15 Integration with observability/evaluation layer

Every open-weight model run should emit observability events.

Required trace fields:

```text
run_id
model_id
model_version
hosting_mode
task_class
AI_employee
machine
domain
prompt_version
input_sensitivity_level
cost_estimate
actual_cost
latency
output_state
benchmark_reference
human_review_required
human_review_outcome
false_positive_flag
false_negative_flag
approved_for_followup
```

Langfuse, LangSmith, or the selected observability/evaluation layer should be able to trace model comparisons over time.

## 19.16 Implementation objects

Add or extend these objects:

```text
ModelBenchCandidate
ModelEvaluationRecord
ModelBenchmarkRun
ModelRoutingPolicy
ModelRiskProfile
ModelPrivacyReview
ModelSecurityReview
ModelCostProfile
ModelOutputQuarantineRecord
OpenWeightDeploymentProfile
CyberModelSandboxPolicy
HostedModelDataReview
ModelApprovalState
ModelRestrictionRecord
ModelDeprecationRecord
```

## 19.17 UI additions

Add UI surfaces:

```text
Model Bench Dashboard
Model Candidate Detail Page
Open-Weight Model Review Card
Security-Coding Model Benchmark View
Model Routing Policy Panel
Model Output Quarantine Queue
Model Privacy Review Panel
Model Security Review Panel
Model Cost/Value Comparison View
Model Kill Switch / Restrict Button
```

Required visible fields:

1. approved tasks;
2. blocked tasks;
3. sensitivity permissions;
4. benchmark status;
5. privacy review status;
6. security review status;
7. cost performance;
8. quality performance;
9. last reviewed date;
10. current status;
11. kill switch;
12. owner.

## 19.18 v1.6 Build Sequence Update

Add this after the v1.5 vendor adapter bench, not before governance.

Updated sequence addition:

```text
Sprint 1.25:
Agent Observability/Evaluation layer selection and integration stub.

Sprint 1.5:
Cost Dashboard, Mode Switchboard, Budget Governor, Tool Introduction Review UI, and initial Model Bench schema.

Sprint 2:
Opportunity Radar, queue separation, loop governance, vendor adapter bench, and model bench registration.

Sprint 2.25:
Open-weight model experiment harness:
- ModelBenchCandidate;
- ModelEvaluationRecord;
- ModelOutputQuarantineRecord;
- ModelRoutingPolicy;
- benchmark runner stub;
- read-only repo/code review test lane;
- Budget Governor integration.

Sprint 2.5:
First external adapter pilots and first model-bench pilots.

Sprint 3:
Domain rollout only after governance, cost, lifecycle, observability, adapter controls, and model controls exist.
```

Hard rule:

```text
Benchmark before trust.
```

## 19.19 v1.6 Testing Requirements

Add tests for:

1. ModelBenchCandidate creation.
2. GLM 5.2 candidate registration.
3. open-weight model cannot become default without approval.
4. hosted foreign-developed model requires data sensitivity review.
5. cyber-capable model is blocked from unrestricted repo access.
6. read-only repo mount enforced for security-review tasks.
7. Model Output Quarantine prevents direct source-of-truth updates.
8. Model Router respects sensitivity level.
9. Model Router respects Cheapo Mode.
10. Model Router respects Critical-Only Mode.
11. Model Router respects Strategic Surge budget/scope.
12. Budget Governor records open-weight model cost.
13. observability trace records model version and hosting mode.
14. benchmark run records false-positive and false-negative markers.
15. human review required for consequential security findings.
16. model restriction blocks future sensitive tasks.
17. model kill switch blocks future use.
18. AI employee suspension blocks assigned model runs.
19. no private LP/fund/sponsor/relationship data can be sent to unapproved hosted model APIs.
20. code/security output cannot be marked resolved without validation evidence.

No open-weight model is production-ready until these tests exist and pass for its approved task class.



---

# 20. v1.7 INTENT-TO-EXECUTION INTELLIGENCE IMPLEMENTATION DELTA

## 20.1 Purpose

v1.7 implements the technical build plan for the v3.2.10 canonical Intent-to-Execution Intelligence update.

The implementation objective is not to build a decorative prompt library.

The objective is to ensure that serious work enters the system as a governed, typed, auditable, cost-aware, backend-adaptable work packet.

Core implementation law:

```text
Raw MP intent is input.
Universal Tier-1 Work Packet is the execution standard.
Backend-specific prompt is an adapter output.
```

## 20.2 Scope of v1.7 Implementation Update

v1.7 adds implementation requirements for:

1. IntentEnhancementRun;
2. EnhancementLevel;
3. InstitutionalLensCard;
4. LensStack;
5. POVCardGenerator;
6. UniversalTier1WorkPacket;
7. BackendPromptAdapterRegistry;
8. BackendPromptVariant;
9. PromptQualityScorecard;
10. PromptLibraryPromotionCandidate;
11. PromptObservabilityTrace;
12. Prompt / Assignment Enhancer Portal;
13. Cost Governor integration;
14. Approval Center integration;
15. vendor/model/backend adapter compatibility;
16. tests.

## 20.3 Data Objects

### IntentEnhancementRun

```text
IntentEnhancementRun
- id
- raw_intent
- requested_by
- created_at
- enhancement_level
- inferred_task_type
- firm_domain
- machine_id
- assigned_ai_employee_id
- risk_level
- data_classification
- cost_class
- cost_mode
- lens_stack_id
- pov_card_id
- universal_work_packet_id
- backend_adapter_selected
- backend_prompt_variant_id
- prompt_quality_scorecard_id
- approval_requirement
- approval_queue_target
- observability_trace_id
- status
```

### EnhancementLevel

```text
EnhancementLevel
- INVISIBLE_INTENT_ENHANCEMENT
- AUTOMATIC_TIER_1_WORK_PACKET
- PROMPT_ASSIGNMENT_ENHANCER_PORTAL
```

Rules:

1. low-risk work may default to invisible enhancement;
2. serious work must create Automatic Tier-1 Work Packet;
3. export/reuse/inspection/comparison requests open the portal;
4. external action requires approval regardless of enhancement level.

### InstitutionalLensCard

```text
InstitutionalLensCard
- id
- lens_name
- lens_category
- named_sources
- schools_of_thought
- role_archetypes
- firm_domain
- when_to_use
- when_not_to_use
- core_principles
- questions_it_asks
- failure_modes_it_catches
- blind_spots
- counter_lenses
- output_standard
- truth_or_compliance_limits
- source_notes
- version
- review_date
- promotion_status
```

### LensStack

```text
LensStack
- id
- task_id
- lead_lens_id
- supporting_lens_ids
- counter_lens_id
- hostile_reviewer_lens_id
- truth_compliance_gate_id
- blind_spot_summary
- selected_by
- selection_reason
- override_reason
- created_at
```

### UniversalTier1WorkPacket

```text
UniversalTier1WorkPacket
- id
- raw_intent
- objective
- context
- source_materials
- firm_domain
- machine_id
- assigned_ai_employee_id
- requested_by
- owner
- output_format
- audience
- lead_lens_id
- supporting_lens_ids
- counter_lens_id
- hostile_reviewer_id
- truth_compliance_gate_id
- lead_pov
- supporting_povs
- definition_of_done
- evidence_standard
- truth_mode
- data_classification
- allowed_tools
- forbidden_tools
- allowed_context
- forbidden_context
- forbidden_actions
- review_requirements
- validation_requirements
- artifact_requirements
- approval_queue
- approval_requirement
- cost_class
- current_cost_mode
- budget_cap
- backend_recommendation
- model_backend_adapter
- observability_trace_required
- memory_promotion_candidate
- prompt_library_promotion_candidate
- completion_criteria
- kill_condition
- status
```

### BackendPromptAdapter

```text
BackendPromptAdapter
- id
- adapter_name
- backend_type
- supported_backend
- input_packet_version
- output_prompt_format
- required_fields
- forbidden_fields
- data_boundary_rules
- approval_boundary_rules
- cost_boundary_rules
- validation_boundary_rules
- execution_notes
- version
- owner
- review_cadence
```

Initial adapters:

1. Claude / Claude Code Adapter;
2. Codex / OpenAI Agent Adapter;
3. Gemini Adapter;
4. Perplexity / Research Adapter;
5. DeepSeek / GLM / Qwen / Open-Weight Adapter;
6. Browserbase / Stagehand Browser Execution Adapter;
7. n8n Workflow Adapter;
8. Pipedream / Composio Tool Access Adapter;
9. Cloudflare Agents / Owned Runtime Adapter;
10. Human Helper Adapter.

### BackendPromptVariant

```text
BackendPromptVariant
- id
- universal_work_packet_id
- backend_prompt_adapter_id
- rendered_prompt
- adapter_notes
- omitted_fields
- added_backend_specific_fields
- approval_boundary_statement
- cost_boundary_statement
- validation_statement
- created_at
```

### PromptQualityScorecard

```text
PromptQualityScorecard
- id
- universal_work_packet_id
- objective_clarity
- output_specificity
- source_grounding
- constraint_clarity
- lens_selection_quality
- counter_lens_quality
- pov_fit
- risk_boundary_clarity
- truth_mode_fit
- data_classification_fit
- approval_boundary_clarity
- validation_plan_quality
- backend_fit
- cost_fit
- ambiguity_risk
- hallucination_risk
- rework_risk
- overall_score
- level: Draft / Usable / Tier-1 / Reusable / Canonical
- reviewer
- notes
```

### PromptLibraryPromotionCandidate

```text
PromptLibraryPromotionCandidate
- id
- universal_work_packet_id
- backend_prompt_variant_id
- task_type
- lens_stack_id
- success_score
- failure_notes
- cost_profile
- last_used
- proposed_by
- approved_by
- promotion_status
- replacement_conditions
```

## 20.4 Core Services

### IntentEnhancementService

Responsibilities:

1. capture raw MP intent;
2. classify task type;
3. infer domain and machine;
4. choose enhancement level;
5. trigger LensStack generation;
6. request Cost Governor preflight;
7. create UniversalTier1WorkPacket for serious work;
8. route to Prompt / Assignment Enhancer Portal when needed.

### InstitutionalLensBenchService

Responsibilities:

1. maintain lens cards;
2. retrieve candidate lenses by task;
3. reject inappropriate lenses;
4. select lead/support/counter/hostile/truth-gate lenses;
5. record lens blind spots;
6. update lens performance through observability and evals.

### POVCardGenerator

Responsibilities:

1. translate LensStack into role-ready POV card;
2. define professional standards;
3. define failure modes;
4. define evidence and review requirements;
5. attach to UniversalTier1WorkPacket.

### UniversalWorkPacketService

Responsibilities:

1. generate UniversalTier1WorkPacket;
2. validate required fields;
3. ensure approval boundary exists;
4. ensure data classification exists;
5. ensure cost class exists;
6. ensure forbidden actions are explicit;
7. pass packet to backend adapter only after preflight.

### BackendPromptAdapterService

Responsibilities:

1. take UniversalTier1WorkPacket;
2. render backend-specific prompt;
3. preserve authority/approval/evidence/cost constraints;
4. label backend limitations;
5. prevent backend prompt from weakening the universal standard.

### PromptQualityService

Responsibilities:

1. score packet quality;
2. flag ambiguity;
3. flag weak evidence standards;
4. flag missing approval boundaries;
5. flag excessive cost for task stakes;
6. recommend revise / execute / defer / block.

### PromptPromotionService

Responsibilities:

1. identify successful reusable packets;
2. create promotion candidate;
3. require MP approval before firm prompt library promotion;
4. preserve versioning and replacement conditions.

## 20.5 Prompt / Assignment Enhancer Portal UI

Required UI surfaces:

1. Raw Intent Box;
2. Enhance Button;
3. Enhancement Level Indicator;
4. Task Classification Panel;
5. Domain + Machine Recommendation;
6. AI Employee Recommendation;
7. Institutional Lens Stack Panel;
8. POV Card Preview;
9. Universal Tier-1 Work Packet Preview;
10. Backend Adapter Selector;
11. Backend-Specific Prompt Preview;
12. Cost Estimate Panel;
13. Approval Requirement Panel;
14. Forbidden Actions Panel;
15. Prompt Quality Scorecard;
16. Execute / Copy / Save / Reject controls;
17. Promote to Prompt Library option;
18. Observability trace link after execution.

Anti-friction law:

```text
The portal must not interrogate MPs to death.
Ask only when the answer materially changes the work packet, approval boundary, or risk posture.
```

## 20.6 Enhancement Routing Logic

Routing rules:

```text
Low-risk simple task
→ Invisible Intent Enhancement
→ normal answer/draft/route

Serious internal work
→ Automatic Tier-1 Work Packet
→ backend/model routing
→ observability trace

External action
→ Automatic Tier-1 Work Packet
→ Workflow Approval Queue
→ execution only after approval

Surfaced opportunity
→ Opportunity Review Queue
→ if approved, Universal Tier-1 Work Packet
→ Workflow Approval Queue as needed

Reusable/exportable prompt request
→ Prompt / Assignment Enhancer Portal
→ backend-specific variants
→ optional promotion candidate
```

## 20.7 Cost Governor Integration

Cost preflight must run before Automatic Tier-1 Work Packet execution.

Cost Governor checks:

1. current firmwide cost mode;
2. domain override;
3. task cost class;
4. backend/model expected cost;
5. prompt enhancement expected cost;
6. observability/eval expected cost;
7. approval threshold;
8. monthly budget impact.

Cost Governor may downgrade:

1. lens count;
2. model tier;
3. research depth;
4. output length;
5. CoVE depth;
6. portal visibility;
7. execution timing.

Cost Governor may not remove:

1. approval boundaries;
2. data classification;
3. legal/compliance gates;
4. source-of-truth hierarchy;
5. forbidden actions;
6. security controls;
7. truthful validation status.

## 20.8 Observability and Evals Integration

Every Automatic Tier-1 Work Packet and portal-generated packet must write a trace.

Trace additions:

```text
intent_enhancement_run_id
enhancement_level
raw_intent
universal_work_packet_id
lens_stack_id
pov_card_id
backend_prompt_adapter_id
backend_prompt_variant_id
prompt_quality_scorecard_id
shown_to_MP
edited_by_MP
portal_generated
auto_generated
promoted_to_library
cost_preflight_result
post_run_usefulness_score
rework_required
```

Evaluation questions:

1. Did enhancement improve output?
2. Did the lens stack help?
3. Did the counter-lens catch a real issue?
4. Did the backend prompt adapter preserve constraints?
5. Did prompt quality score correlate with output usefulness?
6. Was the cost justified?
7. Did the enhancement reduce or increase approval burden?
8. Should the packet be promoted, revised, or retired?

## 20.9 Relationship to Machine #42

Implementation should not add a new machine for this.

Update Machine #42 internals:

```text
Machine #42: Prompt Enhancer + Intent-to-Execution Machine
```

New modules inside Machine #42:

1. IntentEnhancementService;
2. InstitutionalLensBenchService;
3. POVCardGenerator;
4. UniversalWorkPacketService;
5. BackendPromptAdapterService;
6. PromptQualityService;
7. PromptPromotionService.

Cross-machine dependencies:

1. Approval Center Machine;
2. Cost Dashboard / Budget Governor Machine;
3. AI Employee Performance + Cost Ledger Machine;
4. Vendor Adapter Bench;
5. Model Governance + Privacy Airlock Machine;
6. Opportunity Radar + Strategic Initiative Machine;
7. Activity Feed + Audit Ledger Machine.

## 20.10 Security and Authority Rules

1. backend prompts may not remove approval gates;
2. backend prompts may not broaden tool permissions;
3. backend prompts may not downgrade data classification;
4. backend prompts may not hide cost;
5. backend prompts may not authorize external action;
6. model-specific adaptation cannot convert draft-only work into send/execute work;
7. prompt library promotion requires approval;
8. Institutional Lens Bench cannot override documents, evidence, compliance, MP authority, or source-of-truth records;
9. external vendors receive only backend-specific scoped prompts, not the full institution;
10. human helpers receive context packets, not raw canonical memory.

## 20.11 Implementation Sequence Update

Add to build order:

```text
Sprint 1.1:
IntentEnhancementRun, EnhancementLevel, InstitutionalLensCard, LensStack, POVCard data model.

Sprint 1.2:
UniversalTier1WorkPacket and BackendPromptAdapterRegistry.

Sprint 1.3:
Prompt Quality Scorecard and basic Prompt / Assignment Enhancer Portal.

Sprint 1.4:
Cost Governor preflight integration and Approval Center integration.

Sprint 1.5:
Observability traces for enhanced work packets.

Sprint 2:
Backend-specific prompt variants for Claude/Codex/Gemini/Research/Open-Weight/Browserbase/n8n/Human Helper.

Sprint 2.5:
Prompt library promotion workflow and lens performance evals.
```

Hard rule:

```text
Tier-1 work packet before broad serious agent execution.
```

## 20.12 Testing Requirements

Add tests for:

1. low-risk task receives Invisible Intent Enhancement;
2. canonical update request triggers Automatic Tier-1 Work Packet;
3. external action request requires Workflow Approval Queue;
4. surfaced opportunity routes through Opportunity Review before Work Packet execution;
5. LensStack includes lead lens, supporting lens, counter-lens, hostile reviewer, and truth/compliance gate;
6. No Pedestal Law prevents named source from overriding source documents;
7. UniversalTier1WorkPacket requires data classification;
8. UniversalTier1WorkPacket requires cost class;
9. UniversalTier1WorkPacket requires forbidden actions;
10. BackendPromptAdapter cannot remove approval boundaries;
11. Browserbase adapter cannot receive unrestricted credentials;
12. n8n adapter cannot send external messages without approval;
13. open-weight model adapter obeys model-bench sensitivity limits;
14. human helper adapter receives scoped context packet only;
15. Prompt Quality Scorecard flags weak objective clarity;
16. Prompt Quality Scorecard flags missing evidence standard;
17. Cost Governor can downgrade model tier;
18. Cost Governor cannot remove compliance gate;
19. observability trace records raw intent and enhanced packet;
20. prompt library promotion requires approval;
21. Machine #42 owns intent enhancement without creating Machine #46;
22. Cheapo Mode preserves approval and safety boundaries;
23. Critical-Only Mode blocks non-essential prompt enhancement;
24. Strategic Surge Mode permits enhanced packets only within approved scope;
25. prompt adapter output preserves truthful validation language.

No prompt-intelligence layer is production-ready until these tests exist and pass for the approved task class.


# 21. v1.9 Capability Intelligence, AI Employee Launch Wizard, and Claude Managed Agent Reference Update

## 21.1 Implementation Decision

Implement Capability Intelligence as the governing layer that lets West Peek OS classify, select, benchmark, observe, improve, retire, and replace reusable execution capabilities.

This update does not make any new vendor or framework canonical.

Implementation law:

```text
The institution owns the standard.
Capabilities compete to serve the standard.
```

West Peek OS should treat vendors, models, skills, workflows, reference repositories, human SOPs, prompt adapters, validators, and document-production methods as governed capabilities.

## 21.2 Capability Registry Objects

Add the following implementation objects:

```text
CapabilityPackage
CapabilityRegistry
CapabilityStack
CapabilitySelectionRun
CapabilityAfterActionReview
CapabilityImprovementProposal
CapabilityPromotionDecision
CapabilityRetirementDecision
CapabilityBenchmarkRun
CapabilityCompatibilityMatrix
CapabilityStatusChangeEvent
CapabilityReviewSchedule
CapabilityFailureMode
CapabilityReplacementPath
```

## 21.3 CapabilityPackage Schema

```text
CapabilityPackage
- capability_id
- capability_name
- capability_type
- source
- source_url_or_reference
- compatible_backends
- purpose
- when_to_use
- when_not_to_use
- inputs_required
- outputs_produced
- allowed_tools
- forbidden_actions
- data_sensitivity_allowed
- data_sensitivity_forbidden
- approval_requirements
- cost_profile
- budget_class
- observability_requirements
- audit_requirements
- known_failure_modes
- eval_requirements
- version
- last_reviewed_at
- review_cadence
- owner
- status
- replacement_candidates
- retirement_conditions
- promotion_conditions
- rollback_path
```

Capability types:

```text
Claude Skill
Prompt Adapter
Model Adapter
Open-Weight Model Candidate
MCP Server
Workflow Automation
Browser Automation
Research Tool
Vendor Runtime
Repo Validator
Eval Harness
Human SOP
Agent Launch Template
Document Production Pipeline
Project Governance Document
```

## 21.4 Capability Statuses

```text
Discovered
Watched
Bench Testing
Approved-Limited
Approved-Production
Rejected
Blocked
Deprecated
Retired
```

Status transition rules:

1. Discovered may become Watched after relevance review.
2. Watched may become Bench Testing after data, cost, and risk review.
3. Bench Testing may become Approved-Limited only after sandbox evidence exists.
4. Approved-Limited may become Approved-Production only after repeatable task-specific success, observability, cost visibility, failure-mode review, and authorized approval.
5. Blocked capabilities cannot be selected.
6. Deprecated capabilities require replacement plan.
7. Retired capabilities remain historically visible but cannot be routed without reactivation approval.

## 21.5 Capability Stack Selector

For every serious Universal Tier-1 Work Packet, select:

```text
Lead Capability
Support Capability
Verifier / Reviewer
Fallback
```

Selection fields:

```text
work_packet_id
task_type
risk_level
data_classification
cost_mode
approval_class
lead_capability_id
support_capability_ids
verifier_capability_id
fallback_capability_id
selection_reason
capabilities_rejected
rejection_reason
observability_trace_id
```

The selector must prefer the smallest effective stack.

Forbidden selection patterns:

1. selecting every available tool because it exists;
2. selecting an unapproved vendor for sensitive data;
3. selecting a capability whose status is Blocked, Retired, or Deprecated without override;
4. selecting a capability that cannot produce audit evidence for serious work;
5. selecting a cheaper capability when the task requires higher reliability, compliance review, or source-grounded precision;
6. selecting an expensive frontier stack for low-risk repetitive work without cost justification.

## 21.6 Example Capability Stacks

### LP Memo / Fund Diligence Packet

```text
Lead Capability:
Institutional investor / skeptical LP work-packet adapter + approved frontier model.

Support Capability:
Source documents, fund model, approved relationship context, IC standards.

Verifier / Reviewer:
Compliance Sentinel + skeptical LP hostile review.

Fallback:
Human fund counsel / senior GP review packet.
```

### Sponsor Target Research for West Peek Rooms

```text
Lead Capability:
Research adapter or Browserbase candidate for public-source collection.

Support Capability:
West Peek Rooms sponsorship rules and brand-fit criteria.

Verifier / Reviewer:
Source capture + compliance/pay-to-play boundary review.

Fallback:
Manual research packet or human assistant SOP.
```

### Repo / Product Work

```text
Lead Capability:
Claude Code / Codex-style repo worker under Repository Runtime.

Support Capability:
Repo authority files, validation scripts, artifact law, Hallmark standards.

Verifier / Reviewer:
Senior Security Engineer + QA hostile review.

Fallback:
Alternate coding backend or human engineer review.
```

### Long-Form Document Production

```text
Lead Capability:
Document Compiler Mode v2.0 discipline.

Support Capability:
Source corpus + artifact tracker + completeness ledger.

Verifier / Reviewer:
Deduplication + structural integrity + operational readiness check.

Fallback:
Newer document production capability only after benchmarked superiority.
```

## 21.7 Capability After-Action Review

After serious execution, create a CapabilityAfterActionReview.

```text
CapabilityAfterActionReview
- review_id
- work_packet_id
- assignment_id
- capability_stack_used
- model_backend_used
- vendor_or_adapter_used
- output_summary
- outcome_quality
- cost
- latency
- human_corrections_required
- failure_modes_observed
- missing_instructions
- approval_burden
- observability_trace_id
- usefulness_score
- promotion_recommendation
- improvement_recommendation
- retirement_recommendation
- next_review_date
```

After-action law:

```text
A capability that repeatedly creates supervision burden should be patched, downgraded, parked, or retired.
```

## 21.8 Capability Improvement Proposal

When a capability fails or could be improved, generate a proposal rather than silently rewriting critical instructions.

```text
CapabilityImprovementProposal
- proposal_id
- capability_id
- triggering_review_id
- issue_summary
- current_version
- proposed_change
- expected_benefit
- risk_of_change
- eval_required
- approval_required
- proposed_status_after_change
- rollback_plan
```

Approval rules:

1. low-risk prompt copy improvements may be reviewed by authorized operator;
2. repo validators, compliance rules, model routing, data-boundary, approval, memory, or vendor-permission changes require elevated approval;
3. no critical capability is silently rewritten after one bad run;
4. all promoted changes must version the capability.

## 21.9 AI Employee Launch Wizard

Add an AI Employee Launch Wizard to turn MP intent into a governed pilot-ready AI employee or external agent assignment.

Flow:

```text
1. MP intent captured
2. Role classified
3. Domain and machine mapped
4. Authority envelope generated
5. Capability stack selected
6. Backend candidates compared
7. Universal Tier-1 Work Packet created
8. Eval scaffold generated
9. Cost boundary assigned
10. Observability trace configured
11. Pilot launch approval requested
12. First run executed under restricted scope
13. First run graded
14. Agent scorecard updated
15. Promote / restrict / PIP / retire decision made
```

Launch artifacts:

```text
Agent Build Sheet
Role Charter
Authority Envelope
Standing Duties
Allowed Tools
Forbidden Actions
Data Boundary
Cost Class
Eval Scaffold
Definition of Done
Pilot Plan
Observability Trace Contract
Lifecycle Review Date
Decommission / Kill Switch Plan
```

No AI employee becomes production-active without these artifacts.

## 21.10 Agent Build Sheet Fields

```text
Agent Build Sheet
- agent_name
- agent_role
- owning_domain
- owning_machine
- business_purpose
- primary_users
- task_classes
- standing_duties
- trigger_events
- input_sources
- output_artifacts
- allowed_data_classes
- forbidden_data_classes
- allowed_tools
- forbidden_actions
- approval_required_for
- default_capability_stack
- backend_candidates
- model_candidates
- vendor_candidates
- cost_class
- monthly_budget_limit
- observability_requirements
- eval_scaffold
- success_metrics
- failure_modes
- lifecycle_status
- review_date
- retirement_conditions
```

## 21.11 Eval Scaffold for New AI Employees

Every launched AI employee must have an eval scaffold before promotion beyond pilot.

```text
Eval Scaffold
- golden_tasks
- expected_output_shapes
- forbidden_behaviors
- required_sources
- required_approval_points
- data-boundary tests
- hallucination checks
- cost ceiling
- latency target
- human review rubric
- score threshold for promotion
- failure threshold for restriction/PIP/retirement
```

Promotion gates:

1. pilot run completed;
2. eval scaffold executed for approved task class;
3. observability trace exists;
4. cost recorded;
5. human review completed where required;
6. scorecard updated;
7. lifecycle decision recorded.

## 21.12 Claude Managed Agent Launch Reference — Bench Candidate

The Anthropic `launch-your-agent` repository enters the Capability Bench as a reference pattern, not a production default.

Classification:

```text
Capability Name:
Claude Managed Agent Launch Reference

Capability Type:
Agent Launch Workflow Reference + Claude Managed Agent Adapter Candidate

Status:
Bench / Pattern Extract
```

Use:

```text
study launch flow
extract agent artifact requirements
compare against West Peek AI Employee Launch Wizard
define agent build sheet fields
define eval scaffold requirements
define wrap-up protocol
define scheduled deployment gate
```

Do not:

```text
make it canonical by default
assume Claude Managed Agents are the default runtime
replace Cloudflare-first owned runtime exploration
bypass West Peek AI Employee Registry
bypass approvals, observability, cost governor, lifecycle controls, or audit ledger
```

Implementation extraction targets:

```text
interview-to-agent-config mapping
build sheet structure
exact API payload capture pattern
resumable launch script pattern
eval scaffold pattern
wrap-up / status-check pattern
next-directions plan
scheduled-task gate pattern
```

Architectural lesson:

```text
West Peek OS should have a governed Agent Launch Wizard.
Claude Managed Agents are one possible backend candidate.
```

## 21.13 UI Requirements

Add UI surfaces:

```text
Capability Registry
Capability Detail Page
Capability Stack Selector Preview
Capability Bench
Capability After-Action Review Queue
Capability Improvement Proposal Queue
Capability Promotion / Retirement Review
AI Employee Launch Wizard
Agent Build Sheet View
Eval Scaffold View
Launch Pilot Approval Card
```

Capability Registry list columns:

```text
Capability
Type
Status
Active Default For
Data Allowed
Cost Class
Last Reviewed
Failure Count
Replacement Candidate
Owner
```

## 21.14 Service Layer Requirements

Add services:

```text
CapabilityRegistryService
CapabilitySelectionService
CapabilityStackPolicyEngine
CapabilityAfterActionService
CapabilityImprovementService
CapabilityBenchmarkService
AIEmployeeLaunchWizardService
AgentBuildSheetService
EvalScaffoldService
CapabilityStatusTransitionService
```

## 21.15 Observability and Cost Integration

Every CapabilitySelectionRun must record:

```text
capabilities considered
capabilities selected
capabilities rejected
selection reason
data classification
cost mode
actual cost
trace id
output score
review score
promotion or retirement signal
```

Cost Governor must support capability-level spend:

```text
spend by capability
spend by capability type
spend by capability stack
cost per accepted capability-assisted output
cost per promoted capability
cost per retired/failed capability
```

Observability must show whether a capability improved or degraded output quality over time.

## 21.16 Security and Authority Rules

1. capability selection cannot broaden data access;
2. capability selection cannot remove approval gates;
3. a capability may not be selected if its data sensitivity boundary conflicts with the work packet;
4. a reference repo may not become execution authority without adapter review;
5. Claude Managed Agent reference patterns may not bypass West Peek OS launch artifacts;
6. AI Employee Launch Wizard cannot launch production agents without MP/admin approval;
7. external agent launch requires vendor adapter review;
8. capability improvement proposals cannot silently alter compliance, approval, cost, memory, or audit controls;
9. blocked capabilities cannot run;
10. deprecated capabilities require override and reason.

## 21.17 Testing Requirements

Add tests for:

1. CapabilityPackage requires status, capability type, data sensitivity, and approval fields;
2. blocked capability cannot be selected;
3. high-risk work packet cannot select unapproved capability;
4. capability stack selector chooses smallest effective stack;
5. capability stack selector rejects vendor/data sensitivity conflict;
6. Active Default can be selected when still approved;
7. Bench candidate requires explicit selection reason;
8. Deprecated capability requires override reason;
9. CapabilityAfterActionReview records cost, quality, failure modes, and trace id;
10. CapabilityImprovementProposal requires approval for approval/data/compliance/memory/cost changes;
11. capability status cannot move to Approved-Production without promotion decision;
12. Claude Managed Agent Launch Reference remains Bench / Pattern Extract, not default runtime;
13. AI Employee Launch Wizard creates Agent Build Sheet;
14. AI Employee Launch Wizard creates Authority Envelope;
15. AI Employee Launch Wizard creates Eval Scaffold;
16. AI Employee Launch Wizard blocks production launch without approval;
17. new AI employee pilot run creates observability trace;
18. Cost Governor records capability-level spend;
19. capability output returns as untrusted until reviewed where required;
20. capability retirement removes it from default routing;
21. fallback capability is used only after active/default failure or explicit override;
22. capability improvement versions the capability;
23. reference repositories cannot override canonical West Peek OS or source documents;
24. Vendor Adapter Bench and Model Bench integrate with Capability Registry;
25. Prompt / Assignment Enhancer records selected capability stack.

No Capability Intelligence layer is production-ready until these tests exist and pass for the approved task class.


---

# 22. v1.9 Mobile-First Cloud Execution Runtime Update

## 22.1 Purpose

This v1.9 update converts the approved mobile-first / cloud-execution discussion into implementation architecture.

The target operating model is:

```text
iPhone / mobile web app = command surface and approval cockpit
Cloud runtime = orchestration and execution engine
Laptop = optional development, local validation, private-file, and fallback workstation
Dedicated isolated runtimes = high-risk or special-purpose execution environments only
```

This section is implementation guidance. It does not validate any deployment provider, PWA behavior, Cloudflare service, mobile browser behavior, repo worker, or external vendor.

## 22.2 Runtime Layer Architecture

West Peek OS should be implemented with these runtime layers:

```text
1. Mobile Command UI
2. Cloud Orchestration Runtime
3. Execution Worker Layer
4. Evidence + Approval Layer
5. Notification Layer
6. Local Workstation / Validation Lane
7. Protected Self-Modification Lane
8. Isolated High-Risk Runtime Lane
```

### Runtime Responsibilities

```text
Mobile Command UI:
Task entry, approval review, artifact review, risk/cost/evidence inspection, status view.

Cloud Orchestration Runtime:
Queues, job state, assignment routing, approval state, scheduled jobs, audit/cost ledgers, worker coordination.

Execution Worker Layer:
Models, owned agents, repo workers, document workers, research adapters, browser workers, workflow tools, human helpers.

Evidence + Approval Layer:
Artifacts, screenshots, logs, diffs, source links, risk notes, approval records, rollback references.

Notification Layer:
Mobile/email/PWA/push-style alerts and digest delivery.

Local Workstation / Validation Lane:
Local-only proof, private files, local credentials, source packaging, repo validation, local models.

Protected Self-Modification Lane:
Controlled changes to West Peek OS source, docs, runtime, permissions, and authority files.

Isolated High-Risk Runtime Lane:
Brokerage-sensitive, regulated, trading, financial, or highly confidential work separated from general runtime.
```

## 22.3 Mobile Command UI Requirements

The first mobile surface should be a responsive web application with PWA readiness.

Required capabilities:

```text
task capture
work card review
approval inbox
artifact preview
evidence viewer
risk card viewer
cost card viewer
AI employee status
capability stack preview
worker run status
notification center
redaction / permission envelope review
approve / edit / reject / snooze actions
```

Rollout sequence:

```text
Phase 1: responsive mobile-first web app
Phase 2: installable iPhone PWA
Phase 3: native iOS app only if justified by product evidence
```

Native iOS should be deferred unless needed for:

```text
Face ID approval
secure local device vault
critical push notifications
Apple Shortcuts
home-screen widgets
offline capture
deep notification controls
```

## 22.4 Cloud Orchestration Runtime Candidate

The preferred candidate posture remains Cloudflare-first owned runtime, subject to implementation validation.

Candidate primitives:

```text
Workers / serverless handlers
Durable Objects / stateful sessions
Workflows / durable jobs
Queues / background execution
Cron / scheduled triggers
R2 / artifact storage
D1 / structured persistence
KV / small key-value persistence
Access / auth boundary
Observability hooks
Audit ledger
Cost event ledger
Approval state machine
```

These primitives must be validated before production reliance.

Implementation may choose substitutes if Cloudflare constraints prove unsuitable.

## 22.5 Cloud Runtime Objects

Add or plan the following implementation objects:

```text
CloudRuntimeJob
CloudRuntimeQueue
CloudRuntimeWorkerRun
CloudRuntimeSchedule
CloudRuntimeArtifact
CloudRuntimeEvidenceRecord
CloudRuntimeApprovalState
CloudRuntimeNotification
CloudRuntimeCostEvent
CloudRuntimeAuditEvent
CloudRuntimeFailureRecord
CloudRuntimeRetryPolicy
CloudRuntimeKillSwitch
```

Required fields for `CloudRuntimeJob`:

```text
job_id
work_packet_id
requested_by
assigned_agent_id
capability_stack_id
worker_type
runtime_lane
status
priority
risk_level
data_classification
approval_required
approval_state
cost_cap
schedule_id
started_at
completed_at
result_artifact_ids
evidence_record_ids
trace_id
failure_record_id
kill_switch_state
```

## 22.6 Execution Worker Layer

Workers are interchangeable capability surfaces.

Worker categories:

```text
owned West Peek AI employees
model API workers
repo/code workers
document compiler workers
research/extraction workers
browser execution workers
workflow automation workers
human helper workers
external hosted-agent workers
```

Worker selection must consider:

```text
task type
data sensitivity
approval requirement
cost class
capability fit
runtime availability
observability requirements
risk level
```

No worker may bypass:

```text
Authority Envelope
Approval Inbox
Cost Governor
Observability Trace
Audit Ledger
Memory Promotion Queue
Lifecycle Controls
```

## 22.7 Non-Repo Work Parity Flow

Repo work must not become the mental model for all agent work.

Non-repo work uses the same governed flow:

```text
Partner command
↓
Task intake
↓
Intent-to-Execution Intelligence
↓
Universal Tier-1 Work Packet
↓
Capability Stack Selector
↓
Permission / data / cost envelope
↓
Worker execution
↓
Draft / artifact / evidence
↓
Approval if needed
↓
Audit + memory promotion decision
```

Initial non-repo task classes:

```text
LP meeting prep
sponsor target research
West Peek Rooms partner list
portfolio support brief
founder diligence memo
relationship intelligence update
email draft
calendar prep
event ops checklist
market map
document compilation
data cleanup
dashboard review
vendor review
```

Each class should receive acceptance criteria, approval rules, evidence requirements, cost class, and default capability stack.

## 22.8 Evidence + Approval Layer

Every cloud-executed serious task must return evidence before approval or memory promotion.

Evidence types:

```text
artifact file
source link
screenshot
trace log
tool-call log
cost event
diff
risk note
approval card
rollback reference
human review note
```

Approval cards must support mobile review.

Approval actions:

```text
Approve
Edit
Reject
Snooze
Request More Evidence
Escalate
```

No external-facing, money-related, compliance-sensitive, regulated, investor-facing, sponsor-facing, relationship-sensitive, or reputation-sensitive action may execute without the required approval card.

## 22.9 Notification Layer

The notification layer should support:

```text
critical alerts
daily digest
approval-needed notices
artifact-ready notices
job-failed notices
cost threshold notices
scheduled task summaries
security / permission alerts
```

Notification routing must respect:

```text
risk level
urgency
partner role
quiet hours
approval deadline
notification fatigue budget
```

The system should notify without turning West Peek OS into a panic dashboard.

## 22.10 Local Workstation / Validation Lane

The laptop is used when work requires local proof or local resources.

Local-only or laptop-preferred work:

```text
local repo validation
local browser proof
source ZIP packaging
private file access
local credentials
manual debugging
local model inference
high-fidelity design validation
fallback continuity work
```

Cloud may prepare work, but local validation remains required where repo law or proof requirements demand it.

The system must label any cloud-prepared repo artifact honestly:

```text
STRUCTURALLY CHECKED — LOCAL VALIDATION REQUIRED
```

unless local validation has actually run.

## 22.11 Protected Self-Modification Lane

West Peek OS can help improve its own repo and documents, but only through a controlled lane.

Required controls:

```text
separate branch or isolated workspace
diff summary
artifact package
validation status
rollback path
approval before merge/deploy
explicit MP/admin approval for system-law changes
permission-change review
memory/approval/cost/compliance/lifecycle rule review
```

Forbidden:

```text
silent self-editing
silent permission expansion
self-removal of approval gates
self-removal of audit logs
self-removal of cost controls
self-promotion of capabilities to production default
self-modification of compliance or authority rules without approval
```

## 22.12 Mobile Policy Airlock

Mobile can supervise a policy airlock.

Mobile supports:

```text
redaction review
permission envelope review
external model warning
data-sharing review
return-result inspection
approve / reject / edit
```

Mobile is not the full private compute airlock.

Full compute airlock requires one of:

```text
laptop
private server
secure cloud / VPC
Mac Studio or other local hardware
local/private model runtime
```

Implementation should support both:

```text
Policy Airlock:
review/approve what leaves and what returns.

Compute Airlock:
private/local processing before data leaves the controlled environment.
```

## 22.13 Runtime Isolation Matrix

Runtime lanes:

```text
General West Peek OS Cloud Runtime
Repo / Product Runtime
Sensitive Data / Private Compute Runtime
Brokerage-Sensitive Runtime
High-Risk Financial / Trading Runtime, if ever applicable
External Vendor Runtime
Human Helper Runtime
```

Data and tasks that require elevated isolation:

```text
LP data
founder data
secondaries deal data
brokerage communications
fund materials
MNPI-sensitive context
private diligence materials
regulated or compliance-sensitive correspondence
credentials and secrets
```

Isolation requirements:

```text
separate credentials
separate logs where required
separate data stores where required
separate permission boundaries
explicit approval before cross-lane data movement
audit record for every cross-lane handoff
kill switch per lane
```

## 22.14 Acceptance Criteria

v1 mobile-cloud architecture is not ready until:

```text
mobile task submission works
mobile approval review works
cloud job queue records state
scheduled job does not require laptop awake
worker result returns to evidence layer
approval gate blocks external actions
cost event is recorded
observability trace is recorded
laptop/local validation boundary is honestly labeled
protected self-modification lane requires branch/diff/rollback
sensitive data cannot route to unapproved runtime
mobile policy airlock records approval/rejection
runtime isolation rules block forbidden cross-lane handoffs
```

## 22.15 Testing Requirements

Add tests for:

```text
1. mobile task can be submitted without laptop dependency;
2. approval card can be reviewed from mobile;
3. cloud job can queue while user is offline;
4. scheduled job does not require laptop awake;
5. worker output returns to evidence layer before approval;
6. external action is blocked without approval;
7. repo self-modification requires protected branch/diff/rollback;
8. sensitive data cannot route to unapproved worker;
9. mobile policy airlock records approval/rejection;
10. high-risk runtime cannot share general worker credentials;
11. cost and observability records are created for cloud-executed work;
12. laptop/local-validation-required status appears when local proof has not run;
13. native iOS-only features are not required for v1 web/PWA flow;
14. PWA/mobile route does not expose admin-only controls to unauthorized users;
15. notification routing obeys risk level and partner role;
16. runtime isolation matrix blocks forbidden cross-lane data transfer;
17. protected self-modification cannot alter approval rules without MP/admin approval;
18. evidence record must exist before memory promotion for serious cloud-executed work;
19. job kill switch transitions job to stopped state;
20. cloud worker failure creates failure record and does not silently disappear.
```

No mobile-first cloud runtime layer is production-ready until these tests exist and pass for the approved runtime class.


---

# 23. Harvey + Norm AI Legal / Compliance Adapter Bench

## 23.1 Purpose

This section converts canonical West Peek OS v3.2.13 Legal + Compliance AI Adapter Governance into implementation objects, routing rules, adapter cards, tests, and proof requirements.

Approved user rule:

```text
Use Harvey when legal work is involved.
Bring in Norm AI only for compliance-heavy workflows.
```

Implementation translation:

```text
Harvey = Legal Workbench Adapter candidate.
Norm AI = Compliance + Supervisory AI Adapter candidate.
Both are bench tools subordinate to West Peek OS governance, approvals, evidence, data classification, and cost controls.
```

## 23.2 Vendor Research Boundary

Current public vendor characterization used for implementation planning:

| Vendor | Publicly visible positioning | Implementation meaning |
|---|---|---|
| Harvey | AI software for legal and professional services; platform areas include Assistant, Vault, Knowledge, Agents, Contract Intelligence, Command Center, Shared Spaces; use cases include legal research, deal management, due diligence, fund formation, contract analysis, complex workflows, and document storage. | Bench as legal-work AI adapter, especially for legal document analysis, diligence support, legal research support, legal drafting support, and counsel-review packet preparation. |
| Norm AI | Agentic law and legal/regulatory reasoning platform; describes Supervisory AI as verification layer for AI agents operating under law; technology page distinguishes Norm AI as technology/service provider and Norm Law as the law firm providing legal advice/services. | Bench as compliance-heavy, regulatory, supervisory, policy-to-workflow, and AI-agent-governance adapter. Do not treat Norm AI itself as legal counsel. |

Source URLs to preserve in adapter registry notes:

```text
https://www.harvey.ai/
https://www.harvey.ai/platform/assistant
https://www.norm.ai/
https://www.norm.ai/technology
```

## 23.3 New Capability Cards

### 23.3.1 Harvey Legal Workbench Adapter

```yaml
capability_id: harvey_legal_workbench_adapter
capability_name: Harvey Legal Workbench Adapter
vendor: Harvey
capability_type: legal_ai_adapter
status: BENCH_LEGAL_WORK_PREFERRED
primary_domain: Legal/Compliance OS
secondary_domains:
  - Investment OS
  - Fundraising / LP OS
  - Event OS / Sponsorship
  - Governance OS
  - Knowledge OS
use_when:
  - legal research support
  - contract review support
  - NDA review packet
  - side letter issue spotting
  - fund formation support
  - diligence document review
  - transaction support packet
  - legal memo first draft
  - clause extraction
  - legal document comparison table
  - counsel-review packet preparation
not_for:
  - final legal advice
  - final compliance approval
  - MP approval replacement
  - registered-person approval replacement
  - source-of-truth replacement
  - sensitive data routing without permission envelope
required_controls:
  - data classification
  - source document attachment
  - human review flag
  - output status label
  - cost preflight
  - audit trace
  - evidence packet
output_statuses:
  - draft
  - legal_support_packet
  - issue_spotting_aid
  - counsel_review_packet
  - not_final_legal_advice
```

### 23.3.2 Norm AI Compliance + Supervisory Adapter

```yaml
capability_id: norm_ai_compliance_supervisory_adapter
capability_name: Norm AI Compliance + Supervisory Adapter
vendor: Norm AI
capability_type: compliance_ai_supervisory_adapter
status: BENCH_COMPLIANCE_HEAVY_RESERVED
primary_domain: Legal/Compliance OS
secondary_domains:
  - Governance OS
  - Brokerage-Sensitive Runtime
  - Fundraising / LP OS
  - Investment OS
  - Brand / Marketing OS
  - AI Employee Governance
use_when:
  - compliance-heavy workflow review
  - regulatory rule mapping
  - policy-to-workflow translation
  - AI agent supervisory review
  - fund marketing compliance checklist
  - LP material compliance screen
  - brokerage communication compliance review
  - MNPI-sensitive workflow review
  - sponsor disclosure compliance review
  - external claims compliance checklist
not_for:
  - ordinary non-compliance legal drafting by default
  - final legal advice from Norm AI
  - final compliance approval
  - source-of-truth replacement
  - MP approval replacement
  - registered-person approval replacement
required_controls:
  - compliance-heavy classifier
  - data classification
  - human review flag
  - output status label
  - cost preflight
  - audit trace
  - supervisory evidence packet
output_statuses:
  - compliance_support_aid
  - supervisory_review_packet
  - policy_to_workflow_aid
  - risk_screening_packet
  - human_review_required
  - not_final_legal_advice
```

## 23.4 New Object: LegalComplianceAdapterSelectionRun

```typescript
interface LegalComplianceAdapterSelectionRun {
  run_id: string;
  task_id: string;
  work_packet_id: string;
  requested_by: 'scooter' | 'sequoia' | 'ai_employee' | 'operator' | 'system';
  domain: string;
  machine_id?: string;
  task_type: string;

  legal_work_involved: boolean;
  compliance_heavy: boolean;
  regulated_context: boolean;
  brokerage_sensitive: boolean;
  fund_or_lp_sensitive: boolean;
  external_facing: boolean;
  money_or_commitment_related: boolean;
  reputationally_sensitive: boolean;

  data_classification: 'public' | 'internal' | 'confidential' | 'restricted' | 'mnpi_sensitive' | 'credentials_forbidden';
  contains_sensitive_data: boolean;
  source_documents_required: boolean;
  source_documents_attached: boolean;

  recommended_adapter: 'none' | 'harvey' | 'norm_ai' | 'harvey_and_norm' | 'human_only';
  harvey_allowed: boolean;
  norm_allowed: boolean;
  vendor_routing_reason: string;

  human_review_required: boolean;
  required_reviewer_role?: 'mp' | 'counsel' | 'compliance' | 'registered_person' | 'admin';
  approval_gate: 'none' | 'before_vendor' | 'before_external_action' | 'before_memory_promotion' | 'blocked';

  cost_class: 'low' | 'normal' | 'high' | 'surge';
  cost_preflight_id?: string;
  audit_event_id: string;
  observability_trace_id: string;

  output_status: 'draft' | 'support_packet' | 'review_packet' | 'human_review_required' | 'blocked';
  final_authority_claim_blocked: boolean;
}
```

## 23.5 Routing Matrix

| Work Type | Harvey | Norm AI | Human Review | Routing Decision |
|---|---:|---:|---:|---|
| NDA review packet | yes | no unless compliance-heavy | counsel/admin before external use | Harvey |
| Fund formation support question | yes | if regulatory workflow implicated | counsel | Harvey, maybe Norm |
| Side letter issue spotting | yes | if LP/compliance obligations central | counsel/MP | Harvey, maybe Norm |
| LP deck compliance screen | no unless legal drafting issue | yes | MP/compliance/counsel | Norm |
| Brokerage communication review | no unless legal drafting issue | yes | registered-person / compliance | Norm |
| Sponsor agreement draft support | yes | if sponsorship disclosure/compliance issue | counsel/MP | Harvey, maybe Norm |
| Sponsor disclosure compliance | no unless contract interpretation needed | yes | MP/compliance | Norm |
| AI employee compliance supervision | no | yes | admin/MP for policy changes | Norm |
| Contract clause extraction | yes | no unless compliance-heavy | counsel as needed | Harvey |
| Regulatory policy-to-checklist workflow | no unless legal interpretation packet needed | yes | compliance/counsel | Norm |
| External legal memo draft | yes | maybe | counsel before use | Harvey |
| Public regulated claim review | no unless legal drafting issue | yes | compliance/counsel/MP | Norm |
| Non-legal business strategy | no | no | MP only if strategic | neither |

## 23.6 Backend Adapter Registry Requirements

Add records to the Capability Registry / Vendor Adapter Bench:

```json
{
  "capability_id": "harvey_legal_workbench_adapter",
  "adapter_class": "legal_ai_adapter",
  "status": "bench_legal_work_preferred",
  "default_use_rule": "Use Harvey when legal work is involved, subject to data classification and human review flags.",
  "authority_boundary": "support_only_not_legal_counsel_not_approval_authority",
  "cost_tracking_required": true,
  "observability_required": true,
  "human_review_required_for_external_use": true
}
```

```json
{
  "capability_id": "norm_ai_compliance_supervisory_adapter",
  "adapter_class": "compliance_supervisory_ai_adapter",
  "status": "bench_compliance_heavy_reserved",
  "default_use_rule": "Bring in Norm AI only for compliance-heavy workflows, regulatory supervision, policy-to-workflow mapping, or AI-agent compliance supervision.",
  "authority_boundary": "support_only_not_final_legal_advice_not_approval_authority",
  "cost_tracking_required": true,
  "observability_required": true,
  "human_review_required_for_external_use": true
}
```

## 23.7 UI / Admin Requirements

Add to MP/Admin surfaces where capability routing is visible:

```text
Legal / Compliance Adapter Recommendation card
- task name
- legal work involved: yes/no
- compliance-heavy: yes/no
- regulated context: yes/no
- data classification
- recommended adapter: Harvey / Norm / Both / Neither / Human-only
- why this adapter was selected
- human review required
- data not allowed to leave boundary, if applicable
- estimated cost
- actual cost after run
- audit receipt
```

Admin controls:

```text
Approve vendor routing
Reject vendor routing
Switch to human-only
Mark counsel review required
Mark compliance review required
Mark registered-person review required
Block external action
Archive vendor output without memory promotion
```

## 23.8 Data Boundary Implementation Requirements

Adapter routing must reject or require approval when data classification is:

```text
restricted
mnpi_sensitive
credentials_forbidden
```

Minimum controls:

```text
No credentials to vendor adapters.
No secrets to vendor adapters.
No raw MNPI-sensitive packet to vendor adapters without explicit permission envelope.
No LP/founder/private deal data to vendor adapters unless vendor boundary is approved.
No external-facing output without human review flag when legal/compliance sensitive.
```

## 23.9 Observability and Cost Records

Every Harvey or Norm run must create:

```text
adapter_selection_trace
cost_preflight_record
vendor_run_record
source_document_record
output_status_record
human_review_requirement_record
audit_event
adapter_after_action_score
```

Quality scoring fields:

```text
was_adapter_selection_correct
was_output_useful
was_output_overconfident
were_sources_or citations sufficient
was_human_review_required_correctly flagged
was_cost_worth_it
should this pattern be promoted, modified, or archived
```

## 23.10 Test Requirements

Add tests for:

```text
1. Harvey selected when legal_work_involved=true and compliance_heavy=false.
2. Norm AI selected when compliance_heavy=true and legal_work_involved=false.
3. Harvey + Norm selected when legal_work_involved=true and compliance_heavy=true.
4. Neither selected for ordinary non-legal business work.
5. Human-only selected when data_classification=credentials_forbidden.
6. Restricted/MNPI-sensitive data requires permission envelope before vendor routing.
7. Legal/compliance output cannot be marked final approval.
8. External-facing legal/compliance-sensitive output requires human review.
9. Brokerage communication requires registered-person/compliance review flag.
10. LP/fund material requires MP/counsel/compliance review flag.
11. Vendor output cannot bypass approval queues.
12. Vendor output cannot write to source-of-truth records.
13. Cost Governor records estimated and actual cost.
14. Observability trace is created.
15. Adapter after-action scorecard is generated.
16. Norm AI is not used for ordinary legal drafting unless compliance-heavy.
17. Harvey is not used as a compliance supervisor when Norm is required.
18. Vendor output is labeled draft/support/review packet, not legal advice.
```

## 23.11 Implementation Phasing

| Phase | Scope | Status |
|---|---|---|
| Phase 1 | Registry-only cards for Harvey and Norm | Planned |
| Phase 2 | LegalComplianceAdapterSelectionRun object and routing matrix | Planned |
| Phase 3 | Data classification + approval envelope integration | Planned |
| Phase 4 | MP/Admin adapter recommendation card | Planned |
| Phase 5 | Cost/observability/audit integration | Planned |
| Phase 6 | Tests and hostile review | Planned |
| Phase 7 | Actual vendor/API integration after account/security review | Not included in this document |

## 23.12 Not Included Yet

This implementation plan does not prove:

```text
Harvey subscription access
Norm AI subscription access
Harvey API availability
Norm AI API availability
SSO/security contract
vendor data-processing terms
pricing
approved procurement
live integration
local validation
provider credentials
```

Those remain vendor/procurement/security work before runtime integration.

## 23.13 Acceptance Criteria

The Harvey/Norm bench is implementation-ready when:

```text
capability cards exist;
routing matrix exists;
LegalComplianceAdapterSelectionRun is modeled;
data classification gates are enforced;
human review flags are mandatory for external legal/compliance-sensitive work;
Cost Governor and observability hooks exist;
outputs cannot be marked as final legal advice or final compliance approval;
UI shows adapter recommendation and approval boundary;
tests prove routing and authority constraints;
actual vendor integration is blocked until access, security, and procurement are approved.
```

# 24. FUND AI OPERATING MODEL IMPLEMENTATION — HYBRID FUND DATA, SERVICES, ROUTING, AND CONTROLS

## 24.1 Implementation Objective

This section translates the canonical Fund AI Operating Model into implementation-ready data structures, services, workflows, UI surfaces, permissions, observability requirements, migrations, and tests.

The implementation must preserve the governing boundary:

```text
AI prepares the decision.
The Managing Partners and authorized humans make the decision.
```

This section does not authorize code execution, live data access, financial-model reliance, legal reliance, compliance reliance, provider integration, or production deployment.

---

## 24.2 Domain Model Additions

### CanonicalCompany

```text
CanonicalCompany
- id
- legal_name
- display_name
- aliases[]
- prior_names[]
- legal_entity_identifiers[]
- primary_domain
- headquarters
- sector_ids[]
- stage
- status
- network_os_company_id
- source_of_truth_status
- identity_confidence
- identity_resolution_status
- identity_resolution_notes
- created_at
- updated_at
- archived_at
```

Rules:

- one canonical company record per company;
- aliases do not create duplicate companies;
- affiliated legal entities may remain distinct when economically or legally necessary;
- all opportunities, transactions, positions, diligence, meetings, portfolio records, and reporting evidence point to `canonical_company_id`;
- destructive merge requires human approval and a reversible merge receipt.

### InvestmentOpportunity

```text
InvestmentOpportunity
- id
- canonical_company_id
- opportunity_type: EARLY_STAGE_PRIMARY | FOLLOW_ON | SECONDARY_PURCHASE | SECONDARY_SALE | OTHER
- source_type
- source_record_id
- source_relationship_id
- stage
- round_or_block_size
- target_check_size
- valuation_pre_money
- valuation_post_money
- implied_valuation
- share_class
- price_per_share
- discount_premium
- seller_id
- broker_id
- thesis_fit
- mandate_fit
- evidence_status
- missing_information[]
- primary_risks[]
- next_action
- assigned_human_owner_id
- assigned_ai_employee_ids[]
- staleness_date
- approval_status
- status
- created_at
- updated_at
```

### Transaction

```text
Transaction
- id
- canonical_company_id
- opportunity_id
- transaction_type
- security_type
- share_class
- counterparty_ids[]
- broker_ids[]
- signed_date
- close_date
- gross_amount
- fees
- carry
- net_amount
- shares
- price_per_share
- implied_valuation
- legal_document_ids[]
- approval_ids[]
- status
- source_provenance
- created_at
- updated_at
```

### Position

```text
Position
- id
- canonical_company_id
- fund_entity_id
- security_type
- share_class
- cost_basis
- shares
- current_ownership
- fully_diluted_ownership
- current_mark
- mark_date
- valuation_source
- reserve_assigned
- reserve_consumed
- liquidity_status
- status
```

### OwnershipSnapshot

```text
OwnershipSnapshot
- id
- position_id
- as_of_date
- issued_shares
- fully_diluted_shares
- shares_owned
- current_ownership
- fully_diluted_ownership
- dilution_assumptions
- source_document_ids[]
- confidence
- verification_status
```

### PricingObservation

```text
PricingObservation
- id
- canonical_company_id
- observed_at
- observation_type: BID | ASK | INDICATION | EXECUTED_TRANSACTION | PRIMARY_ROUND | INTERNAL_ESTIMATE
- price_per_share
- implied_valuation
- share_class
- block_size
- seller_type
- buyer_appetite
- fees
- carry
- source_type
- source_id
- relationship_provenance_id
- actual_or_indicated
- confidentiality_classification
- freshness_status
- confidence
- outcome
- restrictions
```

### DiligenceClaim

```text
DiligenceClaim
- id
- canonical_company_id
- opportunity_id
- topic
- normalized_metric
- claim_value
- unit
- period_start
- period_end
- as_of_date
- claim_status: VERIFIED | FOUNDER_STATED | THIRD_PARTY_SOURCED | AI_INFERRED | UNVERIFIED | MISSING
- source_document_id
- source_location
- extraction_method
- confidence
- materiality
- supersedes_claim_id
```

### ContradictionRecord

```text
ContradictionRecord
- id
- canonical_company_id
- opportunity_id
- topic
- claim_ids[]
- contradiction_type: VALUE | PERIOD | DEFINITION | VERSION | SOURCE | OTHER
- summary
- materiality
- confidence
- assigned_owner_id
- required_question
- status: OPEN | INVESTIGATING | RESOLVED | ACCEPTED_RISK | INVALID
- resolution_summary
- resolution_evidence_ids[]
- human_disposition_by
- resolved_at
```

### PortfolioMetricSnapshot

```text
PortfolioMetricSnapshot
- id
- canonical_company_id
- metric_key
- metric_value
- unit
- period_start
- period_end
- as_of_date
- target_value
- source_document_id
- source_type
- confidence
- verification_status
```

### PortfolioAlert

```text
PortfolioAlert
- id
- canonical_company_id
- alert_type
- metric_key
- current_value
- prior_value
- absolute_change
- percentage_change
- target_variance
- trend
- severity
- confidence
- source_ids[]
- recommended_human_action
- assigned_owner_id
- status
- acknowledged_by
- resolved_by
- resolution_notes
```

### SupportRequest

```text
SupportRequest
- id
- canonical_company_id
- request_type
- request_summary
- desired_outcome
- urgency
- requested_by_person_id
- requested_at
- assigned_human_owner_id
- assigned_ai_employee_ids[]
- status
- relationship_risk
- approval_requirement
```

### SupportMatch

```text
SupportMatch
- id
- support_request_id
- person_or_resource_id
- match_reason
- match_score
- relationship_owner_id
- relationship_risk
- ai_recommended
- human_approved
- approved_by
- approved_at
```

### SupportOutcome

```text
SupportOutcome
- id
- support_request_id
- support_match_id
- delivered_at
- response_received
- outcome_type
- outcome_summary
- founder_satisfaction
- value_created
- relationship_impact
- follow_up_required
- evidence_ids[]
- recorded_by
```

### CapitalAllocationOption

```text
CapitalAllocationOption
- id
- canonical_company_id
- opportunity_id
- option_type: SKIP | INITIAL_CHECK | PRO_RATA | SUPER_PRO_RATA | PRIMARY_FOLLOW_ON | SECONDARY_PURCHASE | PARTIAL_SALE | FULL_EXIT | HOLD_RESERVE | HOLD_CASH
- capital_required
- sleeve
- current_ownership
- projected_ownership
- diluted_ownership
- reserve_assigned
- reserve_consumed
- current_valuation
- entry_price
- discount_premium
- base_exit_value
- upside_exit_value
- downside_exit_value
- incremental_moic
- incremental_irr
- liquidity_duration
- concentration_effect
- fund_capacity_effect
- expected_fund_contribution
- opportunity_cost
- assumption_ids[]
- confidence
- status
```

### CrossSleeveComparisonRun

```text
CrossSleeveComparisonRun
- id
- fund_id
- option_ids[]
- fund_model_version
- investment_mandate_version
- sleeve_policy_version
- reserve_policy_version
- scenario_version
- scoring_method
- ranking_output
- constraint_violations[]
- unresolved_assumptions[]
- generated_by_ai_employee_id
- generated_at
- human_review_required: true
- human_decision_id
```

### ReserveAllocation

```text
ReserveAllocation
- id
- fund_id
- canonical_company_id
- position_id
- policy_version
- allocated_amount
- consumed_amount
- remaining_amount
- purpose
- review_date
- approved_by
- approval_id
- status
```

### LPReportingPacket

```text
LPReportingPacket
- id
- fund_id
- reporting_period
- packet_type
- source_snapshot_ids[]
- portfolio_summary
- valuation_commentary
- deployment_summary
- reserve_summary
- concentration_summary
- pipeline_summary
- draft_document_ids[]
- numerical_verification_status
- legal_review_status
- compliance_review_status
- mp_review_status
- distribution_status
- approval_ids[]
```

### FundReconciliationRun

```text
FundReconciliationRun
- id
- fund_id
- period
- internal_source_snapshot_id
- administrator_source_snapshot_id
- accounting_source_snapshot_id
- reconciliation_rules_version
- discrepancy_count
- material_discrepancy_count
- status
- generated_at
- reviewed_by
```

### FundReconciliationException

```text
FundReconciliationException
- id
- reconciliation_run_id
- metric_or_record_type
- internal_value
- external_value
- difference
- source_ids[]
- materiality
- assigned_owner_id
- status
- resolution_summary
- resolution_evidence_ids[]
- authorized_resolution_by
```

### HumanReservedAction

```text
HumanReservedAction
- id
- action_type
- domain
- machine_id
- triggering_work_card_id
- reason_reserved
- required_role
- required_reviewer_ids[]
- source_evidence_ids[]
- ai_recommendation
- status
- decided_by
- decided_at
- decision_rationale
- audit_event_id
```

### FundAIDuty

```text
FundAIDuty
- id
- ai_employee_id
- machine_id
- duty_type
- cadence
- trigger
- allowed_actions[]
- forbidden_actions[]
- required_inputs[]
- required_outputs[]
- evidence_requirements[]
- approval_requirements[]
- cost_class
- observability_profile
- lifecycle_status
```

---

## 24.3 Service Layer

### CompanyIdentityResolver

Responsibilities:

- search CanonicalCompany and Network OS before creating a company;
- compare legal names, aliases, domains, founders, legal identifiers, and provider IDs;
- produce match candidates and confidence;
- distinguish duplicate company from affiliated legal entity;
- require human review for destructive merges;
- preserve merge and split receipts.

### DealIntakeNormalizer

Responsibilities:

- ingest approved source packets;
- extract opportunity fields;
- classify opportunity type;
- resolve company identity;
- identify missing fields;
- create evidence-linked InvestmentOpportunity;
- initiate staleness monitoring;
- draft first diligence request;
- create assigned WorkCard.

### DiligenceReconciliationService

Responsibilities:

- extract normalized claims from approved documents;
- align metrics by definition and period;
- compare values across sources;
- create DiligenceClaim and ContradictionRecord objects;
- detect version and date conflicts;
- generate founder and diligence questions;
- prevent unresolved material contradictions from being hidden in memo prose.

### PortfolioDeltaMonitor

Responsibilities:

- compare current and prior PortfolioMetricSnapshot values;
- calculate absolute change, percentage change, target variance, and trend;
- apply configurable alert rules;
- create PortfolioAlert objects;
- track missing or stale updates;
- prevent automatic external communication.

### PortfolioAlertService

Responsibilities:

- deduplicate alerts;
- group alerts by company and severity;
- route alerts to assigned humans and AI employees;
- create action packets;
- manage acknowledgement and resolution;
- record false-positive and missed-alert feedback.

### SupportMatchService

Responsibilities:

- query Network OS and approved resource registries;
- generate suggested matches;
- show relationship owner and risk;
- block automated introduction sending;
- create human match-approval cards;
- draft introduction text after approval.

### SupportOutcomeService

Responsibilities:

- record delivery and response;
- request outcome feedback;
- calculate time to resolution;
- record founder satisfaction, value created, and relationship impact;
- feed learning and portfolio-support analytics.

### SecondaryBlockDeduplicator

Responsibilities:

- compare issuer, seller, block size, share class, price, fees, broker, and timing;
- identify likely duplicate or related blocks;
- preserve distinct economics and source provenance;
- create relation links instead of unsafe merges;
- flag possible double-counting in pipeline and capital planning.

### PrivateMarketPricingLedger

Responsibilities:

- ingest approved bids, asks, indications, primary rounds, and executed transactions;
- preserve source type, status, date, share class, and restrictions;
- calculate freshness;
- prevent indications from being labeled executed;
- enforce confidentiality and external-use restrictions;
- produce issuer pricing history views.

### CrossSleeveCapitalAllocator

Responsibilities:

- load fund, sleeve, reserve, concentration, and mandate constraints;
- compare CapitalAllocationOption objects;
- calculate configured scenarios;
- show cross-sleeve opportunity cost;
- identify policy violations;
- generate ranked decision support;
- require HumanReservedAction for final decision;
- never mutate capital authority or policy.

### LPReportingDraftService

Responsibilities:

- assemble governed source snapshots;
- draft reporting sections;
- identify missing or unverified numbers;
- attach claim and metric provenance;
- enforce legal, compliance, MP, and numerical review gates;
- block distribution until approvals are complete.

### FundAdminReconciliationService

Responsibilities:

- compare internal records against administrator, accounting, and other authoritative schedules;
- create FundReconciliationException objects;
- preserve both values and sources;
- prevent silent overwrites;
- route material exceptions to authorized humans;
- record resolution evidence and authority.

### HumanAuthorityEnforcer

Responsibilities:

- evaluate proposed actions against the Human Reserved Authority Register;
- create HumanReservedAction records;
- block AI-only completion states;
- require the correct human role;
- prevent vendor, model, workflow, or AI employee outputs from marking reserved actions complete;
- write audit events for attempted boundary violations.

---

## 24.4 Workflow Definitions

### Deal Intake Workflow

```text
Approved source arrives
→ data classification
→ CompanyIdentityResolver
→ DealIntakeNormalizer
→ evidence and missing-field check
→ InvestmentOpportunity created
→ WorkCard assigned
→ first diligence request drafted
→ human review or next approved action
```

### Diligence Reconciliation Workflow

```text
Approved documents ingested
→ claims extracted
→ metrics normalized
→ cross-source comparison
→ contradictions created
→ questions generated
→ owners assigned
→ resolution evidence collected
→ human disposition
→ memo and IC packet updated
```

### Portfolio Monitoring Workflow

```text
Portfolio update arrives or review date triggers
→ metric snapshots created
→ PortfolioDeltaMonitor runs
→ alerts created
→ duplicate/severity grouping
→ human action packet
→ support/follow-on/financing workflow if approved
→ outcome and alert-quality feedback
```

### Portfolio Support Workflow

```text
Support request captured
→ request classified
→ Network OS matching
→ suggested matches
→ human match approval
→ draft introduction/support plan
→ approved delivery
→ response and outcome capture
→ value and relationship impact review
```

### Cross-Sleeve Allocation Workflow

```text
Capital decision trigger
→ eligible options created
→ fund/sleeve/reserve constraints loaded
→ CrossSleeveComparisonRun
→ assumptions and policy violations displayed
→ IC/human reserved approval
→ approved transaction or reserve update
→ audit and learning record
```

### Secondary Normalization Workflow

```text
Broker/source packet arrives
→ company identity resolution
→ secondary terms normalized
→ duplicate-block detection
→ pricing observation created
→ documentation and legal review status
→ diligence and deal math
→ IC/human decision
```

### LP Reporting Workflow

```text
Reporting period closes
→ source snapshots frozen
→ internal/admin/accounting reconciliation
→ discrepancies resolved or disclosed
→ LPReportingDraftService
→ numerical review
→ legal/compliance review
→ MP approval
→ authorized distribution
→ immutable distribution receipt
```

---

## 24.5 Permissions and Authority Matrix

| Action | AI Employee | MP / IC | Counsel | Compliance / Registered Person | Fund Admin / Finance Authority |
|---|---|---|---|---|---|
| Normalize deal | Allowed | Review | — | Review if sensitive | — |
| Draft diligence request | Allowed | Approve/send as required | Review if legal | Review if regulated | — |
| Flag contradiction | Allowed | Resolve/accept risk | Interpret legal issues | Resolve compliance issues | Resolve provider issues |
| Draft investment memo | Allowed | Own final recommendation and decision | Review legal | Review compliance | Review financial source data |
| Calculate scenario | Allowed with trace | Approve assumptions/use | — | Review regulated claims | Verify official numbers |
| Approve investment | Forbidden | Reserved | Advisory | Advisory | Advisory |
| Suggest portfolio support match | Allowed | Approve relationship action | — | Review if sensitive | — |
| Send introduction | Approval-gated | Authorized human | — | Review if required | — |
| Approve follow-on/secondary allocation | Forbidden | Reserved | Legal review | Compliance review | Financial verification |
| Interpret transaction document | Extract/flag only | Decide business terms | Reserved legal interpretation | Review compliance | — |
| Draft LP report | Allowed | Approve | Review | Review | Verify official records |
| Issue capital call/distribution | Forbidden | Approve under authority | Review | Review if required | Execute under official process |
| Change bank/wire instructions | Forbidden | Reserved under controls | Review | Review | Execute under dual control |

---

## 24.6 UI and Navigation Additions

### Fund AI Command Map

Components:

- deal intake queue;
- diligence contradictions;
- upcoming IC decisions;
- portfolio alerts;
- support requests;
- cross-sleeve decisions;
- reserve and sleeve capacity;
- secondary pricing signals;
- LP reporting status;
- fund reconciliation exceptions;
- human-reserved actions;
- AI employee and cost status.

### Canonical Company 360

Tabs:

1. Overview
2. People and Relationships
3. Opportunities
4. Transactions
5. Positions and Ownership
6. Pricing History
7. Diligence and Contradictions
8. IC Decisions
9. Portfolio Metrics and Alerts
10. Support Requests and Outcomes
11. Meetings and Commitments
12. Documents and Evidence
13. LP-Safe Reporting
14. Audit

### Cross-Sleeve Capital Allocation Center

Required views:

- option comparison;
- fund-capacity and sleeve-capacity impact;
- reserve usage;
- ownership and dilution;
- concentration;
- MOIC/IRR scenarios;
- liquidity duration;
- opportunity cost;
- assumption registry;
- policy violations;
- human decision card.

### Portfolio Alert Center

Required views:

- severity;
- metric deltas;
- source freshness;
- confidence;
- recommended human action;
- assigned owner;
- acknowledgement and resolution;
- alert-quality feedback.

### Diligence Contradiction View

Required views:

- conflicting claims side by side;
- source links and locations;
- periods and definitions;
- materiality;
- required question;
- resolution evidence;
- human disposition.

### Secondary Pricing History

Required views:

- bid/ask/indication/executed distinctions;
- timeline;
- share class;
- block size;
- source and relationship provenance;
- restrictions;
- freshness;
- outcome.

### Fund Reconciliation Exceptions

Required views:

- internal value;
- provider/administrator value;
- difference;
- materiality;
- evidence;
- assigned owner;
- resolution state;
- authorized resolution.

### Human Reserved Authority Queue

Required views:

- reserved action type;
- why human authority is required;
- AI recommendation;
- evidence;
- required role;
- approval status;
- decision rationale;
- audit receipt.

---

## 24.7 API and Route Candidates

Candidate routes, subject to Odysseus local audit and framework fit:

```text
POST   /api/fund-ai/intake
GET    /api/companies/{company_id}/360
POST   /api/companies/resolve-identity
POST   /api/diligence/claims/extract
GET    /api/diligence/contradictions
POST   /api/diligence/contradictions/{id}/resolve
POST   /api/portfolio/metrics/ingest
GET    /api/portfolio/alerts
POST   /api/portfolio/alerts/{id}/acknowledge
POST   /api/support/requests
POST   /api/support/requests/{id}/matches
POST   /api/support/matches/{id}/approve
POST   /api/support/outcomes
POST   /api/secondaries/normalize
POST   /api/secondaries/deduplicate
GET    /api/companies/{company_id}/pricing-history
POST   /api/capital-allocation/compare
GET    /api/capital-allocation/runs/{id}
POST   /api/lp-reporting/draft
POST   /api/fund-admin/reconcile
GET    /api/fund-admin/exceptions
GET    /api/human-reserved-actions
POST   /api/human-reserved-actions/{id}/decide
```

All mutating routes require:

- authentication;
- authorization;
- tenant/firm scope;
- data classification;
- idempotency where applicable;
- audit event;
- cost event for AI/provider work;
- evidence linkage;
- human-reserved enforcement.

---

## 24.8 Observability and Evaluation

Every material Fund AI run should record:

- work-card ID;
- company ID;
- opportunity or portfolio record ID;
- AI employee;
- machine;
- capability stack;
- model and provider;
- work-packet version;
- source documents and data snapshots;
- tools used;
- cost;
- latency;
- retries;
- output status;
- contradiction count;
- missing-evidence count;
- human edits;
- approval result;
- final disposition;
- usefulness score;
- false-positive or false-negative feedback.

Golden eval tasks should include:

- deal-card normalization;
- duplicate-company detection;
- diligence contradiction detection;
- memo evidence labeling;
- portfolio delta calculation;
- alert generation;
- support matching without unauthorized sending;
- duplicate secondary-block detection;
- cross-sleeve comparison;
- fund reconciliation discrepancy detection;
- human reserved-action blocking.

---

## 24.9 Security and Data Boundaries

Required controls:

- row-level firm/tenant isolation;
- role-based access;
- legal/compliance data classification;
- MNPI-sensitive routing restrictions;
- provider and model allowlists;
- no credentials or wire instructions in LLM context;
- output quarantine for external models and vendors;
- source-document access logging;
- immutable approval and audit receipts;
- protected pricing and relationship provenance;
- retention/deletion rules;
- no silent memory promotion;
- no silent canonical-company merge;
- no external communication without authority;
- no autonomous capital action.

---

## 24.10 Migration Plan

Subject to the local Odysseus Reality Assessment, migrations should proceed in this order:

1. add CanonicalCompany and identity mapping;
2. link existing company-like records to canonical company IDs;
3. add opportunities and transaction types;
4. migrate portfolio and secondaries references without deleting source provenance;
5. add positions and ownership snapshots;
6. add diligence claims and contradiction records;
7. add portfolio metrics and alerts;
8. add support matches and outcomes;
9. add pricing observations;
10. add capital-allocation options and comparison runs;
11. add LP reporting and reconciliation objects;
12. add human reserved actions and FundAIDuty;
13. backfill audit receipts and unresolved migration exceptions;
14. verify no duplicate canonical company identities were introduced.

No migration may silently merge companies, overwrite official fund records, or discard legacy evidence.

---

## 24.11 Test Requirements

### Identity and Data Integrity

```text
1. A company cannot create duplicate canonical identities across early-stage, follow-on, secondary, portfolio, and LP views.
2. Aliases resolve to the canonical company without destroying source provenance.
3. Affiliated but distinct legal entities can remain separate.
4. A company may have multiple opportunities and transactions.
5. Distinct share classes and block economics are not collapsed.
6. Destructive merge requires human approval and rollback receipt.
```

### Diligence and IC

```text
7. Material cross-document contradictions create ContradictionRecord objects.
8. Contradictions preserve source, period, definition, and materiality.
9. Unresolved material contradictions remain visible in the IC packet.
10. AI cannot mark final investment recommendation as human-approved.
11. AI cannot approve founder character, valuation, or scenario probabilities.
12. Memo claims retain evidence status.
```

### Portfolio Monitoring and Support

```text
13. Portfolio metric ingestion creates dated snapshots.
14. Period-over-period deterioration creates alerts under configured rules.
15. Missing or stale updates create data-quality alerts.
16. Alert deduplication does not hide worsening severity.
17. AI can suggest support matches but cannot send introductions without authority.
18. Support outcomes retain value and relationship-impact fields.
```

### Secondaries and Pricing

```text
19. Duplicate secondary blocks are linked without collapsing distinct fees, share classes, sellers, or terms.
20. Bid, ask, indication, and executed transaction statuses remain distinct.
21. Pricing observations preserve provenance and confidentiality restrictions.
22. AI cannot make final legal interpretation of transaction documents.
```

### Cross-Sleeve Allocation

```text
23. Initial, follow-on, secondary, reserve, and exit options can be compared in one run.
24. Fund and sleeve capacity constraints are applied.
25. Concentration and reserve effects are visible.
26. Assumptions and policy versions are stored.
27. AI cannot approve the capital allocation.
28. Policy changes require governed approval.
```

### LP, Fund Administration, and Authority

```text
29. LP reports cannot distribute without required reviews and approvals.
30. Fund-admin discrepancies create exceptions instead of overwrites.
31. AI cannot issue capital calls, distributions, wires, or bank changes.
32. HumanReservedAction blocks AI-only completion.
33. Legal and compliance review routing remains enforced.
34. Harvey and Norm outputs remain support packets, not final authority.
```

### Observability and Cost

```text
35. Every material AI run creates a trace and cost event.
36. Source documents, work-packet version, model, tools, and output status are traceable.
37. Human edits and approval outcomes feed eval records.
38. Repeated false positives can trigger a capability-improvement proposal but not a silent policy change.
```

---

## 24.12 Acceptance Criteria

The Fund AI implementation is ready for a coding sprint only when:

- canonical company and multi-transaction data relationships are defined;
- source-of-truth and identity-resolution rules are explicit;
- human reserved authority is enforceable;
- separate sleeve underwriting can feed one allocation engine;
- diligence contradictions are first-class records;
- portfolio metric deltas and alerts are first-class records;
- support matching requires human approval before relationship action;
- secondary duplicate-block logic preserves distinct economics;
- private-market pricing observations retain provenance and restrictions;
- LP reporting and fund reconciliation workflows preserve human/provider authority;
- UI surfaces, routes, permissions, observability, migrations, and tests are specified;
- implementation remains blocked on the Odysseus local reality assessment and actual sprint approval.

---

## 24.13 Not Implemented by This Document

This implementation-plan update does not implement or validate:

- Odysseus source changes;
- database migrations;
- APIs;
- UI;
- model routing;
- provider integrations;
- portfolio alert thresholds;
- fund-construction formulas;
- financial return calculations;
- Harvey or Norm access;
- Network OS synchronization;
- fund-administrator integration;
- legal or compliance conclusions;
- production security;
- deployment;
- end-to-end tests.

All remain future implementation and validation work.

