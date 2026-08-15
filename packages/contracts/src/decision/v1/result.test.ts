import { describe, expect, it } from "vitest";

import {
  createContractRejectedDecisionTaskResultV1,
  createUnknownDecisionExecutionResultV1,
  decodeDecisionTaskResultV1,
  finalizeSuccessfulDecisionTaskResultV1,
  getDecisionTaskResultHttpStatusV1,
  type DecisionTaskResultV1
} from "./index.js";

type MutableFixture<Value> = Value extends readonly (infer Item)[]
  ? MutableFixture<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: MutableFixture<Value[Key]> }
    : Value;

describe("decodeDecisionTaskResultV1", () => {
  it("finalizes Runtime Claim/Evidence links into a canonical Claim Assessment", () => {
    const finalized = finalizeSuccessfulDecisionTaskResultV1(
      buildClaimEvidenceAuthorityDraft()
    );

    expect(finalized).toMatchObject({
      ok: true,
      value: {
        bundle: {
          claimAssessments: [
            {
              claimId: "claim-contract-test",
              contractType: "claim-assessment",
              contractVersion: "1.0",
              evidenceState: "SUPPORTED",
              refutingEvidenceIds: [],
              supportingEvidenceIds: ["evidence-contract-test"]
            }
          ]
        }
      }
    });

    if (!finalized.ok) {
      throw new Error("finalizer 应生成规范化 Claim Assessment");
    }

    expect(decodeDecisionTaskResultV1(finalized.value)).toMatchObject({ ok: true });
  });

  it("rejects a Runtime draft that attempts to author Claim Assessments", () => {
    const draft = buildClaimEvidenceAuthorityDraft();
    const bundle = draft.bundle as unknown as Record<string, unknown>;
    bundle.claimAssessments = [
      {
        contractType: "claim-assessment",
        contractVersion: "1.0",
        claimId: "claim-contract-test",
        evidenceState: "SUPPORTED",
        supportingEvidenceIds: ["evidence-contract-test"],
        refutingEvidenceIds: []
      }
    ];

    expect(finalizeSuccessfulDecisionTaskResultV1(draft)).toMatchObject({
      code: "CONTRACT_INVALID",
      ok: false
    });
  });

  it.each([
    { directions: [], expectedState: "INSUFFICIENT" },
    { directions: ["SUPPORTS"], expectedState: "SUPPORTED" },
    { directions: ["REFUTES"], expectedState: "REFUTED" },
    { directions: ["SUPPORTS", "REFUTES"], expectedState: "CONFLICTED" }
  ] as const)(
    "derives $expectedState from the complete eligible Evidence set",
    ({ directions, expectedState }) => {
      const draft = buildClaimEvidenceAuthorityDraft();
      draft.bundle.claims.push({
        contractType: "claim",
        contractVersion: "1.0",
        claimId: "claim-truth-table",
        decisionTaskId: "task-contract-test",
        subject: {
          subjectType: "CANDIDATE",
          subjectId: "candidate-contract-test"
        },
        predicate: "research.note",
        value: { kind: "TEXT", value: "合成真值表命题" },
        claimKind: "SYSTEM_INFERENCE"
      });
      const evidenceTemplate = requiredFirst(draft.bundle.evidence, "Evidence");

      directions.forEach((direction, index) => {
        const evidenceId = `evidence-truth-table-${index + 1}`;
        draft.bundle.evidence.push({
          ...structuredClone(evidenceTemplate),
          evidenceId,
          locator: { section: "truth-table", field: `${index + 1}` },
          excerpt: `合成${direction === "SUPPORTS" ? "支持" : "反驳"}证据`
        });
        draft.bundle.claimEvidenceLinks.push({
          contractType: "claim-evidence-link",
          contractVersion: "1.0",
          linkId: `link-truth-table-${index + 1}`,
          decisionTaskId: "task-contract-test",
          claimId: "claim-truth-table",
          evidenceId,
          direction
        });
      });

      const finalized = finalizeSuccessfulDecisionTaskResultV1(draft);

      expect(finalized).toMatchObject({
        ok: true,
        value: {
          bundle: {
            claimAssessments: expect.arrayContaining([
              expect.objectContaining({
                claimId: "claim-truth-table",
                evidenceState: expectedState
              })
            ])
          }
        }
      });
    }
  );

  it("rejects a canonical Result whose Claim Assessment was forged", () => {
    const finalized = finalizeSuccessfulDecisionTaskResultV1(
      buildClaimEvidenceAuthorityDraft()
    );

    if (!finalized.ok) {
      throw new Error("测试 fixture 必须能生成标准 Result");
    }

    const forged = structuredClone(finalized.value) as MutableFixture<
      typeof finalized.value
    >;
    requiredFirst(forged.bundle.claimAssessments, "Claim Assessment").evidenceState =
      "CONFLICTED";

    expect(decodeDecisionTaskResultV1(forged)).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.claimAssessments.0",
          message: "Claim Assessment 必须等于 Decision Basis 的规范化派生结果"
        }
      ]),
      ok: false
    });
  });

  it("keeps expired Evidence for traceability but excludes it from Assessment", () => {
    const draft = buildClaimEvidenceAuthorityDraft();
    draft.bundle.claims.push({
      contractType: "claim",
      contractVersion: "1.0",
      claimId: "claim-expired-evidence",
      decisionTaskId: "task-contract-test",
      subject: { subjectType: "CANDIDATE", subjectId: "candidate-contract-test" },
      predicate: "research.expired",
      value: { kind: "TEXT", value: "已过期的合成事实" },
      claimKind: "FACT_ASSERTION"
    });
    const evidenceTemplate = requiredFirst(draft.bundle.evidence, "Evidence");
    draft.bundle.evidence.push({
      ...structuredClone(evidenceTemplate),
      evidenceId: "evidence-expired",
      capturedAt: "2026-08-10T12:00:00.000Z",
      validUntil: "2026-08-11T12:00:00.000Z"
    });
    draft.bundle.claimEvidenceLinks.push({
      contractType: "claim-evidence-link",
      contractVersion: "1.0",
      linkId: "link-expired",
      decisionTaskId: "task-contract-test",
      claimId: "claim-expired-evidence",
      evidenceId: "evidence-expired",
      direction: "SUPPORTS"
    });

    expect(finalizeSuccessfulDecisionTaskResultV1(draft)).toMatchObject({
      ok: true,
      value: {
        bundle: {
          evidence: expect.arrayContaining([
            expect.objectContaining({ evidenceId: "evidence-expired" })
          ]),
          claimAssessments: expect.arrayContaining([
            {
              contractType: "claim-assessment",
              contractVersion: "1.0",
              claimId: "claim-expired-evidence",
              evidenceState: "INSUFFICIENT",
              supportingEvidenceIds: [],
              refutingEvidenceIds: []
            }
          ])
        }
      }
    });
  });

  it("rejects Evidence captured after the Decision becomes valid", () => {
    const draft = buildClaimEvidenceAuthorityDraft();
    requiredFirst(draft.bundle.evidence, "Evidence").capturedAt =
      "2026-08-13T12:00:00.000Z";

    expect(finalizeSuccessfulDecisionTaskResultV1(draft)).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.evidence.0.capturedAt",
          message: "Decision 不得引用形成时间之后采集的 Evidence"
        }
      ]),
      ok: false
    });
  });

  it.each(["SOURCE_OPINION", "SYSTEM_INFERENCE"] as const)(
    "does not let %s alone satisfy the selected Candidate hard budget",
    (claimKind) => {
      const draft = buildClaimEvidenceAuthorityDraft();
      requiredFirst(draft.bundle.claims, "Claim").claimKind = claimKind;

      expect(finalizeSuccessfulDecisionTaskResultV1(draft)).toMatchObject({
        code: "CONTRACT_INVALID",
        issues: expect.arrayContaining([
          {
            path: "bundle.decision.selectedCandidateId",
            message: "被选 Candidate 的价格事实必须满足已确认的硬预算"
          }
        ]),
        ok: false
      });
    }
  );

  it("strictly rejects the legacy Runtime-authored Claim status", () => {
    const finalized = finalizeSuccessfulDecisionTaskResultV1(
      buildClaimEvidenceAuthorityDraft()
    );

    if (!finalized.ok) {
      throw new Error("测试 fixture 必须能生成标准 Result");
    }

    const legacy = structuredClone(finalized.value) as MutableFixture<
      typeof finalized.value
    >;
    const claim = requiredFirst(legacy.bundle.claims, "Claim") as unknown as Record<
      string,
      unknown
    >;
    claim.status = "SUPPORTED";

    expect(decodeDecisionTaskResultV1(legacy)).toMatchObject({
      code: "CONTRACT_INVALID",
      ok: false
    });
  });

  it("accepts a completed decision with a closed evidence chain", () => {
    const result = decodeDecisionTaskResultV1(buildClosedDecisionResult());

    expect(result).toMatchObject({
      ok: true,
      value: {
        ok: true,
        bundle: { decision: { status: "BUY_IF_PRICE" } }
      }
    });
  });

  it("rejects a Decision whose Evidence closure omits the selected Candidate budget Evidence", () => {
    const input = buildClosedDecisionResult();
    addBudgetEliminatedCandidate(input);
    input.bundle.decision.evidenceIds = ["evidence-contract-z-price"];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.decision.evidenceIds",
          message: "被选 Candidate 的预算 Evidence 必须进入 Decision Evidence"
        })
      ]),
      ok: false
    });
  });

  it("rejects a Decision whose Evidence closure omits the selected Candidate must-have Evidence", () => {
    const input = buildClosedDecisionResult();
    input.bundle.requirementRevision.mustHaves = [
      {
        key: "memory.capacity",
        operator: "AT_LEAST",
        value: { amount: 32, unit: "GiB" }
      }
    ];
    input.bundle.claims.push({
      contractType: "claim",
      contractVersion: "1.0",
      claimId: "claim-contract-z-memory",
      decisionTaskId: input.taskStatus.decisionTaskId,
      subject: { subjectType: "CANDIDATE", subjectId: "candidate-contract-test" },
      predicate: "memory.capacity",
      value: { kind: "QUANTITY", amount: 32, unit: "GiB" },
      claimKind: "FACT_ASSERTION"
    });
    const evidenceTemplate = requiredFirst(input.bundle.evidence, "Evidence");
    input.bundle.evidence.push({
      ...structuredClone(evidenceTemplate),
      evidenceId: "evidence-contract-z-memory",
      locator: { section: "contract", field: "memory-capacity" },
      excerpt: "合成内存容量为 32 GiB"
    });
    input.bundle.claimEvidenceLinks.push({
      contractType: "claim-evidence-link",
      contractVersion: "1.0",
      linkId: "link-contract-z-memory",
      decisionTaskId: input.taskStatus.decisionTaskId,
      claimId: "claim-contract-z-memory",
      evidenceId: "evidence-contract-z-memory",
      direction: "SUPPORTS"
    });
    input.bundle.claimAssessments.push({
      contractType: "claim-assessment",
      contractVersion: "1.0",
      claimId: "claim-contract-z-memory",
      evidenceState: "SUPPORTED",
      supportingEvidenceIds: ["evidence-contract-z-memory"],
      refutingEvidenceIds: []
    });
    input.bundle.decision.evidenceIds = ["evidence-contract-test"];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.decision.evidenceIds",
          message: "被选 Candidate 的 must-have Evidence 必须进入 Decision Evidence"
        })
      ]),
      ok: false
    });
  });

  it("rejects a Runtime draft whose Evidence closure omits the selected Candidate budget Evidence", () => {
    const draft = buildClaimEvidenceAuthorityDraftWithEliminatedBudgetCandidate();
    draft.bundle.decision.evidenceIds = ["evidence-contract-z-price"];

    const result = finalizeSuccessfulDecisionTaskResultV1(draft);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.decision.evidenceIds",
          message: "被选 Candidate 的预算 Evidence 必须进入 Decision Evidence"
        })
      ]),
      ok: false
    });
  });

  it("canonically orders Claim Assessments by a fixed locale-independent rule", () => {
    const draft = buildClaimEvidenceAuthorityDraft();
    addUnlinkedLocaleOrderClaims(draft);

    const finalized = finalizeSuccessfulDecisionTaskResultV1(draft);

    if (!finalized.ok) {
      throw new Error("测试 fixture 必须能生成标准 Result");
    }

    expect(
      finalized.value.bundle.claimAssessments.map((assessment) => assessment.claimId)
    ).toEqual(["claim-contract-test", "claim-z", "claim-ä"]);
    expect(decodeDecisionTaskResultV1(finalized.value)).toMatchObject({ ok: true });
  });

  it("derives the same canonical Assessments regardless of Claim array order", () => {
    const draft = buildClaimEvidenceAuthorityDraft();
    addUnlinkedLocaleOrderClaims(draft);
    const reordered = structuredClone(draft);
    reordered.bundle.claims.reverse();

    const original = finalizeSuccessfulDecisionTaskResultV1(draft);
    const permuted = finalizeSuccessfulDecisionTaskResultV1(reordered);

    if (!original.ok || !permuted.ok) {
      throw new Error("测试 fixture 必须能生成标准 Result");
    }

    expect(permuted.value.bundle.claimAssessments).toEqual(
      original.value.bundle.claimAssessments
    );
  });

  it("rejects whitespace-only user-visible verification text", () => {
    const input = buildClosedDecisionResult();
    requiredFirst(input.bundle.decision.conditions, "Decision Condition").verification = "   ";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.conditions.0.verification",
          message: "字段不符合合同要求"
        }
      ]),
      ok: false
    });
  });

  it.each([
    {
      field: "Requirement submittedText",
      path: "bundle.requirementRevision.submittedText",
      mutate: (input: ReturnType<typeof buildClosedDecisionResult>) => {
        input.bundle.requirementRevision.submittedText = "   ";
      }
    },
    {
      field: "Requirement intended use",
      path: "bundle.requirementRevision.intendedUses.0",
      mutate: (input: ReturnType<typeof buildClosedDecisionResult>) => {
        input.bundle.requirementRevision.intendedUses[0] = "   ";
      }
    },
    {
      field: "Candidate displayName",
      path: "bundle.candidates.0.displayName",
      mutate: (input: ReturnType<typeof buildClosedDecisionResult>) => {
        requiredFirst(input.bundle.candidates, "Candidate").displayName = "   ";
      }
    },
    {
      field: "Candidate configuration",
      path: "bundle.candidates.0.identity.configuration",
      mutate: (input: ReturnType<typeof buildClosedDecisionResult>) => {
        requiredFirst(input.bundle.candidates, "Candidate").identity.configuration = "   ";
      }
    },
    {
      field: "Evidence source title",
      path: "bundle.evidence.0.source.title",
      mutate: (input: ReturnType<typeof buildClosedDecisionResult>) => {
        requiredFirst(input.bundle.evidence, "Evidence").source.title = "   ";
      }
    },
    {
      field: "Evidence locator",
      path: "bundle.evidence.0.locator.section",
      mutate: (input: ReturnType<typeof buildClosedDecisionResult>) => {
        requiredFirst(input.bundle.evidence, "Evidence").locator.section = "   ";
      }
    },
    {
      field: "Evidence excerpt",
      path: "bundle.evidence.0.excerpt",
      mutate: (input: ReturnType<typeof buildClosedDecisionResult>) => {
        requiredFirst(input.bundle.evidence, "Evidence").excerpt = "   ";
      }
    },
    {
      field: "Decision summary",
      path: "bundle.decision.summary",
      mutate: (input: ReturnType<typeof buildClosedDecisionResult>) => {
        input.bundle.decision.summary = "   ";
      }
    },
    {
      field: "Decision assumption",
      path: "bundle.decision.assumptions.0",
      mutate: (input: ReturnType<typeof buildClosedDecisionResult>) => {
        input.bundle.decision.assumptions = ["   "];
      }
    },
    {
      field: "Decision next-step instruction",
      path: "bundle.decision.nextSteps.0.instruction",
      mutate: (input: ReturnType<typeof buildClosedDecisionResult>) => {
        requiredFirst(input.bundle.decision.nextSteps, "Decision Next Step").instruction = "   ";
      }
    },
    {
      field: "RunEvent summary",
      path: "runEvents.0.summary",
      mutate: (input: ReturnType<typeof buildClosedDecisionResult>) => {
        requiredFirst(input.runEvents, "RunEvent").summary = "   ";
      }
    }
  ])("rejects whitespace-only $field", ({ mutate, path }) => {
    const input = buildClosedDecisionResult();
    mutate(input);

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([{ path, message: "字段不符合合同要求" }]),
      ok: false
    });
  });

  it.each([
    {
      field: "Candidate Disposition reason",
      path: "bundle.decision.candidateDispositions.0.reason",
      mutate: (input: ReturnType<typeof buildClosedDecisionResult>) => {
        input.bundle.decision.candidateDispositions = [
          {
            dispositionId: "disposition-contract-blank-reason",
            dispositionType: "ELIMINATED",
            candidateId: "candidate-contract-test",
            requirementKey: "budget.maxAmountMinor",
            reason: "   ",
            evidenceIds: ["evidence-contract-test"]
          }
        ];
      }
    },
    {
      field: "Critical Gap question",
      path: "bundle.decision.criticalGaps.0.question",
      mutate: (input: ReturnType<typeof buildClosedDecisionResult>) => {
        input.bundle.decision.criticalGaps = [
          {
            gapId: "gap-contract-blank-question",
            key: "price.current",
            question: "   ",
            resolution: {
              resolutionType: "VERIFY_CONDITION",
              conditionId: "condition-contract-test"
            }
          }
        ];
      }
    },
    {
      field: "Decision Risk verification",
      path: "bundle.decision.risks.0.verification",
      mutate: (input: ReturnType<typeof buildClosedDecisionResult>) => {
        input.bundle.decision.risks = [
          {
            riskId: "risk-contract-blank-verification",
            candidateId: "candidate-contract-test",
            statementClaimId: "claim-contract-test",
            verification: "   "
          }
        ];
      }
    }
  ])("rejects whitespace-only $field", ({ mutate, path }) => {
    const input = buildClosedDecisionResult();
    mutate(input);

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([{ path, message: "字段不符合合同要求" }]),
      ok: false
    });
  });

  it("accepts structured next steps and rejects the legacy string format", () => {
    const structuredInput = buildClosedDecisionResult();
    structuredInput.bundle.decision.nextSteps = [
      {
        actionType: "VERIFY_CONDITION",
        conditionId: "condition-contract-test",
        instruction: "核验价格"
      }
    ];
    const legacyInput = buildClosedDecisionResult();
    (legacyInput.bundle.decision as { nextSteps: unknown }).nextSteps = ["核验价格"];

    const structured = decodeDecisionTaskResultV1(structuredInput);
    const legacy = decodeDecisionTaskResultV1(legacyInput);

    expect([structured.ok, legacy.ok]).toEqual([true, false]);
  });

  it("rejects a next step that references a missing Decision Condition", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.nextSteps = [
      {
        actionType: "VERIFY_CONDITION",
        conditionId: "condition-missing",
        instruction: "核验不存在的条件"
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.nextSteps.0.conditionId",
          message: "VERIFY_CONDITION 必须引用存在的 Decision Condition"
        }
      ]),
      ok: false
    });
  });

  it("rejects a next step that references a missing Decision Risk", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.nextSteps = [
      {
        actionType: "VERIFY_RISK",
        riskId: "risk-missing",
        instruction: "核验不存在的风险"
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.nextSteps.0.riskId",
          message: "VERIFY_RISK 必须引用存在的 Decision Risk"
        }
      ]),
      ok: false
    });
  });

  it("rejects a Decision Condition without a verification next step", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.nextSteps = [];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.conditions.0.conditionId",
          message: "每个 Decision Condition 必须有对应的 VERIFY_CONDITION next step"
        }
      ]),
      ok: false
    });
  });

  it("rejects error metadata that does not match the fixed error code semantics", () => {
    const input = buildRejectedDecisionResult();
    input.error.category = "VALIDATION";
    input.error.retryMode = "NONE";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "error.category",
          message: "错误分类必须与错误码的固定语义一致"
        },
        {
          path: "error.retryMode",
          message: "重试模式必须与错误码的固定语义一致"
        }
      ]),
      ok: false
    });
  });

  it("rejects a runtime failure without the failed task status and run events", () => {
    const input = buildRejectedDecisionResult();
    input.error.code = "FAKE_RUNTIME_FAILED";
    input.error.category = "RUNTIME";
    input.error.retryMode = "NEW_EXECUTION_ALLOWED";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "error.code",
          message: "FAKE_RUNTIME_FAILED 必须属于已创建任务的失败结果"
        }
      ]),
      ok: false
    });
  });

  it("rejects a decision that references missing evidence", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.evidenceIds = ["evidence-missing"];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.evidenceIds.0",
          message: "Decision 引用了不存在的 Evidence"
        }
      ]),
      ok: false
    });
  });

  it("rejects a decision without any supporting evidence", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.evidenceIds = [];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.evidenceIds",
          message: "Decision 必须引用至少一条 Evidence"
        }
      ]),
      ok: false
    });
  });

  it("rejects a decision from a different decision task", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.decisionTaskId = "task-other";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.decision.decisionTaskId",
          message: "Decision Revision 必须属于结果中的 Decision Task"
        })
      ]),
      ok: false
    });
  });

  it("rejects a decision that references a different requirement revision", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.requirementRevisionId = "req-other-r1";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.decision.requirementRevisionId",
          message: "Decision 必须引用结果中的 Requirement Revision"
        })
      ]),
      ok: false
    });
  });

  it("rejects an unsupported nested evidence contract version explicitly", () => {
    const input = buildClosedDecisionResult();
    (
      requiredFirst(input.bundle.evidence, "Evidence") as { contractVersion: string }
    ).contractVersion = "2.0";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [
        {
          path: "bundle.evidence.0.contractVersion",
          message: "仅支持合同版本 1.0"
        }
      ],
      ok: false
    });
  });

  it("rejects a timestamp that only looks like UTC by its suffix", () => {
    const input = buildClosedDecisionResult();
    requiredFirst(input.bundle.candidates, "Candidate").observedPrice.observedAt = "not-a-timeZ";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.candidates.0.observedPrice.observedAt"
        })
      ]),
      ok: false
    });
  });

  it("rejects a run event sequence that does not start at one", () => {
    const input = buildClosedDecisionResult();
    requiredFirst(input.runEvents, "RunEvent").sequence = 2;

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "runEvents.0.sequence",
          message: "RunEvent 序号必须从 1 开始严格递增"
        })
      ]),
      ok: false
    });
  });

  it("rejects duplicate RunEvent identifiers", () => {
    const input = buildClosedDecisionResult();
    const firstEvent = requiredFirst(input.runEvents, "RunEvent");
    const secondEvent = input.runEvents[1];

    if (secondEvent === undefined) {
      throw new Error("测试 fixture 缺少第二个 RunEvent");
    }

    secondEvent.eventId = firstEvent.eventId;

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "runEvents.1.eventId",
          message: "RunEvent ID 在结果中必须唯一"
        }
      ]),
      ok: false
    });
  });

  it("rejects a completed task that skips required run stages", () => {
    const input = buildClosedDecisionResult();
    const createdEvent = requiredFirst(input.runEvents, "RunEvent");
    const understandingEvent = input.runEvents[1];
    const completedEvent = requiredLast(input.runEvents, "RunEvent");

    if (understandingEvent === undefined) {
      throw new Error("测试 fixture 缺少 UNDERSTANDING RunEvent");
    }

    input.runEvents = [createdEvent, understandingEvent, completedEvent].map((event, index) => ({
      ...event,
      eventId: `event-contract-skipped-${index + 1}`,
      sequence: index + 1
    }));
    input.taskStatus.latestEventSequence = 3;
    input.taskStatus.updatedAt = completedEvent.occurredAt;

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "runEvents.2.taskState",
          message: "成功结果的 RunEvent 必须按固定阶段顺序迁移"
        })
      ]),
      ok: false
    });
  });

  it("rejects a completed task whose intermediate event reports runtime failure", () => {
    const input = buildClosedDecisionResult();
    const understandingEvent = input.runEvents[1];

    if (understandingEvent === undefined) {
      throw new Error("测试 fixture 缺少 UNDERSTANDING RunEvent");
    }

    (understandingEvent as { eventType: string }).eventType = "RUNTIME_FAILED";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "runEvents.1.eventType",
          message: "成功结果的中间 RunEvent 必须是任务状态变化"
        }
      ]),
      ok: false
    });
  });

  it("rejects a completed task whose final event is not completed", () => {
    const input = buildClosedDecisionResult();
    const finalEvent = requiredLast(input.runEvents, "RunEvent");
    finalEvent.eventType = "TASK_STATE_CHANGED";
    finalEvent.taskState = "RESEARCHING";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "runEvents.8.taskState",
          message: "成功结果的最后事件必须是 COMPLETED"
        })
      ]),
      ok: false
    });
  });

  it("rejects a completed task without a runtime success event", () => {
    const input = buildClosedDecisionResult();
    requiredLast(input.runEvents, "RunEvent").eventType = "TASK_STATE_CHANGED";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "runEvents.8.eventType",
          message: "成功结果的最后事件必须是 RUNTIME_SUCCEEDED"
        })
      ]),
      ok: false
    });
  });

  it("rejects a task status whose latest event sequence is stale", () => {
    const input = buildClosedDecisionResult();
    input.taskStatus.latestEventSequence = 2;

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "taskStatus.latestEventSequence",
          message: "Task Status 必须指向最后一个 RunEvent"
        })
      ]),
      ok: false
    });
  });

  it("rejects a task status whose update time differs from the final event", () => {
    const input = buildClosedDecisionResult();
    input.taskStatus.updatedAt = "2026-08-12T12:00:01.000Z";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "taskStatus.updatedAt",
          message: "Task Status 更新时间必须等于最后一个 RunEvent 时间"
        })
      ]),
      ok: false
    });
  });

  it("rejects a task status that points to another decision revision", () => {
    const input = buildClosedDecisionResult();
    input.taskStatus.decisionRevisionId = "decision-other-r1";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "taskStatus.decisionRevisionId",
          message: "Task Status 必须指向结果中的 Decision Revision"
        })
      ]),
      ok: false
    });
  });

  it("rejects a run event from a different decision task", () => {
    const input = buildClosedDecisionResult();
    requiredFirst(input.runEvents, "RunEvent").decisionTaskId = "task-other";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "runEvents.0.decisionTaskId",
          message: "RunEvent 必须属于结果中的 Decision Task"
        })
      ]),
      ok: false
    });
  });

  it("rejects a run event from a different agent run", () => {
    const input = buildClosedDecisionResult();
    requiredFirst(input.runEvents, "RunEvent").agentRunId = "run-other";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "runEvents.0.agentRunId",
          message: "RunEvent 必须属于 Task Status 中的 Agent Run"
        })
      ]),
      ok: false
    });
  });

  it("rejects a failed task whose final event is not failed", () => {
    const input = buildFailedDecisionResult();
    requiredFirst(input.runEvents, "RunEvent").eventType = "RUNTIME_SUCCEEDED";
    requiredFirst(input.runEvents, "RunEvent").taskState = "COMPLETED";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "runEvents.0.taskState",
          message: "失败结果的最后事件必须是 FAILED"
        })
      ]),
      ok: false
    });
  });

  it("rejects a failed task without a runtime failure event", () => {
    const input = buildFailedDecisionResult();
    requiredFirst(input.runEvents, "RunEvent").eventType = "TASK_STATE_CHANGED";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "runEvents.0.eventType",
          message: "失败结果的最后事件必须是 RUNTIME_FAILED"
        })
      ]),
      ok: false
    });
  });

  it("rejects a failed task whose status points to another error", () => {
    const input = buildFailedDecisionResult();
    input.taskStatus.errorId = "error-other";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "taskStatus.errorId",
          message: "Task Status 必须指向结果中的 Error"
        })
      ]),
      ok: false
    });
  });

  it("rejects a candidate from a different decision task", () => {
    const input = buildClosedDecisionResult();
    requiredFirst(input.bundle.candidates, "Candidate").decisionTaskId = "task-other";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.candidates.0.decisionTaskId",
          message: "Candidate 必须属于结果中的 Decision Task"
        })
      ]),
      ok: false
    });
  });

  it("rejects duplicate Candidate identifiers", () => {
    const input = buildClosedDecisionResult();
    const candidate = requiredFirst(input.bundle.candidates, "Candidate");
    input.bundle.candidates.push({
      ...structuredClone(candidate),
      displayName: "重复 ID 的合成候选",
      identity: {
        ...candidate.identity,
        sku: "CM-SYNTH-CONTRACT-DUPLICATE"
      }
    });

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.candidates.1.candidateId",
          message: "Candidate ID 在结果中必须唯一"
        }
      ]),
      ok: false
    });
  });

  it("rejects a requirement revision from a different decision task", () => {
    const input = buildClosedDecisionResult();
    input.bundle.requirementRevision.decisionTaskId = "task-other";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.requirementRevision.decisionTaskId",
          message: "Requirement Revision 必须属于结果中的 Decision Task"
        })
      ]),
      ok: false
    });
  });

  it("rejects BUY_IF_PRICE without a verifiable condition", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.conditions = [];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.decision.conditions",
          message: "BUY_IF_PRICE 必须包含至少一个可核验条件"
        })
      ]),
      ok: false
    });
  });

  it("rejects a MAX_PRICE condition above the confirmed hard budget", () => {
    const input = buildClosedDecisionResult();
    const condition = requiredFirst(input.bundle.decision.conditions, "Decision Condition");

    if (condition.conditionType !== "MAX_PRICE") {
      throw new Error("测试 fixture 必须包含 MAX_PRICE 条件");
    }

    condition.amountMinor = 100001;

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.conditions.0.amountMinor",
          message: "MAX_PRICE 条件不得超过已确认硬预算"
        }
      ]),
      ok: false
    });
  });

  it("rejects a decision that selects a missing candidate", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.selectedCandidateId = "candidate-missing";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.decision.selectedCandidateId",
          message: "Decision 必须选择结果中存在的 Candidate"
        })
      ]),
      ok: false
    });
  });

  it("rejects a selected Candidate that violates a must-have", () => {
    const input = buildClosedDecisionResult();
    input.bundle.requirementRevision.mustHaves = [
      {
        key: "memory.capacity",
        operator: "AT_LEAST",
        value: { amount: 64, unit: "GiB" }
      }
    ];
    input.bundle.claims.push({
      contractType: "claim",
      contractVersion: "1.0",
      claimId: "claim-contract-memory",
      decisionTaskId: "task-contract-test",
      subject: {
        subjectType: "CANDIDATE",
        subjectId: "candidate-contract-test"
      },
      predicate: "memory.capacity",
      value: { kind: "QUANTITY", amount: 32, unit: "GiB" },
      claimKind: "FACT_ASSERTION"
    });
    input.bundle.evidence.push({
      contractType: "evidence",
      contractVersion: "1.0",
      evidenceId: "evidence-contract-memory",
      decisionTaskId: "task-contract-test",
      synthetic: true,
      source: {
        sourceKind: "SYNTHETIC",
        sourceId: "source-contract-test",
        title: "合成合同资料"
      },
      capturedAt: "2026-08-12T12:00:00.000Z",
      locator: { section: "contract", field: "memory" },
      excerpt: "合成内存容量为 32 GiB",
      validUntil: "2026-08-19T12:00:00.000Z"
    });
    addClaimEvidenceLink(
      input,
      "claim-contract-memory",
      "evidence-contract-memory",
      "SUPPORTS"
    );

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.selectedCandidateId",
          message: "被选 Candidate 必须满足每项 must-have"
        }
      ]),
      ok: false
    });
  });

  it("rejects a selected Candidate when the fact unit does not exactly match the must-have", () => {
    const input = buildClosedDecisionResult();
    input.bundle.requirementRevision.mustHaves = [
      {
        key: "memory.capacity",
        operator: "AT_LEAST",
        value: { amount: 32, unit: "GiB" }
      }
    ];
    input.bundle.claims.push({
      contractType: "claim",
      contractVersion: "1.0",
      claimId: "claim-contract-memory-gb",
      decisionTaskId: "task-contract-test",
      subject: {
        subjectType: "CANDIDATE",
        subjectId: "candidate-contract-test"
      },
      predicate: "memory.capacity",
      value: { kind: "QUANTITY", amount: 32, unit: "GB" },
      claimKind: "FACT_ASSERTION"
    });
    input.bundle.evidence.push({
      contractType: "evidence",
      contractVersion: "1.0",
      evidenceId: "evidence-contract-memory-gb",
      decisionTaskId: "task-contract-test",
      synthetic: true,
      source: {
        sourceKind: "SYNTHETIC",
        sourceId: "source-contract-test",
        title: "合成合同资料"
      },
      capturedAt: "2026-08-12T12:00:00.000Z",
      locator: { section: "contract", field: "memory" },
      excerpt: "合成内存容量为 32 GB",
      validUntil: "2026-08-19T12:00:00.000Z"
    });
    addClaimEvidenceLink(
      input,
      "claim-contract-memory-gb",
      "evidence-contract-memory-gb",
      "SUPPORTS"
    );

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.selectedCandidateId",
          message: "被选 Candidate 必须满足每项 must-have"
        }
      ]),
      ok: false
    });
  });

  it("rejects a selected Candidate whose must-have facts conflict", () => {
    const input = buildClosedDecisionResult();
    input.bundle.requirementRevision.mustHaves = [
      {
        key: "memory.capacity",
        operator: "AT_LEAST",
        value: { amount: 32, unit: "GiB" }
      }
    ];
    input.bundle.claims.push(
      {
        contractType: "claim",
        contractVersion: "1.0",
        claimId: "claim-contract-memory-32",
        decisionTaskId: "task-contract-test",
        subject: {
          subjectType: "CANDIDATE",
          subjectId: "candidate-contract-test"
        },
        predicate: "memory.capacity",
        value: { kind: "QUANTITY", amount: 32, unit: "GiB" },
        claimKind: "FACT_ASSERTION"
      },
      {
        contractType: "claim",
        contractVersion: "1.0",
        claimId: "claim-contract-memory-64",
        decisionTaskId: "task-contract-test",
        subject: {
          subjectType: "CANDIDATE",
          subjectId: "candidate-contract-test"
        },
        predicate: "memory.capacity",
        value: { kind: "QUANTITY", amount: 64, unit: "GiB" },
        claimKind: "FACT_ASSERTION"
      }
    );
    input.bundle.evidence.push(
      {
        contractType: "evidence",
        contractVersion: "1.0",
        evidenceId: "evidence-contract-memory-32",
        decisionTaskId: "task-contract-test",
        synthetic: true,
        source: {
          sourceKind: "SYNTHETIC",
          sourceId: "source-contract-test",
          title: "合成合同资料"
        },
        capturedAt: "2026-08-12T12:00:00.000Z",
        locator: { section: "contract", field: "memory-a" },
        excerpt: "合成内存容量为 32 GiB",
        validUntil: "2026-08-19T12:00:00.000Z"
      },
      {
        contractType: "evidence",
        contractVersion: "1.0",
        evidenceId: "evidence-contract-memory-64",
        decisionTaskId: "task-contract-test",
        synthetic: true,
        source: {
          sourceKind: "SYNTHETIC",
          sourceId: "source-contract-test",
          title: "合成合同资料"
        },
        capturedAt: "2026-08-12T12:00:00.000Z",
        locator: { section: "contract", field: "memory-b" },
        excerpt: "合成内存容量为 64 GiB",
        validUntil: "2026-08-19T12:00:00.000Z"
      }
    );
    addClaimEvidenceLink(
      input,
      "claim-contract-memory-32",
      "evidence-contract-memory-32",
      "SUPPORTS"
    );
    addClaimEvidenceLink(
      input,
      "claim-contract-memory-64",
      "evidence-contract-memory-64",
      "SUPPORTS"
    );

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.selectedCandidateId",
          message: "被选 Candidate 必须满足每项 must-have"
        }
      ]),
      ok: false
    });
  });

  it("rejects a selected Candidate when one must-have Claim has conflicting Evidence", () => {
    const input = buildClosedDecisionResult();
    input.bundle.requirementRevision.mustHaves = [
      {
        key: "memory.capacity",
        operator: "AT_LEAST",
        value: { amount: 32, unit: "GiB" }
      }
    ];
    const claim = requiredFirst(input.bundle.claims, "Claim");
    claim.predicate = "memory.capacity";
    claim.value = { kind: "QUANTITY", amount: 32, unit: "GiB" };
    const supportingEvidence = requiredFirst(input.bundle.evidence, "Evidence");
    input.bundle.evidence.push({
      ...structuredClone(supportingEvidence),
      evidenceId: "evidence-contract-memory-refutes",
      locator: { section: "contract", field: "memory-conflict" },
      excerpt: "另一条合成证据反驳该内存容量"
    });
    addClaimEvidenceLink(
      input,
      claim.claimId,
      "evidence-contract-memory-refutes",
      "REFUTES"
    );

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.selectedCandidateId",
          message: "被选 Candidate 必须满足每项 must-have"
        }
      ]),
      ok: false
    });
  });

  it("rejects a compared candidate that is neither selected nor given a disposition", () => {
    const input = buildClosedDecisionResult();
    const selectedCandidate = requiredFirst(input.bundle.candidates, "Candidate");
    input.bundle.candidates.push({
      ...structuredClone(selectedCandidate),
      candidateId: "candidate-contract-unaccounted",
      identity: {
        ...selectedCandidate.identity,
        sku: "CM-SYNTH-CONTRACT-2"
      }
    });

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.candidates.1.candidateId",
          message: "未选 Candidate 必须拥有 Candidate Disposition"
        })
      ]),
      ok: false
    });
  });

  it("rejects a decision condition for a missing candidate", () => {
    const input = buildClosedDecisionResult();
    requiredFirst(input.bundle.decision.conditions, "Decision Condition").candidateId =
      "candidate-missing";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.decision.conditions.0.candidateId",
          message: "Decision Condition 必须关联存在的 Candidate"
        })
      ]),
      ok: false
    });
  });

  it("rejects a decision condition for a Candidate that was not selected", () => {
    const input = buildClosedDecisionResult();
    const selectedCandidate = requiredFirst(input.bundle.candidates, "Candidate");
    input.bundle.candidates.push({
      ...structuredClone(selectedCandidate),
      candidateId: "candidate-contract-eliminated",
      identity: {
        ...selectedCandidate.identity,
        sku: "CM-SYNTH-CONTRACT-ELIMINATED"
      },
      observedPrice: {
        ...selectedCandidate.observedPrice,
        amountMinor: 120000
      }
    });
    input.bundle.claims.push({
      contractType: "claim",
      contractVersion: "1.0",
      claimId: "claim-contract-eliminated-price",
      decisionTaskId: "task-contract-test",
      subject: {
        subjectType: "CANDIDATE",
        subjectId: "candidate-contract-eliminated"
      },
      predicate: "price.observed",
      value: { kind: "MONEY", amountMinor: 120000, currency: "CNY" },
      claimKind: "FACT_ASSERTION"
    });
    input.bundle.evidence.push({
      contractType: "evidence",
      contractVersion: "1.0",
      evidenceId: "evidence-contract-eliminated-price",
      decisionTaskId: "task-contract-test",
      synthetic: true,
      source: {
        sourceKind: "SYNTHETIC",
        sourceId: "source-contract-test",
        title: "合成合同资料"
      },
      capturedAt: "2026-08-12T12:00:00.000Z",
      locator: { section: "contract", field: "price" },
      excerpt: "合成价格为 1200 元",
      validUntil: "2026-08-19T12:00:00.000Z"
    });
    addClaimEvidenceLink(
      input,
      "claim-contract-eliminated-price",
      "evidence-contract-eliminated-price",
      "SUPPORTS"
    );
    input.bundle.decision.candidateDispositions = [
      {
        dispositionId: "disposition-contract-budget",
        dispositionType: "ELIMINATED",
        candidateId: "candidate-contract-eliminated",
        requirementKey: "budget.maxAmountMinor",
        reason: "合成价格超过硬预算",
        evidenceIds: ["evidence-contract-eliminated-price"]
      }
    ];
    requiredFirst(input.bundle.decision.conditions, "Decision Condition").candidateId =
      "candidate-contract-eliminated";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.conditions.0.candidateId",
          message: "Decision Condition 必须关联被选 Candidate"
        }
      ]),
      ok: false
    });
  });

  it("rejects a selected Candidate when its price facts conflict", () => {
    const input = buildClosedDecisionResult();
    input.bundle.claims.push({
      contractType: "claim",
      contractVersion: "1.0",
      claimId: "claim-contract-selected-price-conflict",
      decisionTaskId: "task-contract-test",
      subject: {
        subjectType: "CANDIDATE",
        subjectId: "candidate-contract-test"
      },
      predicate: "price.observed",
      value: { kind: "MONEY", amountMinor: 120000, currency: "CNY" },
      claimKind: "FACT_ASSERTION"
    });
    input.bundle.evidence.push({
      contractType: "evidence",
      contractVersion: "1.0",
      evidenceId: "evidence-contract-selected-price-conflict",
      decisionTaskId: "task-contract-test",
      synthetic: true,
      source: {
        sourceKind: "SYNTHETIC",
        sourceId: "source-contract-test",
        title: "合成合同资料"
      },
      capturedAt: "2026-08-12T12:00:00.000Z",
      locator: { section: "contract", field: "selected-price-conflict" },
      excerpt: "同一合成候选的另一条价格为 1200 元",
      validUntil: "2026-08-19T12:00:00.000Z"
    });
    addClaimEvidenceLink(
      input,
      "claim-contract-selected-price-conflict",
      "evidence-contract-selected-price-conflict",
      "SUPPORTS"
    );

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.selectedCandidateId",
          message: "被选 Candidate 的价格事实必须满足已确认的硬预算"
        }
      ]),
      ok: false
    });
  });

  it("rejects an elimination record for a missing candidate", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.candidateDispositions = [
      {
        dispositionId: "disposition-contract-test",
        dispositionType: "ELIMINATED",
        candidateId: "candidate-missing",
        requirementKey: "budget.maxAmountMinor",
        reason: "合成候选超过硬预算",
        evidenceIds: ["evidence-contract-test"]
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.decision.candidateDispositions.0.candidateId",
          message: "Candidate Disposition 必须关联存在的 Candidate"
        })
      ]),
      ok: false
    });
  });

  it("rejects an elimination record that references missing evidence", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.candidateDispositions = [
      {
        dispositionId: "disposition-contract-test",
        dispositionType: "ELIMINATED",
        candidateId: "candidate-contract-test",
        requirementKey: "budget.maxAmountMinor",
        reason: "合成候选超过硬预算",
        evidenceIds: ["evidence-missing"]
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.decision.candidateDispositions.0.evidenceIds.0",
          message: "Candidate Disposition 引用了不存在的 Evidence"
        })
      ]),
      ok: false
    });
  });

  it("rejects an elimination record that cites an unrelated Requirement", () => {
    const input = buildClosedDecisionResult();
    const selectedCandidate = requiredFirst(input.bundle.candidates, "Candidate");
    input.bundle.candidates.push({
      ...structuredClone(selectedCandidate),
      candidateId: "candidate-contract-eliminated",
      identity: {
        ...selectedCandidate.identity,
        sku: "CM-SYNTH-CONTRACT-ELIMINATED"
      },
      observedPrice: {
        ...selectedCandidate.observedPrice,
        amountMinor: 120000
      }
    });
    input.bundle.claims.push({
      contractType: "claim",
      contractVersion: "1.0",
      claimId: "claim-contract-eliminated-price",
      decisionTaskId: "task-contract-test",
      subject: {
        subjectType: "CANDIDATE",
        subjectId: "candidate-contract-eliminated"
      },
      predicate: "price.observed",
      value: { kind: "MONEY", amountMinor: 120000, currency: "CNY" },
      claimKind: "FACT_ASSERTION"
    });
    input.bundle.evidence.push({
      contractType: "evidence",
      contractVersion: "1.0",
      evidenceId: "evidence-contract-eliminated-price",
      decisionTaskId: "task-contract-test",
      synthetic: true,
      source: {
        sourceKind: "SYNTHETIC",
        sourceId: "source-contract-test",
        title: "合成合同资料"
      },
      capturedAt: "2026-08-12T12:00:00.000Z",
      locator: { section: "contract", field: "price" },
      excerpt: "合成价格为 1200 元",
      validUntil: "2026-08-19T12:00:00.000Z"
    });
    addClaimEvidenceLink(
      input,
      "claim-contract-eliminated-price",
      "evidence-contract-eliminated-price",
      "SUPPORTS"
    );
    input.bundle.decision.candidateDispositions = [
      {
        dispositionId: "disposition-contract-unrelated",
        dispositionType: "ELIMINATED",
        candidateId: "candidate-contract-eliminated",
        requirementKey: "unrelated.constraint",
        reason: "使用了无关约束",
        evidenceIds: ["evidence-contract-eliminated-price"]
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.candidateDispositions.0.requirementKey",
          message: "ELIMINATED Disposition 必须引用真实 Hard Constraint"
        }
      ]),
      ok: false
    });
  });

  it("rejects a budget elimination whose Evidence does not prove the budget was exceeded", () => {
    const input = buildClosedDecisionResult();
    const selectedCandidate = requiredFirst(input.bundle.candidates, "Candidate");
    input.bundle.candidates.push({
      ...structuredClone(selectedCandidate),
      candidateId: "candidate-contract-within-budget",
      identity: {
        ...selectedCandidate.identity,
        sku: "CM-SYNTH-CONTRACT-WITHIN-BUDGET"
      },
      observedPrice: {
        ...selectedCandidate.observedPrice,
        amountMinor: 90000
      }
    });
    input.bundle.claims.push({
      contractType: "claim",
      contractVersion: "1.0",
      claimId: "claim-contract-within-budget-price",
      decisionTaskId: "task-contract-test",
      subject: {
        subjectType: "CANDIDATE",
        subjectId: "candidate-contract-within-budget"
      },
      predicate: "price.observed",
      value: { kind: "MONEY", amountMinor: 90000, currency: "CNY" },
      claimKind: "FACT_ASSERTION"
    });
    input.bundle.evidence.push({
      contractType: "evidence",
      contractVersion: "1.0",
      evidenceId: "evidence-contract-within-budget-price",
      decisionTaskId: "task-contract-test",
      synthetic: true,
      source: {
        sourceKind: "SYNTHETIC",
        sourceId: "source-contract-test",
        title: "合成合同资料"
      },
      capturedAt: "2026-08-12T12:00:00.000Z",
      locator: { section: "contract", field: "price" },
      excerpt: "合成价格为 900 元",
      validUntil: "2026-08-19T12:00:00.000Z"
    });
    addClaimEvidenceLink(
      input,
      "claim-contract-within-budget-price",
      "evidence-contract-within-budget-price",
      "SUPPORTS"
    );
    input.bundle.decision.candidateDispositions = [
      {
        dispositionId: "disposition-contract-within-budget",
        dispositionType: "ELIMINATED",
        candidateId: "candidate-contract-within-budget",
        requirementKey: "budget.maxAmountMinor",
        reason: "错误地声称超过预算",
        evidenceIds: ["evidence-contract-within-budget-price"]
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.candidateDispositions.0.requirementKey",
          message: "ELIMINATED Evidence 必须证明 Candidate 违反 Hard Constraint"
        }
      ]),
      ok: false
    });
  });

  it("rejects a budget elimination when the Candidate price facts conflict", () => {
    const input = buildClosedDecisionResult();
    const selectedCandidate = requiredFirst(input.bundle.candidates, "Candidate");
    input.bundle.candidates.push({
      ...structuredClone(selectedCandidate),
      candidateId: "candidate-contract-price-conflict",
      identity: {
        ...selectedCandidate.identity,
        sku: "CM-SYNTH-CONTRACT-PRICE-CONFLICT"
      },
      observedPrice: {
        ...selectedCandidate.observedPrice,
        amountMinor: 120000
      }
    });
    input.bundle.claims.push(
      {
        contractType: "claim",
        contractVersion: "1.0",
        claimId: "claim-contract-price-conflict-high",
        decisionTaskId: "task-contract-test",
        subject: {
          subjectType: "CANDIDATE",
          subjectId: "candidate-contract-price-conflict"
        },
        predicate: "price.observed",
        value: { kind: "MONEY", amountMinor: 120000, currency: "CNY" },
        claimKind: "FACT_ASSERTION"
      },
      {
        contractType: "claim",
        contractVersion: "1.0",
        claimId: "claim-contract-price-conflict-low",
        decisionTaskId: "task-contract-test",
        subject: {
          subjectType: "CANDIDATE",
          subjectId: "candidate-contract-price-conflict"
        },
        predicate: "price.observed",
        value: { kind: "MONEY", amountMinor: 90000, currency: "CNY" },
        claimKind: "FACT_ASSERTION"
      }
    );
    input.bundle.evidence.push(
      {
        contractType: "evidence",
        contractVersion: "1.0",
        evidenceId: "evidence-contract-price-conflict-high",
        decisionTaskId: "task-contract-test",
        synthetic: true,
        source: {
          sourceKind: "SYNTHETIC",
          sourceId: "source-contract-test",
          title: "合成合同资料"
        },
        capturedAt: "2026-08-12T12:00:00.000Z",
        locator: { section: "contract", field: "price-high" },
        excerpt: "合成价格为 1200 元",
        validUntil: "2026-08-19T12:00:00.000Z"
      },
      {
        contractType: "evidence",
        contractVersion: "1.0",
        evidenceId: "evidence-contract-price-conflict-low",
        decisionTaskId: "task-contract-test",
        synthetic: true,
        source: {
          sourceKind: "SYNTHETIC",
          sourceId: "source-contract-test",
          title: "合成合同资料"
        },
        capturedAt: "2026-08-12T12:00:00.000Z",
        locator: { section: "contract", field: "price-low" },
        excerpt: "合成价格为 900 元",
        validUntil: "2026-08-19T12:00:00.000Z"
      }
    );
    addClaimEvidenceLink(
      input,
      "claim-contract-price-conflict-high",
      "evidence-contract-price-conflict-high",
      "SUPPORTS"
    );
    addClaimEvidenceLink(
      input,
      "claim-contract-price-conflict-low",
      "evidence-contract-price-conflict-low",
      "SUPPORTS"
    );
    input.bundle.decision.candidateDispositions = [
      {
        dispositionId: "disposition-contract-price-conflict",
        dispositionType: "ELIMINATED",
        candidateId: "candidate-contract-price-conflict",
        requirementKey: "budget.maxAmountMinor",
        reason: "价格超过硬预算",
        evidenceIds: ["evidence-contract-price-conflict-high"]
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.candidateDispositions.0.requirementKey",
          message: "ELIMINATED Evidence 必须证明 Candidate 违反 Hard Constraint"
        }
      ]),
      ok: false
    });
  });

  it("rejects a must-have elimination whose Evidence proves the Candidate satisfies it", () => {
    const input = buildClosedDecisionResult();
    input.bundle.requirementRevision.mustHaves = [
      {
        key: "memory.capacity",
        operator: "AT_LEAST",
        value: { amount: 32, unit: "GiB" }
      }
    ];
    const selectedCandidate = requiredFirst(input.bundle.candidates, "Candidate");
    input.bundle.candidates.push({
      ...structuredClone(selectedCandidate),
      candidateId: "candidate-contract-memory-64",
      identity: {
        ...selectedCandidate.identity,
        sku: "CM-SYNTH-CONTRACT-MEMORY-64"
      }
    });
    input.bundle.claims.push(
      {
        contractType: "claim",
        contractVersion: "1.0",
        claimId: "claim-contract-selected-memory",
        decisionTaskId: "task-contract-test",
        subject: {
          subjectType: "CANDIDATE",
          subjectId: "candidate-contract-test"
        },
        predicate: "memory.capacity",
        value: { kind: "QUANTITY", amount: 32, unit: "GiB" },
        claimKind: "FACT_ASSERTION"
      },
      {
        contractType: "claim",
        contractVersion: "1.0",
        claimId: "claim-contract-memory-64",
        decisionTaskId: "task-contract-test",
        subject: {
          subjectType: "CANDIDATE",
          subjectId: "candidate-contract-memory-64"
        },
        predicate: "memory.capacity",
        value: { kind: "QUANTITY", amount: 64, unit: "GiB" },
        claimKind: "FACT_ASSERTION"
      }
    );
    input.bundle.evidence.push(
      {
        contractType: "evidence",
        contractVersion: "1.0",
        evidenceId: "evidence-contract-selected-memory",
        decisionTaskId: "task-contract-test",
        synthetic: true,
        source: {
          sourceKind: "SYNTHETIC",
          sourceId: "source-contract-test",
          title: "合成合同资料"
        },
        capturedAt: "2026-08-12T12:00:00.000Z",
        locator: { section: "contract", field: "memory" },
        excerpt: "合成内存容量为 32 GiB",
        validUntil: "2026-08-19T12:00:00.000Z"
      },
      {
        contractType: "evidence",
        contractVersion: "1.0",
        evidenceId: "evidence-contract-memory-64",
        decisionTaskId: "task-contract-test",
        synthetic: true,
        source: {
          sourceKind: "SYNTHETIC",
          sourceId: "source-contract-test",
          title: "合成合同资料"
        },
        capturedAt: "2026-08-12T12:00:00.000Z",
        locator: { section: "contract", field: "memory" },
        excerpt: "合成内存容量为 64 GiB",
        validUntil: "2026-08-19T12:00:00.000Z"
      }
    );
    addClaimEvidenceLink(
      input,
      "claim-contract-selected-memory",
      "evidence-contract-selected-memory",
      "SUPPORTS"
    );
    addClaimEvidenceLink(
      input,
      "claim-contract-memory-64",
      "evidence-contract-memory-64",
      "SUPPORTS"
    );
    input.bundle.decision.candidateDispositions = [
      {
        dispositionId: "disposition-contract-memory-64",
        dispositionType: "ELIMINATED",
        candidateId: "candidate-contract-memory-64",
        requirementKey: "memory.capacity",
        reason: "错误地声称内存不满足要求",
        evidenceIds: ["evidence-contract-memory-64"]
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.candidateDispositions.0.requirementKey",
          message: "ELIMINATED Evidence 必须证明 Candidate 违反 Hard Constraint"
        }
      ]),
      ok: false
    });
  });

  it("rejects a must-have elimination when the Candidate facts conflict", () => {
    const input = buildClosedDecisionResult();
    input.bundle.requirementRevision.mustHaves = [
      {
        key: "memory.capacity",
        operator: "AT_LEAST",
        value: { amount: 32, unit: "GiB" }
      }
    ];
    const selectedCandidate = requiredFirst(input.bundle.candidates, "Candidate");
    input.bundle.candidates.push({
      ...structuredClone(selectedCandidate),
      candidateId: "candidate-contract-memory-conflict",
      identity: {
        ...selectedCandidate.identity,
        sku: "CM-SYNTH-CONTRACT-MEMORY-CONFLICT"
      }
    });
    input.bundle.claims.push(
      {
        contractType: "claim",
        contractVersion: "1.0",
        claimId: "claim-contract-selected-memory",
        decisionTaskId: "task-contract-test",
        subject: {
          subjectType: "CANDIDATE",
          subjectId: "candidate-contract-test"
        },
        predicate: "memory.capacity",
        value: { kind: "QUANTITY", amount: 32, unit: "GiB" },
        claimKind: "FACT_ASSERTION"
      },
      {
        contractType: "claim",
        contractVersion: "1.0",
        claimId: "claim-contract-memory-conflict-16",
        decisionTaskId: "task-contract-test",
        subject: {
          subjectType: "CANDIDATE",
          subjectId: "candidate-contract-memory-conflict"
        },
        predicate: "memory.capacity",
        value: { kind: "QUANTITY", amount: 16, unit: "GiB" },
        claimKind: "FACT_ASSERTION"
      },
      {
        contractType: "claim",
        contractVersion: "1.0",
        claimId: "claim-contract-memory-conflict-64",
        decisionTaskId: "task-contract-test",
        subject: {
          subjectType: "CANDIDATE",
          subjectId: "candidate-contract-memory-conflict"
        },
        predicate: "memory.capacity",
        value: { kind: "QUANTITY", amount: 64, unit: "GiB" },
        claimKind: "FACT_ASSERTION"
      }
    );
    input.bundle.evidence.push(
      {
        contractType: "evidence",
        contractVersion: "1.0",
        evidenceId: "evidence-contract-selected-memory",
        decisionTaskId: "task-contract-test",
        synthetic: true,
        source: {
          sourceKind: "SYNTHETIC",
          sourceId: "source-contract-test",
          title: "合成合同资料"
        },
        capturedAt: "2026-08-12T12:00:00.000Z",
        locator: { section: "contract", field: "selected-memory" },
        excerpt: "合成内存容量为 32 GiB",
        validUntil: "2026-08-19T12:00:00.000Z"
      },
      {
        contractType: "evidence",
        contractVersion: "1.0",
        evidenceId: "evidence-contract-memory-conflict-16",
        decisionTaskId: "task-contract-test",
        synthetic: true,
        source: {
          sourceKind: "SYNTHETIC",
          sourceId: "source-contract-test",
          title: "合成合同资料"
        },
        capturedAt: "2026-08-12T12:00:00.000Z",
        locator: { section: "contract", field: "memory-a" },
        excerpt: "合成内存容量为 16 GiB",
        validUntil: "2026-08-19T12:00:00.000Z"
      },
      {
        contractType: "evidence",
        contractVersion: "1.0",
        evidenceId: "evidence-contract-memory-conflict-64",
        decisionTaskId: "task-contract-test",
        synthetic: true,
        source: {
          sourceKind: "SYNTHETIC",
          sourceId: "source-contract-test",
          title: "合成合同资料"
        },
        capturedAt: "2026-08-12T12:00:00.000Z",
        locator: { section: "contract", field: "memory-b" },
        excerpt: "合成内存容量为 64 GiB",
        validUntil: "2026-08-19T12:00:00.000Z"
      }
    );
    addClaimEvidenceLink(
      input,
      "claim-contract-selected-memory",
      "evidence-contract-selected-memory",
      "SUPPORTS"
    );
    addClaimEvidenceLink(
      input,
      "claim-contract-memory-conflict-16",
      "evidence-contract-memory-conflict-16",
      "SUPPORTS"
    );
    addClaimEvidenceLink(
      input,
      "claim-contract-memory-conflict-64",
      "evidence-contract-memory-conflict-64",
      "SUPPORTS"
    );
    input.bundle.decision.candidateDispositions = [
      {
        dispositionId: "disposition-contract-memory-conflict",
        dispositionType: "ELIMINATED",
        candidateId: "candidate-contract-memory-conflict",
        requirementKey: "memory.capacity",
        reason: "合成内存不满足要求",
        evidenceIds: ["evidence-contract-memory-conflict-16"]
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.candidateDispositions.0.requirementKey",
          message: "ELIMINATED Evidence 必须证明 Candidate 违反 Hard Constraint"
        }
      ]),
      ok: false
    });
  });

  it("rejects a selected candidate that is also eliminated", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.candidateDispositions = [
      {
        dispositionId: "disposition-contract-selected",
        dispositionType: "ELIMINATED",
        candidateId: "candidate-contract-test",
        requirementKey: "budget.maxAmountMinor",
        reason: "同一候选不能同时被选中和淘汰",
        evidenceIds: ["evidence-contract-test"]
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.candidateDispositions.0.candidateId",
          message: "被选 Candidate 不能拥有 Candidate Disposition"
        }
      ]),
      ok: false
    });
  });

  it("rejects elimination evidence that belongs to another candidate", () => {
    const input = buildClosedDecisionResult();
    const originalCandidate = requiredFirst(input.bundle.candidates, "Candidate");
    input.bundle.candidates.push({
      ...structuredClone(originalCandidate),
      candidateId: "candidate-contract-eliminated",
      identity: {
        ...originalCandidate.identity,
        sku: "CM-SYNTH-CONTRACT-ELIMINATED"
      }
    });
    input.bundle.decision.candidateDispositions = [
      {
        dispositionId: "disposition-contract-wrong-evidence",
        dispositionType: "ELIMINATED",
        candidateId: "candidate-contract-eliminated",
        requirementKey: "budget.maxAmountMinor",
        reason: "合成候选超过硬预算",
        evidenceIds: ["evidence-contract-test"]
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.candidateDispositions.0.evidenceIds.0",
          message: "Candidate Disposition Evidence 必须描述对应 Candidate"
        }
      ]),
      ok: false
    });
  });

  it("rejects the legacy NOT_SELECTED disposition at the contract boundary", () => {
    const input = buildClosedDecisionResult();
    (input.bundle.decision as { candidateDispositions: unknown }).candidateDispositions = [
      {
        dispositionId: "disposition-contract-legacy",
        dispositionType: "NOT_SELECTED",
        candidateId: "candidate-contract-test",
        reason: "自由文本不足以证明候选应当落选",
        evidenceIds: ["evidence-contract-test"]
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({ message: "字段不符合合同要求" })
      ]),
      ok: false
    });
  });

  it("accepts a Decision Risk backed by a supported Claim in Decision Evidence", () => {
    const input = buildClosedDecisionResult();
    (input.bundle.decision as { risks: unknown }).risks = [
      {
        riskId: "risk-contract-test",
        candidateId: "candidate-contract-test",
        statementClaimId: "claim-contract-test",
        verification: "购买前核验成交价"
      }
    ];
    input.bundle.decision.nextSteps.push({
      actionType: "VERIFY_RISK",
      riskId: "risk-contract-test",
      instruction: "核验成交价"
    });

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({ ok: true });
  });

  it("rejects a Decision Risk without a verification next step", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.risks = [
      {
        riskId: "risk-contract-test",
        candidateId: "candidate-contract-test",
        statementClaimId: "claim-contract-test",
        verification: "购买前核验成交价"
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.risks.0.riskId",
          message: "每个 Decision Risk 必须有对应的 VERIFY_RISK next step"
        }
      ]),
      ok: false
    });
  });

  it("rejects the legacy Decision Risk summary and impact fields", () => {
    const input = buildClosedDecisionResult();
    (input.bundle.decision as { risks: unknown }).risks = [
      {
        riskId: "risk-contract-legacy",
        candidateId: "candidate-contract-test",
        summary: "模型自由编写的风险事实",
        impact: "模型自由编写的影响",
        verification: "由用户核验"
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({ message: "字段不符合合同要求" })
      ]),
      ok: false
    });
  });

  it("rejects a Decision Risk that references a missing Claim", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.risks = [
      {
        riskId: "risk-contract-test",
        candidateId: "candidate-contract-test",
        statementClaimId: "claim-missing",
        verification: "购买前核验风险事实"
      }
    ];
    input.bundle.decision.nextSteps.push({
      actionType: "VERIFY_RISK",
      riskId: "risk-contract-test",
      instruction: "核验风险事实"
    });

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.risks.0.statementClaimId",
          message: "Decision Risk 必须引用存在的 Claim"
        }
      ]),
      ok: false
    });
  });

  it("rejects a Decision Risk whose Claim belongs to another Candidate", () => {
    const input = buildClosedDecisionResult();
    const otherCandidate = structuredClone(requiredFirst(input.bundle.candidates, "Candidate"));
    otherCandidate.candidateId = "candidate-contract-other";
    otherCandidate.identity.sku = "CM-SYNTH-CONTRACT-OTHER";
    input.bundle.candidates.push(otherCandidate);
    input.bundle.decision.risks = [
      {
        riskId: "risk-contract-test",
        candidateId: otherCandidate.candidateId,
        statementClaimId: "claim-contract-test",
        verification: "购买前核验风险事实"
      }
    ];
    input.bundle.decision.nextSteps.push({
      actionType: "VERIFY_RISK",
      riskId: "risk-contract-test",
      instruction: "核验风险事实"
    });

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.risks.0.statementClaimId",
          message: "Decision Risk Claim 必须描述对应 Candidate"
        }
      ]),
      ok: false
    });
  });

  it("rejects a Decision Risk backed by a non-supported Claim", () => {
    const input = buildClosedDecisionResult();
    setClaimEvidenceLinkDirection(
      input,
      "claim-contract-test",
      "evidence-contract-test",
      "REFUTES"
    );
    input.bundle.decision.risks = [
      {
        riskId: "risk-contract-test",
        candidateId: "candidate-contract-test",
        statementClaimId: "claim-contract-test",
        verification: "购买前核验风险事实"
      }
    ];
    input.bundle.decision.nextSteps.push({
      actionType: "VERIFY_RISK",
      riskId: "risk-contract-test",
      instruction: "核验风险事实"
    });

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.risks.0.statementClaimId",
          message: "Decision Risk Claim 必须由权威 Assessment 判定为 SUPPORTED"
        }
      ]),
      ok: false
    });
  });

  it("rejects a Decision Risk when valid supporting and refuting Evidence conflict", () => {
    const input = buildClosedDecisionResult();
    const supportingEvidence = requiredFirst(input.bundle.evidence, "Evidence");
    input.bundle.evidence.push({
      ...structuredClone(supportingEvidence),
      evidenceId: "evidence-contract-risk-refutes",
      locator: { section: "contract", field: "risk-conflict" },
      excerpt: "另一条合成证据反驳该风险命题"
    });
    addClaimEvidenceLink(
      input,
      "claim-contract-test",
      "evidence-contract-risk-refutes",
      "REFUTES"
    );
    input.bundle.decision.risks = [
      {
        riskId: "risk-contract-test",
        candidateId: "candidate-contract-test",
        statementClaimId: "claim-contract-test",
        verification: "购买前核验风险事实"
      }
    ];
    input.bundle.decision.nextSteps.push({
      actionType: "VERIFY_RISK",
      riskId: "risk-contract-test",
      instruction: "核验风险事实"
    });

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.risks.0.statementClaimId",
          message: "Decision Risk Claim 必须由权威 Assessment 判定为 SUPPORTED"
        }
      ]),
      ok: false
    });
  });

  it("rejects a Decision Risk whose supporting Evidence is absent from the Decision", () => {
    const input = buildClosedDecisionResult();
    input.bundle.claims.push({
      contractType: "claim",
      contractVersion: "1.0",
      claimId: "claim-contract-risk",
      decisionTaskId: "task-contract-test",
      subject: {
        subjectType: "CANDIDATE",
        subjectId: "candidate-contract-test"
      },
      predicate: "memory.soldered",
      value: { kind: "BOOLEAN", value: true },
      claimKind: "FACT_ASSERTION"
    });
    input.bundle.evidence.push({
      contractType: "evidence",
      contractVersion: "1.0",
      evidenceId: "evidence-contract-risk",
      decisionTaskId: "task-contract-test",
      synthetic: true,
      source: {
        sourceKind: "SYNTHETIC",
        sourceId: "source-contract-test",
        title: "合成合同资料"
      },
      capturedAt: "2026-08-12T12:00:00.000Z",
      locator: { section: "contract", field: "memory-soldered" },
      excerpt: "合成候选使用板载内存",
      validUntil: "2026-08-19T12:00:00.000Z"
    });
    addClaimEvidenceLink(
      input,
      "claim-contract-risk",
      "evidence-contract-risk",
      "SUPPORTS"
    );
    input.bundle.decision.risks = [
      {
        riskId: "risk-contract-test",
        candidateId: "candidate-contract-test",
        statementClaimId: "claim-contract-risk",
        verification: "购买前核验内存是否板载"
      }
    ];
    input.bundle.decision.nextSteps.push({
      actionType: "VERIFY_RISK",
      riskId: "risk-contract-test",
      instruction: "核验内存是否板载"
    });

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.risks.0.statementClaimId",
          message: "Decision Risk 的 SUPPORTS Evidence 必须进入 Decision Evidence"
        }
      ]),
      ok: false
    });
  });

  it("rejects a decision risk for a missing candidate", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.risks = [
      {
        riskId: "risk-contract-test",
        candidateId: "candidate-missing",
        statementClaimId: "claim-contract-test",
        verification: "由用户核验"
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.decision.risks.0.candidateId",
          message: "Decision Risk 必须关联存在的 Candidate"
        })
      ]),
      ok: false
    });
  });

  it("rejects NO_MATCH when a Candidate is selected", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.status = "NO_MATCH";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.selectedCandidateId",
          message: "NO_MATCH 不得选择 Candidate"
        }
      ]),
      ok: false
    });
  });

  it.each(["BUY_NOW", "WAIT", "KEEP_CURRENT", "NO_MATCH", "REFUSE_RISK"] as const)(
    "rejects the %s Decision status while it is locked in P0-03",
    (status) => {
      const input = buildClosedDecisionResult();
      input.bundle.decision.status = status;

      const result = decodeDecisionTaskResultV1(input);

      expect(result).toMatchObject({
        code: "CONTRACT_INVALID",
        issues: expect.arrayContaining([
          {
            path: "bundle.decision.status",
            message: "P0-03 仅开放 BUY_IF_PRICE 和 NEED_MORE_INFO"
          }
        ]),
        ok: false
      });
    }
  );

  it("rejects BUY_NOW when a critical evidence gap remains", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.status = "BUY_NOW";
    input.bundle.decision.criticalGaps = [
      {
        gapId: "gap-contract-test",
        key: "warranty.official",
        question: "是否提供官方保修？",
        resolution: {
          resolutionType: "VERIFY_CONDITION",
          conditionId: "condition-contract-test"
        }
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.decision.criticalGaps",
          message: "存在 Critical Gap 时禁止 BUY_NOW"
        })
      ]),
      ok: false
    });
  });

  it("accepts a BUY_IF_PRICE Critical Gap mapped to a verifiable Condition", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.criticalGaps = [
      {
        gapId: "gap-contract-price-verification",
        key: "price.observed",
        question: "实际到手价是否满足条件？",
        resolution: {
          resolutionType: "VERIFY_CONDITION",
          conditionId: "condition-contract-test"
        }
      }
    ] as never;

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({ ok: true });
  });

  it("rejects a BUY_IF_PRICE Critical Gap that is not closed by a verifiable Condition", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.criticalGaps = [
      {
        gapId: "gap-contract-unclosed",
        key: "compatibility.unknown",
        question: "是否兼容现有设备？",
        resolution: {
          resolutionType: "VERIFY_CONDITION",
          conditionId: "condition-missing"
        }
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.criticalGaps.0.resolution.conditionId",
          message: "BUY_IF_PRICE Critical Gap 必须由可核验的 Decision Condition 闭合"
        }
      ]),
      ok: false
    });
  });

  it("rejects an unrelated next step when the budget is unconfirmed", () => {
    const input = buildClosedDecisionResult();
    const budget = input.bundle.requirementRevision.budget;

    if (budget === undefined) {
      throw new Error("测试 fixture 必须包含预算");
    }

    budget.confirmed = false;
    input.bundle.decision.status = "NEED_MORE_INFO";
    delete (input.bundle.decision as { selectedCandidateId?: string }).selectedCandidateId;
    input.bundle.decision.conditions = [];
    input.bundle.decision.criticalGaps = [
      {
        gapId: "gap-contract-budget",
        key: "budget.maxAmountMinor",
        question: "你的最高预算是多少？",
        resolution: {
          resolutionType: "PROVIDE_REQUIREMENT",
          requirementKey: "budget.maxAmountMinor"
        }
      }
    ];
    input.bundle.decision.nextSteps = [
      {
        actionType: "PROVIDE_REQUIREMENT",
        requirementKey: "warranty.official",
        instruction: "请补充官方保修要求"
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.nextSteps",
          message: "预算上限未确认时必须要求用户补充预算"
        }
      ]),
      ok: false
    });
  });

  it("rejects NEED_MORE_INFO without a concrete Gap and requirement step", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.status = "NEED_MORE_INFO";
    delete input.bundle.decision.selectedCandidateId;
    input.bundle.decision.conditions = [];
    input.bundle.decision.candidateDispositions = [];
    input.bundle.decision.risks = [];
    input.bundle.decision.criticalGaps = [];
    input.bundle.decision.nextSteps = [];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.criticalGaps",
          message: "NEED_MORE_INFO 必须至少包含一个可回答的 Critical Gap"
        }
      ]),
      ok: false
    });
  });

  it("rejects NEED_MORE_INFO that selects a Candidate", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.status = "NEED_MORE_INFO";
    input.bundle.decision.conditions = [];
    input.bundle.decision.candidateDispositions = [];
    input.bundle.decision.risks = [];
    input.bundle.decision.criticalGaps = [
      {
        gapId: "gap-contract-usage",
        key: "usage.detail",
        question: "你的主要使用场景是什么？",
        resolution: {
          resolutionType: "PROVIDE_REQUIREMENT",
          requirementKey: "usage.detail"
        }
      }
    ];
    input.bundle.decision.nextSteps = [
      {
        actionType: "PROVIDE_REQUIREMENT",
        requirementKey: "usage.detail",
        instruction: "请补充主要使用场景"
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.selectedCandidateId",
          message: "NEED_MORE_INFO 不得选择 Candidate"
        }
      ]),
      ok: false
    });
  });

  it("rejects NEED_MORE_INFO when its Gap has no matching requirement step", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.status = "NEED_MORE_INFO";
    delete input.bundle.decision.selectedCandidateId;
    input.bundle.decision.conditions = [];
    input.bundle.decision.candidateDispositions = [];
    input.bundle.decision.risks = [];
    input.bundle.decision.criticalGaps = [
      {
        gapId: "gap-contract-usage-unclosed",
        key: "usage.detail",
        question: "你的主要使用场景是什么？",
        resolution: {
          resolutionType: "PROVIDE_REQUIREMENT",
          requirementKey: "usage.detail"
        }
      }
    ];
    input.bundle.decision.nextSteps = [];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.criticalGaps.0.resolution.requirementKey",
          message: "NEED_MORE_INFO Critical Gap 必须由同一 Requirement 补充步骤闭合"
        }
      ]),
      ok: false
    });
  });

  it("rejects NEED_MORE_INFO with a premature Candidate Disposition", () => {
    const input = buildClosedDecisionResult();
    input.bundle.decision.status = "NEED_MORE_INFO";
    delete input.bundle.decision.selectedCandidateId;
    input.bundle.decision.conditions = [];
    input.bundle.decision.candidateDispositions = [
      {
        dispositionId: "disposition-contract-premature",
        dispositionType: "ELIMINATED",
        candidateId: "candidate-contract-test",
        requirementKey: "budget.maxAmountMinor",
        reason: "尚未形成最终取舍，不应提前标记",
        evidenceIds: ["evidence-contract-test"]
      }
    ];
    input.bundle.decision.risks = [];
    input.bundle.decision.criticalGaps = [
      {
        gapId: "gap-contract-premature-disposition",
        key: "usage.detail",
        question: "你的主要使用场景是什么？",
        resolution: {
          resolutionType: "PROVIDE_REQUIREMENT",
          requirementKey: "usage.detail"
        }
      }
    ];
    input.bundle.decision.nextSteps = [
      {
        actionType: "PROVIDE_REQUIREMENT",
        requirementKey: "usage.detail",
        instruction: "请补充主要使用场景"
      }
    ];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.decision.candidateDispositions",
          message: "NEED_MORE_INFO 不得形成 Candidate Disposition"
        }
      ]),
      ok: false
    });
  });

  it("rejects a Claim-Evidence Link that points to a missing Claim", () => {
    const input = buildClosedDecisionResult();
    requiredFirst(input.bundle.claimEvidenceLinks, "Claim-Evidence Link").claimId =
      "claim-missing";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.claimEvidenceLinks.0.claimId",
          message: "Claim-Evidence Link 必须引用存在的 Claim"
        })
      ]),
      ok: false
    });
  });

  it("rejects orphan Evidence without any Claim-Evidence Link", () => {
    const input = buildClosedDecisionResult();
    input.bundle.claimEvidenceLinks = [];

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.evidence.0.evidenceId",
          message: "每份 Evidence 必须至少关联一个 Claim"
        })
      ]),
      ok: false
    });
  });

  it("rejects evidence from a different decision task", () => {
    const input = buildClosedDecisionResult();
    requiredFirst(input.bundle.evidence, "Evidence").decisionTaskId = "task-other";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.evidence.0.decisionTaskId",
          message: "Evidence 必须属于结果中的 Decision Task"
        })
      ]),
      ok: false
    });
  });

  it("rejects duplicate Evidence identifiers", () => {
    const input = buildClosedDecisionResult();
    const evidence = requiredFirst(input.bundle.evidence, "Evidence");
    input.bundle.evidence.push({
      ...structuredClone(evidence),
      excerpt: "重复 ID 的合成证据"
    });

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.evidence.1.evidenceId",
          message: "Evidence ID 在结果中必须唯一"
        }
      ]),
      ok: false
    });
  });

  it("rejects a claim whose subject candidate does not exist", () => {
    const input = buildClosedDecisionResult();
    requiredFirst(input.bundle.claims, "Claim").subject.subjectId = "candidate-missing";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.claims.0.subject.subjectId",
          message: "Claim 必须关联存在的 Candidate"
        })
      ]),
      ok: false
    });
  });

  it("rejects a claim from a different decision task", () => {
    const input = buildClosedDecisionResult();
    requiredFirst(input.bundle.claims, "Claim").decisionTaskId = "task-other";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.claims.0.decisionTaskId",
          message: "Claim 必须属于结果中的 Decision Task"
        })
      ]),
      ok: false
    });
  });

  it("rejects duplicate Claim identifiers", () => {
    const input = buildClosedDecisionResult();
    const claim = requiredFirst(input.bundle.claims, "Claim");
    input.bundle.claims.push({
      ...structuredClone(claim),
      predicate: "price.duplicate-observation"
    });

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "bundle.claims.1.claimId",
          message: "Claim ID 在结果中必须唯一"
        }
      ]),
      ok: false
    });
  });

  it("rejects a Claim-Evidence Link that references missing Evidence", () => {
    const input = buildClosedDecisionResult();
    requiredFirst(input.bundle.claimEvidenceLinks, "Claim-Evidence Link").evidenceId =
      "evidence-missing";

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.claimEvidenceLinks.0.evidenceId",
          message: "Claim-Evidence Link 必须引用存在的 Evidence"
        })
      ]),
      ok: false
    });
  });

  it("rejects opposite directions for the same Claim and Evidence pair", () => {
    const input = buildClosedDecisionResult();
    const originalLink = requiredFirst(
      input.bundle.claimEvidenceLinks,
      "Claim-Evidence Link"
    );
    input.bundle.claimEvidenceLinks.push({
      ...structuredClone(originalLink),
      linkId: "link-contract-opposite",
      direction: "REFUTES"
    });

    const result = decodeDecisionTaskResultV1(input);

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "bundle.claimEvidenceLinks.1.evidenceId",
          message: "同一 Claim 与 Evidence 组合只能有一个关系方向"
        })
      ]),
      ok: false
    });
  });
});

