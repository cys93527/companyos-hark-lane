/**
 * UI-AUDIT-2 (user report 2026-11-11) — what KIND of model an upstream catalogue entry is.
 *
 * Root cause: an OpenAI-compatible `GET /models` answer lists every model the account can
 * reach (image, video, embedding, speech …), the adapter marked every one of them as a
 * structured-output chat model, and the model selector offered all of them for a Goal. The
 * user picked an image model for a chat Goal.
 *
 * The answer is decided in the MAIN process (the renderer never classifies): upstream hints
 * first (an explicit `type` / `task` / output modalities field, as several gateways send),
 * then the model id. Only `chat` (and `unknown`, which is treated as chat so a new chat
 * model is never hidden) can run a Goal: every Goal call asks for structured text output.
 * The model the user configured as their chat model is always `chat` — a misclassification
 * must never lock the user out of the model they set up.
 */

export type ModelModality = 'chat' | 'image' | 'video' | 'audio' | 'embedding' | 'rerank' | 'moderation' | 'unknown';

export const NON_CHAT_MODALITIES: ReadonlySet<ModelModality> = new Set(['image', 'video', 'audio', 'embedding', 'rerank', 'moderation']);

/** Ordered: the first rule that matches wins (video before image: "image-to-video" is video). */
const ID_RULES: readonly { readonly modality: ModelModality; readonly pattern: RegExp }[] = [
  { modality: 'embedding', pattern: /(embed|(^|[-_/.])(bge|e5|gte|m3e)([-_/.]|$))/iu },
  { modality: 'rerank', pattern: /rerank/iu },
  { modality: 'moderation', pattern: /moderation/iu },
  { modality: 'video', pattern: /(video|seedance|(^|[-_/.])(sora|kling|veo|vidu|hailuo|cogvideox?)([-_/.0-9]|$)|(^|[-_/.])(t2v|i2v|v2v|s2v)([-_/.]|$))/iu },
  { modality: 'image', pattern: /(image|seedream|dall-?e|flux|stable-?diffusion|sdxl|(^|[-_/.])sd[0-9.]+([-_/.]|$)|midjourney|imagen|kolors|cogview|wanx|(^|[-_/.])(t2i|i2i)([-_/.]|$))/iu },
  { modality: 'audio', pattern: /(tts|whisper|(^|[-_/.])asr([-_/.]|$)|speech|audio|voice|transcri|paraformer|cosyvoice|sambert)/iu },
];

/** Classify by model id alone (persisted rows from before this classifier existed). */
export const modalityFromModelId = (modelId: string): ModelModality => {
  for (const rule of ID_RULES) if (rule.pattern.test(modelId)) return rule.modality;
  return 'unknown';
};

const WORD_MODALITY: readonly { readonly modality: ModelModality; readonly words: readonly string[] }[] = [
  { modality: 'chat', words: ['chat', 'text', 'llm', 'completion', 'completions', 'language', 'text-generation', 'reasoning'] },
  { modality: 'embedding', words: ['embedding', 'embeddings', 'embed', 'text-embedding'] },
  { modality: 'rerank', words: ['rerank', 'reranker'] },
  { modality: 'image', words: ['image', 'images', 'image-generation', 'text-to-image', 'image-to-image'] },
  { modality: 'video', words: ['video', 'videos', 'video-generation', 'text-to-video', 'image-to-video'] },
  { modality: 'audio', words: ['audio', 'speech', 'tts', 'asr', 'text-to-speech', 'speech-to-text', 'transcription'] },
  { modality: 'moderation', words: ['moderation'] },
];

const modalityOfWord = (value: unknown): ModelModality | null => {
  if (typeof value !== 'string') return null;
  const word = value.trim().toLowerCase();
  for (const entry of WORD_MODALITY) if (entry.words.includes(word)) return entry.modality;
  return null;
};

const outputModalities = (entry: Readonly<Record<string, unknown>>): readonly string[] | null => {
  const architecture = entry['architecture'];
  const fromArchitecture =
    typeof architecture === 'object' && architecture !== null ? (architecture as Record<string, unknown>)['output_modalities'] : undefined;
  const raw = fromArchitecture ?? entry['output_modalities'] ?? entry['modalities'];
  if (!Array.isArray(raw)) return null;
  const words = raw.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase());
  return words.length === 0 ? null : words;
};

/**
 * Classify one upstream `/models` entry: an explicit output-modality list first (text output
 * = chat), then an explicit type/task word, then the id. Never throws; unknown stays unknown.
 */
export const classifyUpstreamModel = (entry: Readonly<Record<string, unknown>>, modelId: string): ModelModality => {
  const outputs = outputModalities(entry);
  if (outputs !== null) {
    if (outputs.includes('text')) return 'chat';
    for (const word of outputs) {
      const modality = modalityOfWord(word);
      if (modality !== null) return modality;
    }
  }
  for (const key of ['type', 'model_type', 'task', 'category']) {
    const modality = modalityOfWord(entry[key]);
    if (modality !== null) return modality;
  }
  return modalityFromModelId(modelId);
};

/**
 * The modality a persisted row reads back as: an adapter-recorded modality (metadata) or an
 * adapter that declared no structured output wins; otherwise the id rule (rows written by
 * earlier versions carry no modality). The configured chat model is always chat.
 */
export const modalityOfRow = (row: {
  readonly modelId: string;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  readonly configured?: boolean;
}): ModelModality => {
  if (row.configured === true) return 'chat';
  const recorded = row.metadata?.['modality'];
  if (typeof recorded === 'string' && (['chat', 'image', 'video', 'audio', 'embedding', 'rerank', 'moderation', 'unknown'] as const).includes(recorded as ModelModality)) {
    if (recorded !== 'unknown') return recorded as ModelModality;
  }
  return modalityFromModelId(row.modelId);
};

/** A Goal sends structured text requests: only chat (or not-known-otherwise) models can run one. */
export const canRunGoals = (modality: ModelModality): boolean => !NON_CHAT_MODALITIES.has(modality);

export const MODALITY_LABELS: Readonly<Record<ModelModality, string>> = {
  chat: '对话模型',
  unknown: '对话模型（未声明类型）',
  image: '图像模型',
  video: '视频模型',
  audio: '语音模型',
  embedding: '向量模型',
  rerank: '重排序模型',
  moderation: '审核模型',
};
