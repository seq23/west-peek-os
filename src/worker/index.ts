import type { Env } from "./env";
import { handleInboundEmail } from "./effects/inboundEmail";
import { handleReadCompanyDeck } from "./services/deckReader";
import {
  handleDraftLpReport,
  handleFundPerformance,
  handleMarkPosition,
  handleRecordCall,
  handleRecordDistribution,
} from "./services/fundPerformance";
import {
  handleFundraisingSummary,
  handleListCommitments,
  handleRecordCommitment,
  handleSetFundSize,
} from "./services/lpCommitments";
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
  handleCompanyHistory,
  handleUpdateCompany,
} from "./services/companies";
import {
  handleCreateFund,
  handleCreateFundEntity,
  handleCreatePolicyVersion,
  handleThesisSectors,
  handleWriteThesisStatement,
  handleGetFund,
  handleGetPolicyVersion,
  handleListFundEntities,
  handleFundBasis,
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
  handleProposePersonToNetwork,
  handleUnresolvedPeople,
} from "./services/captures";
import {
  handleAddWorkCardNote,
  handleCreateWorkCard,
  handleListWorkCardNotes,
  handleWorkByOwner,
  handleWorkRecord,
  handleGetWorkCard,
  handleListWorkCards,
  handleUpdateWorkCard,
  handleHoldWorkCard,
  handleReleaseWorkCard,
  handleMarkWorkDeskSeen,
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
  handleBlockApproval,
  handleReleaseApprovalBlock,
  handleReopenApproval,
} from "./services/approvals";
import { handleDraftCard, handleWorkCard, handleWriteBrief } from "./services/employeeWork";
import { handleUnblockWorkCard } from "./services/blocks";
import { handleHandOffWorkCard, handleTakeBackWorkCard } from "./services/handOff";
import { handleWorkCardInstructions } from "./services/instruction";
import {
  handleGoogleCallback,
  handleGoogleConnectStart,
  handleGoogleDisconnect,
  handleTodaysCalendar,
} from "./services/googleConnect";
import { handleGetSendAs, handleSetSendAs } from "./services/sendAs";
import { handleListActivity } from "./services/activity";
import { handleCreateGovernanceUpdate, handleListGovernanceUpdates } from "./services/governance";
import { handleApprovalVolume } from "./services/diagnostics";
import { handleSystemHealth } from "./services/health";
import {
  handleClearSilencedAttention,
  handleDismissAttention,
  handleDismissManyAttention,
  handleListSilencedAttention,
} from "./services/attention";
import { handleListDomains, handleListMachines } from "./services/registry";
import {
  handleCreateEffectRequest,
  handleExecuteEffectRequest,
  handleListEffectRequests,
} from "./services/effects";
import {
  handleAcceptAiOutput,
  handleAiOutboundPolicy,
  handleDiscardAiOutput,
  handleDiscardAllQuarantined,
  handleGetAiRun,
  handleListAiRuns,
  handleListQuarantinedOutputs,
  handleRunAi,
} from "./services/aiRuns";
import { handleGetRequestAttachment, handleGetWebPropertyChange, handleMaterialsAdded, handleResendPreview, handleReingestStoredEmail, handleSetWorkKindRule, handleWorkKindRules } from "./services/webPropertyChange";
import { handleGetRequestMessage, handleGetRequestMessageRaw, handleGetWorkCardMessageTrail } from "./services/requestMessage";
import { handleListMergeTargets, handleMergeWorkCardInto } from "./services/mergeCards";
import { handleGetEmailPreviewPreference, handleSetEmailPreviewPreference } from "./services/kindRules";
import {
  handleSubscriptionSeatClaim,
  handleSubscriptionSeatHeartbeat,
  handleSubscriptionSeatProgress,
  handleSubscriptionSeatReport,
  handleSubscriptionSeatStatus,
} from "./services/subscriptionSeats";
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
  handleScheduleRoom, handleVerifyVenue, handleWithdrawSteer,
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
import { handleHearing } from "./services/howTheRoomHears";
import { handleCommunityNewest, handleCommunityPopulation, handleUpsertMember } from "./services/communityOs";
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
import {
  handleRetitleEmployee,
  handleUnretireAdvice,
  handleUnretireEmployee,
} from "./services/workforce";
import { handleGenerateImage } from "./services/imageGeneration";
import {
  handleAcknowledgeDeliverable,
  handleAcknowledgeMany,
  handleDismissMany,
  handleDeliverableFeedback,
  handleDismissDeliverable,
  handleDownloadDeliverable,
  handleEmailDeliverable,
  handleListDeliverableFeedback,
  handleListDeliverables,
} from "./services/deliverables";
import {
  handleDecidePreviewApproval,
  handleDecidePreviewApprovalByToken,
  handleListPreviewApprovals,
  handleOpenPreviewApproval,
} from "./services/previewApproval";
import { handleListHireCandidates } from "./services/productionsHire";
import { handleRunPreview } from "./services/preview";
import { handleRunMeetingPrep } from "./services/meetingPrep";
import { handleGetMeetingBrief } from "./services/meetingBrief";
import {
  handleApproveMeetingAfter,
  handleAskOfferLedger,
  handleDecideStageProposal,
  handleDiscardMeetingAfter,
  handleDraftMeetingAfter,
  handleGetMeetingAfter,
  handleHonourCommitment,
  handleListMeetingArtifacts,
  handleProposeStageChange,
  handleRecordDecision,
  handleRecordOpenQuestion,
  handleResolveOpenQuestion,
  handleSaveMeetingArtifact,
} from "./services/meetingAfter";
import { handleRoomAsk, handleRoomRoll, handleRoomState } from "./services/meetingRoom";
import { handleRequestArtifactBuild, handleExportArtifact, handleGetBuiltArtifact, handleListBuiltArtifacts, handleRebuildArtifact } from "./services/artifacts";
import { handleDecideDeck, handleGetDeck, handleUploadDeck } from "./services/deck";
import { handleAddReviewItem, handleDeleteReviewItem,
  handleRefileReviewItem, handleReviewNotes, handleGenerateWeeklyReview, handleGetWeeklyReview, handleSetItemExit } from "./services/weeklyReview";