describe("getDecisionTaskResultHttpStatusV1", () => {
  it("maps every valid Decision Task Result variant to its frozen HTTP status", () => {
    const completed = requireDecodedResult(buildClosedDecisionResult());
    const failed = requireDecodedResult(buildFailedDecisionResult());
    const invalid = createContractRejectedDecisionTaskResultV1({
      errorId: "error-contract-invalid-status",
      code: "CONTRACT_INVALID",
      issues: [],
      occurredAt: "2026-08-12T12:00:00.000Z"
    });
    const unsupportedVersion = createContractRejectedDecisionTaskResultV1({
      errorId: "error-contract-version-status",
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [],
      occurredAt: "2026-08-12T12:00:00.000Z"
    });
    const unknown = createUnknownDecisionExecutionResultV1({
      errorId: "error-contract-unknown-status",
      occurredAt: "2026-08-12T12:00:00.000Z"
    });

    expect(
      [completed, failed, invalid, unsupportedVersion, unknown].map(
        getDecisionTaskResultHttpStatusV1
      )
    ).toEqual([200, 502, 400, 422, 503]);
  });
});

function requireDecodedResult(input: unknown) {
  const decoded = decodeDecisionTaskResultV1(input);

  if (!decoded.ok) {
    throw new Error("测试 fixture 必须是合法 Decision Task Result");
  }

  return decoded.value;
}

