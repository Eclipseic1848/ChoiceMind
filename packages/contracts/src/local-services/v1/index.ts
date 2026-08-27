import * as z from "zod";

export type LocalServicePortV1 =
	| "MODEL_PROVIDER"
	| "EMBEDDING_PROVIDER"
	| "RERANKER"
	| "DOCUMENT_PARSER"
	| "ASR";

export type LocalServiceErrorCodeV1 =
	| "TIMEOUT"
	| "CONNECTION_FAILED"
	| "INVALID_RESPONSE"
	| "CAPABILITY_LIMIT_EXCEEDED";

export type ModelProviderRequestV1 = Readonly<{
	contractType: "local-service-request";
	contractVersion: "1.0";
	requestId: string;
	port: "MODEL_PROVIDER";
	input: Readonly<{
		messages: readonly Readonly<{
			role: "system" | "user" | "assistant";
			content: string;
		}>[];
		maxOutputTokens: number;
	}>;
}>;

export type EmbeddingProviderRequestV1 = Readonly<{
	contractType: "local-service-request";
	contractVersion: "1.0";
	requestId: string;
	port: "EMBEDDING_PROVIDER";
	input: Readonly<{ texts: readonly string[] }>;
}>;

export type RerankerRequestV1 = Readonly<{
	contractType: "local-service-request";
	contractVersion: "1.0";
	requestId: string;
	port: "RERANKER";
	input: Readonly<{
		query: string;
		documents: readonly Readonly<{ documentId: string; text: string }>[];
		topK: number;
	}>;
}>;

export type DocumentParserRequestV1 = Readonly<{
	contractType: "local-service-request";
	contractVersion: "1.0";
	requestId: string;
	port: "DOCUMENT_PARSER";
	input: Readonly<{
		document: Readonly<{
			mediaType: "application/pdf" | "image/png" | "image/jpeg" | "text/html";
			dataBase64: string;
		}>;
	}>;
}>;

export type AsrRequestV1 = Readonly<{
	contractType: "local-service-request";
	contractVersion: "1.0";
	requestId: string;
	port: "ASR";
	input: Readonly<{
		audio: Readonly<{ mediaType: "audio/wav"; dataBase64: string }>;
		language?: string | undefined;
	}>;
}>;

export type LocalServiceRequestV1 =
	| ModelProviderRequestV1
	| EmbeddingProviderRequestV1
	| RerankerRequestV1
	| DocumentParserRequestV1
	| AsrRequestV1;

type LocalServiceResultHeaderV1<Port extends LocalServicePortV1> = Readonly<{
	contractType: "local-service-result";
	contractVersion: "1.0";
	requestId: string;
	port: Port;
}>;

export type SuccessfulLocalServiceResultV1 =
	| (LocalServiceResultHeaderV1<"MODEL_PROVIDER"> &
			Readonly<{ ok: true; output: Readonly<{ model: string; text: string }> }>)
	| (LocalServiceResultHeaderV1<"EMBEDDING_PROVIDER"> &
			Readonly<{
				ok: true;
				output: Readonly<{
					model: string;
					dimensions: number;
					vectors: readonly (readonly number[])[];
				}>;
			}>)
	| (LocalServiceResultHeaderV1<"RERANKER"> &
			Readonly<{
				ok: true;
				output: Readonly<{
					model: string;
					rankings: readonly Readonly<{ documentId: string; score: number }>[];
				}>;
			}>)
	| (LocalServiceResultHeaderV1<"DOCUMENT_PARSER"> &
			Readonly<{
				ok: true;
				output: Readonly<{ parser: string; text: string; pageCount: number }>;
			}>)
	| (LocalServiceResultHeaderV1<"ASR"> &
			Readonly<{
				ok: true;
				output: Readonly<{
					model: string;
					text: string;
					language?: string | undefined;
				}>;
			}>);

