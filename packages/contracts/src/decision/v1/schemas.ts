import * as z from "zod";

import type { DecisionTaskResultV1, ExecuteDecisionTaskCommandV1 } from "./index.js";

const meaningfulTextSchema = z.string().refine((value) => value.trim().length > 0);

const contractHeader = {
  contractType: z.string().min(1),
  contractVersion: z.literal("1.0")
};

const quantitySchema = z.strictObject({
  amount: z.number().positive(),
  unit: z.string().min(1)
});

const requirementConstraintSchema = z.strictObject({
  key: z.string().min(1),
  operator: z.enum(["AT_LEAST", "AT_MOST", "EQUALS"]),
  value: quantitySchema
});

const requirementRevisionSchema = z
  .strictObject({
    ...contractHeader,
    contractType: z.literal("requirement-revision"),
    requirementRevisionId: z.string().min(1),
    decisionTaskId: z.string().min(1),
    revision: z.number().int().positive(),
    submittedText: meaningfulTextSchema,
    market: z.strictObject({
      country: z.literal("CN"),
      currency: z.literal("CNY"),
      locale: z.literal("zh-CN")
    }),
    intendedUses: z.array(meaningfulTextSchema).min(1),
    budget: z
      .strictObject({
        confirmed: z.boolean(),
        currency: z.literal("CNY"),
        hard: z.boolean(),
        maxAmountMinor: z.number().int().nonnegative()
      })
      .optional(),
    mustHaves: z.array(requirementConstraintSchema),
    niceToHaves: z.array(meaningfulTextSchema),
    mustNotHaves: z.array(meaningfulTextSchema),
    unknowns: z.array(meaningfulTextSchema)
  })
  .superRefine((requirementRevision, context) => {
    const seenKeys = new Set<string>();

    requirementRevision.mustHaves.forEach((constraint, index) => {
      if (seenKeys.has(constraint.key)) {
        context.addIssue({
          code: "custom",
          path: ["mustHaves", index, "key"],
          message: "must-have key 在 Requirement Revision 中必须唯一"
        });
      }

      seenKeys.add(constraint.key);
    });
  });

const utcTimestampSchema = z.iso.datetime({ offset: false });

const candidateSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("candidate"),
  candidateId: z.string().min(1),
  decisionTaskId: z.string().min(1),
  displayName: meaningfulTextSchema,
  synthetic: z.literal(true),
  identity: z.strictObject({
    model: z.string().min(1),
    sku: z.string().min(1),
    market: z.literal("CN"),
    configuration: meaningfulTextSchema
  }),
  observedPrice: z.strictObject({
    amountMinor: z.number().int().nonnegative(),
    currency: z.literal("CNY"),
    observedAt: utcTimestampSchema
  })
});

const claimValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("MONEY"),
    amountMinor: z.number().int().nonnegative(),
    currency: z.literal("CNY")
  }),
  z.strictObject({
    kind: z.literal("QUANTITY"),
    amount: z.number().nonnegative(),
    unit: z.string().min(1)
  }),
  z.strictObject({ kind: z.literal("BOOLEAN"), value: z.boolean() }),
  z.strictObject({ kind: z.literal("TEXT"), value: meaningfulTextSchema })
]);

const claimSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("claim"),
  claimId: z.string().min(1),
  decisionTaskId: z.string().min(1),
  subject: z.strictObject({
    subjectType: z.literal("CANDIDATE"),
    subjectId: z.string().min(1)
  }),
  predicate: z.string().min(1),
  value: claimValueSchema,
  claimKind: z.enum(["FACT_ASSERTION", "SOURCE_OPINION", "SYSTEM_INFERENCE"])
});

const evidenceSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("evidence"),
  evidenceId: z.string().min(1),
  decisionTaskId: z.string().min(1),
  synthetic: z.literal(true),
  source: z.strictObject({
    sourceKind: z.literal("SYNTHETIC"),
    sourceId: z.string().min(1),
    title: meaningfulTextSchema
  }),
  capturedAt: utcTimestampSchema,
  locator: z.strictObject({
    section: meaningfulTextSchema,
    field: meaningfulTextSchema
  }),
  excerpt: meaningfulTextSchema,
  validUntil: utcTimestampSchema
});

const claimEvidenceLinkSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("claim-evidence-link"),
  linkId: z.string().min(1),
  decisionTaskId: z.string().min(1),
  claimId: z.string().min(1),
  evidenceId: z.string().min(1),
  direction: z.enum(["SUPPORTS", "REFUTES"])
});

const claimAssessmentSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("claim-assessment"),
  claimId: z.string().min(1),
  evidenceState: z.enum(["SUPPORTED", "REFUTED", "CONFLICTED", "INSUFFICIENT"]),
  supportingEvidenceIds: z.array(z.string().min(1)),
  refutingEvidenceIds: z.array(z.string().min(1))
});

const decisionConditionSchema = z.discriminatedUnion("conditionType", [
  z.strictObject({
    conditionId: z.string().min(1),
    conditionType: z.literal("MAX_PRICE"),
    candidateId: z.string().min(1),
    amountMinor: z.number().int().nonnegative(),
    currency: z.literal("CNY"),
    verification: meaningfulTextSchema
  }),
  z.strictObject({
    conditionId: z.string().min(1),
    conditionType: z.literal("OFFICIAL_WARRANTY"),
    candidateId: z.string().min(1),
    verification: meaningfulTextSchema
  })
]);

const candidateDispositionSchema = z.strictObject({
  dispositionId: z.string().min(1),
  dispositionType: z.literal("ELIMINATED"),
  candidateId: z.string().min(1),
  requirementKey: z.string().min(1),
  reason: meaningfulTextSchema,
  evidenceIds: z.array(z.string().min(1)).min(1)
});

const decisionRiskSchema = z.strictObject({
  riskId: z.string().min(1),
  candidateId: z.string().min(1),
  statementClaimId: z.string().min(1),
  verification: meaningfulTextSchema
});

const criticalGapSchema = z.strictObject({
  gapId: z.string().min(1),
  key: z.string().min(1),
  question: meaningfulTextSchema,
  resolution: z.discriminatedUnion("resolutionType", [
    z.strictObject({
      resolutionType: z.literal("VERIFY_CONDITION"),
      conditionId: z.string().min(1)
    }),
    z.strictObject({
      resolutionType: z.literal("PROVIDE_REQUIREMENT"),
      requirementKey: z.string().min(1)
    })
  ])
});

const decisionNextStepSchema = z.discriminatedUnion("actionType", [
  z.strictObject({
    actionType: z.literal("PROVIDE_REQUIREMENT"),
    requirementKey: z.string().min(1),
    instruction: meaningfulTextSchema
  }),
  z.strictObject({
    actionType: z.literal("VERIFY_CONDITION"),
    conditionId: z.string().min(1),
    instruction: meaningfulTextSchema
  }),
  z.strictObject({
    actionType: z.literal("VERIFY_RISK"),
    riskId: z.string().min(1),
    instruction: meaningfulTextSchema
  })
]);

const decisionRevisionSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("decision-revision"),
  decisionRevisionId: z.string().min(1),
  decisionTaskId: z.string().min(1),
  requirementRevisionId: z.string().min(1),
  revision: z.number().int().positive(),
  status: z.enum([
    "BUY_NOW",
    "BUY_IF_PRICE",
    "WAIT",
    "KEEP_CURRENT",
    "NEED_MORE_INFO",
    "NO_MATCH",
    "REFUSE_RISK"
  ]),
  summary: meaningfulTextSchema,
  selectedCandidateId: z.string().min(1).optional(),
  conditions: z.array(decisionConditionSchema),
  candidateDispositions: z.array(candidateDispositionSchema),
  risks: z.array(decisionRiskSchema),
  evidenceIds: z.array(z.string().min(1)),
  criticalGaps: z.array(criticalGapSchema),
  assumptions: z.array(meaningfulTextSchema),
  validFrom: utcTimestampSchema,
  validUntil: utcTimestampSchema,
  nextSteps: z.array(decisionNextStepSchema),
  synthetic: z.literal(true)
});

const taskStateSchema = z.enum([
  "CREATED",
  "UNDERSTANDING",
  "PLANNING",
  "RESEARCHING",
  "VERIFYING",
  "GAP_RESEARCH",
  "COMPARING",
  "CRITIQUING",
  "GENERATING",
  "PAUSED_USER",
  "PAUSED_PERMISSION",
  "PAUSED_SOURCE_LOGIN",
  "PAUSED_LIMIT",
  "COMPLETED",
  "FAILED",
  "CANCELLED"
]);

const runEventSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("run-event"),
  eventId: z.string().min(1),
  decisionTaskId: z.string().min(1),
  agentRunId: z.string().min(1),
  sequence: z.number().int().positive(),
  occurredAt: utcTimestampSchema,
  eventType: z.enum(["TASK_STATE_CHANGED", "RUNTIME_SUCCEEDED", "RUNTIME_FAILED"]),
  taskState: taskStateSchema,
  summary: meaningfulTextSchema,
  synthetic: z.literal(true)
});

const completedTaskStatusSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("decision-task-status"),
  decisionTaskId: z.string().min(1),
  agentRunId: z.string().min(1),
  state: z.literal("COMPLETED"),
  terminal: z.literal(true),
  latestEventSequence: z.number().int().positive(),
  decisionRevisionId: z.string().min(1),
  updatedAt: utcTimestampSchema
});

const failedTaskStatusSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("decision-task-status"),
  decisionTaskId: z.string().min(1),
  agentRunId: z.string().min(1),
  state: z.literal("FAILED"),
  terminal: z.literal(true),
  latestEventSequence: z.number().int().positive(),
  errorId: z.string().min(1),
  updatedAt: utcTimestampSchema
});

const choiceMindErrorSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("choice-mind-error"),
  errorId: z.string().min(1),
  code: z.enum([
    "CONTRACT_INVALID",
    "CONTRACT_VERSION_UNSUPPORTED",
    "AGENT_RUNTIME_FAILED",
    "DECISION_EXECUTION_STATUS_UNKNOWN"
  ]),
  category: z.enum(["VALIDATION", "VERSION", "RUNTIME", "TRANSPORT"]),
  message: meaningfulTextSchema,
  retryMode: z.enum(["NONE", "SAME_EXECUTION_ONLY", "NEW_EXECUTION_ALLOWED"]),
  issues: z.array(
    z.strictObject({
      path: z.string(),
      message: meaningfulTextSchema
    })
  ),
  occurredAt: utcTimestampSchema
});

const decisionBundleDraftShape = {
  requirementRevision: requirementRevisionSchema,
  candidates: z.array(candidateSchema).min(1),
  claims: z.array(claimSchema),
  evidence: z.array(evidenceSchema),
  claimEvidenceLinks: z.array(claimEvidenceLinkSchema),
  decision: decisionRevisionSchema
};

const decisionBundleSchema = z.strictObject({
  ...decisionBundleDraftShape,
  claimAssessments: z.array(claimAssessmentSchema)
});

const decisionBundleDraftSchema = z.strictObject(decisionBundleDraftShape);

const successfulDecisionTaskResultSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("decision-task-result"),
  ok: z.literal(true),
  taskStatus: completedTaskStatusSchema,
  runEvents: z.array(runEventSchema).min(1),
  bundle: decisionBundleSchema
});

export const successfulDecisionTaskResultDraftSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("decision-task-result"),
  ok: z.literal(true),
  taskStatus: completedTaskStatusSchema,
  runEvents: z.array(runEventSchema).min(1),
  bundle: decisionBundleDraftSchema
});

const failedDecisionTaskResultSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("decision-task-result"),
  ok: z.literal(false),
  taskStatus: failedTaskStatusSchema,
  runEvents: z.array(runEventSchema).min(1),
  error: choiceMindErrorSchema
});

const rejectedDecisionTaskResultSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("decision-task-result"),
  ok: z.literal(false),
  error: choiceMindErrorSchema
});

export const executeDecisionTaskCommandSchema = z.strictObject({
  ...contractHeader,
  contractType: z.literal("execute-decision-task-command"),
  executionRequestId: z.string().min(1),
  requirementRevision: requirementRevisionSchema
});

export const decisionTaskResultSchema = z.union([
  successfulDecisionTaskResultSchema,
  failedDecisionTaskResultSchema,
  rejectedDecisionTaskResultSchema
]);

type DeepMutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
      : T;

type IsExact<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() =>
    Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() =>
        Value extends Left ? 1 : 2
      ? true
      : false
    : false;

type Assert<Type extends true> = Type;

const schemaContractConsistency: readonly [
  Assert<
    IsExact<
      z.output<typeof executeDecisionTaskCommandSchema>,
      DeepMutable<ExecuteDecisionTaskCommandV1>
    >
  >,
  Assert<
    IsExact<z.output<typeof decisionTaskResultSchema>, DeepMutable<DecisionTaskResultV1>>
  >
] = [true, true];

void schemaContractConsistency;