function buildClosedDecisionResult(): MutableFixture<
  Extract<DecisionTaskResultV1, { ok: true }>
> {
  return {
    contractType: "decision-task-result",
    contractVersion: "1.0",
    ok: true,
    taskStatus: {
      contractType: "decision-task-status",
      contractVersion: "1.0",
      decisionTaskId: "task-contract-test",
      agentRunId: "run-contract-test",
      state: "COMPLETED",
      terminal: true,
      latestEventSequence: 9,
      decisionRevisionId: "decision-contract-test-r1",
      updatedAt: "2026-08-12T12:00:08.000Z"
    },
    runEvents: buildCompletedRunEvents(),
    bundle: {
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-contract-test-r1",
        decisionTaskId: "task-contract-test",
        revision: 1,
        submittedText: "合同测试需求",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
        intendedUses: ["测试"],
        budget: {
          confirmed: true,
          currency: "CNY",
          hard: true,
          maxAmountMinor: 100000
        },
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: []
      },
      candidates: [
        {
          contractType: "candidate",
          contractVersion: "1.0",
          candidateId: "candidate-contract-test",
          decisionTaskId: "task-contract-test",
          displayName: "合成候选",
          synthetic: true,
          identity: {
            model: "CM-SYNTH-CONTRACT",
            sku: "CM-SYNTH-CONTRACT-1",
            market: "CN",
            configuration: "合成配置"
          },
          observedPrice: {
            amountMinor: 100000,
            currency: "CNY",
            observedAt: "2026-08-12T12:00:00.000Z"
          }
        }
      ],
      claims: [
        {
          contractType: "claim",
          contractVersion: "1.0",
          claimId: "claim-contract-test",
          decisionTaskId: "task-contract-test",
          subject: {
            subjectType: "CANDIDATE",
            subjectId: "candidate-contract-test"
          },
          predicate: "price.observed",
          value: { kind: "MONEY", amountMinor: 100000, currency: "CNY" },
          claimKind: "FACT_ASSERTION"
        }
      ],
      evidence: [
        {
          contractType: "evidence",
          contractVersion: "1.0",
          evidenceId: "evidence-contract-test",
          decisionTaskId: "task-contract-test",
          synthetic: true,
          source: {
            sourceKind: "SYNTHETIC",
            sourceId: "source-contract-test",
            title: "合成合同资料"
          },
          capturedAt: "2026-08-12T12:00:00.000Z",
          locator: { section: "contract", field: "price" },
          excerpt: "合成价格为 1000 元",
          validUntil: "2026-08-19T12:00:00.000Z"
        }
      ],
      claimEvidenceLinks: [
        {
          contractType: "claim-evidence-link",
          contractVersion: "1.0",
          linkId: "link-contract-test",
          decisionTaskId: "task-contract-test",
          claimId: "claim-contract-test",
          evidenceId: "evidence-contract-test",
          direction: "SUPPORTS"
        }
      ],
      claimAssessments: [
        {
          contractType: "claim-assessment",
          contractVersion: "1.0",
          claimId: "claim-contract-test",
          evidenceState: "SUPPORTED",
          supportingEvidenceIds: ["evidence-contract-test"],
          refutingEvidenceIds: []
        }
      ],
      decision: {
        contractType: "decision-revision",
        contractVersion: "1.0",
        decisionRevisionId: "decision-contract-test-r1",
        decisionTaskId: "task-contract-test",
        requirementRevisionId: "req-contract-test-r1",
        revision: 1,
        status: "BUY_IF_PRICE",
        summary: "仅在满足价格条件时考虑。",
        selectedCandidateId: "candidate-contract-test",
        conditions: [
          {
            conditionId: "condition-contract-test",
            conditionType: "MAX_PRICE",
            candidateId: "candidate-contract-test",
            amountMinor: 100000,
            currency: "CNY",
            verification: "由用户核验外部价格"
          }
        ],
        candidateDispositions: [],
        risks: [],
        evidenceIds: ["evidence-contract-test"],
        criticalGaps: [],
        assumptions: [],
        validFrom: "2026-08-12T12:00:00.000Z",
        validUntil: "2026-08-19T12:00:00.000Z",
        nextSteps: [
          {
            actionType: "VERIFY_CONDITION",
            conditionId: "condition-contract-test",
            instruction: "核验价格"
          }
        ],
        synthetic: true
      }
    }
  };
}