export type FailedLocalServiceResultV1 =
	LocalServiceResultHeaderV1<LocalServicePortV1> &
		Readonly<{
			ok: false;
			error: Readonly<{
				code: LocalServiceErrorCodeV1;
				category: "TRANSPORT" | "PROTOCOL" | "CAPABILITY";
				message: string;
				retryable: boolean;
			}>;
		}>;

export type LocalServiceResultV1 =
	| SuccessfulLocalServiceResultV1
	| FailedLocalServiceResultV1;

export type LocalServiceContractIssueV1 = Readonly<{
	path: string;
	message: string;
}>;

export type LocalServiceDecodeResultV1<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{
			ok: false;
			code: "CONTRACT_INVALID" | "CONTRACT_VERSION_UNSUPPORTED";
			issues: readonly LocalServiceContractIssueV1[];
	  }>;

const meaningfulTextSchema = z
	.string()
	.refine((value) => value.trim().length > 0);
const base64Schema = meaningfulTextSchema.regex(/^[A-Za-z0-9+/]+={0,2}$/);
const requestHeader = {
	contractType: z.literal("local-service-request"),
	contractVersion: z.literal("1.0"),
	requestId: meaningfulTextSchema,
};
const resultHeader = {
	contractType: z.literal("local-service-result"),
	contractVersion: z.literal("1.0"),
	requestId: meaningfulTextSchema,
};

const localServiceRequestSchema = z.discriminatedUnion("port", [
	z.strictObject({
		...requestHeader,
		port: z.literal("MODEL_PROVIDER"),
		input: z.strictObject({
			messages: z
				.array(
					z.strictObject({
						role: z.enum(["system", "user", "assistant"]),
						content: meaningfulTextSchema,
					}),
				)
				.min(1),
			maxOutputTokens: z.number().int().positive(),
		}),
	}),
	z.strictObject({
		...requestHeader,
		port: z.literal("EMBEDDING_PROVIDER"),
		input: z.strictObject({ texts: z.array(meaningfulTextSchema).min(1) }),
	}),
	z.strictObject({
		...requestHeader,
		port: z.literal("RERANKER"),
		input: z.strictObject({
			query: meaningfulTextSchema,
			documents: z
				.array(
					z.strictObject({
						documentId: meaningfulTextSchema,
						text: meaningfulTextSchema,
					}),
				)
				.min(1),
			topK: z.number().int().positive(),
		}),
	}),
	z.strictObject({
		...requestHeader,
		port: z.literal("DOCUMENT_PARSER"),
		input: z.strictObject({
			document: z.strictObject({
				mediaType: z.enum([
					"application/pdf",
					"image/png",
					"image/jpeg",
					"text/html",
				]),
				dataBase64: base64Schema,
			}),
		}),
	}),
	z.strictObject({
		...requestHeader,
		port: z.literal("ASR"),
		input: z.strictObject({
			audio: z.strictObject({
				mediaType: z.literal("audio/wav"),
				dataBase64: base64Schema,
			}),
			language: meaningfulTextSchema.optional(),
		}),
	}),
]);

