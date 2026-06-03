import type { H3Event } from "h3";

interface RagConfig {
  tavilyKey?: string;
  tavilyMaxResults: number;
  pineconeKey?: string;
  pineconeHost: string;
  pineconeNamespace: string;
  pineconeTextField: string;
  pineconeApiVersion: string;
}

interface ChatRequest {
  prompt?: string;
  history?: unknown[];
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string;
}

interface TavilyResponse {
  answer?: string;
  results?: TavilyResult[];
}

interface TavilyDocument {
  title: string;
  url: string;
  content: string;
}

interface Source {
  number: number;
  type: "tavily";
  title: string;
  url: string;
}

interface ChatSuccess {
  answer: string;
  sources: Source[];
  diagnostics: {
    tavilyResults: number;
    pineconeStored: number;
    provider: "tavily";
    namespace: string;
  };
}

interface ChatFailure {
  statusCode: number;
  error: string;
}

export async function handleChat(event: H3Event): Promise<ChatSuccess | ChatFailure> {
  const config = getConfig();
  const missing = getMissingConfig(config);

  if (missing.length) {
    return {
      statusCode: 400,
      error: `Missing required environment variables: ${missing.join(", ")}`
    };
  }

  const body = await readBody<ChatRequest>(event);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  if (!prompt) {
    return {
      statusCode: 400,
      error: "Prompt is required"
    };
  }

  const tavily = await searchTavily(prompt, config);
  const tavilyDocuments = normalizeTavilyResults(tavily);
  const pineconeStored = await storeResourcesInPinecone(prompt, tavilyDocuments, config);
  const answer = buildTavilyAnswer(tavily, tavilyDocuments);

  return {
    answer,
    sources: tavilyDocuments.map((doc, index) => sourceFromTavily(doc, index + 1)),
    diagnostics: {
      tavilyResults: tavilyDocuments.length,
      pineconeStored,
      provider: "tavily",
      namespace: config.pineconeNamespace
    }
  };
}

export function getConfigStatus() {
  const config = getConfig();

  return {
    tavily: Boolean(config.tavilyKey),
    pinecone: Boolean(config.pineconeKey && config.pineconeHost),
    namespace: config.pineconeNamespace,
    provider: "tavily"
  };
}

export function toPublicErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return sanitizeErrorMessage(error.message);
  }

  return "Server error while processing the chat request.";
}

function getConfig(): RagConfig {
  return {
    tavilyKey: process.env.TAVILY_API_KEY,
    tavilyMaxResults: Number(process.env.TAVILY_MAX_RESULTS || 5),
    pineconeKey: process.env.PINECONE_API_KEY,
    pineconeHost: stripTrailingSlash(process.env.PINECONE_HOST || ""),
    pineconeNamespace: process.env.PINECONE_NAMESPACE || "rag-dashboard-resources",
    pineconeTextField: process.env.PINECONE_TEXT_FIELD || "text",
    pineconeApiVersion: process.env.PINECONE_API_VERSION || "2026-04"
  };
}

async function searchTavily(query: string, config: RagConfig) {
  return apiFetch<TavilyResponse>("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.tavilyKey}`
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      include_answer: true,
      include_raw_content: "text",
      max_results: config.tavilyMaxResults
    })
  });
}

function normalizeTavilyResults(tavily: TavilyResponse): TavilyDocument[] {
  return (Array.isArray(tavily.results) ? tavily.results : [])
    .map((result) => ({
      title: result.title || result.url || "Untitled result",
      url: result.url || "",
      content: result.raw_content || result.content || ""
    }))
    .filter((result) => result.content);
}

function buildTavilyAnswer(tavily: TavilyResponse, tavilyDocuments: TavilyDocument[]) {
  const answer = typeof tavily.answer === "string" ? tavily.answer.trim() : "";

  if (answer && answer.toLowerCase() !== "true") {
    return answer;
  }

  if (!tavilyDocuments.length) {
    return "Tavily did not return an answer or source snippets for this prompt.";
  }

  const snippets = tavilyDocuments
    .slice(0, 3)
    .map((doc, index) => `[${index + 1}] ${doc.title}: ${truncate(doc.content, 320)}`);

  return `Tavily did not provide a direct answer, but it returned these relevant source snippets:\n\n${snippets.join("\n\n")}`;
}

function sourceFromTavily(doc: TavilyDocument, number: number): Source {
  return {
    number,
    type: "tavily",
    title: doc.title,
    url: doc.url
  };
}

async function storeResourcesInPinecone(
  userQuery: string,
  documents: TavilyDocument[],
  config: RagConfig
) {
  if (!documents.length) return 0;

  const queryId = stableId(userQuery);
  const queriedAt = new Date().toISOString();
  const records = documents.map((doc, index) => {
    const id = `${queryId}-source-${index + 1}-${stableId(doc.url || doc.title)}`;

    return {
      _id: id,
      [config.pineconeTextField]: truncate(`${doc.title}\n${doc.content}`, 6000),
      user_query: truncate(userQuery, 2000),
      query_id: queryId,
      source_rank: index + 1,
      source_title: truncate(doc.title, 500),
      source_url: doc.url,
      source_type: "tavily",
      queried_at: queriedAt
    };
  });

  await apiFetch(
    `${config.pineconeHost}/records/namespaces/${encodeURIComponent(config.pineconeNamespace)}/upsert`,
    {
      method: "POST",
      headers: pineconeRecordHeaders(config),
      body: records.map((record) => JSON.stringify(record)).join("\n")
    }
  );

  return records.length;
}

async function apiFetch<T = unknown>(url: string, options: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = parseJson(text);

  if (!response.ok) {
    const parsed = data as Record<string, unknown>;
    const error = parsed.error as { message?: string } | undefined;
    const detail = error?.message || asString(parsed.message) || text || response.statusText;
    throw new Error(
      `${getServiceName(url)} request failed (${response.status} ${response.statusText}): ${detail}`
    );
  }

  return data as T;
}

function getMissingConfig(config: RagConfig) {
  return [
    ["TAVILY_API_KEY", config.tavilyKey],
    ["PINECONE_API_KEY", config.pineconeKey],
    ["PINECONE_HOST", config.pineconeHost]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

function pineconeRecordHeaders(config: RagConfig) {
  return {
    "Content-Type": "application/x-ndjson",
    "Api-Key": config.pineconeKey || "",
    "X-Pinecone-Api-Version": config.pineconeApiVersion
  };
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}

function truncate(value: string, maxLength: number) {
  if (!value || value.length <= maxLength) return value || "";
  return value.slice(0, maxLength - 1) + "...";
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function parseJson(value: string) {
  if (!value) return {};

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function getServiceName(url: string) {
  if (url.includes("api.tavily.com")) return "Tavily";
  if (url.includes("pinecone.io")) return "Pinecone";
  return "External API";
}

function sanitizeErrorMessage(value: string) {
  return value
    .replace(/sk-\S+/g, "[redacted API key]")
    .replace(/tvly-\S+/g, "[redacted Tavily key]")
    .replace(/pcsk_\S+/g, "[redacted API key]");
}

function stableId(input: string) {
  let hash = 5381;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }

  return (hash >>> 0).toString(16);
}