function buildClaimEvidenceAuthorityDraft() {
  const canonicalResult = buildClosedDecisionResult();
  const { claimAssessments, ...draftBundle } = canonicalResult.bundle;
  void claimAssessments;

  return {
    ...canonicalResult,
    bundle: draftBundle
  };
}

function addUnlinkedLocaleOrderClaims(
  input: ReturnType<typeof buildClaimEvidenceAuthorityDraft>
): void {
  // claim-z 与 claim-ä 的码元升序为 claim-z < claim-ä;
  // 默认语言环境排序会把 ä 归为 a 变体,两者顺序相反,用于暴露 Locale 相关排序
  input.bundle.claims.push(
    {
      contractType: "claim",
      contractVersion: "1.0",
      claimId: "claim-z",
      decisionTaskId: input.taskStatus.decisionTaskId,
      subject: { subjectType: "CANDIDATE", subjectId: "candidate-contract-test" },
      predicate: "research.locale-order",
      value: { kind: "TEXT", value: "合成排序命题" },
      claimKind: "FACT_ASSERTION"
    },
    {
      contractType: "claim",
      contractVersion: "1.0",
      claimId: "claim-ä",
      decisionTaskId: input.taskStatus.decisionTaskId,
      subject: { subjectType: "CANDIDATE", subjectId: "candidate-contract-test" },
      predicate: "research.locale-order",
      value: { kind: "TEXT", value: "合成排序命题" },
      claimKind: "FACT_ASSERTION"
    }
  );
}

