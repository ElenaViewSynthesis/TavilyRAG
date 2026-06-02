import type { H3Event } from "h3";

type ChatRole = "system" | "user" | "assistant";

interface RagConfig {
  openAiKey?: string;
  openAiBaseUrl: string;
  chatModel: string;
  embeddingModel: string;
  tavilyKey?: string;
  tavilyMaxResults: number;
  pineconeKey?: string;
  pineconeHost: string;
  pineconeNamespace: string;
  pineconeTopK: number;
  pineconeApiVersion: string;
}

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface ChatRequest {
  prompt?: string;
  history?: unknown[];
}

interface EmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface PineconeMatch {
  id: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

interface PineconeQueryResponse {
  matches?: PineconeMatch[];
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
  type: "pinecone" | "tavily";
  title: string;
  url: string;
  score?: number;
}

interface ChatSuccess {
  answer: string;
  sources: Source[];
  diagnostics: {
    pineconeMatches: number;
    tavilyResults: number;
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
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];

  if (!prompt) {
    return {
      statusCode: 400,
      error: "Prompt is required"
    };
  }

  const queryEmbedding = await embedText(prompt, config);
  const [pineconeMatches, tavily] = await Promise.all([
    queryPinecone(queryEmbedding, config),
    searchTavily(prompt, config)
  ]);

  const tavilyDocuments = normalizeTavilyResults(tavily);
  if (tavilyDocuments.length) {
    upsertTavilyDocuments(tavilyDocuments, config).catch((error: Error) => {
      console.warn("Pinecone upsert skipped:", error.message);
    });
  }

  const context = buildContext(pineconeMatches, tavilyDocuments, tavily.answer);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a concise RAG assistant. Answer using the supplied Pinecone memory and Tavily web results. " +
        "Cite sources inline using the provided source numbers. If the context is thin, say what is missing."
    },
    ...sanitizeHistory(history),
    {
      role: "user",
      content: `User prompt:\n${prompt}\n\nRetrieved context:\n${context}`
    }
  ];

  const answer = await chat(messages, config);

  return {
    answer,
    sources: [
      ...pineconeMatches.map((match, index) => sourceFromPinecone(match, index + 1)),
      ...tavilyDocuments.map((doc, index) => sourceFromTavily(doc, pineconeMatches.length + index + 1))
    ],
    diagnostics: {
      pineconeMatches: pineconeMatches.length,
      tavilyResults: tavilyDocuments.length,
      namespace: config.pineconeNamespace
    }
  };
}

export function getConfigStatus() {
  const config = getConfig();

  return {
    openai: Boolean(config.openAiKey),
    tavily: Boolean(config.tavilyKey),
    pinecone: Boolean(config.pineconeKey && config.pineconeHost),
    namespace: config.pineconeNamespace
  };
}

function getConfig(): RagConfig {
  return {
    openAiKey: process.env.OPENAI_API_KEY,
    openAiBaseUrl: stripTrailingSlash(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
    chatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
    tavilyKey: process.env.TAVILY_API_KEY,
    tavilyMaxResults: Number(process.env.TAVILY_MAX_RESULTS || 5),
    pineconeKey: process.env.PINECONE_API_KEY,
    pineconeHost: stripTrailingSlash(process.env.PINECONE_HOST || ""),
    pineconeNamespace: process.env.PINECONE_NAMESPACE || "rag-dashboard",
    pineconeTopK: Number(process.env.PINECONE_TOP_K || 5),
    pineconeApiVersion: process.env.PINECONE_API_VERSION || "2026-04"
  };
}

async function embedText(input: string, config: RagConfig) {
  const response = await apiFetch<EmbeddingResponse>(`${config.openAiBaseUrl}/embeddings`, {
    method: "POST",
    headers: openAiHeaders(config),
    body: JSON.stringify({
      model: config.embeddingModel,
      input
    })
  });

  const embedding = response.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("Embedding response did not include a vector");
  }

  return embedding;
}

