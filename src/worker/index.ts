import type { Env } from "./env";
import { resolveFirmUser } from "./auth";
import { Router, json, type RouteContext } from "./router";
import {
  handleAcceptCandidate,
  handleAddAlias,
  handleCreateCandidate,
  handleCreateCompany,
  handleGetCompany,
  handleListAliases,
  handleListCandidates,
  handleListCompanies,
  handleMergeCompanies,
  handleRejectCandidate,
  handleResolveCompany,
  handleReverseMerge,
  handleUpdateCompany,
} from "./services/companies";
import {
  handleCreateFund,
  handleCreateFundEntity,
  handleCreatePolicyVersion,
  handleGetFund,
  handleGetPolicyVersion,
  handleListFundEntities,
  handleListFunds,
  handleListPolicyVersions,
} from "./services/funds";
import { handleDryRunImport } from "./import/contracts";
import {
  handleArchiveCapture,
  handleCreateCapture,
  handleGetCapture,
  handleListCaptures,
  handleRouteCapture,
} from "./services/captures";
import {
  handleCreateWorkCard,
  handleGetWorkCard,
  handleListWorkCards,
  handleUpdateWorkCard,
} from "./services/workCards";
import {
  handleCreateApproval,
  handleDecideApproval,
  handleGetApproval,
  handleListApprovals,
  handleSubmitApproval,
} from "./services/approvals";
import { handleListActivity } from "./services/activity";
import { handleCreateGovernanceUpdate, handleListGovernanceUpdates } from "./services/governance";
import { handleApprovalVolume } from "./services/diagnostics";
import { handleListDomains, handleListMachines } from "./services/registry";
import {
  handleCreateEffectRequest,
  handleExecuteEffectRequest,
  handleListEffectRequests,
} from "./services/effects";
import { handleAcceptAiOutput, handleGetAiRun, handleListAiRuns, handleRunAi } from "./services/aiRuns";
import {
  handleActivateAiEmployee,
  handleGetAiEmployee,
  handleGrantToolScope,
  handleListAiEmployees,
  handleRequestActivation,
} from "./services/aiEmployees";
import {
  handleGetAiBudget,
  handleListAiProviders,
  handleProviderEnable,
  handleProviderKillSwitch,
  handleUpdateAiBudget,
} from "./services/aiGovernance";
import {
  handleAddDocumentVersion,
  handleDownloadDocument,
  handleGetDocument,
  handleListDocuments,
  handleUploadDocument,
} from "./services/documents";
import {
  handleAcceptClaim,
  handleApplyKnowledge,
  handleContradictionCandidates,
  handleCreateClaim,
  handleCreateContradiction,
  handleCreateSourceConflict,
  handleEvidenceSummary,
  handleExtractClaims,
  handleGetClaim,
  handleGetContradiction,
  handleGetKnowledgeRecord,
  handleGetSourceConflict,
  handleInvestigateContradiction,
  handleListClaims,
  handleListContradictions,
  handleListKnowledgeCandidates,
  handleListKnowledgeRecords,
  handleListSourceConflicts,
  handleProposeKnowledge,
  handleRejectKnowledge,
  handleResolveContradiction,
  handleResolveSourceConflict,
  handleSupersedeClaim,
  handleVerifyClaim,
} from "./services/evidence";
import {
  handleAddTransactionParty,
  handleCalculateDealMath,
  handleCompany360,
  handleCreateBlockLink,
  handleCreateDealMathPacket,
  handleCreateOpportunity,
  handleCreateOwnershipSnapshot,
  handleCreatePricingObservation,
  handleCreateSecurityClass,
  handleCreateTransaction,
  handleDecideBlockLink,
  handleExecuteTransaction,
  handleGetDealMathPacket,
  handleGetOpportunity,
  handleGetTransaction,
  handleListBlockLinks,
  handleListOpportunities,
  handleListOwnershipSnapshots,
  handleListPositions,
  handleListPricingObservations,
  handleListSecurityClasses,
  handleListTransactions,
  handleReviewDealMathPacket,
  handleScanBlockLinks,
  handleSubmitTransaction,
  handleTransitionOpportunity,
  handleUpdateDealMathPacket,
  handleUpdateOpportunity,
  handleVoidTransaction,
} from "./services/investment";
import {
  handleAccessLedger,
  handleCreateArtifact,
  handleCreateDiligenceRequest,
  handleCreateLpOpportunity,
  handleCreateLpRecord,
  handleDraftLpClaim,
  handleGetLpClaim,
  handleGetLpRecord,
  handleGrantAccess,
  handleLinkEvidence,
  handleListArtifacts,
  handleListLpClaims,
  handleListLpRecords,
  handlePublishLpClaim,
  handleRejectLpClaim,
  handleRespondDiligenceRequest,
  handleRevokeAccess,
  handleSubmitLpClaim,
  handleTransitionLpOpportunity,
} from "./services/lp";
import {
  handleAddAssumption,
  handleCreateFollowOnReview,
  handleCreateOption,
  handleCreateScenario,
  handleDecideOption,
  handleGetComparisonRun,
  handleGetScenario,
  handleListReserveAllocations,
  handleListScenarios,
  handleRequestOptionApproval,
  handleReviewFollowOn,
  handleRunComparison,
} from "./services/allocation";
import {
  handleCreatePacket,
  handleCreatePeriod,
  handleDistributePacket,
  handleGetPacket,
  handleListExceptions,
  handleListPackets,
  handleListPeriods,
  handleListReconciliationRuns,
  handleRecordReview,
  handleResolveException,
  handleRunReconciliation,
  handleSubmitPacket,
} from "./services/reporting";
import {
  handleDeclareContract,
  handleGetContract,
  handleListConflicts,
  handleListMappings,
  handleListSyncState,
  handlePullResource,
  handleResolveConflict,
  handleWriteBack,
} from "./services/networkAdapter";
import {
  handleAlertVolume,
  handleCreateMetricDefinition,
  handleCreateMetricSnapshot,
  handleCreatePortfolioUpdate,
  handleCreateSupportRequest,
  handleCreateSuppressionRule,
  handleDecideAlert,
  handleDecideSupportMatch,
  handleEvaluateAlerts,
  handleGetSupportRequest,
  handleListAlerts,
  handleListMetricDefinitions,
  handleListMetricSnapshots,
  handleListSupportRequests,
  handleProposeSupportMatch,
  handleRecordSupportOutcome,
} from "./services/portfolio";
import {
  handleActivateRecordingPolicy,
  handleAddNote,
  handleAddParticipant,
  handleAssemblePrepPacket,
  handleConvertCommitment,
  handleCreateCommitment,
  handleCreateDebrief,
  handleCreateMeeting,
  handleGetMeeting,
  handleImportTranscript,
  handleListMeetings,
  handlePromoteToClaim,
  handleRecordConsent,
  handleTransitionMeeting,
} from "./services/meetings";
import {
  handleAssembleIcPacket,
  handleGetIcPacket,
  handleListIcPackets,
  handleRecordDissent,
  handleRecordIcDecision,
  handleSubmitIcPacket,
} from "./services/ic";