function buildClaimEvidenceAuthorityDraftWithEliminatedBudgetCandidate() {
  const canonicalResult = buildClosedDecisionResult();
  addBudgetEliminatedCandidate(canonicalResult);
  const { claimAssessments, ...draftBundle } = canonicalResult.bundle;
  void claimAssessments;

  return {
    ...canonicalResult,
    bundle: draftBundle
  };
}

function addBudgetEliminatedCandidate(
  input: ReturnType<typeof buildClosedDecisionResult>
): void {
  const taskId = input.taskStatus.decisionTaskId;
  input.bundle.candidates.push({
    contractType: "candidate",
    contractVersion: "1.0",
    candidateId: "candidate-contract-z",
    decisionTaskId: taskId,
    displayName: "超预算合成候选",
    synthetic: true,
    identity: {
      model: "CM-SYNTH-CONTRACT-Z",
      sku: "CM-SYNTH-CONTRACT-Z",
      market: "CN",
      configuration: "超预算配置"
    },
    observedPrice: {
      amountMinor: 200000,
      currency: "CNY",
      observedAt: "2026-08-12T12:00:00.000Z"
    }
  });
  input.bundle.claims.push({
    contractType: "claim",
    contractVersion: "1.0",
    claimId: "claim-contract-z-price",
    decisionTaskId: taskId,
    subject: { subjectType: "CANDIDATE", subjectId: "candidate-contract-z" },
    predicate: "price.observed",
    value: { kind: "MONEY", amountMinor: 200000, currency: "CNY" },
    claimKind: "FACT_ASSERTION"
  });
  const evidenceTemplate = requiredFirst(input.bundle.evidence, "Evidence");
  input.bundle.evidence.push({
    ...structuredClone(evidenceTemplate),
    evidenceId: "evidence-contract-z-price",
    locator: { section: "contract", field: "price-z" },
    excerpt: "合成价格为 2000 元"
  });
  input.bundle.claimEvidenceLinks.push({
    contractType: "claim-evidence-link",
    contractVersion: "1.0",
    linkId: "link-contract-z-price",
    decisionTaskId: taskId,
    claimId: "claim-contract-z-price",
    evidenceId: "evidence-contract-z-price",
    direction: "SUPPORTS"
  });
  input.bundle.claimAssessments.push({
    contractType: "claim-assessment",
    contractVersion: "1.0",
    claimId: "claim-contract-z-price",
    evidenceState: "SUPPORTED",
    supportingEvidenceIds: ["evidence-contract-z-price"],
    refutingEvidenceIds: []
  });
  input.bundle.decision.candidateDispositions.push({
    dispositionId: "disposition-contract-z-budget",
    dispositionType: "ELIMINATED",
    candidateId: "candidate-contract-z",
    requirementKey: "budget.maxAmountMinor",
    reason: "合成价格超过硬预算",
    evidenceIds: ["evidence-contract-z-price"]
  });
}

