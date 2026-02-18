import { CallState, AIPeerContext } from "./types";

export function setState(ctx: AIPeerContext, newState: CallState) {
    if (ctx.state !== newState) {
        console.log(`[AI_PEER] State Transition: ${ctx.state} -> ${newState}`);
        ctx.state = newState;
        if (ctx.controlChannel && ctx.controlChannel.readyState === "open") {
            ctx.controlChannel.send(JSON.stringify({ type: "STATE_CHANGE", state: newState }));
        }
        if (newState !== CallState.SPEAKING && newState !== CallState.INTERRUPTED) {
            ctx.currentMaxConfidence = 0;
        }
    }
}

export function startSilenceTimer(ctx: AIPeerContext, isFinal: boolean = false, finalizeTurn: (ctx: AIPeerContext) => Promise<void>) {
    clearSilenceTimer(ctx);
    const FAST_SILENCE_THRESHOLD = 500;
    const NORMAL_SILENCE_THRESHOLD = 1500;
    const delay = isFinal ? FAST_SILENCE_THRESHOLD : NORMAL_SILENCE_THRESHOLD;
    ctx.silenceTimer = setTimeout(() => finalizeTurn(ctx), delay);
}

export function clearSilenceTimer(ctx: AIPeerContext) {
    if (ctx.silenceTimer) {
        clearTimeout(ctx.silenceTimer);
        ctx.silenceTimer = null;
    }
}
