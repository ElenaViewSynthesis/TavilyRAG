# Tavily RAG Dashboard

A Nuxt.js + TypeScript dashboard that accepts prompts, searches the web with Tavily, and returns Tavily's generated answer with source links.

## Setup

1. Copy `.env.example` to `.env` and fill in the keys.
2. Install JavaScript dependencies:

```bash
npm install
```

3. Start the app:

```bash
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

- `TAVILY_API_KEY`: Tavily Search API key.
- `PINECONE_API_KEY`: Pinecone API key.
- `PINECONE_HOST`: Pinecone index host for an index with integrated embedding enabled.

Optional knobs include `TAVILY_MAX_RESULTS`, `PINECONE_NAMESPACE`, `PINECONE_TEXT_FIELD`, and `PINECONE_API_VERSION`.

## Flow

1. The Nitro API route searches Tavily for fresh web context.
2. It stores every Tavily source in Pinecone, linked to the original `user_query` and a stable `query_id`.
3. It returns Tavily's generated answer when one is available.
4. If Tavily does not provide a direct answer, it returns a short fallback built from top source snippets.
5. The API returns the answer and Tavily sources to the UI.

## Pinecone Storage

The app uses Pinecone's integrated embedding upsert endpoint:

```text
POST /records/namespaces/{namespace}/upsert
```

Each Tavily source is stored as a text record. The text field defaults to `text`, but you can change it with `PINECONE_TEXT_FIELD` to match your index `field_map`.

Each record includes metadata linking it back to the user prompt:

- `user_query`
- `query_id`
- `source_rank`
- `source_title`
- `source_url`
- `source_type`
- `queried_at`
