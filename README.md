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

Optional knobs include `TAVILY_MAX_RESULTS`.

## Flow

1. The Nitro API route searches Tavily for fresh web context.
2. It returns Tavily's generated answer when one is available.
3. If Tavily does not provide a direct answer, it returns a short fallback built from top source snippets.
4. The API returns the answer and Tavily sources to the UI.