/**
 * West Peek OS Worker API — P1 runtime/persistence/auth/delivery.
 * `/api/*` is handled here; everything else is delegated to the static SPA assets.
 * Every /api/* route except /api/health requires an authenticated FirmUser (ADR-006).
 */

async function handleHealth(ctx: RouteContext): Promise<Response> {
  const { env } = ctx;

  let d1: { reachable: boolean; schemaVersion: string | null; error?: string } = {
    reachable: false,
    schemaVersion: null,
  };
  try {
    const row = await env.WP_OS_DB.prepare(
      "SELECT migration FROM schema_version ORDER BY migration DESC LIMIT 1",
    ).first<{ migration: string }>();
    d1 = { reachable: true, schemaVersion: row?.migration ?? null };
  } catch (err) {
    d1 = { reachable: false, schemaVersion: null, error: err instanceof Error ? err.message : String(err) };
  }

  return json({
    ok: d1.reachable,
    env: env.WP_OS_ENV,
    d1,
    bindings: {
      WP_OS_DB: typeof env.WP_OS_DB !== "undefined",
      WP_OS_DOCUMENTS: typeof env.WP_OS_DOCUMENTS !== "undefined",
      WP_OS_KV: typeof env.WP_OS_KV !== "undefined",
      ASSETS: typeof env.ASSETS !== "undefined",
    },
  });
}