function addClaimEvidenceLink(
  input: ReturnType<typeof buildClosedDecisionResult>,
  claimId: string,
  evidenceId: string,
  direction: "SUPPORTS" | "REFUTES"
): void {
  input.bundle.claimEvidenceLinks.push({
    contractType: "claim-evidence-link",
    contractVersion: "1.0",
    linkId: `link-${claimId}-${evidenceId}`,
    decisionTaskId: input.taskStatus.decisionTaskId,
    claimId,
    evidenceId,
    direction
  });
  refreshClaimAssessment(input, claimId);
}

function setClaimEvidenceLinkDirection(
  input: ReturnType<typeof buildClosedDecisionResult>,
  claimId: string,
  evidenceId: string,
  direction: "SUPPORTS" | "REFUTES"
): void {
  const link = input.bundle.claimEvidenceLinks.find(
    (candidate) => candidate.claimId === claimId && candidate.evidenceId === evidenceId
  );

  if (link === undefined) {
    throw new Error("测试 fixture 必须包含 Claim-Evidence Link");
  }

  link.direction = direction;
  refreshClaimAssessment(input, claimId);
}

function refreshClaimAssessment(
  input: ReturnType<typeof buildClosedDecisionResult>,
  claimId: string
): void {
  const supportingEvidenceIds = input.bundle.claimEvidenceLinks
    .filter((link) => link.claimId === claimId && link.direction === "SUPPORTS")
    .map((link) => link.evidenceId)
    .sort();
  const refutingEvidenceIds = input.bundle.claimEvidenceLinks
    .filter((link) => link.claimId === claimId && link.direction === "REFUTES")
    .map((link) => link.evidenceId)
    .sort();
  const evidenceState: "SUPPORTED" | "REFUTED" | "CONFLICTED" | "INSUFFICIENT" =
    supportingEvidenceIds.length > 0
      ? refutingEvidenceIds.length > 0
        ? "CONFLICTED"
        : "SUPPORTED"
      : refutingEvidenceIds.length > 0
        ? "REFUTED"
        : "INSUFFICIENT";
  const assessment = {
    contractType: "claim-assessment" as const,
    contractVersion: "1.0" as const,
    claimId,
    evidenceState,
    supportingEvidenceIds,
    refutingEvidenceIds
  };
  const index = input.bundle.claimAssessments.findIndex(
    (candidate) => candidate.claimId === claimId
  );

  if (index === -1) {
    input.bundle.claimAssessments.push(assessment);
  } else {
    input.bundle.claimAssessments[index] = assessment;
  }

  input.bundle.claimAssessments.sort((left, right) =>
    left.claimId < right.claimId ? -1 : left.claimId > right.claimId ? 1 : 0
  );
}

