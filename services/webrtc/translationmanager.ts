import { createTranslationStream } from "../ai/claudeservice";
import { AIPeerContext } from "./types";

const ROMANIZED_ISLAMIC = [
    'assalamu alaikum', 'assalamualaikum', 'assalam alaikum',
    'walaikum assalam', 'wa alaikum assalam', 'walikum assalam',
    'jazakallah', 'mashallah', 'inshallah', 'alhamdulillah',
    'subhanallah', 'bismillah',
];

function resolveLanguage(text: string, sttLanguage: string): string {
    // Islamic greetings in romanized form are always from Urdu speakers
    const lowerText = text.toLowerCase();
    if (ROMANIZED_ISLAMIC.some(g => lowerText.includes(g))) return 'urdu';

    const urduChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
    const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
    const total = urduChars + latinChars;

    if (total === 0) return (sttLanguage === 'urdu' || sttLanguage === 'hindi') ? 'urdu' : 'english';

    // Urdu script is unambiguous
    if (urduChars >= latinChars && urduChars > 0) return 'urdu';

    // Clearly Latin text → English regardless of STT label
    if (latinChars / total >= 0.6) return 'english';

    // Ambiguous — treat 'urdu' or 'hindi' STT label as Urdu, default everything else to 'english'
    return (sttLanguage === 'urdu' || sttLanguage === 'hindi') ? 'urdu' : 'english';
}

export async function handleTranslation(ctx: AIPeerContext, text: string) {
    if (ctx.isTranslationActive) return;
    ctx.isTranslationActive = true;
    const startTime = Date.now();

    console.log(`[AI_PEER] Processing transcript through AI: "${text}"`);

    try {
        if (ctx.claudeAbortController) ctx.claudeAbortController.abort();
        ctx.claudeAbortController = new AbortController();

        const watchdog = setTimeout(() => {
            if (ctx.isTranslationActive) {
                console.error("[AI_PEER] Pipeline Watchdog Triggered: Forcing reset");
                ctx.isTranslationActive = false;
                ctx.claudeAbortController?.abort();
            }
        }, 15000);

        const interruptedContext = ctx.isInterrupted ? ctx.lastPartialResponse : undefined;
        const interruptedQuestion = ctx.isInterrupted ? ctx.lastInterruptedQuestion : undefined;

        ctx.lastInterruptedQuestion = text;

        const rawLang = ctx.detectedLanguage || 'english';
        const targetLang = resolveLanguage(text, rawLang);
        console.log(`[AI_PEER] Language resolved: STT='${rawLang}' → Script='${targetLang}'`);

        const stream = createTranslationStream(
            text,
            targetLang,
            'auto',
            ctx.chatHistory,
            ctx.claudeAbortController.signal,
            interruptedContext,
            interruptedQuestion
        );

        ctx.isInterrupted = false;
        ctx.lastPartialResponse = "";

        stream.on("error", (error: any) => {
            const isAbort = error.name === 'AbortError' ||
                error.name === 'APIUserAbortError' ||
                error.message?.toLowerCase().includes('aborted');

            if (isAbort) {
                console.log("[AI_PEER] Claude stream aborted intentionally");
                return;
            }
            console.error("[AI_PEER] Claude Stream Error:", error);
        });

        let fullTranslation = "";
        ctx.sentenceBuffer = "";

        stream.on("text", (delta) => {
            if (!ctx.isTranslationActive) return;

            fullTranslation += delta;
            ctx.currentResponseText = fullTranslation;
            ctx.sentenceBuffer += delta;

            const trimmed = ctx.sentenceBuffer.trim();
            const wordCount = trimmed.split(/\s+/).filter(w => w.length > 0).length;
            const hasRealContent = /[\u0600-\u06FF\u0900-\u097F\u4e00-\u9fff\w]/.test(trimmed);

            const isSentenceEnd = /[.!?;।؟۔]$/.test(trimmed);

            // Only split on full sentences with at least 2 words to avoid fragments
            if (hasRealContent && isSentenceEnd && wordCount >= 2) {
                console.log(`[AI_PEER] Sending sentence to TTS: "${trimmed}"`);
                ctx.tts.streamTTS(trimmed, 'auto');
                ctx.sentenceBuffer = "";
            }
        });

        stream.on("finalMessage", () => {
            if (!ctx.isTranslationActive) return;

            clearTimeout(watchdog);
            const remaining = ctx.sentenceBuffer.trim();
            const hasRealContent = /[\u0600-\u06FF\u0900-\u097F\u4e00-\u9fff\w]/.test(remaining);
            const wordCount = remaining.split(/\s+/).filter(w => w.length > 0).length;

            if (remaining && hasRealContent && (wordCount > 0)) {
                ctx.tts.streamTTS(remaining, 'auto');
            }

            ctx.chatHistory.push({ role: "user", content: text });
            ctx.chatHistory.push({ role: "assistant", content: fullTranslation });

            if (ctx.chatHistory.length > 10) ctx.chatHistory = ctx.chatHistory.slice(-10);

            ctx.claudeAbortController = null;
            ctx.isTranslationActive = false;
        });

        await stream.finalMessage();
        clearTimeout(watchdog);

    } catch (error: any) {
        const isAbort = error.name === 'AbortError' ||
            error.name === 'APIUserAbortError' ||
            error.message?.toLowerCase().includes('aborted');

        if (isAbort) {
            ctx.isTranslationActive = false;
            ctx.claudeAbortController = null;
            return;
        }

        console.error("[AI_PEER] Translation Error:", error);
        ctx.isTranslationActive = false;

        try {
            if (!ctx.claudeAbortController?.signal.aborted) {
                const hasUrdu = /[\u0600-\u06FF]/.test(text);
                const errMsg = hasUrdu
                    ? 'مَعَاف کِیجِیے، کُچھ غَلَط ہُوا۔ دَوبَارہ کوشِش کِیجِیے۔'
                    : 'Sorry, something went wrong. Please try again.';
                ctx.tts.streamTTS(errMsg, 'auto');
            }
        } catch (fallbackError: any) {
            console.error("[AI_PEER] Fallback TTS failed:", fallbackError);
        }
    }
}