function handleMe(ctx: RouteContext): Response {
  const identity = ctx.identity!;
  return json({
    id: identity.id,
    email: identity.email,
    fullName: identity.fullName,
    status: identity.status,
    roles: identity.roles,
    authorityScopes: identity.authorityScopes,
  });
}

const router = new Router()
  .get("/api/health", handleHealth, { auth: false })
  .get("/api/me", handleMe)
  // P2 — canonical identity (D3). Literal routes before `:id` parameter routes.
  .post("/api/companies", handleCreateCompany)
  .get("/api/companies", handleListCompanies)
  .get("/api/companies/resolve", handleResolveCompany)
  .get("/api/companies/:id", handleGetCompany)
  .patch("/api/companies/:id", handleUpdateCompany)
  .post("/api/companies/:id/aliases", handleAddAlias)
  .get("/api/companies/:id/aliases", handleListAliases)
  .post("/api/companies/:sourceId/merge-into/:targetId", handleMergeCompanies)
  .post("/api/identity/candidates", handleCreateCandidate)
  .get("/api/identity/candidates", handleListCandidates)
  .post("/api/identity/candidates/:id/accept", handleAcceptCandidate)
  .post("/api/identity/candidates/:id/reject", handleRejectCandidate)
  .post("/api/identity/merges/:receiptId/reverse", handleReverseMerge)
  // P2 — fund + policy substrate (policy versions are immutable by trigger).
  .post("/api/funds", handleCreateFund)
  .get("/api/funds", handleListFunds)
  .get("/api/funds/:id", handleGetFund)
  .post("/api/funds/:id/entities", handleCreateFundEntity)
  .get("/api/funds/:id/entities", handleListFundEntities)
  .post("/api/funds/:id/policies/:kind", handleCreatePolicyVersion)
  .get("/api/funds/:id/policies/:kind", handleListPolicyVersions)
  .get("/api/funds/:id/policies/:kind/:versionNo", handleGetPolicyVersion)
  // P2 — import contracts: DRY-RUN only, persists nothing.
  .post("/api/import/dry-run", handleDryRunImport)
  // P3 — capture intake (+Capture) → routing.
  .post("/api/captures", handleCreateCapture)
  .get("/api/captures", handleListCaptures)
  .get("/api/captures/:id", handleGetCapture)
  .post("/api/captures/:id/route", handleRouteCapture)
  .post("/api/captures/:id/archive", handleArchiveCapture)
  // P3 — work spine.
  .post("/api/work-cards", handleCreateWorkCard)
  .get("/api/work-cards", handleListWorkCards)
  .get("/api/work-cards/:id", handleGetWorkCard)
  .patch("/api/work-cards/:id", handleUpdateWorkCard)
  // P3 — approval center (state machine enforced in services/approvals.ts).
  .post("/api/approvals", handleCreateApproval)
  .get("/api/approvals", handleListApprovals)
  .get("/api/approvals/:id", handleGetApproval)
  .post("/api/approvals/:id/submit", handleSubmitApproval)
  .post("/api/approvals/:id/decide", handleDecideApproval)
  // P3 — external effects (execution ONLY via effects/executor.ts + receipt).
  .post("/api/effects/requests", handleCreateEffectRequest)
  .get("/api/effects/requests", handleListEffectRequests)
  .post("/api/effects/requests/:id/execute", handleExecuteEffectRequest)
  // P3 — activity feed over the one event spine (D15).
  .get("/api/activity", handleListActivity)
  // P3 — governance updates (MP-issued).
  .post("/api/governance/updates", handleCreateGovernanceUpdate)
  .get("/api/governance/updates", handleListGovernanceUpdates)
  // P3 — diagnostics (observational only, D7).
  .get("/api/diagnostics/approval-volume", handleApprovalVolume)
  // P3 — registry reference data (read-only).
  .get("/api/machines", handleListMachines)
  .get("/api/domains", handleListDomains)
  // P4 — governed AI boundary (run_ai). Literal routes before `:id` parameter routes.
  .post("/api/ai/run", handleRunAi)
  .get("/api/ai/runs", handleListAiRuns)
  .get("/api/ai/runs/:id", handleGetAiRun)
  .post("/api/ai/runs/:id/accept-output", handleAcceptAiOutput)
  // P4 — AI employee lifecycle (no direct status route; activation via approval receipt only).
  .get("/api/ai/employees", handleListAiEmployees)
  .get("/api/ai/employees/:id", handleGetAiEmployee)
  .post("/api/ai/employees/:id/request-activation", handleRequestActivation)
  .post("/api/ai/employees/:id/activate", handleActivateAiEmployee)
  .post("/api/ai/employees/:id/tools", handleGrantToolScope)
  // P4 — provider registry governance (reserved governance.policy_change + receipt).
  .get("/api/ai/providers", handleListAiProviders)
  .post("/api/ai/providers/:key/kill-switch", handleProviderKillSwitch)
  .post("/api/ai/providers/:key/enable", handleProviderEnable)
  // P4 — firmwide budget/privacy policy (versioned; change via approval receipt).
  .get("/api/ai/budget", handleGetAiBudget)
  .post("/api/ai/budget", handleUpdateAiBudget)
  // P5 — documents (R2 binary + D1 metadata/provenance; D16).
  .post("/api/documents", handleUploadDocument)
  .get("/api/documents", handleListDocuments)
  .get("/api/documents/:id", handleGetDocument)
  .post("/api/documents/:id/versions", handleAddDocumentVersion)
  .get("/api/documents/:id/download", handleDownloadDocument)
  // P5 — diligence claims (ADR-004 enum; self-promotion ban enforced in the service).
  .post("/api/claims", handleCreateClaim)
  .get("/api/claims", handleListClaims)
  .post("/api/claims/extract", handleExtractClaims)
  .get("/api/claims/:id", handleGetClaim)
  .post("/api/claims/:id/verify", handleVerifyClaim)
  .post("/api/claims/:id/accept", handleAcceptClaim)
  .post("/api/claims/:id/supersede", handleSupersedeClaim)
  // P5 — contradictions (AI may propose; humans investigate/resolve).
  .post("/api/contradictions", handleCreateContradiction)
  .get("/api/contradictions", handleListContradictions)
  .get("/api/contradictions/:id", handleGetContradiction)
  .post("/api/contradictions/:id/investigate", handleInvestigateContradiction)
  .post("/api/contradictions/:id/resolve", handleResolveContradiction)
  // P5 — company evidence surface (the P6 IC hook; material contradictions un-hidable).
  .get("/api/companies/:id/evidence-summary", handleEvidenceSummary)
  .get("/api/companies/:id/contradiction-candidates", handleContradictionCandidates)
  // P5 — knowledge promotion (candidate → approval card → receipted apply).
  .post("/api/knowledge/promotion-candidates", handleProposeKnowledge)
  .get("/api/knowledge/promotion-candidates", handleListKnowledgeCandidates)
  .post("/api/knowledge/promotion-candidates/:id/apply", handleApplyKnowledge)
  .post("/api/knowledge/promotion-candidates/:id/reject", handleRejectKnowledge)
  .get("/api/knowledge/records", handleListKnowledgeRecords)
  .get("/api/knowledge/records/:id", handleGetKnowledgeRecord)
  // P5 — source-of-truth conflicts (resolution decisions append-only).
  .post("/api/source-conflicts", handleCreateSourceConflict)
  .get("/api/source-conflicts", handleListSourceConflicts)
  .get("/api/source-conflicts/:id", handleGetSourceConflict)
  .post("/api/source-conflicts/:id/resolve", handleResolveSourceConflict)
  // P6 — security classes (share classes stay distinct; never merged).
  .post("/api/security-classes", handleCreateSecurityClass)
  .get("/api/security-classes", handleListSecurityClasses)
  // P6 — investment opportunities (secondaries keep seller/broker/class provenance).
  .post("/api/opportunities", handleCreateOpportunity)
  .get("/api/opportunities", handleListOpportunities)
  .get("/api/opportunities/:id", handleGetOpportunity)
  .patch("/api/opportunities/:id", handleUpdateOpportunity)
  .post("/api/opportunities/:id/transition", handleTransitionOpportunity)
  // P6 — duplicate/related blocks are LINKED, never merged.
  .post("/api/opportunities/:id/block-links/scan", handleScanBlockLinks)
  .post("/api/opportunities/:id/block-links", handleCreateBlockLink)
  .get("/api/block-links", handleListBlockLinks)
  .post("/api/block-links/:id/decide", handleDecideBlockLink)
  // P6 — deal math (manual entry always available; CALCULATED uses verified formulas only).
  .post("/api/opportunities/:id/deal-math", handleCreateDealMathPacket)
  .post("/api/opportunities/:id/deal-math/calculate", handleCalculateDealMath)
  .get("/api/deal-math-packets/:id", handleGetDealMathPacket)
  .patch("/api/deal-math-packets/:id", handleUpdateDealMathPacket)
  .post("/api/deal-math-packets/:id/review", handleReviewDealMathPacket)
  // P6 — transactions (execute/void only behind the type-specific reserved receipt).
  .post("/api/transactions", handleCreateTransaction)
  .get("/api/transactions", handleListTransactions)
  .get("/api/transactions/:id", handleGetTransaction)
  .post("/api/transactions/:id/parties", handleAddTransactionParty)
  .post("/api/transactions/:id/submit", handleSubmitTransaction)
  .post("/api/transactions/:id/execute", handleExecuteTransaction)
  .post("/api/transactions/:id/void", handleVoidTransaction)
  // P6 — positions, ownership snapshots, pricing observations (statuses stay distinct).
  .get("/api/positions", handleListPositions)
  .post("/api/ownership-snapshots", handleCreateOwnershipSnapshot)
  .get("/api/ownership-snapshots", handleListOwnershipSnapshots)
  .post("/api/pricing-observations", handleCreatePricingObservation)
  .get("/api/pricing-observations", handleListPricingObservations)
  // P6 — IC packets/decisions/dissent (AI drafts; humans decide).
  .post("/api/ic/packets", handleAssembleIcPacket)
  .get("/api/ic/packets", handleListIcPackets)
  .get("/api/ic/packets/:id", handleGetIcPacket)
  .post("/api/ic/packets/:id/submit", handleSubmitIcPacket)
  .post("/api/ic/packets/:id/decide", handleRecordIcDecision)
  .post("/api/ic/decisions/:id/dissent", handleRecordDissent)
  // P6 — company 360 over the one canonical identity (D3).
  .get("/api/companies/:id/360", handleCompany360)
  // P7 — meetings: a conversation is never institutional truth.
  .post("/api/meetings", handleCreateMeeting)
  .get("/api/meetings", handleListMeetings)
  .get("/api/meetings/:id", handleGetMeeting)
  .post("/api/meetings/:id/transition", handleTransitionMeeting)
  .post("/api/meetings/:id/participants", handleAddParticipant)
  // P7 — consent (append-only) and the MP/compliance-reserved recording gate.
  .post("/api/meetings/:id/consent", handleRecordConsent)
  .post("/api/meetings/:id/recording-policy", handleActivateRecordingPolicy)
  .post("/api/meetings/:id/prep", handleAssemblePrepPacket)
  .post("/api/meetings/:id/transcript", handleImportTranscript)
  .post("/api/meetings/:id/notes", handleAddNote)
  .post("/api/meetings/:id/commitments", handleCreateCommitment)
  .post("/api/meeting-commitments/:id/convert", handleConvertCommitment)
  .post("/api/meetings/:id/debriefs", handleCreateDebrief)
  .post("/api/meetings/:id/claim-candidates", handlePromoteToClaim)
  // P8 — portfolio monitoring: dated metrics, deterministic alerts, support.
  .post("/api/portfolio/metric-definitions", handleCreateMetricDefinition)
  .get("/api/portfolio/metric-definitions", handleListMetricDefinitions)
  .post("/api/portfolio/updates", handleCreatePortfolioUpdate)
  .post("/api/portfolio/snapshots", handleCreateMetricSnapshot)
  .get("/api/portfolio/snapshots", handleListMetricSnapshots)
  .post("/api/portfolio/companies/:id/evaluate", handleEvaluateAlerts)
  .get("/api/portfolio/alerts", handleListAlerts)
  .post("/api/portfolio/alerts/:id/decide", handleDecideAlert)
  .post("/api/portfolio/suppression-rules", handleCreateSuppressionRule)
  // P8 — support: AI may propose a match; acting on it is MP-reserved.
  .post("/api/support/requests", handleCreateSupportRequest)
  .get("/api/support/requests", handleListSupportRequests)
  .get("/api/support/requests/:id", handleGetSupportRequest)
  .post("/api/support/requests/:id/matches", handleProposeSupportMatch)
  .post("/api/support/requests/:id/outcomes", handleRecordSupportOutcome)
  .post("/api/support/matches/:id/decide", handleDecideSupportMatch)
  // P8 — observed alert volume (counts only; no alert-quality claim).
  .get("/api/diagnostics/alert-volume", handleAlertVolume)
  // P9 — Network OS integration (D5). No client is configured: live calls fail closed.
  .post("/api/network/contract", handleDeclareContract)
  .get("/api/network/contract", handleGetContract)
  .post("/api/network/pull/:resource", handlePullResource)
  .get("/api/network/sync-state", handleListSyncState)
  .get("/api/network/mappings", handleListMappings)
  .get("/api/network/conflicts", handleListConflicts)
  .post("/api/network/conflicts/:id/resolve", handleResolveConflict)
  .post("/api/network/writeback", handleWriteBack)
  // P10 — LP / fundraising. LP data is LP_PRIVATE by default.
  .post("/api/lp/records", handleCreateLpRecord)
  .get("/api/lp/records", handleListLpRecords)
  .get("/api/lp/records/:id", handleGetLpRecord)
  .post("/api/lp/opportunities", handleCreateLpOpportunity)
  .post("/api/lp/opportunities/:id/transition", handleTransitionLpOpportunity)
  .post("/api/lp/opportunities/:id/diligence-requests", handleCreateDiligenceRequest)
  .post("/api/lp/diligence-requests/:id/respond", handleRespondDiligenceRequest)
  // P10 — LP claims: evidence-backed or unpublishable.
  .post("/api/lp/claims", handleDraftLpClaim)
  .get("/api/lp/claims", handleListLpClaims)
  .get("/api/lp/claims/:id", handleGetLpClaim)
  .post("/api/lp/claims/:id/evidence", handleLinkEvidence)
  .post("/api/lp/claims/:id/submit", handleSubmitLpClaim)
  .post("/api/lp/claims/:id/reject", handleRejectLpClaim)
  .post("/api/lp/claims/:id/publish", handlePublishLpClaim)
  // P10 — data room: the EXTERNAL room's governed access ledger.
  .post("/api/lp/data-room/artifacts", handleCreateArtifact)
  .get("/api/lp/data-room/artifacts", handleListArtifacts)
  .post("/api/lp/data-room/access", handleGrantAccess)
  .get("/api/lp/data-room/access", handleAccessLedger)
  .post("/api/lp/data-room/access/:id/revoke", handleRevokeAccess)
  // P11 — fund construction / cross-sleeve allocation. Comparison computes; humans decide.
  .post("/api/allocation/scenarios", handleCreateScenario)
  .get("/api/allocation/scenarios", handleListScenarios)
  .get("/api/allocation/scenarios/:id", handleGetScenario)
  .post("/api/allocation/scenarios/:id/assumptions", handleAddAssumption)
  .post("/api/allocation/scenarios/:id/options", handleCreateOption)
  .post("/api/allocation/scenarios/:id/compare", handleRunComparison)
  .get("/api/allocation/runs/:id", handleGetComparisonRun)
  .post("/api/allocation/options/:id/request-approval", handleRequestOptionApproval)
  .post("/api/allocation/options/:id/decide", handleDecideOption)
  .get("/api/allocation/reserve-allocations", handleListReserveAllocations)
  .post("/api/allocation/scenarios/:id/follow-on-reviews", handleCreateFollowOnReview)
  .post("/api/allocation/follow-on-reviews/:id/review", handleReviewFollowOn)
  // P12 — LP reporting: reviews gate distribution; the packet is LP_PRIVATE.
  .post("/api/reporting/periods", handleCreatePeriod)
  .get("/api/reporting/periods", handleListPeriods)
  .post("/api/reporting/periods/:id/packets", handleCreatePacket)
  .get("/api/reporting/packets", handleListPackets)
  .get("/api/reporting/packets/:id", handleGetPacket)
  .post("/api/reporting/packets/:id/submit", handleSubmitPacket)
  .post("/api/reporting/packets/:id/reviews", handleRecordReview)
  .post("/api/reporting/packets/:id/distribute", handleDistributePacket)
  // P12 — fund-admin reconciliation: read-only import, exceptions, human disposition.
  .post("/api/reconciliation/runs", handleRunReconciliation)
  .get("/api/reconciliation/runs", handleListReconciliationRuns)
  .get("/api/reconciliation/exceptions", handleListExceptions)
  .post("/api/reconciliation/exceptions/:id/resolve", handleResolveException);

/**
 * Pure request handler — exported so tests can exercise it directly with a
 * miniflare-backed Env, without standing up a server.
 */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (!url.pathname.startsWith("/api/")) {
    if (typeof env.ASSETS === "undefined") {
      return json({ error: "assets binding unavailable" }, { status: 503 });
    }
    return env.ASSETS.fetch(request);
  }

  const matched = router.match(request.method, url.pathname);
  if (!matched) {
    // Unknown /api/* paths still require identity before revealing anything: fail closed.
    const identity = await resolveFirmUser(request, env);
    if (!identity) return json({ error: "unauthenticated" }, { status: 401 });
    return json({ error: "not_found", path: url.pathname }, { status: 404 });
  }

  let identity: RouteContext["identity"] = null;
  if (matched.route.auth) {
    identity = await resolveFirmUser(request, env);
    if (!identity) return json({ error: "unauthenticated" }, { status: 401 });
  }

  return matched.route.handler({ request, env, identity, params: matched.params });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      // Fail closed, no internals leaked.
      console.error("worker error", err);
      return json({ error: "internal_error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