const successfulResultSchema = z.discriminatedUnion("port", [
	z.strictObject({
		...resultHeader,
		port: z.literal("MODEL_PROVIDER"),
		ok: z.literal(true),
		output: z.strictObject({
			model: meaningfulTextSchema,
			text: meaningfulTextSchema,
		}),
	}),
	z
		.strictObject({
			...resultHeader,
			port: z.literal("EMBEDDING_PROVIDER"),
			ok: z.literal(true),
			output: z.strictObject({
				model: meaningfulTextSchema,
				dimensions: z.number().int().positive(),
				vectors: z.array(z.array(z.number())).min(1),
			}),
		})
		.superRefine((result, context) => {
			result.output.vectors.forEach((vector, index) => {
				if (vector.length !== result.output.dimensions) {
					context.addIssue({
						code: "custom",
						path: ["output", "vectors", index],
						message: "向量维度必须与 dimensions 一致",
					});
				}
			});
		}),
	z.strictObject({
		...resultHeader,
		port: z.literal("RERANKER"),
		ok: z.literal(true),
		output: z.strictObject({
			model: meaningfulTextSchema,
			rankings: z.array(
				z.strictObject({
					documentId: meaningfulTextSchema,
					score: z.number().finite(),
				}),
			),
		}),
	}),
	z.strictObject({
		...resultHeader,
		port: z.literal("DOCUMENT_PARSER"),
		ok: z.literal(true),
		output: z.strictObject({
			parser: meaningfulTextSchema,
			text: meaningfulTextSchema,
			pageCount: z.number().int().positive(),
		}),
	}),
	z.strictObject({
		...resultHeader,
		port: z.literal("ASR"),
		ok: z.literal(true),
		output: z.strictObject({
			model: meaningfulTextSchema,
			text: meaningfulTextSchema,
			language: meaningfulTextSchema.optional(),
		}),
	}),
]);

const localServiceErrorSchema = z.discriminatedUnion("code", [
	z.strictObject({
		code: z.literal("TIMEOUT"),
		category: z.literal("TRANSPORT"),
		message: meaningfulTextSchema,
		retryable: z.literal(true),
	}),
	z.strictObject({
		code: z.literal("CONNECTION_FAILED"),
		category: z.literal("TRANSPORT"),
		message: meaningfulTextSchema,
		retryable: z.literal(true),
	}),
	z.strictObject({
		code: z.literal("INVALID_RESPONSE"),
		category: z.literal("PROTOCOL"),
		message: meaningfulTextSchema,
		retryable: z.literal(false),
	}),
	z.strictObject({
		code: z.literal("CAPABILITY_LIMIT_EXCEEDED"),
		category: z.literal("CAPABILITY"),
		message: meaningfulTextSchema,
		retryable: z.literal(false),
	}),
]);

const failedResultSchema = z.strictObject({
	...resultHeader,
	port: z.enum([
		"MODEL_PROVIDER",
		"EMBEDDING_PROVIDER",
		"RERANKER",
		"DOCUMENT_PARSER",
		"ASR",
	]),
	ok: z.literal(false),
	error: localServiceErrorSchema,
});

const localServiceResultSchema = z.union([
	successfulResultSchema,
	failedResultSchema,
]);

export function decodeLocalServiceRequestV1(
	input: unknown,
): LocalServiceDecodeResultV1<LocalServiceRequestV1> {
	return decodeContract(input, localServiceRequestSchema);
}

export function decodeLocalServiceResultV1(
	input: unknown,
): LocalServiceDecodeResultV1<LocalServiceResultV1> {
	return decodeContract(input, localServiceResultSchema);
}

function decodeContract<T>(
	input: unknown,
	schema: Readonly<{
		safeParse(value: unknown):
			| Readonly<{ success: true; data: T }>
			| Readonly<{
					success: false;
					error: Readonly<{
						issues: readonly Readonly<{
							path: readonly PropertyKey[];
							message: string;
						}>[];
					}>;
			  }>;
	}>,
): LocalServiceDecodeResultV1<T> {
	if (
		typeof input === "object" &&
		input !== null &&
		"contractVersion" in input &&
		input.contractVersion !== "1.0"
	) {
		return {
			ok: false,
			code: "CONTRACT_VERSION_UNSUPPORTED",
			issues: [{ path: "contractVersion", message: "合同版本不受支持" }],
		};
	}

	const parsed = schema.safeParse(input);
	if (parsed.success) {
		return { ok: true, value: parsed.data };
	}

	return {
		ok: false,
		code: "CONTRACT_INVALID",
		issues: parsed.error.issues.map((issue) => ({
			path: issue.path.map(String).join("."),
			message:
				issue.message === "向量维度必须与 dimensions 一致"
					? issue.message
					: "字段不符合合同要求",
		})),
	};
}
