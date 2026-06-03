<script setup lang="ts">
type ChatRole = "user" | "assistant";

interface ChatHistoryMessage {
  role: ChatRole;
  content: string;
}

interface Source {
  number: number;
  type: string;
  title: string;
  url?: string;
  score?: number;
}

interface ChatResponse {
  answer: string;
  sources: Source[];
  diagnostics: {
    tavilyResults: number;
    provider: "tavily";
  };
}

interface HealthResponse {
  ok: boolean;
  configured: {
    tavily: boolean;
    provider: "tavily";
  };
}

interface FetchErrorLike {
  data?: {
    error?: string;
    message?: string;
  };
  message?: string;
}

const prompt = ref("");
const isLoading = ref(false);
const sources = ref<Source[]>([]);
const configured = ref<HealthResponse["configured"]>({
  tavily: false,
  provider: "tavily"
});
const messages = ref<ChatHistoryMessage[]>([
  {
    role: "assistant",
    content: "Enter a prompt and I will search Tavily before answering."
  }
]);
const messageList = ref<HTMLElement | null>(null);

const history = computed(() =>
  messages.value
    .filter((message) => message.content !== "Searching Tavily...")
    .map((message) => ({
      role: message.role,
      content: message.content
    }))
);

onMounted(async () => {
  await loadHealth();
});

watch(
  messages,
  async () => {
    await nextTick();
    if (messageList.value) {
      messageList.value.scrollTop = messageList.value.scrollHeight;
    }
  },
  { deep: true }
);

async function loadHealth() {
  try {
    const data = await $fetch<HealthResponse>("/api/health");
    configured.value = data.configured;
  } catch {
    // The chat endpoint returns actionable configuration errors.
  }
}

async function submitPrompt() {
  const trimmedPrompt = prompt.value.trim();
  if (!trimmedPrompt || isLoading.value) return;

  const priorHistory = history.value.slice(-8);
  messages.value.push({ role: "user", content: trimmedPrompt });
  prompt.value = "";
  isLoading.value = true;

  const loadingMessage: ChatHistoryMessage = {
    role: "assistant",
    content: "Searching Tavily..."
  };
  messages.value.push(loadingMessage);

  try {
    const data = await $fetch<ChatResponse>("/api/chat", {
      method: "POST",
      body: {
        prompt: trimmedPrompt,
        history: priorHistory
      }
    });

    loadingMessage.content = data.answer;
    sources.value = data.sources || [];
  } catch (error) {
    loadingMessage.content = getErrorMessage(error);
  } finally {
    isLoading.value = false;
  }
}

function submitOnEnter(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submitPrompt();
  }
}

function getErrorMessage(error: unknown) {
  const fetchError = error as FetchErrorLike;
  const dataError = fetchError.data?.error;
  const dataMessage = fetchError.data?.message;

  if (typeof dataError === "string") return dataError;
  if (typeof dataMessage === "string") return dataMessage;
  if (typeof fetchError.message === "string") return fetchError.message;

  return "Request failed";
}

function renderMarkdown(value: string) {
  const escaped = escapeHtml(value);
  const withCode = escaped.replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>");

  return withCode
    .split(/\n{2,}/)
    .map((block) => {
      if (block.startsWith("<pre>")) return block;
      return `<p>${block.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function escapeHtml(value: string) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
</script>

<template>
  <main class="app-shell">
    <section class="workspace">
      <aside class="sidebar" aria-label="RAG status">
        <div>
          <p class="eyebrow">RAG Console</p>
          <h1>Search-grounded chat</h1>
        </div>

        <div class="status-list">
          <div class="status-row">
            <span class="status-dot" :class="{ ready: configured.tavily }"></span>
            <span>Tavily</span>
          </div>
        </div>

        <div class="source-panel">
          <h2>Sources</h2>
          <div class="source-list">
            <p v-if="sources.length === 0" class="muted">
              Ask a question to retrieve live web results.
            </p>
            <article v-for="source in sources" :key="`${source.number}-${source.url || source.title}`" class="source-card">
              <a v-if="source.url" :href="source.url" target="_blank" rel="noreferrer">
                [{{ source.number }}] {{ source.title || "Untitled source" }}
              </a>
              <span v-else>[{{ source.number }}] {{ source.title || "Untitled source" }}</span>
              <span class="source-meta">
                {{ source.type || "source" }}
                <template v-if="typeof source.score === 'number'">
                  &middot; score {{ source.score.toFixed(3) }}
                </template>
              </span>
            </article>
          </div>
        </div>
      </aside>

      <section class="chat-panel" aria-label="Chat interface">
        <div ref="messageList" class="messages">
          <article v-for="(message, index) in messages" :key="index" class="message" :class="message.role">
            <div class="avatar">{{ message.role === "user" ? "You" : "AI" }}</div>
            <div class="bubble" v-html="renderMarkdown(message.content)"></div>
          </article>
        </div>

        <form class="composer" @submit.prevent="submitPrompt">
          <label for="promptInput" class="sr-only">Prompt</label>
          <textarea
            id="promptInput"
            v-model="prompt"
            name="prompt"
            rows="2"
            placeholder="Ask about a company, document topic, current event, or research question"
            required
            :disabled="isLoading"
            @keydown="submitOnEnter"
          ></textarea>
          <button type="submit" aria-label="Send prompt" :disabled="isLoading || !prompt.trim()">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3.4 20.4 21 12 3.4 3.6l2.1 6.7L14 12l-8.5 1.7-2.1 6.7Z"></path>
            </svg>
          </button>
        </form>
      </section>
    </section>
  </main>
</template>
