import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_API_KEY, CLAUDE_MODEL_NAME } from '../../config/env';

export const anthropic = new Anthropic({
    apiKey: CLAUDE_API_KEY,
});

export const TRANSLATOR_SYSTEM_PROMPT = [
    'You are a helpful assistant on a phone call.',

    // === LANGUAGE RULES — HIGHEST PRIORITY — READ FIRST ===
    '=== STRICT LANGUAGE RULE (NON-NEGOTIABLE) ===',
    'You will be told in every message which language the user spoke (URDU or ENGLISH).',
    'You MUST respond ONLY in that exact language. Zero exceptions.',
    '  • If instruction says URDU  → your ENTIRE response must be in Urdu script (اردو). Not a single English word.',
    '  • If instruction says ENGLISH → your ENTIRE response must be in English. Not a single Urdu word.',
    'Mixing languages = FAILURE. Responding in the wrong language = FAILURE.',

    // === URDU DIACRITICS RULE ===
    '=== URDU DIACRITICS RULE (MANDATORY WHEN RESPONDING IN URDU) ===',
    'You MUST apply full diacritics (اعراب) on every Urdu word you write:',
    '  زَبَر (Fatah) = َ  |  زِیر (Kasra) = ِ  |  پَیش (Damma) = ُ  |  تَشدِید = ّ  |  جَزم (Sukun) = ْ',
    'CORRECT: "مَیں آپ کِی مَدَد کَر سَکتَا ہُوں" (every word has diacritics)',
    'WRONG:   "میں آپ کی مدد کر سکتا ہوں" (no diacritics — FORBIDDEN)',
    'Every single Urdu word in your response MUST carry proper diacritics. No bare Urdu words ever.',

    // === CONVERSATION RULES ===
    '=== CONVERSATION RULES ===',
    '- You are a helpful human-like assistant. Be warm, professional, and concise.',
    '- Response Length: 2 to 3 sentences maximum.',
    '- Directness: Lead with the most relevant information.',
    '- Natural speech: Use natural transitions, avoid robotic phrasing.',
    '- Maintain continuity: Use conversation history to ensure logical flow.',
    '- Handle Interruptions: When interrupted, address the new input first, then naturally close the previous topic.',
    '- Noise Handling: If the input is noise or a hallucination phrase, respond with a neutral "Could you repeat that?" in the user\'s language.',
    '- Unsupported Language: If the user speaks a language other than English or Urdu, politely say in English: "I only support English and Urdu."',
].join('\n');


export function createTranslationRequest(
    text: string,
    sourceLang: string = 'auto',
    targetLang: string = 'auto',
    context: Array<{ speaker: string; text: string }> = [],
    interruptedResponse?: string,
    interruptedQuestion?: string
): string {
    let prompt = '';

    if (context.length > 0) {
        prompt += `[Previous conversation context:\n`;
        context.slice(-2).forEach(msg => {
            prompt += `${msg.speaker}: ${msg.text}\n`;
        });
        prompt += `]\n\n`;
    }

    if (interruptedQuestion && interruptedResponse) {
        prompt += `[CONTEXT: You were interrupted while answering the user's previous question: "${interruptedQuestion}"]\n`;
        prompt += `[WHAT YOU HAD SAID BEFORE INTERRUPTION: "${interruptedResponse}..."]\n`;
        prompt += `[USER'S NEW INPUT: "${text}"]\n`;
        const iLang1 = targetLang === 'urdu' ? 'Urdu' : 'English';
        const langWarn1 = targetLang === 'urdu' ? ' Your ENTIRE reply must be in Urdu script only. DO NOT use any English words.' : '';
        prompt += `[INSTRUCTION: ⚠️ LANGUAGE = ${iLang1.toUpperCase()}. Respond ONLY in ${iLang1}.${langWarn1} Address the user's new input while naturally closing or pivoting from the previous topic.]\n\n`;
    } else if (interruptedResponse) {
        prompt += `[CONTEXT: You were interrupted while saying: "${interruptedResponse}..."]\n`;
        prompt += `[USER'S NEW INPUT: "${text}"]\n`;
        const iLang2 = targetLang === 'urdu' ? 'Urdu' : 'English';
        const langWarn2 = targetLang === 'urdu' ? ' Your ENTIRE reply must be in Urdu script only. DO NOT use any English words.' : '';
        prompt += `[INSTRUCTION: ⚠️ LANGUAGE = ${iLang2.toUpperCase()}. Respond ONLY in ${iLang2}.${langWarn2} Acknowledge the interruption naturally if appropriate.]\n\n`;
    } else {
        const responseLang = targetLang === 'urdu' ? 'Urdu' : 'English';
        const langWarn3 = targetLang === 'urdu' ? ' Your ENTIRE reply must be in Urdu script only — not a single English word.' : '';
        prompt += `[Caller Input: "${text}"]\n`;
        prompt += `[INSTRUCTION: ⚠️ LANGUAGE = ${responseLang.toUpperCase()}. Respond ONLY in ${responseLang}.${langWarn3} Do NOT mix languages. Maintain conversation context.]`;
    }

    return prompt;
}


export const createTranslationStream = (
    text: string,
    targetLang: string,
    sourceLang: string = 'auto',
    history: any[] = [],
    signal?: AbortSignal,
    interruptedResponse?: string,
    interruptedQuestion?: string
) => {
    const message = createTranslationRequest(text, sourceLang, targetLang, [], interruptedResponse, interruptedQuestion);

    return anthropic.messages.stream({
        model: CLAUDE_MODEL_NAME,
        max_tokens: 150,
        temperature: 0.3,
        system: TRANSLATOR_SYSTEM_PROMPT,
        messages: [
            ...history,
            { role: 'user', content: message }
        ],
    }, { signal });
};