function buildFailedDecisionResult() {
  return {
    contractType: "decision-task-result",
    contractVersion: "1.0",
    ok: false,
    taskStatus: {
      contractType: "decision-task-status",
      contractVersion: "1.0",
      decisionTaskId: "task-contract-failed",
      agentRunId: "run-contract-failed",
      state: "FAILED",
      terminal: true,
      latestEventSequence: 1,
      errorId: "error-contract-failed",
      updatedAt: "2026-08-12T12:00:00.000Z"
    },
    runEvents: [
      {
        contractType: "run-event",
        contractVersion: "1.0",
        eventId: "event-contract-failed-1",
        decisionTaskId: "task-contract-failed",
        agentRunId: "run-contract-failed",
        sequence: 1,
        occurredAt: "2026-08-12T12:00:00.000Z",
        eventType: "RUNTIME_FAILED",
        taskState: "FAILED",
        summary: "合成 Runtime 执行失败",
        synthetic: true
      }
    ],
    error: {
      contractType: "choice-mind-error",
      contractVersion: "1.0",
      errorId: "error-contract-failed",
      code: "FAKE_RUNTIME_FAILED",
      category: "RUNTIME",
      message: "决策任务失败",
      retryMode: "NEW_EXECUTION_ALLOWED",
      issues: [],
      occurredAt: "2026-08-12T12:00:00.000Z"
    }
  };
}

