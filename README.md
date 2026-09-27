# Contextify

AI-powered document Q&A with OCR, retrieval, and evidence-backed answers for PDFs, images, and office documents.

Contextify is a document intelligence platform that lets users upload institutional and academic documents, extract text from PDFs/images/office files, index the content for search, and ask natural-language questions with source-grounded answers and evidence references.

## Features

- Upload PDFs, images, and office documents
- OCR and parsing pipeline for heterogeneous documents
- Chunking and indexing for search and retrieval
- Hybrid retrieval using lexical + dense matching
- Evidence-backed answers with file/page references
- Support for multiple AI providers with fallback routing
- React-based frontend for chat and document browsing

## Tech Stack

- Node.js 24 + TypeScript
- Hono backend
- SQLite with FTS + vector storage
- React 18 + Vite
- OCR / parsing via PDF.js, canvas, and AI vision flows
- Multi-provider LLM routing (Sarvam, xAI, Groq, Ollama)

## Repository Structure

```text
contextify/
├── server/              # backend API and ingestion pipeline
├── web/                 # React frontend
├── data/                # local document storage (ignored in public repo)
├── .env.example         # sample env file
├── .gitignore           # public-safe ignore rules
├── package.json         # scripts and dependencies
├── tsconfig.json        # TypeScript config
├── README.md            # project documentation
└── eng.traineddata      # local OCR data (not required for public repo)
```

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a local `.env` file from `.env.example` and fill in your keys.

```bash
copy .env.example .env
```

3. Start the app:

```bash
npm run dev
```

This starts the API and frontend locally.

## Environment Variables

Example values can be set in the project-root `.env`:

```env
PORT=8787
SARVAM_API_KEY=
SARVAM_TEXT_MODEL=sarvam-105b
GROQ_API_KEY=
GROQ_MODEL=llama-3.1-8b-instant
XAI_API_KEY=
XAI_MODEL=grok-3-mini
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b-instruct
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

## Usage

- Open the frontend at `http://localhost:5173`
- Upload files through the app interface
- Ask questions about the uploaded documents
- Review answer evidence and source references

## Notes

- Keep `.env` local and never commit secrets to GitHub.
- Generated files, uploads, local DB files, and build outputs are ignored by default.
- This repository is intended for source-code sharing; local data and runtime artifacts remain outside the public repo.

## License

This project is currently shared as source code for learning and portfolio use. Add a license if you plan to distribute it more formally.