import { handleIngestTranscript } from "./services/captureAdapter";
import { handleBriefStatus, handleGenerateDailyReport, handleGetDailyReport, handleGetInterests, handleSetInterests } from "./services/dailyIntelligence";
import { handleBuildPacket, handleExportPacket } from "./services/researchPacket";
import { handleBuildMap, handleGetMap, handleListMaps } from "./services/marketMap";
import {
  handleApproveBrowserTask, handleListBrowserTasks, handleRequestBrowserTask, handleRunBrowserTask, handleCardLook, handleSetCardBrowserPermission } from "./services/browserTask";
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
  handleEmployEmployee,
  handleGetAiEmployee,
  handleGrantToolScope,
  handleListAiEmployees,
  handleSetEmployeeRunning,
  handleDutyRoster,
  handleRequestActivation,
} from "./services/aiEmployees";
import {
  handleDutyPicture,
  handleRevertDutyOverride,
  handleSetDutyOverride,
} from "./services/dutyOverrides";
import {
  handleGetAiBudget,
  handleListAiProviders,
  handleProviderEnable,
  handleProviderKillSwitch,
  handleUpdateAiBudget,
} from "./services/aiGovernance";
import {
  handleAddDocumentVersion,
  handleLinkDocument,
  handleListLinkedDocuments,
  handleDownloadDocument,
  handleGetDocument,
  handleListDocuments,
  handleUploadDocument,
  handleArchiveDocument,
  handleRestoreDocument,
  handleArchiveAllDocuments,
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
  handleArchiveOpportunity,
  handleRecommendOpportunity,
  handleTransitionOpportunity,
  handleBackfillOpportunity,
  handleConfirmPlaceholders,
  handleDealflowBoard,
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
  handleNetworkCompanyPush,
  handlePullResource,
  handleResolveConflict,
  handleWriteBack,
} from "./services/networkAdapter";
import { handleScoutedIntake } from "./services/dealIntake";
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
  handleArchiveMeeting,
  handleMeetingStarted,
} from "./services/meetings";
import {
  handleAssembleIcPacket,
  handleGetIcPacket,
  handleIcDealSurface,
  handleIcDealForOpportunity,
  handleListIcPackets,
  handleListIcQuestions,
  handleRaiseIcQuestion,
  handleRecordDissent,
  handleRecordIcDecision,
  handleResolveIcQuestion,
  handleSubmitIcPacket,
} from "./services/ic";
// ADR-019 — recording a meeting from the browser it is being held in. The consent prompt lives in
// front of it and the two existing gates (activated policy, granted consent) are unchanged.
import {
  handleCaptureChunk,
  handleCaptureConsent,
  handleCaptureReadiness,
  handleFirefliesRetired,
} from "./services/liveTranscription";
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
import { handleMarkHomeSeen, handleMarkModuleSeen, handleMarkRouteVisited, handleMpHome } from "./services/mpHome";
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
import { handleDraftPortfolioSummary, handlePortfolioReporting } from "./services/portfolioReporting";
import { handlePortfolioAllocation, handlePortfolioComposition, handlePortfolioHoldings } from "./services/portfolioHoldings";
import { handleBookHolding, handleReservePosition, handleSellHolding } from "./services/portfolioBooking";
import { handleCheckConnector, handleListConnectors, handleMeetingPrepQueue } from "./services/connectors";
import { handleAcceptEngagement, handleListEngagements, handleOpenEngagement } from "./services/specialist";
import {
  handleLpOpsOverview,
  handleRegisterAdminSource,
  handleSetReconciliationSchedule,
  handleUpdateLpEngagement,
} from "./services/lpOps";
import { handlePageThread, handlePageReply } from "./services/pageChat";
import {
  handleGrantStandingAuthority,
  handleListStandingAuthority,
  handleRevokeStandingAuthority,
} from "./services/standingAuthority";
import {
  handleAddQuestion,
  handleProposeQuestions,
  handleResearchReply,
  handleResearchThread,
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
  handleReadAllNotifications,
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
  handleSetFirmBudget,
} from "./services/costCenter";
import {
  handleAdoptFirmSkill,
  handleDraftFirmSkill,
  handleListFirmSkills,
  handleRetireFirmSkill,
} from "./services/firmSkills";
import { handleCalendarLedger, handleRunCalendarSync } from "./services/calendarSync";
import { handleFirmRecordingPolicy, handleMeetInbox, handleMeetStatus, handleRunMeetIngest } from "./services/meetIngest";
import { handleAdoptMeetCode, handleLiveChunk, handleLiveHeartbeat, handleLiveStatus, handleOpenLiveSession, handleReportLiveSession, handleResolveMeetCode } from "./services/meetLive";
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

  /*
   * WHICH IDENTITY HEADERS ACTUALLY ARRIVE. Names only — never values.
   *
   * The firm's browser could not authenticate and there was no way to tell why: the Worker sees
   * whatever Cloudflare Access chooses to forward, and guessing at that from documentation is how
   * two deploys were spent on the wrong header. This answers it directly, and it is safe to leave
   * on because a header NAME is not a secret and this route is already unauthenticated.
   */
  const identityHeaders = [...ctx.request.headers.keys()]
    .filter((h) => h.toLowerCase().startsWith("cf-"))
    .sort();


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
    identity_headers: identityHeaders,
    access_client_id_configured: typeof env.CF_ACCESS_CLIENT_ID === "string" && env.CF_ACCESS_CLIENT_ID.length > 0,
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
  // Whose name approved email goes out under. Self-service only — the handler refuses to let one
  // partner arrange for mail to be sent in the other's name.
  .get("/api/me/send-as", handleGetSendAs)
  .post("/api/me/send-as", handleSetSendAs)
  // P51 — connecting a partner's own Google account. The start route redirects the browser out to
  // Google and the callback comes back through Access, so the client never handles a token.
  .get("/api/connect/calendar/start", handleGoogleConnectStart)
  // The SECOND consent: calendar plus gmail.send. Separate so connecting a diary never asks for a
  // mail permission as the price.
  .get("/api/connect/gmail-send/start", handleGoogleConnectStart)
  .get("/api/connections/google/callback", handleGoogleCallback)
  .post("/api/connections/google/disconnect", handleGoogleDisconnect)
  .get("/api/me/calendar/today", handleTodaysCalendar)
  .get("/api/companies/:id", handleGetCompany)
  .patch("/api/companies/:id", handleUpdateCompany)
  // The trail item 9 asked for. It did not exist because nothing was ever written.
  .get("/api/companies/:id/history", handleCompanyHistory)
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
  // Item 13: what the fund actually is, so a scenario stops being modelled against fiction.
  .get("/api/funds/:id/basis", handleFundBasis)
  .get("/api/funds/:id", handleGetFund)
  .post("/api/funds/:id/entities", handleCreateFundEntity)
  .get("/api/funds/:id/entities", handleListFundEntities)
  // The sector list every surface files a company under. Derived, never typed.
  .get("/api/thesis/sectors", handleThesisSectors)
  .post("/api/thesis/statement", handleWriteThesisStatement)
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
  // The other direction: a person the firm met goes to Network OS as a PROPOSAL.
  .post("/api/captures/:id/propose-to-network", handleProposePersonToNetwork)
  .get("/api/captures/:id", handleGetCapture)
  .post("/api/captures/:id/route", handleRouteCapture)
  .post("/api/captures/:id/resolve", handleResolveCapture)
  .post("/api/captures/:id/archive", handleArchiveCapture)
  // P3 — work spine.
  .post("/api/work-cards", handleCreateWorkCard)
  // Wave C, 22 Sep 2026 — the desk remembers when she last looked (migration 0225,
  // `work_desk_seen`). Literal, registered before any `:id`-shaped work-card route below so
  // "desk-seen" is never read as a card id.
  .post("/api/work-cards/desk-seen", handleMarkWorkDeskSeen)
  // Literal before the :id that would swallow it.
  .post("/api/intent/brief", handleWriteBrief)
  .post("/api/images/generate", handleGenerateImage)
  .post("/api/workforce/:id/unretire", handleUnretireEmployee)
  .post("/api/workforce/:id/unretire-advice", handleUnretireAdvice)
  .patch("/api/workforce/:id/role", handleRetitleEmployee)
  // Preview: run any scheduled job or work card for real and send the result to Sequoia alone.
  // Partner-only; a 404 for anyone else. See services/preview.ts and shared/work/preview.ts.
  .post("/api/preview", handleRunPreview)
  // Walker's weekly hire search for West Peek Productions: the candidates behind one week's note.
  // Read-only and Scooter's alone. There is no status to set — see the note at the end of
  // services/productionsHire.ts for why the marking route was removed rather than hidden.
  .get("/api/productions/candidates", handleListHireCandidates)
  .get("/api/deliverables", handleListDeliverables)
  .get("/api/deliverables/:id/download", handleDownloadDeliverable)
  .post("/api/deliverables/:id/email", handleEmailDeliverable)
  // === Home overhaul ===
  .post("/api/deliverables/acknowledge-many", handleAcknowledgeMany)
  .post("/api/deliverables/dismiss-many", handleDismissMany)
  .post("/api/attention/dismiss-many", handleDismissManyAttention)
  .post("/api/deliverables/:id/acknowledge", handleAcknowledgeDeliverable)
  .post("/api/deliverables/:id/dismiss", handleDismissDeliverable)
  .get("/api/deliverables/:id/feedback", handleListDeliverableFeedback)
  .post("/api/deliverables/:id/feedback", handleDeliverableFeedback)
  /*
   * THE PREVIEW LANE — "yes, send that" (17 Sep 2026). A deliverable could be dismissed or given
   * feedback; there was no way to approve one. These are the three answers, and the two doors.
   *
   * THE TWO TOKEN ROUTES ARE `auth: false` DELIBERATELY, AND THE TOKEN IS THE CREDENTIAL. She reads
   * these on a phone, from the email, where there is no session. That is a higher bar than the
   * steering replies — which were given no token at all, because the worst a forged steer does is
   * waste a week — so the token is per-preview, 128-bit, stored only as a hash, single use and
   * expiring, and the recipient it authorises is checked again at the send boundary. The full
   * threat model, and why recognising the sender is NOT sufficient here, is in
   * `shared/work/previewLane.ts`.
   *
   * THE GET CHANGES NOTHING. It renders the draft and three buttons that POST back, because a GET
   * that sent mail would be sent by the first link scanner or mail client that prefetched it.
   */
  .get("/api/preview-approvals", handleListPreviewApprovals)
  .post("/api/preview-approvals/:id/decide", handleDecidePreviewApproval)
  /*
   * A SEPARATE PATH, NOT A SECOND SHAPE ON THE SAME ONE. `/api/preview-approvals/:id/decide` and a
   * hypothetical `/api/preview-approvals/:token/decide` are the SAME four segments to this router,
   * which matches in registration order — so the token door would have been permanently shadowed by
   * the authenticated one and would have answered 401 from her phone, forever, with nothing in the
   * logs saying why. `/api/approve/*` is its own space.
   */
  .get("/api/approve/:token", handleOpenPreviewApproval, { auth: false })
  .post("/api/approve/:token/decide", handleDecidePreviewApprovalByToken, { auth: false })
  // Steering work in flight: a partner says something, the employee answers it on its next step.
  .get("/api/work-cards/:id/notes", handleListWorkCardNotes)
  // 0175 — the receipt: what she typed, and what the model turned it into, side by side. Her
  // question was "tell me what my instructions turned into", asked of an agent, about a database.
  .get("/api/work-cards/:id/instructions", handleWorkCardInstructions)
  .post("/api/work-cards/:id/notes", handleAddWorkCardNote)
  // 0241 — hand a card to the other partner (the current primary only) and take it back (the
  // current secondary only). The same rules answer a reply or a note that says it.
  .post("/api/work-cards/:id/hand-off", handleHandOffWorkCard)
  .post("/api/work-cards/:id/take-back", handleTakeBackWorkCard)
  .get("/api/work-cards/by-owner", handleWorkByOwner)
  // THE RECORD. Finished work left the board because a slice of a cap is not a record — see
  // handleWorkRecord. Search, month spine, collapsed duplicates, paged.
  .get("/api/work-cards/record", handleWorkRecord)
  .get("/api/work-cards", handleListWorkCards)
  .get("/api/work-cards/:id", handleGetWorkCard)
  .patch("/api/work-cards/:id", handleUpdateWorkCard)
  // P3 — approval center (state machine enforced in services/approvals.ts).
  .post("/api/approvals", handleCreateApproval)
  .get("/api/approvals", handleListApprovals)
  .get("/api/approvals/:id", handleGetApproval)
  .post("/api/approvals/:id/submit", handleSubmitApproval)
  .post("/api/approvals/:id/decide", handleDecideApproval)
  // Changing a decision, and blocking — two authorities the decide route deliberately does not
  // carry. See the notes on REOPENABLE_FROM and BLOCKABLE_FROM in services/approvals.ts.
  .post("/api/approvals/:id/reopen", handleReopenApproval)
  .post("/api/approvals/:id/block", handleBlockApproval)
  .post("/api/approvals/:id/release", handleReleaseApprovalBlock)
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
  .get("/api/diagnostics/health", handleSystemHealth)
  .get("/api/attention/silenced", handleListSilencedAttention)
  .post("/api/attention/silenced/clear", handleClearSilencedAttention)
  .post("/api/attention/:key/dismiss", handleDismissAttention)
  .get("/api/diagnostics/approval-volume", handleApprovalVolume)
  // P3 — registry reference data (read-only).
  .get("/api/machines", handleListMachines)
  .get("/api/domains", handleListDomains)
  // P4 — governed AI boundary (run_ai). Literal routes before `:id` parameter routes.
  .post("/api/ai/run", handleRunAi)
  .get("/api/ai/runs", handleListAiRuns)
  .get("/api/ai/runs/:id", handleGetAiRun)
  .post("/api/ai/runs/:id/accept-output", handleAcceptAiOutput)
  // The quarantine's exits. Accept has existed since P4 and had no caller; listing what is waiting
  // and throwing one away are new, and without all three the queue could only grow.
  .get("/api/ai/quarantine", handleListQuarantinedOutputs)
  .post("/api/ai/runs/:id/discard-output", handleDiscardAiOutput)
  // Everything waiting, in one press. Built on the single-item path so every guard comes with it.
  .post("/api/ai/quarantine/discard-all", handleDiscardAllQuarantined)
  // P4 — AI employee lifecycle (no direct status route; activation via approval receipt only).
  .get("/api/ai/employees/on-duty", handleDutyRoster)
  // The rota the operator can change. One GET, because "who is on now", "the whole day" and "what
  // was changed" must be computed from the same override set — three calls could disagree.
  // Reverting is a POST rather than a DELETE only because this router has no DELETE; it is a
  // deletion, and putting a row back is not a thing the system can do.
  .get("/api/ai/duty", handleDutyPicture)
  .post("/api/ai/duty/overrides", handleSetDutyOverride)
  .post("/api/ai/duty/revert", handleRevertDutyOverride)
  .get("/api/ai/employees", handleListAiEmployees)
  .get("/api/ai/employees/:id", handleGetAiEmployee)
  .post("/api/ai/employees/:id/request-activation", handleRequestActivation)
  .post("/api/ai/employees/:id/activate", handleActivateAiEmployee)
  // One press. Requests, approves (when the presser holds the authority) and activates in a
  // single call, writing every record the long way round wrote.
  .post("/api/ai/employees/:id/employ", handleEmployEmployee)
  .post("/api/ai/employees/:id/running", handleSetEmployeeRunning)
  .post("/api/ai/employees/:id/tools", handleGrantToolScope)
  // P4 — provider registry governance (reserved governance.policy_change + receipt).
  .get("/api/ai/outbound-policy", handleAiOutboundPolicy)
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
  // What a document is about. A deck and a deal were two records that never met.
  .post("/api/documents/:id/link", handleLinkDocument)
  // Read the deck attached to a company. Proposes what it found; writes nothing.
  .post("/api/companies/:id/read-deck", handleReadCompanyDeck)
  .get("/api/document-links", handleListLinkedDocuments)
  .get("/api/documents/:id/download", handleDownloadDocument)
  .post("/api/documents/:id/archive", handleArchiveDocument)
  .post("/api/documents/:id/restore", handleRestoreDocument)
  .post("/api/documents/archive-all", handleArchiveAllDocuments)
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
  // Item 7, route 1: the manual door a partner drives herself. It runs through openIntoFunnel.
  .post("/api/opportunities", handleCreateOpportunity)
  // Item 7, route 4: the analyst's own scouting. His list, so his to cut — but it still arrives
  // through the same door, and what he drops still shows on the pass pile.
  .post("/api/dealflow/scouted", handleScoutedIntake)
  .get("/api/opportunities", handleListOpportunities)
  // P51 — where deals come from, and which ones nobody recorded.
  .get("/api/opportunities/provenance", handleDealProvenance)
  .get("/api/opportunities/:id", handleGetOpportunity)
  .patch("/api/opportunities/:id", handleUpdateOpportunity)
  .post("/api/opportunities/:id/transition", handleTransitionOpportunity)
  // An employee advises; the partner still decides. Never moves the deal.
  .post("/api/opportunities/:id/recommend", handleRecommendOpportunity)
  .post("/api/opportunities/:id/archive", handleArchiveOpportunity)
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
  // ADR-019 — the gaps a packet drafted from the record cannot fill, each owed by somebody, and the
  // read behind "where a deal stands with the committee".
  .get("/api/ic/deals", handleIcDealSurface)
  .get("/api/ic/deals/:id", handleIcDealForOpportunity)
  .get("/api/ic/packets/:id/questions", handleListIcQuestions)
  .post("/api/ic/packets/:id/questions", handleRaiseIcQuestion)
  .post("/api/ic/questions/:id/resolve", handleResolveIcQuestion)
  // P6 — company 360 over the one canonical identity (D3).
  .get("/api/companies/:id/360", handleCompany360)
  // P7 — meetings: a conversation is never institutional truth.
  .post("/api/meetings", handleCreateMeeting)
  .get("/api/meetings", handleListMeetings)
  .get("/api/meetings/:id", handleGetMeeting)
  .post("/api/meetings/:id/transition", handleTransitionMeeting)
  // Migration 0140 — off the record, not destroyed. Reason required, human only.
  .post("/api/meetings/:id/archive", handleArchiveMeeting)
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
  // ADR-019 — in-browser capture. Readiness says whether a chunk posted now would actually be
  // written down and why not; the consent answer is logged before anything starts, every time.
  .get("/api/meetings/:id/capture", handleCaptureReadiness)
  .post("/api/meetings/:id/capture/consent", handleCaptureConsent)
  .post("/api/meetings/:id/capture/chunk", handleCaptureChunk)
  // A transcript somebody else recorded. Same two gates, and importing is never consent.
  // Retired 19 Sep 2026 ("we will use Whisper in lieu of Fireflies — it's better"): answers 410 with
  // the two real paths named, never a silent 404.
  .post("/api/meetings/:id/transcript/fireflies", handleFirefliesRetired)
  // === Phase Meet: Google Meet integration ===
  // Tier 1: the firm calendar becomes meetings. Tier 2: an ended Meet is read once, through the
  // governed import. The one reserved decision — recording on by default for every firm-hosted
  // Meet — is a receipt-gated POST. Everything here is read from Google and written here; no route
  // writes to a calendar, a space or Drive. Literal paths only, so nothing shadows a :id route.
  .get("/api/meet/status", handleMeetStatus)
  .get("/api/meet/inbox", handleMeetInbox)
  .get("/api/meet/calendar", handleCalendarLedger)
  .post("/api/meet/calendar/sync", handleRunCalendarSync)
  .post("/api/meet/ingest", handleRunMeetIngest)
  .post("/api/meet/recording-policy", handleFirmRecordingPolicy)
  // === end Phase Meet ===
  // === Meet live ===
  // Tier 4: the room hears the Meet LIVE. The WebRTC peer is the listener on the owner's Mac
  // (scripts/meet/live-listener.mjs); these routes are everything it may do — say it is awake and
  // ask what is due, open a session THROUGH THE GATES (calendar-synced meeting with a conference,
  // firm recording default on, platform-announced consent, meet.live.join authorised), post a slice
  // of audio that goes only to Workers AI and then through the governed import, and report how the
  // join ended. The four listener routes accept the Mac's service-token identity and nobody else;
  // status and resolve are for partners (and tier 3's side panel). Literal paths before :id.
  .post("/api/meet/live/heartbeat", handleLiveHeartbeat)
  .post("/api/meet/live/sessions", handleOpenLiveSession)
  .post("/api/meet/live/sessions/:id/report", handleReportLiveSession)
  .post("/api/meet/live/sessions/:id/chunk", handleLiveChunk)
  .get("/api/meet/live/status", handleLiveStatus)
  .get("/api/meet/live/resolve", handleResolveMeetCode)
  .post("/api/meet/live/adopt", handleAdoptMeetCode)
  // === end Meet live ===
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
  // A steer she gave for a month Parker has not built yet, taken back before he does.
  .post("/api/rooms/steers/:id/withdraw", handleWithdrawSteer)
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
  // The birds-eye view: what the community IS, read as a shape off Network OS rather than
  // mirrored as a roster. Counted in SQL so it survives five thousand people.
  .get("/api/community/population", handleCommunityPopulation)
  // The last 25 people added in Network OS, read off the same synced rows — names, never a roster.
  .get("/api/community/newest", handleCommunityNewest)
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
  // === Brief overhaul ===
  .get("/api/daily-intelligence/status", handleBriefStatus)
  .get("/api/daily-intelligence/interests", handleGetInterests)
  .post("/api/daily-intelligence/interests", handleSetInterests)
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
  // P44 — looking at a page FOR a card. Runs immediately when the card carries permission; without
  // it, waits for a person exactly as a standalone task does.
  // P52 — the employee who owns this card gets on with it. A person starts the run; the employee
  // decides how, never whether.
  .post("/api/work-cards/:id/work", handleWorkCard)
  // P53 — Ask drafts a card. It writes nothing; the partner reads it and presses Add.
  .post("/api/intent/draft", handleDraftCard)
  // 0173 — the four doors on a blocked card: answer it, change it, drop it, send it to an engineer.
  // An answer reopens the card and reaches the employee's next run; it is not a comment box.
  .post("/api/work-cards/:id/unblock", handleUnblockWorkCard)
  // 0227, Wave D — HELD: pull a card and save it for later, with a required reason; release puts
  // it back to OPEN with its attempts reset, never resuming mid-step.
  .post("/api/work-cards/:id/hold", handleHoldWorkCard)
  .post("/api/work-cards/:id/release", handleReleaseWorkCard)
  // Plan A (20 Sep 2026): the state of a web property change, and the standing rules of a card kind.
  .get("/api/work-cards/:id/web-property-change", handleGetWebPropertyChange)
  // 0240: "I added missing items" (her label, exactly) and the preview re-sent in the current template.
  .post("/api/work-cards/:id/materials-added", handleMaterialsAdded)
  .post("/api/work-cards/:id/resend-preview", handleResendPreview)
  .get("/api/work-cards/:id/attachments/:attId", handleGetRequestAttachment)
  // 0226 — the email this card came from. The decoded body for anyone who may see the card; the
  // raw `.eml` for a Managing Partner only (`inbound_message.read_raw`, restricted).
  .get("/api/work-cards/:id/request-message", handleGetRequestMessage)
  .get("/api/work-cards/:id/raw", handleGetRequestMessageRaw)
  // Wave A, Addendum 2 — the message trail: every inbound_message and work_card_notice row for
  // this card, merged and ordered, one chronological list rather than a terse summary line.
  .get("/api/work-cards/:id/message-trail", handleGetWorkCardMessageTrail)
  .post("/api/inbound-email/reingest", handleReingestStoredEmail)
  .get("/api/work-kinds/:kind/rules", handleWorkKindRules)
  .patch("/api/work-kinds/:kind/rules/:key", handleSetWorkKindRule)
  // 0228, Addendum 8 — the firm-wide "preview every partner-facing email" dial, the default every
  // kind inherits unless it carries its own work_kind_rule override.
  .get("/api/email-preview-preference", handleGetEmailPreviewPreference)
  .patch("/api/email-preview-preference", handleSetEmailPreviewPreference)
  .post("/api/work-cards/:id/look", handleCardLook)
  .post("/api/work-cards/:id/browser-permission", handleSetCardBrowserPermission)
  // D/F merge (0242, 27 Sep 2026) — fold a stray card into the one carrying the work: its emails,
  // thread and attachments move, its history reads in the survivor's trail, it stays CANCELLED.
  // Partners only. `merge-targets` is the picker's list: open cards, same primary first, newest first.
  .post("/api/work-cards/:id/merge-into", handleMergeWorkCardInto)
  .get("/api/work-cards/:id/merge-targets", handleListMergeTargets)
  .post("/api/browser-tasks/:id/approve", handleApproveBrowserTask)
  .post("/api/browser-tasks/:id/run", handleRunBrowserTask)
  // P47 — Approval Centre context (canon §24.2).
  .get("/api/approvals/:id/context", handleApprovalContext)
  .post("/api/approvals/:id/evidence", handleAddApprovalEvidence)
  .post("/api/approvals/:id/comments", handleAddApprovalComment)
  .get("/api/weekly-review", handleGetWeeklyReview)
  .post("/api/weekly-review/generate", handleGenerateWeeklyReview)
  // The per-partner Wednesday packets and the deck discrepancy register. Runs on `wednesday_prep`
  // every morning; this is the same path, by hand, for a partner who wants it now.
  .post("/api/meeting-prep/run", handleRunMeetingPrep)
  // The LP deck, its history, and whether the records have moved under it since it was built.
  .get("/api/deck", handleGetDeck)
  .post("/api/deck/versions", handleUploadDeck)
  .post("/api/deck/versions/:id/decide", handleDecideDeck)
  // The capture box: put something on the agenda that no record knows about.
  .post("/api/weekly-review/notes", handleReviewNotes)
  .post("/api/weekly-review/items", handleAddReviewItem)
  .post("/api/weekly-review/items/:id/remove", handleDeleteReviewItem)
  .post("/api/weekly-review/items/:id/heading", handleRefileReviewItem)
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
  // === Phase B: meeting model ===
  // A meeting is one object with three faces. BEFORE: the brief (built by POST …/prep, read here).
  // AFTER: what came out — decisions, commitments on both sides, open questions, a stage PROPOSAL,
  // saved artifacts — and the AI draft that is the only door in for a model, approved by a person.
  .get("/api/meetings/:id/brief", handleGetMeetingBrief)
  .get("/api/meetings/:id/after", handleGetMeetingAfter)
  .post("/api/meetings/:id/decisions", handleRecordDecision)
  .post("/api/meetings/:id/open-questions", handleRecordOpenQuestion)
  .post("/api/meeting-open-questions/:id/resolve", handleResolveOpenQuestion)
  .post("/api/meeting-commitments/:id/honour", handleHonourCommitment)
  .post("/api/meetings/:id/stage-proposals", handleProposeStageChange)
  .post("/api/meeting-stage-proposals/:id/decide", handleDecideStageProposal)
  .get("/api/meetings/:id/artifacts", handleListMeetingArtifacts)
  .post("/api/meetings/:id/artifacts", handleSaveMeetingArtifact)
  .post("/api/meetings/:id/after-draft", handleDraftMeetingAfter)
  .post("/api/meeting-after-drafts/:id/approve", handleApproveMeetingAfter)
  .post("/api/meeting-after-drafts/:id/discard", handleDiscardMeetingAfter)
  .get("/api/meeting-ledger/ask-offer", handleAskOfferLedger)
  // === end Phase B ====
  // === Phase C: the live room ===
  // The DURING face. One read for the whole room (recording status, the rolling draft, the blocks,
  // who is seated, the tasks in flight); the draft rolled from the transcript so far; a question
  // asked by text or push-to-talk voice, which always answers with a saved block and can open a
  // preview-first card — and can never write a decision, commitment, question or stage move.
  .get("/api/meetings/:id/room", handleRoomState)
  .post("/api/meetings/:id/room/roll", handleRoomRoll)
  .post("/api/meetings/:id/room/ask", handleRoomAsk)
  // === end Phase C ====
  // === How the room hears ===
  // Owner, 19 Sep 2026: "If I push Join on Meet what happens? Is it recording? Are my AI employees
  // there?" One read: the facts the During face's "How this room hears" line is chosen from — the
  // meeting's source, the firm default, the ingest cadence from its job row, the Meet inbox row,
  // the capture gates — and, for After, where its material came from with times.
  .get("/api/meetings/:id/hearing", handleHearing)
  // A partner joined the call from the app (Join on Meet, Beside the call, the laptop-mic path): the
  // meeting is in progress from that moment (0214). Idempotent; the first start wins.
  .post("/api/meetings/:id/started", handleMeetingStarted)
  // === end How the room hears ===
  // === Artifacts on demand ===
  // A dashboard, a deck or a document built from the record by the ONE producer (services/artifacts.ts)
  // and kept on the object it is about. The room's `build` intent and an ARTIFACT work card are the
  // two doors; this block is the shelf's own: ask directly, list and search, read one with its
  // versions, build again, export the same derivation the page shows as .pptx or .docx.
  .post("/api/artifacts", handleRequestArtifactBuild)
  .get("/api/artifacts", handleListBuiltArtifacts)
  .get("/api/artifacts/:id", handleGetBuiltArtifact)
  .post("/api/artifacts/:id/refresh", handleRebuildArtifact)
  .post("/api/artifacts/:id/retry", handleRebuildArtifact)
  .get("/api/artifacts/:id/export.pptx", handleExportArtifact)
  .get("/api/artifacts/:id/export.docx", handleExportArtifact)
  // === end Artifacts on demand ===
  // P8 — portfolio monitoring: dated metrics, deterministic alerts, support.
  .post("/api/portfolio/metric-definitions", handleCreateMetricDefinition)
  .get("/api/portfolio/metric-definitions", handleListMetricDefinitions)
  .post("/api/portfolio/updates", handleCreatePortfolioUpdate)
  // Item 12 — reporting off the back of those updates: month on month and quarter on quarter.
  .get("/api/portfolio/reporting", handlePortfolioReporting)
  .post("/api/portfolio/reporting/summary", handleDraftPortfolioSummary)
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
  // Item 7, route 3: Network OS proposing a company for OUR funnel. A proposal, so it lands as a
  // card for the analyst — the far system owns people, not this firm's pipeline.
  .post("/api/network/dealflow", handleNetworkCompanyPush)
  // P10 — LP / fundraising. LP data is LP_PRIVATE by default.
  // What an LP actually committed, and how big the fund is — the two questions the LP surface
  // could not answer at all before 21 Aug 2026.
  .post("/api/lp/commitments", handleRecordCommitment)
  .get("/api/lp/commitments", handleListCommitments)
  .get("/api/lp/fundraising", handleFundraisingSummary)
  // How the fund is actually doing. Reads Portfolio's marks and LP's capital; writes neither.
  .get("/api/funds/:id/performance", handleFundPerformance)
  // Wesley writes it. Nothing reaches an investor until a partner sends it.
  .post("/api/funds/:id/lp-report", handleDraftLpReport)
  // A mark is a fact about a HOLDING, so it is recorded against the position — Portfolio's surface.
  .post("/api/positions/:id/mark", handleMarkPosition)
  .post("/api/lp/capital-calls", handleRecordCall)
  .post("/api/lp/distributions", handleRecordDistribution)
  .patch("/api/funds/:id/size", handleSetFundSize)
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
  .post("/api/mp-home/modules/:key/seen", handleMarkModuleSeen)
  .post("/api/mp-home/visited", handleMarkRouteVisited)
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
  // The firmwide ceiling — this month and ever. Read back inside GET /api/ai/cost, because a budget
  // and the spend it governs belong on one payload or they arrive at the page at different times.
  .post("/api/ai/firm-budget", handleSetFirmBudget)
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
  // The firm's own methods: read both sources, write plain English, adopt what came back.
  .get("/api/firm-skills", handleListFirmSkills)
  .post("/api/firm-skills/draft", handleDraftFirmSkill)
  .post("/api/firm-skills/:id/adopt", handleAdoptFirmSkill)
  .post("/api/firm-skills/:id/retire", handleRetireFirmSkill)
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
  /*
   * P16 / migration 0187 — the two subscription seats on the owner's Mac. Three routes for the
   * claimer and one for a person asking why a card cost money. None of them can create work: the
   * claimer only ever takes a run the router already parked, authorised and classified.
   */
  .post("/api/subscription-seats/heartbeat", handleSubscriptionSeatHeartbeat)
  .post("/api/subscription-seats/claim", handleSubscriptionSeatClaim)
  .post("/api/subscription-seats/report", handleSubscriptionSeatReport)
  .post("/api/subscription-seats/progress", handleSubscriptionSeatProgress)
  .get("/api/subscription-seats/status", handleSubscriptionSeatStatus)
  .get("/api/jobs/runs/:id", handleGetJobRun)
  .post("/api/jobs/runs/:id/cancel", handleCancelJobRun)
  .post("/api/jobs/:key/run", handleRunJob)
  .post("/api/jobs/:key/status", handlePauseJob)
  // P20 — notifications. Literal routes before :id routes.
  .get("/api/notifications/preferences", handleGetNotificationPreferences)
  .post("/api/notifications/preferences", handleSetNotificationPreferences)
  .get("/api/notifications", handleListNotifications)
  .get("/api/notifications/:id/deliveries", handleNotificationDeliveries)
  // Literal before the :param, or "read-all" is read as a notification id.
  .post("/api/notifications/read-all", handleReadAllNotifications)
  .post("/api/notifications/:id/read", handleReadNotification)
  .post("/api/notifications/:id/acknowledge", handleAckNotification)
  // P21 — research workstation. Findings reach truth only through the P5 claim substrate.
  .post("/api/research/projects", handleCreateProject)
  .get("/api/research/projects", handleListProjects)
  .get("/api/research/projects/:id", handleGetProject)
  // Wyatt names what would settle the topic. Proposed, never created.
  // The 1:1. Research is a conversation with the analyst, not a form with two buttons.
  .get("/api/research/projects/:id/thread", handleResearchThread)
  .post("/api/research/projects/:id/reply", handleResearchReply)
  // Item 14: the panel on every hosted page. Keyed by nav key because a page is not a row.
  // ADR-018: authority the partners delegated ahead of time, within bounds.
  .get("/api/standing-authority", handleListStandingAuthority)
  .post("/api/standing-authority", handleGrantStandingAuthority)
  .post("/api/standing-authority/:id/revoke", handleRevokeStandingAuthority)
  .get("/api/pages/:navKey/thread", handlePageThread)
  .post("/api/pages/:navKey/reply", handlePageReply)
  .post("/api/research/projects/:id/propose-questions", handleProposeQuestions)
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
  .get("/api/allocation/scenarios/:id/strategy-view", handleAllocationStrategyView)
  // === Phase D: portfolio ===
  // Book it from the row (design §6, §12.4): ONE save walks the existing ladder — share class →
  // DRAFT transaction → the investment.approve card — and a partner's approval of that card
  // executes the booking (services/approvals.ts decideApproval → investment.ts bookOnApproval →
  // executeTransaction). Nothing here opens a position. A sale starts from the booked row (Q5) and
  // is a SECONDARY_SALE deal on Dealflow; a reserve is an MP write per company (0210).
  .post("/api/holdings/:company_id/book", handleBookHolding)
  .post("/api/holdings/:company_id/sell", handleSellHolding)
  .post("/api/positions/:id/reserve", handleReservePosition)
  // === end Phase D ===
  // === Phase Portfolio ===
  // What the firm owns, as ONE list: closed investments and booked positions, merged per company.
  // Composition and the deployment ring are computed from that list, so Portfolio and Fund
  // strategy cannot name different portfolios (services/portfolioHoldings.ts).
  .get("/api/portfolio/holdings", handlePortfolioHoldings)
  .get("/api/portfolio/composition", handlePortfolioComposition)
  .get("/api/portfolio/allocation", handlePortfolioAllocation);

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

  /*
   * CROSS-SITE WRITES ARE REFUSED (tier 3, 19 Sep 2026). The Meet add-on side panel is this app
   * in an iframe inside meet.google.com, authenticated by the partner's own Access session cookie
   * — which only reaches an iframe if the Access application sends it with SameSite=None. That
   * attribute also means a form on any other site could POST here carrying her cookie. So every
   * state-changing /api call must come from THIS origin: the browser says where a request came
   * from in `Sec-Fetch-Site` (the iframe's own fetches are `same-origin`), and a request that
   * says `cross-site` or `same-site` is refused before any handler runs. A request with no such
   * header — the Mac listener, the seat claimer, tests — is not a browser and is authenticated by
   * its service token instead. Pinned in tests/meetLive.test.ts.
   */
  if (request.method !== "GET" && request.method !== "HEAD") {
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") {
      return json({ error: "cross_site_refused", detail: `a ${request.method} to this system must come from its own origin (Sec-Fetch-Site: ${site})` }, { status: 403 });
    }
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
  /**
   * Inbound mail to the firm's machine inbox, delivered by Cloudflare Email Routing.
   *
   * Reads what arrived and records where each trigger says it belongs. It creates nothing: a
   * hashtag is a public word, so it may route but must never authorise, and every route lands as a
   * proposal a person accepts. See shared/intake/emailTriggers.ts for the table both this and
   * Porter's method read.
   *
   * UNPROVEN until Email Routing is enabled on joinwestpeek.com — no mail reaches this yet.
   */
  /*
   * AWAITED, NOT `waitUntil`ed — and that is a correctness change, not a style one.
   *
   * `message.raw` is a ReadableStream tied to the delivery of THIS message. `ctx.waitUntil` returns
   * from the handler immediately and lets the work continue afterwards, which is right for a
   * fire-and-forget side effect and wrong here: the very first thing `handleInboundEmail` does is
   * read that stream. Under local `wrangler dev` the consequence is exact and visible —
   *
   *   ✘ [ERROR] inbound email failed Error: ReadableStream received over RPC disconnected prematurely.
   *     at async handleInboundEmail (src/worker/effects/inboundEmail.ts:231)
   *
   * — and the message is then lost with no event, no work card and no capture, which is precisely
   * the silent-drop failure the rest of this file is written to prevent. Awaiting keeps the stream
   * alive for as long as the handler needs it. Nothing else changes: the `.catch` is still here, so
   * a throw is still logged rather than bounced back to the sender.
   */
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleInboundEmail(message, env).catch((err) => {
      // A handler that throws silently drops the message. Logged, because an inbox that loses
      // mail without saying so is worse than one that does not exist.
      console.error("inbound email failed", err);
    });
  },

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
