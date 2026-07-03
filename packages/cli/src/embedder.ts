import OpenAI from 'openai';
import type { EnvConfig } from './env';

const VOYAGE_EMBED_URL = 'https://api.voyageai.com/v1/embeddings';
const OPENAI_EMBED_CHUNK = 200;
const VOYAGE_EMBED_CHUNK = 128;

interface VoyageEmbedResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

async function embedViaVoyage(config: EnvConfig, texts: string[]): Promise<number[][]> {
  const voyageKey = config.voyageApiKey;
  if (!voyageKey) {
    throw new Error('VOYAGE_API_KEY is required when PROVIDER=anthropic (Anthropic has no embedding API).');
  }
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += VOYAGE_EMBED_CHUNK) {
    const chunk = texts.slice(i, i + VOYAGE_EMBED_CHUNK);
    const res = await fetch(VOYAGE_EMBED_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${voyageKey}`,
      },
      body: JSON.stringify({
        input: chunk,
        model: config.embeddingModel,
        input_type: 'document',
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Voyage embeddings failed (${res.status}): ${body}`,
      );
    }
    const data = (await res.json()) as VoyageEmbedResponse;
    for (const row of data.data.sort((a, b) => a.index - b.index)) {
      out.push(row.embedding);
    }
  }
  return out;
}

async function embedViaOpenAI(config: EnvConfig, texts: string[]): Promise<number[][]> {
  const client = new OpenAI({ apiKey: config.apiKey });
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += OPENAI_EMBED_CHUNK) {
    const chunk = texts.slice(i, i + OPENAI_EMBED_CHUNK);
    const res = await client.embeddings.create({
      model: config.embeddingModel,
      input: chunk,
    });
    for (const row of res.data.sort((a, b) => a.index - b.index)) {
      out.push(row.embedding);
    }
  }
  return out;
}

export async function embedTexts(config: EnvConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (config.provider === 'openai') {
    return embedViaOpenAI(config, texts);
  }
  return embedViaVoyage(config, texts);
}

function toPgVector(vec: number[]): string {
  return '[' + vec.join(',') + ']';
}

export { toPgVector };
