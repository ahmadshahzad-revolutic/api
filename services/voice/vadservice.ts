import * as ort from "onnxruntime-node";
import * as path from "path";

export interface VADService {
    init(): Promise<void>;
    reset(): void;
    processAudio(chunk: Buffer): Promise<boolean>;
}

export function createVADService(): VADService {
    let session: ort.InferenceSession | null = null;
    let state: ort.Tensor | null = null;
    let sr: ort.Tensor = new ort.Tensor("int64", BigInt64Array.from([8000n]), [1]);
    let speechFrames = 0;
    const threshold = 0.75;
    const minSpeechFrames = 10; // ~320ms at 32ms frame size (8kHz)
    let isSpeechDetected = false;
    let pcmBuffer: Float32Array = new Float32Array(0);

    const decodeUlau = (buffer: Buffer | Uint8Array): Float32Array => {
        const l = buffer.length;
        const pcm = new Float32Array(l);
        for (let i = 0; i < l; i++) {
            let u = ~buffer[i];
            let sign = (u & 0x80);
            let exponent = (u & 0x70) >> 4;
            let mantissa = (u & 0x0F);
            let sample = (mantissa << 3) + 132;
            sample <<= (exponent);
            sample -= 132;
            pcm[i] = (sign ? -sample : sample) / 32768.0;
        }
        return pcm;
    };

    const reset = () => {
        state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128).fill(0), [2, 1, 128]);
        speechFrames = 0;
        isSpeechDetected = false;
    };

    const init = async () => {
        // process.cwd() = project root both locally and in production (Railway /app)
        // __dirname after tsc build = dist/services/voice/ which breaks the relative path
        const modelPath = path.join(process.cwd(), "models", "silero_vad.onnx");
        console.log(`[VAD] Loading model from: ${modelPath}`);
        session = await ort.InferenceSession.create(modelPath);
        reset();
    };

    const processAudio = async (chunk: Buffer): Promise<boolean> => {
        if (!session || !state) return false;

        const newPcm = decodeUlau(chunk);

        const combined = new Float32Array(pcmBuffer.length + newPcm.length);
        combined.set(pcmBuffer);
        combined.set(newPcm, pcmBuffer.length);
        pcmBuffer = combined;

        const frameSize = 256;

        while (pcmBuffer.length >= frameSize) {
            const frame = pcmBuffer.slice(0, frameSize);
            pcmBuffer = pcmBuffer.slice(frameSize);

            try {
                const input = new ort.Tensor("float32", frame, [1, frameSize]);
                const feeds: any = {
                    input: input,
                    sr: sr,
                    state: state
                };

                const results = await session.run(feeds);
                state = results.stateN;
                const probability = results.output.data[0] as number;

                if (probability > threshold) {
                    speechFrames++;
                } else {
                    speechFrames = Math.max(0, speechFrames - 1);
                }

                if (speechFrames >= minSpeechFrames) {
                    if (!isSpeechDetected) {
                        console.log(`[VAD] Speech Detected (prob: ${probability.toFixed(2)}, frames: ${speechFrames})`);
                        isSpeechDetected = true;
                    }
                } else if (speechFrames === 0) {
                    isSpeechDetected = false;
                }
            } catch (error) {
                console.error("[VAD] Inference error:", error);
            }
        }

        return isSpeechDetected;
    };

    return {
        init,
        reset,
        processAudio
    };
}
