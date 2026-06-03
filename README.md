# Tavily + Pinecone RAG Dashboard

A Nuxt.js + TypeScript dashboard that accepts prompts, queries Pinecone for vector memory, searches the web with Tavily, and sends both context sets to an OpenAI-compatible chat model.

## Setup

1. Copy `.env.example` to `.env` and fill in the keys.
2. Create or choose a Pinecone dense-vector index whose dimension matches `OPENAI_EMBEDDING_MODEL`.
   The default `text-embedding-3-small` embedding size is 1536.
3. Set `PINECONE_HOST` to the index data-plane host, including `https://`.
4. Start the app:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

For production builds:

```bash
npm run build
npm start
```

## Netlify Deployment

This project includes `netlify.toml` with the Nuxt build settings:

- Build command: `npm run build`
- Publish directory: `dist`
- Node version: `22`

Set the required environment variables in Netlify under
`Site configuration -> Environment variables` before deploying. Do not commit real API keys.

## Required Environment

- `OPENAI_API_KEY`: chat and embeddings provider key.
- `TAVILY_API_KEY`: Tavily Search API key.
- `PINECONE_API_KEY`: Pinecone API key.
- `PINECONE_HOST`: Pinecone index host.

Optional knobs include `OPENAI_CHAT_MODEL`, `OPENAI_EMBEDDING_MODEL`, `PINECONE_NAMESPACE`, `PINECONE_TOP_K`, and `TAVILY_MAX_RESULTS`.

## Flow

1. The Nitro API route embeds the user prompt.
2. It queries Pinecone with that vector.
3. It searches Tavily for fresh web context.
4. It asynchronously embeds and upserts Tavily results into Pinecone for future recall.
5. It sends the combined context to the chat model and returns sources to the UI.