function buildRejectedDecisionResult() {
  return {
    contractType: "decision-task-result",
    contractVersion: "1.0",
    ok: false,
    error: {
      contractType: "choice-mind-error",
      contractVersion: "1.0",
      errorId: "error-contract-status-unknown",
      code: "DECISION_EXECUTION_STATUS_UNKNOWN",
      category: "TRANSPORT",
      message: "本次执行状态暂时无法确认",
      retryMode: "SAME_EXECUTION_ONLY",
      issues: [],
      occurredAt: "2026-08-12T12:00:00.000Z"
    }
  };
}

function requiredFirst<T>(items: T[], name: string): T {
  const item = items[0];

  if (item === undefined) {
    throw new Error(`测试 fixture 缺少 ${name}`);
  }

  return item;
}

function requiredLast<T>(items: T[], name: string): T {
  const item = items.at(-1);

  if (item === undefined) {
    throw new Error(`测试 fixture 缺少 ${name}`);
  }

  return item;
}

function buildCompletedRunEvents() {
  const states = [
    "CREATED",
    "UNDERSTANDING",
    "PLANNING",
    "RESEARCHING",
    "VERIFYING",
    "COMPARING",
    "CRITIQUING",
    "GENERATING",
    "COMPLETED"
  ] as const;

  return states.map((taskState, index) => ({
    contractType: "run-event" as const,
    contractVersion: "1.0" as const,
    eventId: `event-contract-test-${index + 1}`,
    decisionTaskId: "task-contract-test",
    agentRunId: "run-contract-test",
    sequence: index + 1,
    occurredAt: `2026-08-12T12:00:0${index}.000Z`,
    eventType:
      index === states.length - 1
        ? ("RUNTIME_SUCCEEDED" as const)
        : ("TASK_STATE_CHANGED" as const),
    taskState,
    summary: `合成阶段 ${taskState}`,
    synthetic: true as const
  }));
}
