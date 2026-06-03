import type { H3Event } from "h3";

interface RagConfig {
  tavilyKey?: string;
  tavilyMaxResults: number;
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
    provider: "tavily";
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
  const answer = buildTavilyAnswer(tavily, tavilyDocuments);

  return {
    answer,
    sources: tavilyDocuments.map((doc, index) => sourceFromTavily(doc, index + 1)),
    diagnostics: {
      tavilyResults: tavilyDocuments.length,
      provider: "tavily"
    }
  };
}

export function getConfigStatus() {
  const config = getConfig();

  return {
    tavily: Boolean(config.tavilyKey),
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
    tavilyMaxResults: Number(process.env.TAVILY_MAX_RESULTS || 5)
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
  return [["TAVILY_API_KEY", config.tavilyKey]]
    .filter(([, value]) => !value)
    .map(([key]) => key);
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
  return "External API";
}

function sanitizeErrorMessage(value: string) {
  return value
    .replace(/sk-\S+/g, "[redacted API key]")
    .replace(/tvly-\S+/g, "[redacted Tavily key]")
    .replace(/pcsk_\S+/g, "[redacted API key]");
}
