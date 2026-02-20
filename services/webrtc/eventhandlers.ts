import { RtpPacket, RtpHeader } from "werift";
import { AIPeerContext, CallState } from "./types";
import { calculateDb } from "./audiohandler";
import { setState, startSilenceTimer, clearSilenceTimer } from "./statemanager";

export function handleInterruption(ctx: AIPeerContext) {
    const now = Date.now();
    if (now - ctx.lastInterruptionTime < 500) return;

    if (ctx.isAISpeaking || ctx.isTranslationActive || ctx.audioQueue.length > 0) {
        ctx.lastInterruptionTime = now;
        console.log("[AI_PEER] User interrupted AI. Silencing audio...");

        ctx.lastPartialResponse = ctx.currentResponseText;
        ctx.isInterrupted = true;

        if (ctx.controlChannel && ctx.controlChannel.readyState === "open") {
            ctx.controlChannel.send(JSON.stringify({ type: "INTERRUPTED" }));
        }

        ctx.tts.stop();
        ctx.audioQueue = Buffer.alloc(0);
        ctx.isAISpeaking = false;

        if (ctx.claudeAbortController) {
            ctx.claudeAbortController.abort();
            ctx.claudeAbortController = null;
        }

        const silenceFrame = Buffer.alloc(800, 0xFF);
        ctx.isSilencing = true;
        ctx.audioQueue = silenceFrame;

        ctx.sentenceBuffer = "";
        ctx.isTranslationActive = false;
        ctx.currentResponseText = "";
        setState(ctx, CallState.INTERRUPTED);
    }
}

