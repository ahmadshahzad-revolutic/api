import { createTranslationStream, translateText } from "../ai/claudeservice";
import { AIPeerContext, CallState } from "./types";
import { setState } from "./statemanager";

export async function handleTranslation(ctx: AIPeerContext, text: string) {
    if (ctx.isTranslationActive) return;
    ctx.isTranslationActive = true;
    const startTime = Date.now();
    const sourceLang = ctx.callLanguages.caller;
    const targetLang = ctx.callLanguages.receiver;

    console.log(`[AI_PEER] Translation pipeline: "${text}" (${sourceLang} → ${targetLang})`);

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

        const stream = createTranslationStream(
            text,
            targetLang,
            sourceLang,
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
            const isFirstChunk = fullTranslation.length === trimmed.length;
            const minWords = isFirstChunk ? 1 : 3;
            const isClauseEnd = /[,،]/.test(trimmed) && wordCount >= minWords;
            const isTooLong = wordCount >= 6;

            if (hasRealContent && (isSentenceEnd || isClauseEnd || isTooLong)) {
                ctx.tts.streamTTS(trimmed, targetLang);
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
                ctx.tts.streamTTS(remaining, targetLang);
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
            if (ctx.claudeAbortController?.signal.aborted) return;
            const { translation } = await translateText(
                text,
                targetLang,
                sourceLang,
                ctx.chatHistory,
                ctx.claudeAbortController?.signal
            );
            ctx.tts.streamTTS(translation, targetLang);
            ctx.chatHistory.push({ role: "user", content: text });
            ctx.chatHistory.push({ role: "assistant", content: translation });
        } catch (fallbackError: any) {
            console.error("[AI_PEER] Fallback translation failed:", fallbackError);
        }
    }
}
