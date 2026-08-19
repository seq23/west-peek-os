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
  handleCompanyRegister,
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
import { handlePartnerConnections } from "./services/connectors";
import {
  handleArchiveCapture,
  handleCreateCapture,
  handleGetCapture,
  handleListCaptures,
  handleRouteCapture,
  handleResolveCapture,
  handleUnresolvedPeople,
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
  handleAddApprovalComment,
  handleAddApprovalEvidence,
  handleApprovalContext,
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
  handleAskLiveHelp,
  handleGetLiveHelp,
  handleReleaseEmployee,
  handleSeatEmployee,
  handleRestoreAiAccess,
  handleRevokeAiAccess,
} from "./services/liveHelp";
import { handleGetCloseout, handleRunCloseout } from "./services/meetingDelegation";
import {
  handleAddAttendee,
  handleCreateEvent,
  handleGetEvent,
  handleListEvents,
  handleSetEventStatus,
} from "./services/eventOs";
import {
  handleDecidePacket, handleGeneratePacket,
  handleGetPacket as handleGetRoomPacket,
  handleListPackets as handleListRoomPackets,
  handleScheduleRoom, handleVerifyVenue,
} from "./services/roomPacket";
import {
  handleAdvanceSponsor, handleCreateSponsor, handleListSponsors, handleSponsorAttendeeExport,
  handleSponsorRecap,
} from "./services/sponsors";
import {
  handleDecideCouncil,
  handleListMembers as handleListCommunityMembers,
  handleMemberEvidence, handleRecordAct, handleRetractAct,
} from "./services/communityActs";
import {
  handleDecideMatch, handleListMatches, handleListPeople, handleListSignals, handleMatchConnected,
  handleMatchConsent, handleRecordSignal, handleRetireSignal, handleRunMatching,
} from "./services/matching";
import { handleGetRoomCloseout, handleRunRoomCloseout } from "./services/roomCloseout";
import { handleUpsertMember } from "./services/communityOs";
import {
  handleAddFollowup,
  handleGetDiligence,
  handleGetIcAudit,
  handleListFollowups,
  handleSaveDiligence,
  handleSetupPacket,
  handleGetIcRecords,
} from "./services/icPortal";
import { handleEvidenceLedger, handleListDecisions, handleWorkQueues } from "./services/ledgers";
import { handleCompanyIntelligence, handleFollowOnCentre, handleSecondaries } from "./services/companyIntel";
import { handleGenerateWeeklyReview, handleGetWeeklyReview, handleSetItemExit } from "./services/weeklyReview";
import { handleIngestTranscript } from "./services/captureAdapter";
import { handleGenerateDailyReport, handleGetDailyReport } from "./services/dailyIntelligence";
import { handleBuildPacket, handleExportPacket } from "./services/researchPacket";
import { handleBuildMap, handleGetMap, handleListMaps } from "./services/marketMap";
import {
  handleApproveBrowserTask, handleListBrowserTasks, handleRequestBrowserTask, handleRunBrowserTask,
} from "./services/browserTask";
import {
  handleGetSession as handleGetUniversitySession,
  handleListDiary,
  handleListSessions as handleListUniversitySessions,
  handleReply as handleUniversityReply,
  handleSaveDiary,
  handleStartSession as handleStartUniversitySession,
} from "./services/university";
import {
  handleDetect as handleCrossOfficeDetect,
  handleListConflicts as handleListCrossOfficeConflicts,
  handleResolveConflict as handleResolveCrossOfficeConflict,
} from "./services/crossOffice";
import {
  handleActivateAiEmployee,
  handleGetAiEmployee,
  handleGrantToolScope,
  handleListAiEmployees,
  handleSetEmployeeRunning,
  handleDutyRoster,
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
  handleBackfillOpportunity,
  handleConfirmPlaceholders,
  handleDealflowBoard,
  handlePortfolioComposition,
  handleUpdateDealMathPacket,
  handleUpdateOpportunity,
  handleVoidTransaction,
  handleDealProvenance,
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
import {
  handleAddWatchlist,
  handleArchiveItem,
  handleGetBriefing,
  handleGetItem,
  handleGetPreferences,
  handleItemFeedback,
  handleListBriefings,
  handleListItems,
  handleListRuns,
  handleListSources,
  handleListWatchlist,
  handleRegisterSource,
  handleRunIntelligence,
  handleSetPreferences,
  handleSetWatchlistActive,
  handleSynthesizeItem,
  handleUpdateSource,
} from "./services/intelligence";
import { handleMarkHomeSeen, handleMpHome } from "./services/mpHome";
import {
  handleAcknowledgeGovernance,
  handleAssignMachine,
  handleChangeLifecycle,
  handleComputeScorecard,
  handleCreateMemo,
  handleDecideHandoff,
  handleEmployeeDetail,
  handleGetRoom,
  handleListHandoffs,
  handleListMemos,
  handleListRooms,
  handleLounge,
  handlePostRoomMessage,
  handleProposeHandoff,
  handleRecordReview as handleRecordEmployeeReview,
  handleUpdateProfile,
} from "./services/workforce";
import {
  handleGetRunRouting,
  handleListRoutingPolicies,
  handlePromoteModel,
  handleProviderCatalog,
  handleProviderHealthCheck,
  handleRecordEvaluation,
  handleRegisterModel,
  handleSetMachineModelPolicy,
  handleSetRoutingPolicy,
} from "./services/providerRouter";
import {
  handleAppendMemory,
  handleConfigureMachine,
  handleDeclareDependency,
  handleGetMachine,
  handleMachineControlCenter,
  handlePauseMachine,
} from "./services/machines";
import { handleAllocationStrategyView, handlePortfolioCockpit } from "./services/cockpit";
import { handleCheckConnector, handleListConnectors, handleMeetingPrepQueue } from "./services/connectors";
import { handleAcceptEngagement, handleListEngagements, handleOpenEngagement } from "./services/specialist";
import {
  handleLpOpsOverview,
  handleRegisterAdminSource,
  handleSetReconciliationSchedule,
  handleUpdateLpEngagement,
} from "./services/lpOps";
import {
  handleAddQuestion,
  handleAddSource,
  handleAnswerQuestion,
  handleAssemblePacket,
  handleCreateMarketMap,
  handleCreateProject,
  handleGetProject,
  handleListProjects,
  handlePromoteFinding,
  handleRecordFinding,
} from "./services/research";
import {
  handleAckNotification,
  handleGetNotificationPreferences,
  handleListNotifications,
  handleNotificationDeliveries,
  handleReadNotification,
  handleSetNotificationPreferences,
} from "./services/notifications";
import {
  handleCancelJobRun,
  handleCreateJob,
  handleGetJobRun,
  handleListJobs,
  handlePauseJob,
  handleRunDueJobs,
  handleRunJob,
  runDueJobs,
} from "./services/jobs";
import {
  handleCreatePacket as handleCreateWorkPacket,
  handleExecutePacket,
  handleGetPacket as handleGetWorkPacket,
  handleLensBench,
  handleListPackets as handleListWorkPackets,
  handleRunLens,
  handleUpdatePacket,
} from "./services/workPackets";
import {
  handleAssignCapability,
  handleBuildVsBuy,
  handleListCapabilities,
  handleRecordAfterAction,
  handleRegisterCapability,
  handleTransitionCapability,
} from "./services/capabilities";
import {
  handleAcknowledgeCostAlert,
  handleCostOverview,
  handleListBudgetScopes,
  handleSetBudgetScope,
} from "./services/costCenter";
import {
  handleCreatePersonalEntry,
  handleGetPersonalProfile,
  handleListPersonalEntries,
  handleSetPersonalProfile,
} from "./services/personalIntelligence";

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
  .get("/api/companies/register", handleCompanyRegister)
  .get("/api/me/connections", handlePartnerConnections)
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
  // Literal before the :param that would otherwise swallow it — "unresolved-people" is a
  // perfectly good capture id as far as the router is concerned (README, "Adding a feature" §4).
  .get("/api/captures/unresolved-people", handleUnresolvedPeople)
  .get("/api/captures/:id", handleGetCapture)
  .post("/api/captures/:id/route", handleRouteCapture)
  .post("/api/captures/:id/resolve", handleResolveCapture)
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
  .get("/api/ai/employees/on-duty", handleDutyRoster)
  .get("/api/ai/employees", handleListAiEmployees)
  .get("/api/ai/employees/:id", handleGetAiEmployee)
  .post("/api/ai/employees/:id/request-activation", handleRequestActivation)
  .post("/api/ai/employees/:id/activate", handleActivateAiEmployee)
  .post("/api/ai/employees/:id/running", handleSetEmployeeRunning)
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
  .get("/api/dealflow/board", handleDealflowBoard)
  .get("/api/portfolio/composition", handlePortfolioComposition)
  .post("/api/opportunities", handleCreateOpportunity)
  .get("/api/opportunities", handleListOpportunities)
  // P51 — where deals come from, and which ones nobody recorded.
  .get("/api/opportunities/provenance", handleDealProvenance)
  .get("/api/opportunities/:id", handleGetOpportunity)
  .patch("/api/opportunities/:id", handleUpdateOpportunity)
  .post("/api/opportunities/:id/transition", handleTransitionOpportunity)
  .post("/api/opportunities/:id/backfill", handleBackfillOpportunity)
  .post("/api/opportunities/:id/placeholders", handleConfirmPlaceholders)
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
  .get("/api/meetings/:id/live-help", handleGetLiveHelp)
  .post("/api/meetings/:id/live-help", handleAskLiveHelp)
  .post("/api/meetings/:id/employees", handleSeatEmployee)
  .post("/api/meetings/:id/employees/release", handleReleaseEmployee)
  .post("/api/meetings/:id/ai-access/revoke", handleRevokeAiAccess)
  .post("/api/meetings/:id/ai-access/restore", handleRestoreAiAccess)
  .post("/api/meetings/:id/participants", handleAddParticipant)
  // P7 — consent (append-only) and the MP/compliance-reserved recording gate.
  .post("/api/meetings/:id/consent", handleRecordConsent)
  .post("/api/meetings/:id/recording-policy", handleActivateRecordingPolicy)
  .post("/api/meetings/:id/prep", handleAssemblePrepPacket)
  .get("/api/meetings/:id/closeout", handleGetCloseout)
  .post("/api/meetings/:id/closeout", handleRunCloseout)
  // P33 — Event OS / Community OS scaffolding.
  .get("/api/events", handleListEvents)
  .post("/api/events", handleCreateEvent)
  .get("/api/events/:id", handleGetEvent)
  .post("/api/events/:id/status", handleSetEventStatus)
  .post("/api/events/:id/attendees", handleAddAttendee)
  // P51 — what came out of a Room: West Peek's follow-ups, and who was there.
  .post("/api/events/:id/closeout", handleRunRoomCloseout)
  .get("/api/events/:id/closeout", handleGetRoomCloseout)
  // P51 — Rooms, sponsors and the community model. docs/COMMUNITY.md is the source of truth.
  .get("/api/rooms/packets", handleListRoomPackets)
  .post("/api/rooms/packets", handleGeneratePacket)
  .get("/api/rooms/packets/:id", handleGetRoomPacket)
  .post("/api/rooms/packets/:id/decide", handleDecidePacket)
  .post("/api/rooms/packets/:id/schedule", handleScheduleRoom)
  .post("/api/rooms/venues/:id/verify", handleVerifyVenue)
  .get("/api/sponsors", handleListSponsors)
  .post("/api/sponsors", handleCreateSponsor)
  .post("/api/sponsors/:id/stage", handleAdvanceSponsor)
  .get("/api/events/:id/sponsor-recap", handleSponsorRecap)
  // Present so the refusal is discoverable. Someone will look for this; better they find the
  // policy and the recap than assume its absence was an oversight and write one.
  .get("/api/events/:id/attendee-export", handleSponsorAttendeeExport)
  .post("/api/community/acts", handleRecordAct)
  .post("/api/community/acts/:id/retract", handleRetractAct)
  .get("/api/community/members/:id/evidence", handleMemberEvidence)
  .post("/api/community/council", handleDecideCouncil)
  .get("/api/people", handleListPeople)
  .get("/api/introductions", handleListMatches)
  .post("/api/introductions/run", handleRunMatching)
  .get("/api/introductions/signals", handleListSignals)
  .post("/api/introductions/signals", handleRecordSignal)
  .post("/api/introductions/signals/:id/retire", handleRetireSignal)
  .post("/api/introductions/:id", handleDecideMatch)
  .post("/api/introductions/:id/consent", handleMatchConsent)
  .post("/api/introductions/:id/connected", handleMatchConnected)
  // Serves the acts-aware handler rather than the scaffold's raw row list: same shape plus each
  // member's unranked one-line evidence summary. Ordered by recency, never by contribution.
  .get("/api/community/members", handleListCommunityMembers)
  .post("/api/community/members", handleUpsertMember)
  // P34 — IC Decision Portal (§28.6).
  .get("/api/ic/packets/:id/diligence", handleGetDiligence)
  .post("/api/ic/packets/:id/diligence", handleSaveDiligence)
  .post("/api/ic/packets/:id/setup", handleSetupPacket)
  .get("/api/ic/packets/:id/followups", handleListFollowups)
  .post("/api/ic/packets/:id/followups", handleAddFollowup)
  .get("/api/ic/packets/:id/audit", handleGetIcAudit)
  .get("/api/ic/packets/:id/records", handleGetIcRecords)
  // P35 — read surfaces over data that already existed (V1 #10, #34, #35).
  .get("/api/decisions", handleListDecisions)
  .get("/api/evidence-ledger", handleEvidenceLedger)
  .get("/api/work-queues", handleWorkQueues)
  .get("/api/companies/:id/intelligence", handleCompanyIntelligence)
  .get("/api/follow-on", handleFollowOnCentre)
  .get("/api/secondaries", handleSecondaries)
  .get("/api/daily-intelligence", handleGetDailyReport)
  .post("/api/daily-intelligence/generate", handleGenerateDailyReport)
  .post("/api/research/packets", handleBuildPacket)
  .get("/api/research/packets/:id/export", handleExportPacket)
  // P45 — West Peek University. Diary routes are declared BEFORE /:id so "diary" is never
  // swallowed as a session id.
  .get("/api/university/diary", handleListDiary)
  .post("/api/university/diary", handleSaveDiary)
  .get("/api/university", handleListUniversitySessions)
  .post("/api/university", handleStartUniversitySession)
  .get("/api/university/:id", handleGetUniversitySession)
  .post("/api/university/:id/reply", handleUniversityReply)
  // P46 — Market Mapping Room.
  .get("/api/market-maps", handleListMaps)
  .post("/api/market-maps", handleBuildMap)
  .get("/api/market-maps/:id", handleGetMap)
  // P50 — browser tasks. Request and run are separate calls: an advisory approval on "fetch an
  // arbitrary URL and feed it to an AI employee" is no approval at all.
  .get("/api/browser-tasks", handleListBrowserTasks)
  .post("/api/browser-tasks", handleRequestBrowserTask)
  .post("/api/browser-tasks/:id/approve", handleApproveBrowserTask)
  .post("/api/browser-tasks/:id/run", handleRunBrowserTask)
  // P47 — Approval Centre context (canon §24.2).
  .get("/api/approvals/:id/context", handleApprovalContext)
  .post("/api/approvals/:id/evidence", handleAddApprovalEvidence)
  .post("/api/approvals/:id/comments", handleAddApprovalComment)
  .get("/api/weekly-review", handleGetWeeklyReview)
  .post("/api/weekly-review/generate", handleGenerateWeeklyReview)
  .post("/api/weekly-review/items/:id/exit", handleSetItemExit)
  .get("/api/cross-office", handleListCrossOfficeConflicts)
  .post("/api/cross-office/detect", handleCrossOfficeDetect)
  .post("/api/cross-office/:id/resolve", handleResolveCrossOfficeConflict)
  .post("/api/meetings/:id/transcript", handleImportTranscript)
  .post("/api/meetings/:id/transcript/ingest", handleIngestTranscript)
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
  .post("/api/reconciliation/exceptions/:id/resolve", handleResolveException)
  // P14 — MP command center. One read-only aggregation; it owns no records.
  .get("/api/mp-home", handleMpHome)
  .post("/api/mp-home/seen", handleMarkHomeSeen)
  .get("/api/mp-home/preferences", handleGetPreferences)
  .post("/api/mp-home/preferences", handleSetPreferences)
  // P14 — daily intelligence engine. An item is never evidence by itself.
  .post("/api/intelligence/sources", handleRegisterSource)
  .get("/api/intelligence/sources", handleListSources)
  .patch("/api/intelligence/sources/:id", handleUpdateSource)
  .post("/api/intelligence/runs", handleRunIntelligence)
  .get("/api/intelligence/runs", handleListRuns)
  .get("/api/intelligence/items", handleListItems)
  .get("/api/intelligence/items/:id", handleGetItem)
  .post("/api/intelligence/items/:id/archive", handleArchiveItem)
  .post("/api/intelligence/items/:id/feedback", handleItemFeedback)
  .post("/api/intelligence/items/:id/synthesize", handleSynthesizeItem)
  .post("/api/intelligence/watchlist", handleAddWatchlist)
  .get("/api/intelligence/watchlist", handleListWatchlist)
  .post("/api/intelligence/watchlist/:id/active", handleSetWatchlistActive)
  .get("/api/briefings", handleListBriefings)
  .get("/api/briefings/current", handleGetBriefing)
  // P14 — private personal intelligence. Owner-only: no route reads another user's layer.
  .get("/api/personal-intelligence/profile", handleGetPersonalProfile)
  .post("/api/personal-intelligence/profile", handleSetPersonalProfile)
  .get("/api/personal-intelligence/entries", handleListPersonalEntries)
  .post("/api/personal-intelligence/entries", handleCreatePersonalEntry)
  // P15 — employee lounge / digital office / performance. Activation stays reserved (P4);
  // only the LOWERING lifecycle moves live here.
  .get("/api/workforce/lounge", handleLounge)
  .get("/api/workforce/employees/:id", handleEmployeeDetail)
  .patch("/api/workforce/employees/:id/profile", handleUpdateProfile)
  .post("/api/workforce/employees/:id/machines", handleAssignMachine)
  .post("/api/workforce/employees/:id/lifecycle", handleChangeLifecycle)
  .post("/api/workforce/employees/:id/scorecard", handleComputeScorecard)
  .post("/api/workforce/employees/:id/reviews", handleRecordEmployeeReview)
  .get("/api/workforce/rooms", handleListRooms)
  .get("/api/workforce/rooms/:id", handleGetRoom)
  .post("/api/workforce/rooms/:id/messages", handlePostRoomMessage)
  .get("/api/workforce/handoffs", handleListHandoffs)
  .post("/api/workforce/handoffs", handleProposeHandoff)
  .post("/api/workforce/handoffs/:id/decide", handleDecideHandoff)
  .get("/api/workforce/memos", handleListMemos)
  .post("/api/workforce/memos", handleCreateMemo)
  .post("/api/governance/updates/:id/acknowledge", handleAcknowledgeGovernance)
  // P16 — provider/model router. Every AI call still goes through run_ai(); this configures it.
  .get("/api/ai/catalog", handleProviderCatalog)
  .post("/api/ai/models", handleRegisterModel)
  .post("/api/ai/models/:id/status", handlePromoteModel)
  .post("/api/ai/models/:id/evaluations", handleRecordEvaluation)
  .post("/api/ai/providers/:key/health-check", handleProviderHealthCheck)
  .get("/api/ai/routing-policies", handleListRoutingPolicies)
  .post("/api/ai/routing-policies", handleSetRoutingPolicy)
  .post("/api/machines/:id/model-policy", handleSetMachineModelPolicy)
  .get("/api/ai/runs/:id/routing", handleGetRunRouting)
  // P16 — AI cost command center.
  .get("/api/ai/cost", handleCostOverview)
  .get("/api/ai/budgets", handleListBudgetScopes)
  .post("/api/ai/budgets", handleSetBudgetScope)
  .post("/api/ai/cost-alerts/:id/acknowledge", handleAcknowledgeCostAlert)
  // P17 — machine control center. Pause is enforced in the services, not by UI hiding.
  .get("/api/machines/control-center", handleMachineControlCenter)
  .get("/api/machines/:id/state", handleGetMachine)
  .patch("/api/machines/:id/state", handleConfigureMachine)
  .post("/api/machines/:id/pause", handlePauseMachine)
  .post("/api/machines/:id/dependencies", handleDeclareDependency)
  .post("/api/machines/:id/memory", handleAppendMemory)
  // P17 — capability intelligence (internal firm registry, not a marketplace).
  .get("/api/capabilities", handleListCapabilities)
  .post("/api/capabilities", handleRegisterCapability)
  .post("/api/capabilities/:id/state", handleTransitionCapability)
  .post("/api/capabilities/:id/assignments", handleAssignCapability)
  .post("/api/capabilities/:id/after-actions", handleRecordAfterAction)
  .post("/api/capabilities/:id/build-vs-buy", handleBuildVsBuy)
  // P18 — intent-to-execution work packets + lens bench. Literal routes before :id routes.
  .get("/api/work-packets/lens-bench", handleLensBench)
  .post("/api/work-packets", handleCreateWorkPacket)
  .get("/api/work-packets", handleListWorkPackets)
  .get("/api/work-packets/:id", handleGetWorkPacket)
  .patch("/api/work-packets/:id", handleUpdatePacket)
  .post("/api/work-packets/:id/lenses", handleRunLens)
  .post("/api/work-packets/:id/execute", handleExecutePacket)
  // P19 — governed orchestration. Literal routes before :key routes.
  .get("/api/jobs", handleListJobs)
  .post("/api/jobs", handleCreateJob)
  .post("/api/jobs/tick", handleRunDueJobs)
  .get("/api/jobs/runs/:id", handleGetJobRun)
  .post("/api/jobs/runs/:id/cancel", handleCancelJobRun)
  .post("/api/jobs/:key/run", handleRunJob)
  .post("/api/jobs/:key/status", handlePauseJob)
  // P20 — notifications. Literal routes before :id routes.
  .get("/api/notifications/preferences", handleGetNotificationPreferences)
  .post("/api/notifications/preferences", handleSetNotificationPreferences)
  .get("/api/notifications", handleListNotifications)
  .get("/api/notifications/:id/deliveries", handleNotificationDeliveries)
  .post("/api/notifications/:id/read", handleReadNotification)
  .post("/api/notifications/:id/acknowledge", handleAckNotification)
  // P21 — research workstation. Findings reach truth only through the P5 claim substrate.
  .post("/api/research/projects", handleCreateProject)
  .get("/api/research/projects", handleListProjects)
  .get("/api/research/projects/:id", handleGetProject)
  .post("/api/research/projects/:id/questions", handleAddQuestion)
  .post("/api/research/projects/:id/sources", handleAddSource)
  .post("/api/research/projects/:id/findings", handleRecordFinding)
  .post("/api/research/projects/:id/market-maps", handleCreateMarketMap)
  .post("/api/research/projects/:id/packets", handleAssemblePacket)
  .post("/api/research/questions/:id/answer", handleAnswerQuestion)
  .post("/api/research/findings/:id/promote", handlePromoteFinding)
  // P22 — external connector status + meeting prep queue. Read-only: this surface writes nothing
  // to any external system.
  .get("/api/connectors", handleListConnectors)
  .post("/api/connectors/:key/check", handleCheckConnector)
  .get("/api/meeting-prep/queue", handleMeetingPrepQueue)
  // P23 — specialist provider lane. A vendor is a provider behind run_ai(), never a bypass.
  .get("/api/specialist/engagements", handleListEngagements)
  .post("/api/specialist/engagements", handleOpenEngagement)
  .post("/api/specialist/engagements/:id/accept", handleAcceptEngagement)
  // P24 — LP / fund-admin / VDR operating surface. The administrator stays authoritative.
  .get("/api/lp-ops/overview", handleLpOpsOverview)
  .post("/api/lp-ops/sources", handleRegisterAdminSource)
  .post("/api/lp-ops/reconciliation-schedules", handleSetReconciliationSchedule)
  .post("/api/lp-ops/engagements/:id", handleUpdateLpEngagement)
  // P25 — MP cockpit views. Read-only aggregations; nothing is recomputed for display.
  .get("/api/portfolio/cockpit", handlePortfolioCockpit)
  .get("/api/allocation/scenarios/:id/strategy-view", handleAllocationStrategyView);

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

  /**
   * P19 — the ONE scheduling entry point (ADR-017). The Cron Trigger in wrangler.toml calls this;
   * it selects due ACTIVE jobs from D1 and runs each one through the same governed path an
   * operator uses manually. A cron trigger cannot fire under local `wrangler dev`, so this exact
   * function is also reachable via POST /api/jobs/tick and is called directly in tests — remote
   * firing itself remains UNPROVEN until deployment.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runDueJobs(env, new Date())
        .then((results) => {
          if (results.length > 0) console.log("scheduled tick", JSON.stringify(results));
        })
        .catch((err) => {
          console.error("scheduled tick failed", err);
        }),
    );
  },
} satisfies ExportedHandler<Env>;