export function setupHandlers(ctx: AIPeerContext, sendGreeting: () => void, finalizeTurn: (ctx: AIPeerContext) => Promise<void>) {
    const ZONE_A_DB = -15;
    const ZONE_A_DUR = 200;
    const ZONE_B_DB = -25;
    const ZONE_B_DUR = 500;
    const CONFIDENCE_THRESHOLD = 0.85;
    const NOISE_GATE_DB = -45;

    ctx.pc.addTrack(ctx.outputTrack);

    ctx.pc.onconnectionstatechange = () => {
        console.log(`[AI_PEER] Connection state: ${ctx.pc.connectionState}`);
        if (ctx.pc.connectionState === "connected") {
            sendGreeting();
        }
    };

    ctx.pc.ontrack = (event) => {
        const track = event.track;
        if (track.kind === "audio") {
            track.onReceiveRtp.subscribe(async (rtp) => {
                if (!ctx.hasSentGreeting) sendGreeting();
                ctx.stt.sendAudio(rtp.payload);

                const db = calculateDb(rtp.payload);
                ctx.lastAudioLevelDb = db;
                ctx.peakVolumeThisUtterance = Math.max(ctx.peakVolumeThisUtterance, db);

                const isSpeech = await ctx.vad.processAudio(rtp.payload);
                if (isSpeech) {
                    if (!ctx.userSpeechStartTime) {
                        ctx.userSpeechStartTime = Date.now();
                    }
                    ctx.lastAudioLevelDb = db;
                    const duration = Date.now() - ctx.userSpeechStartTime;

                    let isInsideZone = false;
                    let targetDuration = ZONE_B_DUR;
                    let zoneLabel = "B";

                    if (db > ZONE_A_DB) {
                        isInsideZone = true;
                        targetDuration = ZONE_A_DUR;
                        zoneLabel = "A (Close)";
                    } else if (db > ZONE_B_DB) {
                        isInsideZone = true;
                        targetDuration = ZONE_B_DUR;
                        zoneLabel = "B (Normal)";
                    }

                    if (isInsideZone && duration > targetDuration) {
                        if (ctx.isAISpeaking || ctx.isTranslationActive || ctx.audioQueue.length > 0) {
                            console.log(`[AI_PEER] Valid Interruption [Zone ${zoneLabel}]: Vol=${db.toFixed(1)}dB, Dur=${duration}ms`);
                            handleInterruption(ctx);
                        }
                    }
                } else {
                    ctx.userSpeechStartTime = null;
                }
            });
        }
    };

    ctx.stt.on("transcript", async (text) => {
        const cleanText = text.trim();
        if (!cleanText) return;

        console.log(`[AI_PEER] STT Final Transcript: "${cleanText}" (Peak Vol: ${ctx.peakVolumeThisUtterance.toFixed(1)}dB)`);
        ctx.transcriptBuffer = cleanText;
        ctx.peakVolumeThisUtterance = -100; // Reset for next
        startSilenceTimer(ctx, true, finalizeTurn);
    });

    ctx.stt.on("speech_started", () => {
        if (ctx.lastAudioLevelDb < NOISE_GATE_DB) return;
        clearSilenceTimer(ctx);
    });

    ctx.stt.on("speech_ended", async (interimText: string) => {
        if (interimText) ctx.transcriptBuffer = interimText.trim();
        startSilenceTimer(ctx, false, finalizeTurn);
        ctx.userSpeechStartTime = null;
    });

    ctx.stt.on("transcript_metadata", (data: any) => {
        if (data?.confidence) {
            ctx.currentMaxConfidence = Math.max(ctx.currentMaxConfidence, data.confidence);

            if ((ctx.isAISpeaking || ctx.isTranslationActive || ctx.audioQueue.length > 0) &&
                ctx.currentMaxConfidence > CONFIDENCE_THRESHOLD &&
                ctx.lastAudioLevelDb > ZONE_B_DB) {

                console.log(`[AI_PEER] High-Confidence Interruption: Conf=${ctx.currentMaxConfidence.toFixed(2)}, Vol=${ctx.lastAudioLevelDb.toFixed(1)}dB`);
                handleInterruption(ctx);
            }

            if (!data.is_final && data.text) {
                startSilenceTimer(ctx, false, finalizeTurn);
            }
        }

        // Track user's detected language so we can mirror it in responses
        if (data?.language) {
            ctx.detectedLanguage = data.language.toLowerCase();
        }
    });

    ctx.tts.on("audio", (chunk: Buffer) => {
        ctx.audioQueue = Buffer.concat([ctx.audioQueue, chunk]);

        if (!ctx.pacerInterval) {
            let lastTime = Date.now();

            ctx.pacerInterval = setInterval(() => {
                const now = Date.now();
                const frameSize = 160;
                const elapsed = now - lastTime;
                const framesToDispatch = Math.floor(elapsed / 20);
                const previousSpeaking = ctx.isAISpeaking;

                if (ctx.audioQueue.length >= frameSize && !ctx.isSilencing) {
                    ctx.isAISpeaking = true;
                    if (ctx.state !== CallState.INTERRUPTED) setState(ctx, CallState.SPEAKING);
                } else {
                    ctx.isAISpeaking = false;
                    if (ctx.state === CallState.SPEAKING) setState(ctx, CallState.LISTENING);
                }

                if (previousSpeaking !== ctx.isAISpeaking && ctx.controlChannel && ctx.controlChannel.readyState === "open") {
                    ctx.controlChannel.send(JSON.stringify({ type: "STATE", isAISpeaking: ctx.isAISpeaking }));
                }

                for (let i = 0; i < framesToDispatch; i++) {
                    if (ctx.audioQueue.length >= frameSize) {
                        const payload = ctx.audioQueue.slice(0, frameSize);
                        ctx.audioQueue = ctx.audioQueue.slice(frameSize);
                        if (ctx.isSilencing && ctx.audioQueue.length === 0) ctx.isSilencing = false;

                        const packet = new RtpPacket(
                            new RtpHeader({
                                payloadType: 0,
                                sequenceNumber: ctx.sequenceNumber++,
                                timestamp: ctx.timestamp,
                                ssrc: ctx.ssrc,
                            }),
                            payload
                        );

                        ctx.outputTrack.writeRtp(packet);
                        ctx.timestamp += payload.length;
                        lastTime += 20;

                        if (ctx.sequenceNumber > 65535) ctx.sequenceNumber = 0;
                    } else {
                        ctx.isAISpeaking = false;
                        lastTime = now;
                        break;
                    }
                }
            }, 10);
        }
    });

    ctx.stt.on("error", (err) => console.error("[AI_PEER] STT Error:", err));
    ctx.tts.on("error", (err) => console.error("[AI_PEER] TTS Error:", err));

    ctx.tts.on("end", () => {
        const frameSize = 160;
        const remainder = ctx.audioQueue.length % frameSize;
        if (ctx.audioQueue.length > 0 && remainder > 0) {
            const padding = Buffer.alloc(frameSize - remainder, 0xFF);
            ctx.audioQueue = Buffer.concat([ctx.audioQueue, padding]);
        }
    });
}

export function setupDataChannel(ctx: AIPeerContext) {
    if (!ctx.controlChannel) return;
    ctx.controlChannel.onMessage.subscribe((message: any) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.type === "INTERRUPT") handleInterruption(ctx);
        } catch (e) { }
    });

    ctx.controlChannel.stateChanged.subscribe(() => {
        console.log(`[AI_PEER] Control DataChannel state: ${ctx.controlChannel.readyState}`);
    });
}