async function chat(messages: ChatMessage[], config: RagConfig) {
  const response = await apiFetch<ChatCompletionResponse>(`${config.openAiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: openAiHeaders(config),
    body: JSON.stringify({
      model: config.chatModel,
      temperature: 0.2,
      messages
    })
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Chat response did not include an answer");
  }

  return content;
}

async function queryPinecone(vector: number[], config: RagConfig) {
  const response = await apiFetch<PineconeQueryResponse>(`${config.pineconeHost}/query`, {
    method: "POST",
    headers: pineconeHeaders(config),
    body: JSON.stringify({
      namespace: config.pineconeNamespace,
      vector,
      topK: config.pineconeTopK,
      includeMetadata: true,
      includeValues: false
    })
  });

  return Array.isArray(response.matches) ? response.matches : [];
}

async function upsertTavilyDocuments(documents: TavilyDocument[], config: RagConfig) {
  const vectors = [];

  for (const doc of documents) {
    const text = truncate(`${doc.title}\n${doc.content}`, 3500);
    const values = await embedText(text, config);
    vectors.push({
      id: stableId(doc.url || `${doc.title}-${doc.content}`),
      values,
      metadata: {
        title: doc.title,
        url: doc.url,
        content: truncate(doc.content, 3000),
        source: "tavily",
        indexedAt: new Date().toISOString()
      }
    });
  }

  if (!vectors.length) return;

  await apiFetch(`${config.pineconeHost}/vectors/upsert`, {
    method: "POST",
    headers: pineconeHeaders(config),
    body: JSON.stringify({
      namespace: config.pineconeNamespace,
      vectors
    })
  });
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

function buildContext(pineconeMatches: PineconeMatch[], tavilyDocuments: TavilyDocument[], tavilyAnswer?: string) {
  const chunks = [];

  if (tavilyAnswer) {
    chunks.push("[Tavily answer]\n" + tavilyAnswer);
  }

  pineconeMatches.forEach((match, index) => {
    const metadata = match.metadata || {};
    chunks.push(
      `[Source ${index + 1}: Pinecone memory]\n` +
        `Title: ${asString(metadata.title) || match.id}\n` +
        `URL: ${asString(metadata.url) || "n/a"}\n` +
        `Score: ${typeof match.score === "number" ? match.score.toFixed(4) : "n/a"}\n` +
        `${asString(metadata.content) || asString(metadata.text) || ""}`
    );
  });

  tavilyDocuments.forEach((doc, index) => {
    chunks.push(
      `[Source ${pineconeMatches.length + index + 1}: Tavily web]\n` +
        `Title: ${doc.title}\n` +
        `URL: ${doc.url || "n/a"}\n` +
        truncate(doc.content, 2200)
    );
  });

  return chunks.join("\n\n---\n\n") || "No retrieved context.";
}

function sourceFromPinecone(match: PineconeMatch, number: number): Source {
  const metadata = match.metadata || {};

  return {
    number,
    type: "pinecone",
    title: asString(metadata.title) || match.id,
    url: asString(metadata.url) || "",
    score: match.score
  };
}

function sourceFromTavily(doc: TavilyDocument, number: number): Source {
  return {
    number,
    type: "tavily",
    title: doc.title,
    url: doc.url
  };
}

function sanitizeHistory(history: unknown[]): ChatMessage[] {
  return history
    .filter(isUserOrAssistantMessage)
    .map((message) => ({
      role: message.role,
      content: truncate(message.content, 2000)
    }));
}

function isUserOrAssistantMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;

  const message = value as Record<string, unknown>;
  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  );
}

async function apiFetch<T = unknown>(url: string, options: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const parsed = data as Record<string, unknown>;
    const error = parsed.error as { message?: string } | undefined;
    const detail = error?.message || asString(parsed.message) || text || response.statusText;
    throw new Error(`${response.status} ${response.statusText}: ${detail}`);
  }

  return data as T;
}

function openAiHeaders(config: RagConfig) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.openAiKey}`
  };
}

function pineconeHeaders(config: RagConfig) {
  return {
    "Content-Type": "application/json",
    "Api-Key": config.pineconeKey || "",
    "X-Pinecone-Api-Version": config.pineconeApiVersion
  };
}

function getMissingConfig(config: RagConfig) {
  return [
    ["OPENAI_API_KEY", config.openAiKey],
    ["TAVILY_API_KEY", config.tavilyKey],
    ["PINECONE_API_KEY", config.pineconeKey],
    ["PINECONE_HOST", config.pineconeHost]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}

function truncate(value: string, maxLength: number) {
  if (!value || value.length <= maxLength) return value || "";
  return value.slice(0, maxLength - 1) + "...";
}

function stableId(input: string) {
  let hash = 5381;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }

  return `tavily-${(hash >>> 0).toString(16)}`;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}
